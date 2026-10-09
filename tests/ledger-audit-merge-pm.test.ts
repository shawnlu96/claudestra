/**
 * dispatch-recovery-MQWATCH1：合并待 PM 处置的台账巡检兜底（src/lib/ledger-audit-merge-pm.ts）。S2W 形状复用 MQWAKE1 夹具
 * （tests/scheduler-merge-pm-kit.test.ts）：真实只读 LedgerReader 上 `ledger audit --dry-run` 只算不写，PM `ledger audit --project --json`
 * 经正规 writer 落库 / 去重 / ack。线 1：一条可行动发现、与原规则共存、on / observe / off；线 2：跨重启不重报、真实解决结清、新阻塞再报、
 * note / memory 不重置计时、正常等待与替代 / 撤回 / 退 fix / 终态 / unknown 零误报、来源失败不假清；线 3：只读、不动业务状态。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { auditLedger, type AuditFinding } from "../src/lib/ledger-audit.js";
import { MERGE_PM_AUDIT_MS, readMergePm } from "../src/lib/ledger-audit-merge-pm.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { openFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { getTask } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { mergePmCandidate } from "../src/lib/scheduler-merge-pm-wait.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import {
  business, claimRun, DIGEST, FPM, manualCard, ok, P, PM, Q, request, s2w, setFeaturePm, setMode, sha, world, type World,
} from "./scheduler-merge-pm-kit.test.js";

const MIN = 60_000, RULE = "merge_pm_blocked";
let w: World, fid: string, c: Awaited<ReturnType<typeof s2w>>;
beforeEach(async () => {
  w = world();
  fid = w.feature();
  await setFeaturePm(w, fid, FPM);
  c = await s2w(w, fid);
});
afterEach(() => w.close());

const sources = (): SnapshotSources => ({
  registry: async () => [], windows: async () => ["master"], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(w.dir, "held.json"),
});
/** 正式巡检入口：PM 带 --project 写（正规 writer），或在只读 LedgerReader 上 --dry-run */
const audit = async (...args: string[]) => (await runLedger(["audit", "--project", P, "--json", ...args], {
  db: args.includes("--dry-run") ? w.reader() : w.db, actor: PM, projectIds: [P, Q], loadRegistry: async () => ({} as Registry),
  saveRegistry: async () => {}, now: () => w.clock, autoDispatch: () => true, autoProjects: () => w.projects, auditSources: sources(),
})) as Record<string, unknown>;
type Run = { ok: boolean; pending?: (AuditFinding & { key: string })[]; projects: { open: AuditFinding[]; skipped: { rule: string; reason: string }[];
  resolved?: number; silenced?: number }[] };
const run = async (...args: string[]) => (await audit(...args)) as unknown as Run;
const mine = (r: Run) => (r.pending ?? []).filter((f) => f.rule === RULE);
const open = () => openFindings(w.db, P).filter((f) => f.rule === RULE);
const ack = (keys: string[]) => ok(audit("--ack", keys.join(",")));
const at = (ms: number) => { w.clock += ms; };
/** 本规则在本项目已有基线（上线首轮之后的常态） */
const baseline = () => void w.db.query("INSERT OR IGNORE INTO audit_baseline (project, rule, since) VALUES (?, ?, ?)").run(P, RULE, w.clock);
/** 直接在只读连接上跑规则（无落库） */
const direct = async () => {
  const [s] = await collectAuditSnapshots(w.reader(), [P], w.clock, sources());
  return auditLedger(s!, w.clock);
};

describe("线 1：S2W 同源阻塞一条可行动发现，开关与原巡检共存", () => {
  test("on：不满 10 分钟不报；满了一条任务级发现给 feature PM，建议引用候选的下一步，正文脱敏；原规则照跑", async () => {
    await setMode(w, "on"); // 新项目、没基线：发现照算
    at(MERGE_PM_AUDIT_MS);
    expect((await direct()).findings.filter((f) => f.rule === RULE)).toEqual([]); // 恰好 10 分钟不报
    at(1);
    const r = await direct();
    const f = r.findings.filter((x) => x.rule === RULE);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ taskId: c.id, notify: FPM, key: expect.stringContaining(c.newHead) });
    expect(f[0]!.detail).toStartWith(`${c.id} 人工合并请求 #${c.request} 已失效（截图门未过、head 已变）`);
    expect(f[0]!.detail).toContain("调度主提醒没有记录");
    for (const s of ["在当前 head 重拍截图", "PM 核图 / 登记 ui-approve", "manual-merge-request", `审查 #${c.reviewSeq}`]) expect(f[0]!.suggestion).toContain(s);
    for (const t of [f[0]!.detail, f[0]!.suggestion]) {
      expect(t).not.toMatch(/\/(Users|tmp|private|var)\/|rs-S2W|r\.md/);
      expect(t).not.toContain(DIGEST);
    }
    expect(r.evaluated).toEqual(expect.arrayContaining(["ship_stalled", "merge_unknown", "dispatch_blocked"])); // 原规则照常 evaluated
    at(30 * MIN); // generic merge 停滞照报，不被本规则替代；本规则仍只一条
    const later = await direct();
    expect(later.findings.filter((x) => x.rule === "ship_stalled")).toHaveLength(1);
    expect(later.findings.filter((x) => x.rule === RULE)).toHaveLength(1);
  });

  test("observe 只算候选写进 skipped 诊断、不报；off 不写不发；开关读不了按 off 且本机有诊断", async () => {
    at(MERGE_PM_AUDIT_MS + MIN);
    const obs = await direct(); // 缺省 observe
    expect(obs.findings.filter((f) => f.rule === RULE)).toEqual([]);
    expect(obs.evaluated).not.toContain(RULE);
    expect(obs.skipped.find((s) => s.rule === RULE)?.reason).toContain(`只诊断不报，候选 ${c.id}`);
    await setMode(w, "off");
    const before = JSON.stringify(w.db.query("SELECT * FROM audit_findings").all());
    const off = await run();
    expect(mine(off)).toEqual([]);
    expect(off.projects[0]!.skipped.find((s) => s.rule === RULE)?.reason).toContain("off");
    expect(JSON.stringify(w.db.query(`SELECT * FROM audit_findings WHERE rule = '${RULE}'`).all())).toBe("[]");
    expect(before).not.toContain(RULE);
    const errs: string[] = [], orig = console.error;
    console.error = (m: string) => void errs.push(String(m));
    try {
      const r = w.reader(); // 只有开关那条读失败，旧发现照读
      const flaky = { query: (sql: string) => { if (/audit_findings|sqlite_master/.test(sql)) return r.query(sql); throw new Error("database is locked"); } };
      const m = readMergePm(flaky as unknown as Database, P, w.clock);
      expect(m).toMatchObject({ mode: "off", candidates: [], open: [] });
      const [s] = await collectAuditSnapshots(w.reader(), [P], w.clock, sources());
      const bad = auditLedger({ ...s!, mergePm: m } as typeof s & { mergePm: typeof m }, w.clock);
      expect(bad.findings.filter((f) => f.rule === RULE)).toEqual([]);
      expect(bad.skipped.find((s) => s.rule === RULE)?.reason).toContain("读不了，按 off");
    } finally { console.error = orig; }
    expect(errs.some((m) => m.includes("mergePmWait") && m.includes("按 off"))).toBe(true);
  });
});

describe("线 2：去重、结清、再报、计时与零误报", () => {
  test("正式入口：没基线首轮当轮就推、不被静默；ack 后跨重启不重报；note / memory 不刷新计时；真实解决结清；新 head / 新实例再报", async () => {
    await setMode(w, "on");
    at(5 * MIN); // 阻塞期间的 memory / 无关 note 不重置计时
    insertEvent(w.db, { actor: PM, now: w.clock }, { project: P, target: c.id, kind: "note", text: "看一眼", data: {} }, false);
    insertEvent(w.db, { actor: PM, now: w.clock }, { project: P, target: c.id, kind: "memory", text: "记一下", data: {} }, false);
    at(5 * MIN + 1);
    const first = await run(); // 规则在本项目第一次跑：当轮就推，不被首轮静默吞掉
    expect(mine(first)).toHaveLength(1);
    expect(first.projects[0]!.silenced).toBe(0);
    const key = mine(first)[0]!.key;
    await ack([key]);
    await run(); // 推过之后这轮 evaluated 建基线，已推过的不重推
    expect(w.db.query("SELECT 1 FROM audit_baseline WHERE project = ? AND rule = ?").get(P, RULE)).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      w.restart();
      at(30 * MIN);
      expect(mine(await run())).toEqual([]); // 同一阻塞不按时间分桶重报
    }
    expect(open().map((f) => f.key)).toEqual([key]);

    // MQWAKE1 已经给 PM 发过，不等于截图门已过：发现照开着
    await ok(w.as("scheduler", "scheduler-autostart", "merge-pm", c.id, "record", mergePmCandidate(w.db, c.id, w.clock)!.key, "--mode", "on", "--pm", FPM));
    await run();
    expect(open().map((f) => f.key)).toEqual([key]);

    // 真实解决：PM 在当前 head 核图 + 提交绑定当前绑定的新请求 → 结清
    await ok(w.as(PM, "ui-approve", c.id, "--head", c.newHead, "--digest", DIGEST));
    const req2 = Number((await request(w, c.id, c.reviewSeq, true)).request);
    const solved = await run();
    expect(solved.projects[0]!.resolved).toBeGreaterThanOrEqual(1);
    expect(open()).toEqual([]);

    // 新实例：新请求再次被 update-branch 打掉 → 新 key，满 10 分钟再报一次
    const head3 = sha(0xe892);
    const intent = claimRun(w, { id: c.id, head: c.newHead, request: req2 }, head3);
    w.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(intent);
    insertEvent(w.db, { actor: "scheduler", now: w.clock }, { project: P, target: c.id, kind: "scheduler", text: "",
      data: { op: "merge_resolve", intentId: intent, outcome: "cancelled" } }, false);
    expect(mine(await run())).toEqual([]);
    at(MERGE_PM_AUDIT_MS + 1);
    const again = mine(await run());
    expect(again).toHaveLength(1);
    expect(again[0]!.key).not.toBe(key);
    expect(again[0]!.key).toContain(head3);
  });

  test("正常排队、await_ci、主动撤回、退 fix、终态、unknown 外部效果：零误报", async () => {
    await setMode(w, "on");
    baseline();
    const queued = await manualCard(w, "QUE", { ui: true, featureId: fid }); // 正常排队
    const ci = await manualCard(w, "ACI", { featureId: fid });
    claimRun(w, ci, sha(0xacc1)); // 意图 submitted，await_ci 中
    const rev = await manualCard(w, "REV", { ui: true, featureId: fid }); // 撤回后 head 再变，也不叫 PM
    await ok(w.as(PM, "manual-merge-revoke", rev.id, "--request", String(rev.request), "--reason", "PM 主动撤回"));
    w.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?").run(sha(0x4e5), rev.id);
    const fix = await s2wLike("FIX");
    w.db.query("UPDATE tasks SET stage = 'fix', rev = rev + 1 WHERE id = ?").run(fix.id);
    const done = await s2wLike("DON");
    w.db.query("UPDATE tasks SET stage = 'done', rev = rev + 1 WHERE id = ?").run(done.id);
    const unk = await s2wLike("UNK");
    w.db.query("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?").run(unk.intent);
    at(3 * 60 * MIN);
    const ids = (await direct()).findings.filter((f) => f.rule === RULE).map((f) => f.taskId);
    expect(ids).toEqual([c.id]); // 只有原 S2W 那张
    expect(ids).not.toContain(queued.id);
  });

  test("来源 / 配置读不了：skipped、不 evaluated，旧发现不被假清", async () => {
    await setMode(w, "on");
    at(MERGE_PM_AUDIT_MS + 1);
    const key = mine(await run())[0]!.key; // 没基线首轮当轮就出
    await ack([key]);
    await run(); // 推过后建基线
    // 阻塞其实解了，但这一轮交接配置读不了：不能当无阻塞关掉旧发现
    await ok(w.as(PM, "ui-approve", c.id, "--head", c.newHead, "--digest", DIGEST));
    await request(w, c.id, c.reviewSeq, true);
    const errs: string[] = [], orig = console.error;
    console.error = (m: string) => void errs.push(String(m));
    let r;
    try {
      const m = readMergePm(w.reader(), P, w.clock, () => { throw new Error("scheduler.json 坏了"); });
      expect(m).toEqual({ unreadable: expect.stringContaining("读不了"), open: [{ key, told: true }] });
      const [s] = await collectAuditSnapshots(w.reader(), [P], w.clock, sources());
      r = auditLedger({ ...s!, mergePm: m } as typeof s & { mergePm: typeof m }, w.clock);
    } finally { console.error = orig; }
    expect(r.evaluated).not.toContain(RULE);
    expect(r.skipped.find((s) => s.rule === RULE)?.reason).not.toMatch(/\/(Users|tmp|private)\//);
    const rec = reconcileFindings(w.db, P, r.findings, r.evaluated, w.clock, { keep: r.keep });
    expect(open().map((f) => f.key)).toEqual([key]);
    expect(rec.pending.filter((f) => f.rule === RULE)).toEqual([]); // 读不了这轮不推
    expect(errs.some((m) => m.includes("候选取不到"))).toBe(true);
    await run(); // 来源恢复：真实解决后正常结清
    expect(open()).toEqual([]);
  });
});

describe("r1 审查回归：模式切换不推旧发现、无基线不卡对账", () => {
  test("on 落库没送达（不 ack）→ 切 off / observe：旧发现保持打开但不进 pending；切回 on 照常可推", async () => {
    await setMode(w, "on");
    at(MERGE_PM_AUDIT_MS + 1);
    baseline();
    const key = mine(await run())[0]!.key; // 投递失败 / PM 不在：不 ack
    await setMode(w, "off");
    expect(mine(await run())).toEqual([]);
    expect(open().map((f) => f.key)).toEqual([key]);
    await setMode(w, "observe");
    const obs = await run();
    expect(mine(obs)).toEqual([]);
    expect(obs.projects[0]!.skipped.find((s) => s.rule === RULE)?.reason).toContain("observe");
    expect(open().map((f) => f.key)).toEqual([key]);
    await setMode(w, "on");
    expect(mine(await run()).map((f) => f.key)).toEqual([key]);
  });

  test("还没基线时两张卡都阻塞：真实解决一张立即结清，另一张照常可推；已推过的不因建基线重推", async () => {
    await setMode(w, "on");
    const other = await s2wLike("OTH");
    at(MERGE_PM_AUDIT_MS + 1);
    const two = await run(); // 没基线首轮两张都当轮推
    expect(mine(two).map((f) => f.taskId).sort()).toEqual([c.id, other.id].sort());
    // 模拟旧版本遗留：开着的发现在、基线却没有；OTHER 已推过，S2W 没推过
    w.db.query("DELETE FROM audit_baseline WHERE rule = ?").run(RULE);
    const otherKey = mine(two).find((f) => f.taskId === other.id)!.key;
    await ack([otherKey]);
    await ok(w.as(PM, "ui-approve", c.id, "--head", c.newHead, "--digest", DIGEST));
    await request(w, c.id, c.reviewSeq, true);
    const solved = await run();
    expect(solved.projects[0]!.resolved).toBeGreaterThanOrEqual(1);
    expect(open().map((f) => f.taskId)).toEqual([other.id]); // S2W 立即结清，OTHER 照开
    expect(mine(solved)).toEqual([]); // OTHER 已推过，不重推
    expect(w.db.query("SELECT 1 FROM audit_baseline WHERE project = ? AND rule = ?").get(P, RULE)).not.toBeNull();
  });
});

describe("r2 审查回归：发现不挂在基线上，首轮准入与对账分开", () => {
  test("新项目没基线：dry-run 反复照出；首轮 writable 当轮进 pending；推过后建基线，已解的照常结清", async () => {
    await setMode(w, "on");
    const other = await s2wLike("OTH");
    at(MERGE_PM_AUDIT_MS + 1);
    for (let i = 0; i < 2; i++) expect((await run("--dry-run")).projects[0]!.open.filter((f) => f.rule === RULE).map((f) => f.taskId).sort()).toEqual([c.id, other.id].sort());
    const first = await run();
    expect(mine(first).map((f) => f.taskId).sort()).toEqual([c.id, other.id].sort());
    expect(first.projects[0]!.silenced).toBe(0);
    expect(first.projects[0]!.skipped.find((s) => s.rule === RULE)?.reason).toContain("还没基线");
    await ack(mine(first).map((f) => f.key));
    // S2W 真实解决、OTHER 仍阻塞：都推过了，这轮 evaluated 建基线并结清 S2W
    await ok(w.as(PM, "ui-approve", c.id, "--head", c.newHead, "--digest", DIGEST));
    await request(w, c.id, c.reviewSeq, true);
    const next = await run();
    expect(mine(next)).toEqual([]);
    expect(open().map((f) => f.taskId)).toEqual([other.id]);
    expect(w.db.query("SELECT 1 FROM audit_baseline WHERE project = ? AND rule = ?").get(P, RULE)).not.toBeNull();
  });
});

describe("r3 审查回归：没基线时对账不等送达确认", () => {
  test("两张都阻塞、首轮推送失败（不 ack）：真实解决 S2W 下一轮就结清、建基线；重启推进后也只剩 OTHER", async () => {
    await setMode(w, "on");
    const other = await s2wLike("OTH");
    at(MERGE_PM_AUDIT_MS + 1);
    const first = await run(); // 首轮当轮推；投递失败 / PM 不在：不 ack
    expect(mine(first).map((f) => f.taskId).sort()).toEqual([c.id, other.id].sort());
    await ok(w.as(PM, "ui-approve", c.id, "--head", c.newHead, "--digest", DIGEST));
    await request(w, c.id, c.reviewSeq, true);
    const solved = await run();
    expect(solved.projects[0]!.resolved).toBe(1);
    expect(open().map((f) => f.taskId)).toEqual([other.id]);
    expect(w.db.query("SELECT 1 FROM audit_baseline WHERE project = ? AND rule = ?").get(P, RULE)).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      at(15 * MIN);
      expect(mine(await run())).toEqual([]); // 同一阻塞不重报
      expect(open().map((f) => f.taskId)).toEqual([other.id]);
      expect((await run("--dry-run")).projects[0]!.open.filter((f) => f.rule === RULE).map((f) => f.taskId)).toEqual([other.id]);
    }
  });
});

describe("线 3：只读计算，正规 writer 只写巡检表", () => {
  test("LedgerReader 上 --dry-run 只算不写；正式入口只动 audit 表，不改任务 / 请求 / 审批 / 意图 / 槽 / 权限", async () => {
    await setMode(w, "on");
    at(MERGE_PM_AUDIT_MS + 1);
    expect(w.reader().query("PRAGMA query_only").get()).toEqual({ query_only: 1 }); // 新项目、没基线
    const before = business(w.db);
    const dry = await run("--dry-run");
    expect(dry.ok).toBe(true);
    expect(dry.projects[0]!.open.filter((f) => f.rule === RULE)).toHaveLength(1);
    expect((await run("--dry-run")).projects[0]!.open.filter((f) => f.rule === RULE)).toHaveLength(1); // 反复只读诊断照出
    expect(open()).toEqual([]); // dry-run 没落库
    expect(w.db.query("SELECT 1 FROM audit_baseline WHERE rule = ?").get(RULE)).toBeNull();
    const r = await run();
    expect(mine(r)).toHaveLength(1);
    expect(business(w.db)).toEqual(before);
    expect(getTask(w.db, c.id)).toMatchObject({ stage: "merge", headSHA: c.newHead });
  });
});

/** 另一张 S2W 形状的卡（同一 feature）：请求受理 → claim → 换 head → 意图 cancelled */
async function s2wLike(id: string) {
  const k = await manualCard(w, id, { ui: true, featureId: fid });
  const intent = claimRun(w, k, sha(Number.parseInt(id.split("").map((ch) => ch.charCodeAt(0).toString(16)).join("").slice(0, 6), 16)));
  w.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(intent);
  return { ...k, intent };
}

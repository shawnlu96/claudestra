/**
 * team-project-PMWAKE2 验收线 1–4（上线后 PM 提醒、结掉即停、节奏与重启、边界）与 PM 批 02:2x 的 writer 负例：
 * 真实临时台账 + 进程内 ledger CLI 跑完整自动开卡 tick（没有 feature 节点要开，只走提醒），发送函数换成记录器（specWaitSend）。
 * 规格卡放在正式路径（statePath("ledger/docs/tasks")，测试进程的状态目录在临时目录），调度侧与 writer 读同一份。时钟统一走 clock。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { importTask, setMeta } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import {
  POST_VERIFY_OVERDUE_MS, POST_VERIFY_REPEAT_MS, postVerifySection, postVerifyText, readPostVerifySpec,
} from "../src/lib/scheduler-post-verify-ledger.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", X = "agent-claudestra";
let dir: string, db: Database, clock: number, seq: number, card: string, fid: string;
let sent: { project: string; to: string; text: string }[];
const specs: string[] = [];

const ledgerDeps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {}, now: () => clock + seq++,
  autoDispatch: () => true, autoProjects: () => [P],
});
const schedLedger = async (...args: string[]) => runLedger(args.slice(1), { ...ledgerDeps("scheduler"), now: () => clock });

const SECTION = "- 跑 `ledger shared-auto observe → on`\n- 核对提醒";
function spec(id: string, body = `# ${id}\n\n## 目标\n做事\n\n## 上线后 PM\n${SECTION}\n\n## 附录\n不算\n`): void {
  const d = statePath("ledger", "docs", "tasks");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.md`), body);
  specs.push(join(d, `${id}.md`));
}

/** 一张 verified 卡：verifiedTs 进 verified */
function verified(id: string, verifiedTs: number, featureId: string | null = fid): void {
  importTask(db, { actor: "owner", now: verifiedTs }, {
    createdTs: verifiedTs - 3_600_000, initialStage: "live",
    events: [{ kind: "stage", ts: verifiedTs, data: { from: "live", to: "verified" } }],
    task: { project: P, id, stage: "verified", title: `${id} 卡`, kind: "code", agent: "agent-w", pm: PM },
  });
  if (featureId) db.run("UPDATE tasks SET featureId = ? WHERE id = ?", [featureId, id]);
}

function env(over: Partial<StartTickEnv> = {}): StartTickEnv {
  const e: StartTickEnv = {
    db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 }, ledger: schedLedger,
    plain: async () => { throw new Error("不该开卡"); }, startEnv: () => { throw new Error("不该开卡"); }, stepIO: () => { throw new Error("不该开卡"); },
    readSpec: readPostVerifySpec, quota: async () => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null, windows: [] }),
    notifyPm: async () => { throw new Error("应走 specWaitSend"); }, memo: new Set(), now: () => clock, attempt: () => "a1", ...over,
  };
  return Object.assign(e, { specWaitSend: async (_db: Database, project: string, to: string, text: string) => void sent.push({ project, to, text }) });
}
const tick = (over: Partial<StartTickEnv> = {}) => autostartTick(env(over));
const sw = (input: { featureId?: string; pm?: string; specWait?: string }) =>
  setAutostartSwitch(db, { actor: PM, now: clock + seq++ }, { project: P, on: true, featureId: input.featureId, pm: input.pm, specWait: input.specWait, reason: "测试" });
const records = (id = card) => listEvents(db, { target: id }).filter((e) => e.data.op === "post_verify");
const done = (id = card) => runLedger(["note", id, "已切 on", "--dedup", `post-verify-done:${id}`], ledgerDeps(X));

beforeEach(() => {
  clock = Date.now();
  seq = 0;
  sent = [];
  dir = mkdtempSync(join(tmpdir(), "pmwake2-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM, X] });
  fid = createFeature(db, { actor: PM, now: clock + seq++ }, { project: P, slug: "n8", title: "共享台账" }).row.id;
  card = `pmwake2-${Math.random().toString(16).slice(2, 10)}`;
  spec(card);
  verified(card, clock - 60_000);
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
  for (const p of specs.splice(0)) rmSync(p, { force: true });
});

describe("线 1：提醒", () => {
  test("verified + 规格有 `## 上线后 PM` + 未结 + 开关 on：一轮给 featurePm 恰好 1 条，正文含该节与结掉命令", async () => {
    sw({ specWait: "on" });
    sw({ featureId: fid, pm: X });
    expect(await tick()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ project: P, to: X });
    expect(sent[0].text).toBe(`[上线后待办] ${card} 已上线，规格要求 PM 接着做：\n${SECTION}\n做完用 \`ledger note ${card} "<做了什么>" --dedup post-verify-done:${card}\` 结掉。`);
    expect(sent[0].text).not.toContain("不算");
    expect(records().map((e) => [e.actor, e.dedupKey, e.data.n])).toEqual([["scheduler", `post-verify:${card}:on:1`, 1]]);
  });
});

describe("线 2：结掉即停", () => {
  test("PM 写入 post-verify-done:<卡> 后 0 条（哪怕过了 30 分钟、过了 72 小时）", async () => {
    sw({ specWait: "on" });
    await tick();
    expect(sent).toHaveLength(1);
    expect(await done()).toMatchObject({ ok: true });
    clock += POST_VERIFY_REPEAT_MS;
    await tick();
    clock += POST_VERIFY_OVERDUE_MS;
    await tick();
    expect(sent).toHaveLength(1);
    expect(records()).toHaveLength(1);
  });
});

describe("线 3：节奏与去重", () => {
  test("同一时刻再跑 0 条；+30 分钟仍未结再 1 条；verified 超过 72 小时 → 只给当班 PM 1 条超时，之后 0 条", async () => {
    sw({ specWait: "on" });
    sw({ featureId: fid, pm: X });
    await tick();
    await tick();
    expect(sent).toHaveLength(1);
    clock += POST_VERIFY_REPEAT_MS - 1;
    await tick();
    expect(sent).toHaveLength(1);
    clock += 1;
    await tick();
    expect(sent.map((s) => s.to)).toEqual([X, X]);
    expect(records().map((e) => e.dedupKey)).toEqual([`post-verify:${card}:on:1`, `post-verify:${card}:on:2`]);
    clock += POST_VERIFY_OVERDUE_MS;
    await tick();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ to: PM });
    expect(sent[2].text).toStartWith(`[上线后待办] ${card} 上线后 PM 步骤 72 小时未结`);
    for (let i = 0; i < 3; i++) {
      clock += POST_VERIFY_REPEAT_MS;
      await tick();
    }
    expect(sent).toHaveLength(3);
    expect(records().at(-1)?.dedupKey).toBe(`post-verify-overdue:${card}:on`);
  });

  test("模拟重启（新 env、新 memo、重开台账）后 30 分钟窗口内 0 条：去重靠台账记录", async () => {
    sw({ specWait: "on" });
    await tick();
    closeLedger(join(dir, "ledger.sqlite"));
    db = openLedger(join(dir, "ledger.sqlite"));
    clock += POST_VERIFY_REPEAT_MS - 1;
    await tick({ memo: new Set() });
    expect(sent).toHaveLength(1);
    clock += 1;
    await tick({ memo: new Set() });
    expect(sent).toHaveLength(2);
  });

  test("verified 早已超过 72 小时的卡：首轮就只给当班 PM 1 条超时", async () => {
    const old = `${card}-old`;
    spec(old);
    verified(old, clock - POST_VERIFY_OVERDUE_MS - 1);
    sw({ specWait: "on" });
    sw({ featureId: fid, pm: X });
    await tick();
    expect(sent.filter((s) => s.text.includes(old)).map((s) => s.to)).toEqual([PM]);
  });
});

describe("线 4：边界", () => {
  test("规格没有该节 0 条；节标题不完全一致也不算", async () => {
    spec(card, "# x\n\n## 上线后PM\n- 做\n\n### 上线后 PM\n- 做\n");
    sw({ specWait: "on" });
    await tick();
    expect(sent).toEqual([]);
    expect(records()).toEqual([]);
  });

  test("规格卡读不到当作没有该节：0 条", async () => {
    for (const p of specs.splice(0)) rmSync(p, { force: true });
    sw({ specWait: "on" });
    await tick();
    expect(sent).toEqual([]);
  });

  test("卡不是 verified：0 条", async () => {
    const live = `${card}-live`;
    spec(live);
    importTask(db, { actor: "owner", now: clock }, { createdTs: clock - 1, events: [], task: { project: P, id: live, stage: "live", title: "live 卡", kind: "code", pm: PM } });
    sw({ specWait: "on" });
    await tick();
    expect(sent.filter((s) => s.text.includes(live))).toEqual([]);
    expect(records(live)).toEqual([]);
  });

  test("开关 observe（缺省）：只写记录 0 消息；切 on 立即发第一条", async () => {
    await tick();
    expect(sent).toEqual([]);
    expect(records().map((e) => e.data)).toEqual([{ op: "post_verify", kind: "remind", mode: "observe", pm: PM, n: 1 }]);
    sw({ specWait: "on" });
    await tick();
    expect(sent).toHaveLength(1);
  });

  test("off：0 记录 0 消息", async () => {
    sw({ specWait: "off" });
    await tick();
    expect(sent).toEqual([]);
    expect(records()).toEqual([]);
  });

  test("featurePm 未设 / 卡不属于 feature：发项目当班 PM", async () => {
    const lone = `${card}-lone`;
    spec(lone);
    verified(lone, clock - 60_000, null);
    sw({ specWait: "on" });
    await tick();
    expect(sent.map((s) => s.to)).toEqual([PM, PM]);
  });

  test("该节超过 1200 字节：截断并注明", async () => {
    spec(card, `## 上线后 PM\n${"步骤。".repeat(500)}\n`);
    sw({ specWait: "on" });
    await tick();
    expect(sent[0].text).toContain(`…（超出 1200 字节已截断，全文见规格卡 ${card}.md）`);
    expect(Buffer.byteLength(sent[0].text)).toBeLessThan(1600);
  });

  test("发送失败不拖垮 tick：进 failed，记录已写、下一窗口再试", async () => {
    sw({ specWait: "on" });
    const e = env();
    Object.assign(e, { specWaitSend: async () => { throw new Error("bridge 不在"); } });
    expect((await autostartTick(e)).map((f) => f.error).join()).toContain("bridge 不在");
    expect(records()).toHaveLength(1);
  });
});

describe("审查 r1 修复", () => {
  test("fenced-heading：只有代码块里的示例 `## 上线后 PM`、没有真正一级小节 → 0 消息 0 记录", async () => {
    spec(card, "# Example\n```markdown\n## 上线后 PM\n- example only\n```\n## Actual section\nno post-verify steps\n");
    sw({ specWait: "on" });
    expect(await tick()).toEqual([]);
    expect(sent).toEqual([]);
    expect(records()).toEqual([]);
    expect(postVerifySection("~~~\n## 上线后 PM\nx\n~~~\n## 上线后 PM\n- 真的\n")).toBe("- 真的");
  });

  test("overdue-lost：72 小时超时提醒第一次发送失败 → 不终结，恢复后下个窗口给当班 PM 送达 1 条，之后 0 条", async () => {
    const old = `${card}-old`;
    spec(old);
    verified(old, clock - POST_VERIFY_OVERDUE_MS - 1);
    sw({ specWait: "on" });
    const e = env();
    Object.assign(e, { specWaitSend: async () => { throw new Error("temporary offline"); } });
    expect((await autostartTick(e)).map((f) => f.error).join()).toContain("temporary offline");
    expect(records(old).map((r) => r.dedupKey)).toEqual([`post-verify-overdue-try:${old}:on:1`]);
    await tick();
    expect(sent.filter((s) => s.text.includes(old))).toEqual([]);
    for (let i = 0; i < 3; i++) {
      clock += POST_VERIFY_REPEAT_MS;
      expect(await tick()).toEqual([]);
    }
    expect(sent.filter((s) => s.text.includes(old)).map((s) => s.to)).toEqual([PM]);
    expect(records(old).map((r) => r.dedupKey)).toEqual([`post-verify-overdue-try:${old}:on:1`, `post-verify-overdue-try:${old}:on:2`, `post-verify-overdue:${old}:on`]);
  });

  test("overdue-sent 经 CLI：先无发送意图 → conflict；observe → invalid；有意图后记已发、重复 0 写入", async () => {
    const old = `${card}-old`;
    spec(old);
    verified(old, clock - POST_VERIFY_OVERDUE_MS - 1);
    sw({ specWait: "on" });
    const w = (args: string[]) => runLedger(["scheduler-autostart", "post-verify", ...args], { ...ledgerDeps("scheduler"), now: () => clock });
    expect(await w([old, "overdue-sent", "--mode", "on", "--pm", PM])).toMatchObject({ ok: false, code: "conflict" });
    expect(await w([old, "overdue-sent", "--mode", "observe", "--pm", PM])).toMatchObject({ ok: false, code: "invalid" });
    expect(await runLedger(["scheduler-autostart", "post-verify", old, "overdue-sent", "--mode", "on", "--pm", PM], ledgerDeps(PM))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await w([old, "overdue", "--mode", "on", "--pm", PM])).toMatchObject({ ok: true, due: true });
    expect(await w([old, "overdue-sent", "--mode", "on", "--pm", PM])).toMatchObject({ ok: true, due: false });
    expect(await w([old, "overdue-sent", "--mode", "on", "--pm", PM])).toMatchObject({ ok: true, due: false });
    expect(await w([old, "overdue", "--mode", "on", "--pm", PM])).toMatchObject({ ok: true, due: false });
    expect(records(old).map((r) => r.dedupKey)).toEqual([`post-verify-overdue-try:${old}:on:1`, `post-verify-overdue:${old}:on`]);
  });
});

describe("生产接线：env.db 是只读 LedgerReader（query_only），记录走调度 ledger CLI", () => {
  test("observe 只记录、on 记录并发 1 条、off 0 写入，failed 都为空", async () => {
    const reader = new LedgerReader(join(dir, "ledger.sqlite"));
    const ro = reader.get() as Database;
    expect((ro.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
    try {
      expect(await tick({ db: ro })).toEqual([]);
      expect(records().map((e) => e.data.mode)).toEqual(["observe"]);
      expect(sent).toEqual([]);
      sw({ specWait: "on" });
      expect(await tick({ db: ro })).toEqual([]);
      expect(sent.map((x) => x.to)).toEqual([PM]);
      expect(records().map((e) => e.data.mode)).toEqual(["observe", "on"]);
      sw({ specWait: "off" });
      clock += POST_VERIFY_REPEAT_MS;
      expect(await tick({ db: ro })).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(records()).toHaveLength(2);
    } finally {
      reader.close();
    }
  });
});

describe("writer：`scheduler-autostart post-verify` 只给调度身份，自己核状态、自己算正文与 dedup", () => {
  const w = (args: string[], actor = "scheduler") =>
    runLedger(["scheduler-autostart", "post-verify", ...args], actor === "scheduler" ? { ...ledgerDeps(actor), now: () => clock } : ledgerDeps(actor));

  test("三态经 CLI：on / observe 各写一条（返回 writer 算的正文与收件人），off 一律 conflict 0 写入", async () => {
    sw({ specWait: "on" });
    expect(await w([card, "remind", "--mode", "on", "--pm", PM])).toMatchObject({ ok: true, due: true, to: PM, text: postVerifyText("remind", card, SECTION) });
    expect(await w([card, "remind", "--mode", "on", "--pm", PM])).toMatchObject({ ok: true, due: false });
    sw({ specWait: "observe" });
    expect(await w([card, "remind", "--mode", "observe", "--pm", PM])).toMatchObject({ ok: true, due: true });
    sw({ specWait: "off" });
    for (const m of ["on", "observe"]) expect(await w([card, "remind", "--mode", m, "--pm", PM])).toMatchObject({ ok: false, code: "conflict" });
    expect(await w([card, "remind", "--mode", "off", "--pm", PM])).toMatchObject({ ok: false, code: "invalid" });
    expect(records().map((e) => e.dedupKey)).toEqual([`post-verify:${card}:on:1`, `post-verify:${card}:observe:1`]);
  });

  test("负例：非调度身份被拒；卡不是 verified、规格无该节、已结、收件人 / 72 小时分界不符 → conflict；带自定义正文 / dedup / 多余参数 → invalid；都 0 写入", async () => {
    sw({ specWait: "on" });
    expect(await w([card, "remind", "--mode", "on", "--pm", PM], PM)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await w([card, "remind", "--mode", "on", "--pm", X])).toMatchObject({ ok: false, code: "conflict" });
    expect(await w([card, "overdue", "--mode", "on", "--pm", PM])).toMatchObject({ ok: false, code: "conflict" });
    expect(await w([card, "remind", "--mode", "on", "--pm", PM, "--text", "自定义"])).toMatchObject({ ok: false, code: "invalid" });
    expect(await w([card, "remind", "--mode", "on", "--pm", PM, "--dedup", "x"])).toMatchObject({ ok: false, code: "invalid" });
    expect(await w([card, "remind", "extra", "--mode", "on", "--pm", PM])).toMatchObject({ ok: false, code: "invalid" });
    const live = `${card}-live`;
    spec(live);
    importTask(db, { actor: "owner", now: clock }, { createdTs: clock - 1, events: [], task: { project: P, id: live, stage: "live", title: "live 卡", kind: "code", pm: PM } });
    expect(await w([live, "remind", "--mode", "on", "--pm", PM])).toMatchObject({ ok: false, code: "conflict" });
    const bare = `${card}-bare`;
    spec(bare, "# 没有那一节\n");
    verified(bare, clock - 60_000);
    expect(await w([bare, "remind", "--mode", "on", "--pm", PM])).toMatchObject({ ok: false, code: "conflict" });
    expect(await done()).toMatchObject({ ok: true });
    expect(await w([card, "remind", "--mode", "on", "--pm", PM])).toMatchObject({ ok: false, code: "conflict" });
    expect([...records(), ...records(live), ...records(bare)]).toEqual([]);
  });
});

describe("postVerifySection", () => {
  test("到下一个一 / 二级标题为止，三级标题与代码块里的 # 算正文；空节当没有", () => {
    expect(postVerifySection("## 上线后 PM\n- a\n### 细节\n```\n# 注释\n```\n## 下一节\nx")).toBe("- a\n### 细节\n```\n# 注释\n```");
    expect(postVerifySection("## 上线后 PM  \n- a\n# 顶层")).toBe("- a");
    expect(postVerifySection("## 上线后 PM\n\n## 下一节")).toBeNull();
    expect(postVerifySection(null)).toBeNull();
  });
});

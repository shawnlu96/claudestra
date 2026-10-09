/**
 * dispatch-recovery-MQWAKE1 验收线 1、3：S2W 形状（tests/scheduler-merge-pm-kit.test.ts）在真实只读 LedgerReader + 正规 ledger CLI 上跑完整
 * 自动开卡 tick。线 1：旧路径（off / 缺省 observe）不叫醒 PM，on 一轮送 feature PM，台账只多本功能事件。线 3：on / observe / off、
 * 发送失败有界重试、发送端回 false、重启、同一阻塞去重、新绑定成新阻塞、记录后到发送前审批 / 请求 / PM / 租约变化。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { MERGE_PM_REPEAT_MS } from "../src/lib/scheduler-merge-pm-ledger.js";
import { mergePmCandidate } from "../src/lib/scheduler-merge-pm-wait.js";
import { business, DIGEST, FPM, mergeCard, ok, P, PM, pmEvents, request, s2w, setFeaturePm, setMode, world, type World } from "./scheduler-merge-pm-kit.test.js";

let w: World, fid: string, c: Awaited<ReturnType<typeof s2w>>;
beforeEach(async () => {
  w = world();
  fid = w.feature();
  await setFeaturePm(w, fid, FPM);
  c = await s2w(w, fid);
});
afterEach(() => w.close());

const kinds = () => pmEvents(w.db).map((e) => [e.actor, e.data.kind, e.data.pm]);
/** PM 在当前 head 核图登记 ui-approve，并（可选）提交绑定新 head 的人工合并请求 */
const reaccept = async (andRequest = false) => {
  await ok(w.as(PM, "ui-approve", c.id, "--head", c.newHead, "--digest", DIGEST));
  if (andRequest) await request(w, c.id, c.reviewSeq, true);
};

describe("线 1：S2W 形状", () => {
  test("旧路径（off、缺省 observe）不发；on 一轮给 feature PM 恰好 1 条，含重拍 / 核图 / 新绑定请求，台账只多本功能事件", async () => {
    expect(w.reader().query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(await w.tick()).toEqual([]);
    expect(w.sent).toEqual([]); // 缺省 observe：只记一条 would
    expect(kinds()).toEqual([["scheduler", "would", FPM]]);
    await setMode(w, "off");
    const off = business(w.db);
    w.clock += MERGE_PM_REPEAT_MS;
    expect(await w.tick()).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(business(w.db)).toEqual(off);
    expect(pmEvents(w.db)).toHaveLength(1);

    await setMode(w, "on");
    const before = business(w.db);
    expect(await w.tick()).toEqual([]);
    expect(w.sent).toHaveLength(1);
    const { to, project, text } = w.sent[0];
    expect([to, project]).toEqual([FPM, P]);
    expect(text).toStartWith(`[合并待处置] ${c.id} 人工合并请求 #${c.request} 已失效（截图门未过、head 已变）`);
    for (const s of ["在当前 head 重拍截图", "PM 核图 / 登记 ui-approve", "符合原沿用门时才沿用", `head ${c.newHead.slice(0, 12)}`, `审查 #${c.reviewSeq}`,
      "manual-merge-request"]) expect(text).toContain(s);
    expect(text).not.toMatch(/\/(Users|tmp|private|var)\/|rs-S2W|r\.md/);
    expect(text).not.toContain(DIGEST);
    expect(business(w.db)).toEqual(before); // 截图 / 审查 / 请求 / 阶段 / 意图 / 槽 / 权限一样不动
    expect(kinds()).toEqual([["scheduler", "would", FPM], ["scheduler", "try", FPM], ["scheduler", "sent", FPM]]);
  });
});

describe("线 3：开关、去重、重试、重启", () => {
  test("observe 每个阻塞实例只一条 would、不发；切 on 立即发 1 条；之后同一阻塞不再发，重启后也不发", async () => {
    await w.tick();
    w.clock += 5 * MERGE_PM_REPEAT_MS;
    await w.tick();
    expect(w.sent).toEqual([]);
    expect(kinds()).toEqual([["scheduler", "would", FPM]]);
    await setMode(w, "on");
    await w.tick();
    await w.tick();
    expect(w.sent).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      w.restart();
      w.clock += MERGE_PM_REPEAT_MS;
      expect(await w.tick()).toEqual([]);
    }
    expect(w.sent).toHaveLength(1);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["would", "try", "sent"]);
  });

  test("发送失败不记已送：30 分钟内不重发（重启也不），满 30 分钟按同一实例重试一次，送达后停", async () => {
    await setMode(w, "on");
    w.send = async () => { throw new Error("bridge 不通"); };
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining("合并待处置提醒发给 agent-fpm 失败")]);
    w.restart();
    w.clock += MERGE_PM_REPEAT_MS - 1;
    expect(await w.tick()).toEqual([]);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
    w.send = async (s) => void w.sent.push(s);
    w.clock += 1;
    await w.tick();
    expect(w.sent).toHaveLength(1);
    expect(pmEvents(w.db).map((e) => [e.data.kind, e.data.n ?? null])).toEqual([["try", 1], ["try", 2], ["sent", null]]);
    w.clock += 10 * MERGE_PM_REPEAT_MS;
    await w.tick();
    expect(w.sent).toHaveLength(1);
  });

  test("发送端回 false 不冒充已送", async () => {
    await setMode(w, "on");
    w.send = async () => false;
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining("发送端回 false")]);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  test("新验收形成新阻塞：旧提醒不再发，新提醒只剩提交新请求一步（无重拍）；有效替代请求后零提醒", async () => {
    await setMode(w, "on");
    await w.tick();
    await reaccept();
    w.clock += 1;
    await w.tick();
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1].text).toContain("（head 已变）");
    expect(w.sent[1].text).not.toMatch(/重拍|ui-approve/);
    expect(new Set(pmEvents(w.db).map((e) => e.data.key)).size).toBe(2);
    await request(w, c.id, c.reviewSeq, true);
    w.clock += 10 * MERGE_PM_REPEAT_MS;
    await w.tick();
    expect(w.sent).toHaveLength(2);
    expect(mergePmCandidate(w.db, c.id, w.clock)).toBeNull();
  });
});

describe("线 3：记录后到发送前的变化", () => {
  const afterRecord = (fn: () => unknown) => {
    w.afterLedger = async (args) => { if (args.includes("record")) { w.afterLedger = null; await fn(); } };
  };

  test("记录后 PM 核图 + 提交新请求：不发陈旧动作，也不再补发", async () => {
    await setMode(w, "on");
    afterRecord(() => reaccept(true));
    expect(await w.tick()).toEqual([]);
    w.clock += 10 * MERGE_PM_REPEAT_MS;
    await w.tick();
    expect(w.sent).toEqual([]);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  for (const mode of ["off", "observe"]) {
    test(`记录后 PM 把开关改成 ${mode}：不发，也不追加已送确认；之后 ${mode === "off" ? "零写零发" : "只记 would"}`, async () => {
      await setMode(w, "on");
      afterRecord(() => setMode(w, mode));
      expect(await w.tick()).toEqual([]);
      expect(w.sent).toEqual([]);
      expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
      const before = JSON.stringify(w.db.query("SELECT * FROM events").all());
      w.clock += 10 * MERGE_PM_REPEAT_MS;
      expect(await w.tick()).toEqual([]);
      expect(w.sent).toEqual([]);
      if (mode === "off") expect(JSON.stringify(w.db.query("SELECT * FROM events").all())).toBe(before);
      expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(mode === "off" ? ["try"] : ["try", "would"]);
    });
  }

  test("发出后到记已送前开关改 off：台账拒写 sent（off 零写），只进本轮 failed，不冒已送", async () => {
    await setMode(w, "on");
    w.send = async (s) => { w.sent.push(s); await setMode(w, "off"); };
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining("记已发失败")]);
    expect(w.sent).toHaveLength(1);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  test("记录后换了 feature PM：不发给旧 PM；30 分钟后按新 PM 发", async () => {
    await setMode(w, "on");
    afterRecord(() => setFeaturePm(w, fid, PM));
    await w.tick();
    expect(w.sent).toEqual([]);
    w.clock += MERGE_PM_REPEAT_MS;
    await w.tick();
    expect(w.sent.map((s) => s.to)).toEqual([PM]);
    expect(kinds()).toEqual([["scheduler", "try", FPM], ["scheduler", "try", PM], ["scheduler", "sent", PM]]);
  });

  test("记录后失租：发送端按存活检查拒发、不记已送；之后的台账写 lease-lost 按原路径抛 SchedulerStopped", async () => {
    await setMode(w, "on");
    w.send = async (s) => { if (!w.lease) throw new Error("服务已不在租约内，不发"); w.sent.push(s); };
    afterRecord(() => { w.lease = false; });
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining("不发")]);
    expect(w.sent).toEqual([]);
    w.clock += MERGE_PM_REPEAT_MS;
    await expect(w.tick()).rejects.toBeInstanceOf(SchedulerStopped);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  test("本功能记账失败只进本轮 failed，不抛、不盖别的错误", async () => {
    await setMode(w, "on");
    const ledger = w.tickEnv().ledger;
    const r = await w.tick({ ledger: async (...a: string[]) => (a.includes("merge-pm") ? { ok: false, code: "internal", error: "坏了" } : ledger(...a)) });
    expect(r).toEqual([{ taskId: c.id, error: "合并待处置提醒记账失败：坏了" }]);
    expect(w.sent).toEqual([]);
  });
});

describe("线 2：没有人工请求时的截图门独立分支（PM 定第 2 点前半）", () => {
  const shot = (id: string, digest: string) =>
    w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?), rev = rev + 1 WHERE id = ?").run(digest, id);

  for (const mode of ["manual", "auto"] as const) {
    test(`${mode} UI 卡未提交请求、审查仍成立、截图摘要变了：提醒重拍 / 核图${mode === "manual" ? " / 提交请求" : "，不叫提交人工请求"}；同一阻塞去重，退 fix 后零提醒`, async () => {
      const u = await mergeCard(w, `U-${mode}`, { ui: true, mode });
      expect(mergePmCandidate(w.db, u.id, w.clock)).toBeNull(); // 截图门通过：不提醒
      shot(u.id, "cd".repeat(32));
      const cand = mergePmCandidate(w.db, u.id, w.clock)!;
      expect([cand.request, cand.reasons, cand.reviewSeq]).toEqual([null, ["ui"], u.reviewSeq]);
      expect(cand.text).toStartWith(`[合并待处置] ${u.id} 当前 head 截图门未过、审查 #${u.reviewSeq} 仍成立（截图门未过）`);
      expect(cand.text).toContain("在当前 head 重拍截图 → PM 核图 / 登记 ui-approve");
      expect(cand.text.includes("manual-merge-request")).toBe(mode === "manual");
      expect(cand.text).not.toContain("cd".repeat(32));
      await setMode(w, "on");
      const before = business(w.db);
      await w.tick();
      expect(w.sent.filter((s) => s.text.includes(u.id)).map((s) => s.to)).toEqual([PM]);
      expect(business(w.db)).toEqual(before);
      w.clock += 10 * MERGE_PM_REPEAT_MS;
      await w.tick();
      expect(w.sent.filter((s) => s.text.includes(u.id))).toHaveLength(1);
      w.db.query("UPDATE tasks SET stage = 'fix', rev = rev + 1 WHERE id = ?").run(u.id);
      expect(mergePmCandidate(w.db, u.id, w.clock)).toBeNull();
    });
  }

  test("未提交请求、截图门不过但审查不成立：不叫 PM（作者 / 审查员的事）；非 UI 卡未提交请求：不提醒", async () => {
    const u = await mergeCard(w, "U-unrev", { ui: true });
    shot(u.id, "cd".repeat(32));
    w.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?").run("ee".repeat(20), u.id);
    expect(mergePmCandidate(w.db, u.id, w.clock)).toBeNull();
    const k = await mergeCard(w, "K-plain");
    expect(mergePmCandidate(w.db, k.id, w.clock)).toBeNull();
  });
});

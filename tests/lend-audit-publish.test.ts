/**
 * dispatch-recovery-PUBFENCE1：写单发布链（推送 → 开 PR → 落交付正文 → 转给 A）每一步发出前都按这张单重核授权 / 本机租约 / journal。
 * 真的 driveLeased、pushWork、ensurePr；git / gh 是假 runner（只记命令、按脚本回结果），A、worker、lend.json 是 lend-harness 的假件，
 * journal 是内存库，推送目录在临时目录。失权都安排在某一步的 await 里面发生：那正是开头核过一次也看不见的地方。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../src/lib/lend-clone.js";
import { driveLeased, workerName } from "../src/lib/lend-drive.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { REVOKED } from "../src/lib/lend-grant.js";
import { advance, getMeta, getOrder, localDay, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { publishFail } from "../src/lib/lend-pr-takeover-retry.js";
import { ensurePr, pushWork } from "../src/lib/lend-push.js";
import { payloadSha } from "../src/lib/lend-submit.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { FP, harness, polled, TEXT, wire } from "./lend-harness.js";

const BR = lendBranch("T93", FP)!;
const BASE = "e".repeat(40);
const H2 = "c".repeat(40);
const OK: BoundedResult = { code: 0, stdout: "", stderr: "", timedOut: false };
type Step = "init" | "fetch" | "rev-parse" | "merge-base" | "ls-remote" | "push" | "pr-list" | "pr-create";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** 一张写单停在「worker 已交活、还没推送」；租约本机截止在 10 分钟后，这一轮不到续租点 */
function publishing(h: ReturnType<typeof harness>, acceptance = ["只推订单分支"]) {
  const now = h.d.now();
  recordAsked(h.db, { orderId: "w1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("w1"), step: "write", pr: null } }, now);
  const order = { ...wire("w1"), node: "write", step: "write", pr: null, acceptance };
  advance(h.db, "w1", "asked", "claimed", { wire: { order, text: TEXT, write: { branch: BR, base: "main" } }, day: localDay(now), leaseGen: 1,
    leaseUntil: now + 600_000, lastBeatAt: now }, now);
  advance(h.db, "w1", "claimed", "cloned", { dir: "/lend/work/w1" }, now);
  const agent = workerName("w1");
  h.registry.set(agent, { sessionId: "s-w1", cwd: "/lend/work/w1" });
  advance(h.db, "w1", "cloned", "started", { agent, sessionId: "s-w1", startedAt: now, submit: "sent", notices: { start: now } }, now);
  advance(h.db, "w1", "started", "result_pending", { work: { head: H2, summary: "实现了 x", selfCheck: "逐条对了" } }, now);
}

/** 真 pushWork / ensurePr 接在假 runner 上；during[步骤] 在那条命令「跑着的时候」调一次，reply[步骤] 换掉它的结果 */
function lab() {
  const h = harness({ entry: { roles: ["review", "write"] } });
  const root = mkdtempSync(join(tmpdir(), "lend-audit-publish-"));
  roots.push(root);
  const steps: Step[] = [];
  const events: string[] = [];
  const during: Partial<Record<Step, () => void>> = {};
  const reply: Partial<Record<Step, BoundedResult[]>> = {};
  const stepOf = (argv: string[]): Step => {
    if (argv[0] === "gh") return argv[2] === "create" ? "pr-create" : "pr-list";
    return (["init", "fetch", "rev-parse", "merge-base", "ls-remote", "push"] as const).find((s) => argv.includes(s))!;
  };
  const run: Run = async (argv) => {
    const step = stepOf(argv);
    steps.push(step);
    if (step === "push" || step === "pr-create") events.push(step);
    await Promise.resolve();
    during[step]?.();
    delete during[step];
    const scripted = reply[step]?.shift();
    if (scripted) return scripted;
    if (step === "rev-parse") return { ...OK, stdout: `${H2}\n` };
    if (step === "pr-create") return { ...OK, stdout: "https://github.com/shawnlu96/claudestra/pull/42\n" };
    return OK;
  };
  const opts = { root, env: {}, run };
  h.d.push.work = (t, gate) => pushWork(t, { ...opts, ...gate });
  h.d.push.pr = (p, gate) => ensurePr(p, { ...opts, ...gate });
  const call = h.d.call;
  h.d.call = (peer, op, body) => { if (op === "result") events.push("result"); return call(peer, op, body); };
  publishing(h);
  const drive = () => driveLeased(getOrder(h.db, "w1")!, h.d);
  const count = (s: Step) => steps.filter((x) => x === s).length;
  const results = () => h.calls.filter((c) => c.op === "result").length;
  const releases = () => h.calls.filter((c) => c.op === "lease" && c.body.action === "release").map((c) => c.body);
  return { h, steps, events, during, reply, drive, count, results, releases, row: () => getOrder(h.db, "w1")! };
}

const revoke = (L: ReturnType<typeof lab>) => () => { L.h.lend.lend = []; };
const facts = (L: ReturnType<typeof lab>) => JSON.parse(getMeta(L.h.db, "publish-facts:w1") ?? "{}") as Record<string, unknown>;

describe("[验收线 1] 发布中途失权：之后的动作零次，已发生的远端事实留档", () => {
  test("[验收线 1] git push 跑着的时候出借方收回授权 → 不开 PR、不转交付；停单原因记着已推送", async () => {
    const L = lab();
    L.during.push = revoke(L);
    await L.drive();
    expect(L.count("push")).toBe(1);
    expect(L.count("pr-list") + L.count("pr-create")).toBe(0);
    expect(L.results()).toBe(0);
    const row = L.row();
    expect(row).toMatchObject({ state: "stopped", payload: null });
    expect(row.reason!.startsWith(REVOKED)).toBe(true);
    expect(row.reason).toContain(`已推送 ${H2.slice(0, 12)} → ${BR}`);
    expect(row.reason).toContain("没开新 PR");
    expect(facts(L)).toMatchObject({ head: H2, branch: BR, push: "done" });
    expect(L.releases()).toHaveLength(1);
    expect(String(L.releases()[0].detail)).toContain("已推送");
  });

  test("[验收线 1] git push 跑着的时候跨过本机租约截止 → 不开 PR、不转交付", async () => {
    const L = lab();
    L.during.push = () => L.h.advanceTime(600_001);
    await L.drive();
    expect(L.count("push")).toBe(1);
    expect(L.count("pr-list") + L.count("pr-create")).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row()).toMatchObject({ state: "stopped", payload: null });
    expect(L.row().reason).toContain("心跳过期");
    expect(L.row().reason).toContain("已推送");
    expect(L.releases()).toEqual([]); // 租约已过：A 那边自己会判，不再发 release
  });

  for (const step of ["fetch", "merge-base"] as const) {
    test(`[验收线 1] 准备阶段（${step}）等待期间收回授权 → git push 零次，没有任何远端事实`, async () => {
      const L = lab();
      L.during[step] = revoke(L);
      await L.drive();
      expect(L.count(step)).toBe(1);
      expect(L.count("push")).toBe(0);
      expect(L.count("pr-create")).toBe(0);
      expect(L.results()).toBe(0);
      expect(L.row().state).toBe("stopped");
      expect(L.row().reason!.startsWith(REVOKED)).toBe(true);
      expect(L.row().reason).not.toContain("已推送");
      expect(facts(L).push).toBeUndefined();
    });
  }

  test("[验收线 1] 准备阶段等待期间跨过本机租约截止 → git push 零次", async () => {
    const L = lab();
    L.during.fetch = () => L.h.advanceTime(600_001);
    await L.drive();
    expect(L.count("push")).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row().state).toBe("stopped");
  });

  test("[验收线 1] 查 PR 的时候收回授权 → 不建 PR、不落交付正文、不转交付", async () => {
    const L = lab();
    L.during["pr-list"] = revoke(L);
    await L.drive();
    expect(L.count("push")).toBe(1);
    expect(L.count("pr-create")).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row()).toMatchObject({ state: "stopped", payload: null, payloadSha: null });
    expect(L.row().reason).toContain("已推送");
  });

  test("[验收线 1] 建 PR 的请求已发出后才收回：撤不回这次请求，但不落正文、不转交付，原因记着 PR 已开", async () => {
    const L = lab();
    L.during["pr-create"] = revoke(L);
    await L.drive();
    expect(L.count("pr-create")).toBe(1);
    expect(L.results()).toBe(0);
    expect(L.row()).toMatchObject({ state: "stopped", payload: null });
    expect(L.row().reason).toContain("PR #42 已开");
    expect(L.row().reason).toContain("没转交付");
    expect(facts(L)).toMatchObject({ push: "done", pr: "done", prNumber: 42 });
  });

  test("[验收线 1] 端口自己不调守卫（假端口）也一样：推送端口的 await 里收回 → PR 端口零次、result 零次", async () => {
    const L = lab();
    let prs = 0;
    L.h.d.push.work = async () => (revoke(L)(), { ok: true });
    L.h.d.push.pr = async () => (prs++, { ok: true, pr: 42 });
    await L.drive();
    expect(prs).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row().state).toBe("stopped");
    expect(L.row().reason).toContain("已推送");
  });

  test("[验收线 1] 交付正文已落、还没转过，这时已失权 → 不发 result", async () => {
    const L = lab();
    L.reply["pr-create"] = [{ ...OK, code: 1, stderr: "HTTP 502" }]; // 这一轮停在开 PR：推送已成
    await L.drive();
    expect(L.row()).toMatchObject({ state: "result_pending", payload: null });
    const payload = { v: 1, orderId: "w1", gen: 1 };
    patchOrder(L.h.db, "w1", ["result_pending"], { payload, payloadSha: payloadSha(JSON.stringify(payload)) }); // 正文落了，进程在转之前退出
    L.h.lend.lend = [];
    await L.drive();
    expect(L.results()).toBe(0);
    expect(L.row().state).toBe("stopped");
  });
});

describe("[验收线 2] 授权稳定时恰好一遍；journal 并发变化拒；结果不明不盲目重发", () => {
  test("[验收线 2] 授权 / 身份 / 租约都稳：恰好 push → PR → result 各一次，acked", async () => {
    const L = lab();
    await L.drive();
    expect(L.events).toEqual(["push", "pr-create", "result"]);
    expect(L.steps).toEqual(["init", "fetch", "rev-parse", "merge-base", "push", "pr-list", "pr-create"]); // 独立推送目录、head / 祖先核对照旧，没多出命令
    expect(L.row().state).toBe("acked");
    expect(h2(L)).toMatchObject({ branch: BR, pr: 42, gen: 1, deliver: { head: H2 } });
  });
  const h2 = (L: ReturnType<typeof lab>) => L.h.calls.find((c) => c.op === "result")!.body;

  test("[验收线 2] 推送期间租约代被别处换了 → 不开 PR、不转交付，这一轮什么都不写", async () => {
    const L = lab();
    L.during.push = () => void patchOrder(L.h.db, "w1", ["result_pending"], { leaseGen: 2 });
    await L.drive();
    expect(L.count("pr-list") + L.count("pr-create")).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row()).toMatchObject({ state: "result_pending", leaseGen: 2, payload: null, reason: null });
    expect(L.h.log.killed).toEqual([]);
  });

  test("[验收线 2] 准备期间订单被别处收尾（状态变了）→ git push 零次，不抛、不改那一行", async () => {
    const L = lab();
    L.during.fetch = () => void advance(L.h.db, "w1", "result_pending", "stopped", { reason: "别处停的" });
    await L.drive();
    expect(L.count("push")).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row()).toMatchObject({ state: "stopped", reason: "别处停的" });
  });

  test("[验收线 2] 推送期间 worker 交的内容被换了 → 不拿旧内容开 PR / 转交付", async () => {
    const L = lab();
    L.during.push = () => void patchOrder(L.h.db, "w1", ["result_pending"], { work: { head: H2, summary: "换了", selfCheck: "逐条对了" } });
    await L.drive();
    expect(L.count("pr-create")).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row().state).toBe("result_pending");
  });

  test("[验收线 2] 推送发出后结果不明（超时）：下一轮先读远端，已经在了就不再推，接着开 PR、转交付", async () => {
    const L = lab();
    L.reply.push = [{ code: null, stdout: "", stderr: "", timedOut: true }];
    await L.drive();
    expect(L.count("push")).toBe(1);
    expect(L.row()).toMatchObject({ state: "result_pending", payload: null });
    expect(facts(L)).toMatchObject({ push: "issued" });
    L.reply["ls-remote"] = [{ ...OK, stdout: `${H2}\trefs/heads/${BR}\n` }];
    await L.drive();
    expect(L.count("ls-remote")).toBe(1);
    expect(L.count("push")).toBe(1); // 没有第二次
    expect(L.events).toEqual(["push", "pr-create", "result"]);
    expect(L.row().state).toBe("acked");
  });

  test("[验收线 2] 结果不明、远端又读不到 → 不盲目重推，留到下一轮；远端确实没有才重推一次", async () => {
    const L = lab();
    L.reply.push = [{ code: null, stdout: "", stderr: "", timedOut: true }];
    await L.drive();
    L.reply["ls-remote"] = [{ ...OK, code: 128, stderr: "fatal: unable to access" }];
    await L.drive();
    expect(L.count("push")).toBe(1);
    expect(L.row()).toMatchObject({ state: "result_pending", payload: null });
    await L.drive(); // 这次远端读得到、还没有这个 head
    expect(L.count("push")).toBe(2);
    expect(L.row().state).toBe("acked");
    expect(L.results()).toBe(1);
  });

  test("[验收线 2] 发布中途读不到授权（lend.json 读失败）→ 不当成仍有权：不开 PR，留到下一轮", async () => {
    const L = lab();
    const read = L.h.d.readLend;
    L.during.push = () => { L.h.d.readLend = async () => { throw new Error("EIO"); }; };
    await L.drive();
    expect(L.count("pr-list") + L.count("pr-create")).toBe(0);
    expect(L.results()).toBe(0);
    expect(L.row()).toMatchObject({ state: "result_pending", payload: null });
    expect(publishFail(L.h.db, "w1")?.reason).toContain("EIO");
    L.h.d.readLend = read;
    await L.drive();
    expect(L.row().state).toBe("acked");
    expect(L.results()).toBe(1);
  });

  test("[验收线 2] 交付说明预检照旧在发布之前：缺『复现测试：』先让 worker 补，这一轮一条 git 命令都不跑", async () => {
    const L = lab();
    const order = { ...L.row().wire!.order, acceptance: ["交付说明写明 复现测试：<测试名>"] };
    patchOrder(L.h.db, "w1", ["result_pending"], { wire: { ...L.row().wire!, order } });
    await L.drive();
    expect(L.steps).toEqual([]);
    expect(L.results()).toBe(0);
    expect(L.h.log.sent.join("\n")).toContain("补写交付说明");
  });

  test("[验收线 2] 已转过一次的交付正文：之后收回了也照旧原字节重发取回执（A 可能已入账）", async () => {
    const L = lab();
    const ok = L.h.A.result;
    L.h.A.result = () => ({ status: 503, body: { ok: false, code: "unavailable", error: "忙" } });
    await L.drive();
    expect(L.row().payload).not.toBeNull();
    L.h.A.result = ok;
    L.h.lend.lend = [];
    await L.drive();
    const sends = L.h.calls.filter((c) => c.op === "result").map((c) => JSON.stringify(c.body));
    expect(sends).toHaveLength(2);
    expect(sends[0]).toBe(sends[1]);
    expect(L.count("push")).toBe(1);
    expect(L.row().state).toBe("acked");
  });
});

test("起点 head 与 harness 一致（推送目标来自 journal）", () => expect(wire("w1").head).toBe(BASE));

describe("[验收线 2] 失败分支：只给这一次发出的请求记结果；旧一代请求的失败不收尾新一代", () => {
  const TIMEOUT: BoundedResult = { code: null, stdout: "", stderr: "", timedOut: true };
  const DENIED: BoundedResult = { ...OK, code: 1, stderr: "remote: Permission to shawnlu96/claudestra.git denied" };
  const regen = (L: ReturnType<typeof lab>) => () => void patchOrder(L.h.db, "w1", ["result_pending"], { leaseGen: 2 });
  const untouched = (L: ReturnType<typeof lab>) => {
    expect(L.row()).toMatchObject({ state: "result_pending", leaseGen: 2, payload: null, reason: null });
    expect(L.h.log.killed).toEqual([]);
    expect(L.releases()).toEqual([]);
    expect(publishFail(L.h.db, "w1")).toBeNull();
    expect(L.results()).toBe(0);
  };

  test("[验收线 2] 上一轮推送结果不明，这一轮停在本机取分支（没发出请求）→ 「已发出、结果不明」原样留着，停单原因和给 A 的说明都带着", async () => {
    const L = lab();
    L.reply.push = [TIMEOUT];
    await L.drive();
    expect(facts(L)).toMatchObject({ push: "issued" });
    L.reply.fetch = [{ ...OK, code: 128, stderr: "fatal: couldn't find remote ref" }];
    await L.drive();
    expect(L.count("push")).toBe(1);
    expect(L.count("ls-remote")).toBe(0);
    expect(facts(L)).toMatchObject({ head: H2, push: "issued" });
    expect(L.row().state).toBe("stopped");
    expect(L.row().reason).toContain("couldn't find remote ref");
    expect(L.row().reason).toContain(`推送已发出、结果不明 ${H2.slice(0, 12)} → ${BR}`);
    expect(L.releases()).toHaveLength(1);
    expect(String(L.releases()[0].detail)).toContain("推送已发出、结果不明");
  });

  test("[验收线 2] 上一轮结果不明，这一轮 head 对不上（同样没发出请求）→ 记录不变", async () => {
    const L = lab();
    L.reply.push = [TIMEOUT];
    await L.drive();
    L.reply["rev-parse"] = [{ ...OK, stdout: `${"d".repeat(40)}\n` }];
    await L.drive();
    expect(L.count("push")).toBe(1);
    expect(facts(L)).toMatchObject({ push: "issued" });
    expect(L.row().reason).toContain("推送已发出、结果不明");
  });

  test("[验收线 2] 上一轮结果不明、这一轮重推被远端明确拒绝 → 拒的是这一次；上一次那个请求仍是结果不明，停单原因两样都带", async () => {
    const L = lab();
    L.reply.push = [TIMEOUT, DENIED];
    await L.drive();
    await L.drive(); // 远端读得到、没有这个 head → 重推一次，被拒
    expect(L.count("ls-remote")).toBe(1);
    expect(L.count("push")).toBe(2);
    expect(facts(L)).toMatchObject({ push: "issued", pushLast: "refused" });
    expect(L.row().state).toBe("stopped");
    expect(L.row().reason).toContain("没有推送权限");
    expect(L.row().reason).toContain("推送已发出、结果不明");
  });

  test("[验收线 2] 上一轮已推送、开 PR 结果不明，这一轮重推被远端明确拒绝 → 已推送不降级，停单原因和给 A 的说明带着已推送和 PR 结果不明", async () => {
    const L = lab();
    L.reply["pr-create"] = [TIMEOUT];
    await L.drive();
    expect(facts(L)).toMatchObject({ push: "done", pr: "issued" });
    expect(L.row()).toMatchObject({ state: "result_pending", payload: null });
    L.reply.push = [DENIED];
    await L.drive();
    expect(L.count("push")).toBe(2);
    expect(L.count("pr-create")).toBe(1);
    expect(L.results()).toBe(0);
    expect(facts(L)).toMatchObject({ head: H2, push: "done", pushLast: "refused", pr: "issued" });
    expect(L.row().state).toBe("stopped");
    for (const said of [L.row().reason!, String(L.releases()[0].detail)]) {
      expect(said).toContain("没有推送权限");
      expect(said).toContain(`已推送 ${H2.slice(0, 12)} → ${BR}`);
      expect(said).toContain("开 PR 的请求已发出、结果不明");
    }
  });

  test("[验收线 2] 上一轮已推送，这一轮重推超时 → 已推送不退回结果不明", async () => {
    const L = lab();
    L.reply["pr-create"] = [TIMEOUT];
    await L.drive();
    L.reply.push = [TIMEOUT];
    await L.drive();
    expect(L.count("push")).toBe(2);
    expect(L.count("pr-create")).toBe(1);
    expect(facts(L)).toMatchObject({ push: "done", pushLast: "issued", pr: "issued" });
    expect(L.row()).toMatchObject({ state: "result_pending", payload: null });
    await L.drive(); // 已确认推送过的不算「结果不明」：不多读远端，照常接着开 PR
    expect(L.count("ls-remote")).toBe(0);
    expect(L.row().state).toBe("acked");
  });

  test("[验收线 2] 上一轮开 PR 结果不明，这一轮再开被远端明确拒绝 → 上一次那个请求仍是结果不明，不记成没开", async () => {
    const L = lab();
    L.reply["pr-create"] = [TIMEOUT, { ...OK, code: 1, stderr: "HTTP 403: permission denied" }];
    await L.drive();
    await L.drive();
    expect(L.count("pr-create")).toBe(2);
    expect(facts(L)).toMatchObject({ push: "done", pr: "issued", prLast: "refused" });
    expect(L.row().state).toBe("stopped");
    expect(L.row().reason).toContain("已推送");
    expect(L.row().reason).toContain("开 PR 的请求已发出、结果不明");
    expect(L.results()).toBe(0);
  });

  test("[验收线 2] 推送超时但半截输出里有 denied 字样 → 仍是结果不明，不当成远端明确拒绝", async () => {
    const L = lab();
    L.reply.push = [{ ...TIMEOUT, stderr: "remote: Permission denied" }];
    await L.drive();
    expect(facts(L)).toMatchObject({ push: "issued" });
    expect(L.row()).toMatchObject({ state: "result_pending", payload: null });
    expect(publishFail(L.h.db, "w1")?.reason).toContain("超时");
  });

  for (const [name, res] of [["没权限（不可重试）", DENIED], ["断网（可重试）", { ...OK, code: 1, stderr: "fatal: unable to access" }]] as const) {
    test(`[验收线 2] 推送期间租约代被换、推送随后失败：${name} → 不停新一代的单、不杀 worker、不 release、不记账`, async () => {
      const L = lab();
      L.during.push = regen(L);
      L.reply.push = [res];
      await L.drive();
      expect(L.count("push")).toBe(1);
      expect(L.count("pr-create")).toBe(0); // 没权限时多出的一条 gh 是 gh auth status（假 runner 归在 pr-list 下），不是查 PR
      untouched(L);
    });
  }

  for (const [name, stderr] of [["没权限（不可重试）", "HTTP 403: permission denied"], ["502（可重试）", "HTTP 502"]] as const) {
    test(`[验收线 2] 建 PR 期间租约代被换、建 PR 随后失败：${name} → 不停新一代的单`, async () => {
      const L = lab();
      L.during["pr-create"] = regen(L);
      L.reply["pr-create"] = [{ ...OK, code: 1, stderr }];
      await L.drive();
      expect(L.count("pr-create")).toBe(1);
      untouched(L);
      expect(facts(L)).toMatchObject({ push: "done" }); // 已完成的远端事实照记
    });
  }

  test("[验收线 2] 推送失败时这一行被别处换了内容（worker 重新交了活）→ 旧失败不记到新内容头上", async () => {
    const L = lab();
    L.during.push = () => void patchOrder(L.h.db, "w1", ["result_pending"], { work: { head: H2, summary: "换了", selfCheck: "逐条对了" } });
    L.reply.push = [DENIED];
    await L.drive();
    expect(L.row()).toMatchObject({ state: "result_pending", reason: null });
    expect(L.h.log.killed).toEqual([]);
    expect(L.releases()).toEqual([]);
  });

  test("[验收线 2] 收尾途中（停 worker 的 await 里）租约代才被换 → 终态不落、不 release", async () => {
    const L = lab();
    L.reply.push = [DENIED];
    const kill = L.h.d.worker.kill;
    L.h.d.worker.kill = async (name) => { const r = await kill(name); regen(L)(); return r; };
    await L.drive();
    expect(L.row()).toMatchObject({ state: "result_pending", leaseGen: 2, reason: null });
    expect(L.releases()).toEqual([]);
  });

  test("[验收线 2] 代没变时失败分支照旧：没权限 → 停单、告诉 A", async () => {
    const L = lab();
    L.reply.push = [DENIED];
    await L.drive();
    expect(L.row().state).toBe("stopped");
    expect(L.row().reason).toContain("没有推送权限");
    expect(L.row().reason).not.toContain("已推送");
    expect(facts(L)).toMatchObject({ push: "refused" });
    expect(L.releases()).toHaveLength(1);
  });
});

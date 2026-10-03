/**
 * i28-RR1 result 同秒重放的回执恢复（src/lib/lend-result-retry.ts 接在 lend-drive.ts forwardResult）。
 * 复现用进程内双实例 lab（tests/lend-lab-kit.ts：A 真台账 + 真 `ledger lend-*`，B 真 lend 循环 + 文件 journal，worker 交结论走真 routeLendTool），
 * 在 B → A 之间加一层「真签名 + 真防重放」：B 每次调用按 `manager lend call` 的办法现签（instance-key.ts signedHeaders，钥匙在临时目录现生成，
 * 时间戳到秒），A 按 bridge/api-auth.ts 的顺序验签（verifySigned → peerSigVerdict）、判重放（真 ReplayCache），拒了回同样的
 * 401 {code:"peer_signature", reason}（等同 E2E 解开的内层响应）。两边共用 lab 的手拨时钟：不拨就是「同一秒」。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { instanceKeySync, SIG_HEADERS, signedHeaders, verifySigned } from "../src/lib/instance-key.js";
import { advance, getOrder, type LendRow } from "../src/lib/lend-journal.js";
import { lendTick } from "../src/lib/lend-loop.js";
import type { LendNoticeParams } from "../src/lib/lend-notice.js";
import { lendRequest, type LendCall, type LendRes } from "../src/lib/lend-remote.js";
import { resultReplayPending } from "../src/lib/lend-result-retry.js";
import { routeLendTool, type LendToolDeps } from "../src/lib/lend-tools.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { peerSigErrorText } from "../src/lib/peer-auth-hints.js";
import { peerSigVerdict, ReplayCache } from "../src/lib/peer-trust.js";
import { harness, sha, toStarted } from "./lend-harness.js";
import { H1, lab, MATE, type Lab } from "./lend-lab-kit.js";

let L: Lab;
afterEach(() => L?.f.close());

interface Sent { op: string; raw: string; ts: string; sig: string; status: number; reason?: string }

/**
 * B → A 的签名链路：B 侧同 manager/lend-call.ts（每次调用现签 POST /api/v1/lend/<op> + 正文原字节），A 侧同 bridge/api-auth.ts 的 peerGate
 * + peerReplayVerdict（非幂等方法同签名只认一次）。过了闸才交给 lab 里 A 的 bridge（真 ledger CLI）。
 */
function signedLink(lb: Lab) {
  const bKey = instanceKeySync(mkdtempSync(join(tmpdir(), "rr1-b-key-")))!;
  const replays = new ReplayCache(undefined, Math.floor(lb.now() / 1000));
  const sent: Sent[] = [];
  const call: LendCall<string> = async (peer, op, body) => {
    const raw = JSON.stringify(body);
    const path = `/api/v1/lend/${op}`;
    const h = signedHeaders("POST", path, raw, bKey, lb.now());
    const ts = h[SIG_HEADERS.ts], sig = h[SIG_HEADERS.sig];
    const note = (status: number, reason?: string) => sent.push({ op, raw, ts, sig, status, ...(reason ? { reason } : {}) });
    const v = peerSigVerdict(verifySigned(bKey.publicKey, { method: "POST", path, ts, sig, body: raw }, lb.now()), true, lb.now());
    const reject = v.allow ? replays.seen(sig, ts, lb.now(), MATE) : v.reason;
    if (reject) {
      note(401, reject);
      return { status: 401, body: { ok: false, error: peerSigErrorText(reject), code: "peer_signature", reason: reject } };
    }
    const out = await lb.aBridge(peer, op, JSON.parse(raw));
    note(out.status);
    return out;
  };
  /** 接到 B 当前这次启动的依赖上（restartB 之后要再接一次）；B 给 owner 的通知另记一份 */
  const notices: LendNoticeParams[] = [];
  const attach = () => Object.assign(lb.b, {
    call, ...(lb.b.v2 ? { v2: { ...lb.b.v2, call } } : {}),
    notify: async (p: LendNoticeParams) => (notices.push(p), { ok: true as const }),
  });
  attach();
  return { call, sent, notices, attach, results: () => sent.filter((s) => s.op === "result") };
}

/** worker 经 MCP 交审查结论（同 lend-lab-kit workerSubmit，只是传输换成签名链路） */
async function submit(lb: Lab, id: string, call: LendCall<string>) {
  const row = getOrder(lb.db, id)!;
  writeFileSync(join(row.dir!, "report.md"), "# 审查报告\n没有问题。");
  const who: CallerIdentity = { agent: row.agent, sessionId: row.sessionId, family: "codex", verified: true };
  const deps: LendToolDeps = { db: lb.db, call: call as LendToolDeps["call"], log: () => {}, now: lb.now };
  const args = { v: 1, orderId: id, head: H1, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" };
  return routeLendTool("submit_verdict", who, args, deps) as Promise<Record<string, any>>;
}

/** T1 走到 B 上 worker 已起、首条派单已发，B → A 换成签名链路 */
async function running() {
  L = await lab();
  await L.toReview();
  await L.passes(5);
  const id = L.orders()[0].orderId;
  expect(L.bState(id)).toBe("started");
  return { id, link: signedLink(L) };
}

const stoppedNotices = (n: LendNoticeParams[]) => n.filter((p) => JSON.stringify(p).includes("stopped"));
const releases = () => L.wire.filter((w) => w.op === "lease" && w.body.action === "release");

describe("i28-RR1 复现：真签名 + 真 ReplayCache + 真工具提交 → drive 转发", () => {
  test("同秒同正文两次 result：第一次 A 入账回回执，第二次 401 peer_signature/replay；B 留在 result_pending、不发停止通知，跨秒重签取回原回执才 acked", async () => {
    const { id, link } = await running();
    const r = await submit(L, id, link.call);
    expect(r).toMatchObject({ ok: true, forwarded: true });
    const seq = r.receipt.eventSeq as number;
    expect(L.bState(id)).toBe("result_pending");

    await lendTick(L.b); // 同一秒：调度服务原字节再发
    const [first, second] = link.results();
    expect(first).toMatchObject({ status: 200 });
    expect(second).toMatchObject({ status: 401, reason: "replay", raw: first.raw, ts: first.ts, sig: first.sig });
    expect(L.bState(id)).toBe("result_pending");
    expect(L.spawned).toHaveLength(1); // worker 交完结论被停（beat 见 A 已结）是原有行为；不再起新的
    expect(stoppedNotices(link.notices)).toEqual([]);
    expect(releases()).toEqual([]);

    await lendTick(L.b); // 再次同秒：仍是 replay，仍保留
    expect(link.results().map((s) => s.status)).toEqual([200, 401, 401]);
    expect(L.bState(id)).toBe("result_pending");

    L.advance(5_000); // 现有调度节奏：下一个 pass
    await lendTick(L.b);
    const all = link.results();
    expect(all).toHaveLength(4); // 每次 drive 最多一发
    const last = all[3];
    expect(last.status).toBe(200);
    expect(last.raw).toBe(first.raw); // 冻结的正文原字节（sha 不变）
    expect(last.ts).not.toBe(first.ts);
    expect(last.sig).not.toBe(first.sig); // 跨秒新请求重新签名，不复用旧 headers
    const row = getOrder(L.db, id)!;
    expect(row.state).toBe("acked");
    expect(row.receipt).toMatchObject({ orderId: id, eventSeq: seq, sha256: row.payloadSha });
    expect(L.reviews()).toHaveLength(1); // A 只入账一次
    expect(L.receipts).toEqual([expect.objectContaining({ orderId: id, outcome: "acked" })]);
    expect(stoppedNotices(link.notices)).toEqual([]);
    expect(releases()).toEqual([]);
    expect(L.spawned).toHaveLength(1);
  });

  test("replay 之后 B 重启（journal 重开）：不再起 worker、不发停止通知，下一轮重签取回原回执", async () => {
    const { id, link } = await running();
    const r = await submit(L, id, link.call);
    expect(r).toMatchObject({ forwarded: true });
    await lendTick(L.b);
    expect(link.results().at(-1)).toMatchObject({ status: 401, reason: "replay" });
    L.restartB();
    link.attach();
    L.advance(5_000);
    await lendTick(L.b);
    expect(getOrder(L.db, id)!.state).toBe("acked");
    expect(getOrder(L.db, id)!.receipt).toMatchObject({ eventSeq: r.receipt.eventSeq });
    expect(L.spawned).toHaveLength(1);
    expect(L.reviews()).toHaveLength(1);
    expect(stoppedNotices(link.notices)).toEqual([]);
  });

  test("replay 之后取回的回执验签不过：照旧不算入账（stopped），不会因为重试路径变成 acked", async () => {
    const { id, link } = await running();
    await submit(L, id, link.call);
    await lendTick(L.b);
    expect(L.bState(id)).toBe("result_pending");
    L.b.verifyReceipt = async () => false;
    L.advance(5_000);
    await lendTick(L.b);
    expect(L.bState(id)).toBe("stopped");
    expect(getOrder(L.db, id)!.reason).toContain("验签没过");
  });
});

/** 收方回的拒绝（lendRequest 解析后的错误） */
async function refusal(status: number, body: unknown, op: "result" | "lease" = "result") {
  const r = (await lendRequest(async () => ({ status, body }), "a", op, {})) as Extract<LendRes<unknown>, { ok: false }>;
  expect(r.ok).toBe(false);
  return r;
}
const sig401 = (reason?: unknown) => ({ ok: false, error: "peer request signature rejected: replay", code: "peer_signature", ...(reason === undefined ? {} : { reason }) });

describe("i28-RR1 分类：只认 result 的 401 peer_signature + reason=replay", () => {
  test("认：result 的 401 peer_signature/replay", async () => {
    expect(resultReplayPending("result", await refusal(401, sig401("replay")))).toBe(true);
  });

  test("不认：别的 op、别的 peer_signature 原因、reason 缺失 / 非字符串、别的状态码、文案里带 replay、409", async () => {
    expect(resultReplayPending("lease", await refusal(401, sig401("replay"), "lease"))).toBe(false);
    for (const reason of ["before_start", "bad", "stale", "unanchored", "full", "invite_expired", "sig_rate_limited"]) {
      expect(resultReplayPending("result", await refusal(401, sig401(reason)))).toBe(false);
    }
    for (const reason of [undefined, 1, null, ["replay"], { replay: true }, "Replay", "replay ", "x".repeat(41)]) {
      expect(resultReplayPending("result", await refusal(401, sig401(reason)))).toBe(false);
    }
    expect(resultReplayPending("result", await refusal(429, sig401("replay")))).toBe(false);
    expect(resultReplayPending("result", await refusal(403, sig401("replay")))).toBe(false);
    expect(resultReplayPending("result", await refusal(401, { ok: false, code: "unauthorized", reason: "replay", error: "replay" }))).toBe(false);
    expect(resultReplayPending("result", await refusal(401, { ok: false, error: "replay detected, peer_signature" }))).toBe(false);
    // 重握手后原样重发被换成的 409（peer-e2e-outbound.ts e2e_duplicate）：通用防重复执行语义，不放松
    expect(resultReplayPending("result", await refusal(409, { ok: false, error: "对方已经处理过这条（回复在路上丢了），不要重发" }))).toBe(false);
    expect(resultReplayPending("result", await refusal(409, { ok: false, code: "conflict", reason: "replay", error: "replay" }))).toBe(false);
  });

  test("传输失败 / 外层错误（manager lend call 的 ok:false）不带 reason，不进取回执分支", async () => {
    const r = (await lendRequest(async () => { throw new Error("e2e_outcome_unknown peer_signature replay"); }, "a", "result", {})) as Extract<LendRes<unknown>, { ok: false }>;
    expect(r).toMatchObject({ code: "transport" });
    expect("reason" in r).toBe(false);
    expect(resultReplayPending("result", r)).toBe(false);
  });
});

describe("i28-RR1 drive 生命周期（假 A）", () => {
  const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
  const replay = { status: 401, body: sig401("replay") };

  test("其它明确拒绝维持原行为：before_start / bad / stale / reason 缺失都按原码停单并告诉 A", async () => {
    for (const reason of ["before_start", "bad", "stale", undefined]) {
      const h = harness();
      await toStarted(h);
      advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
      h.A.result = () => ({ status: 401, body: sig401(reason) });
      await h.tick();
      expect(getOrder(h.db, "o1")!.state).toBe("stopped");
      expect(getOrder(h.db, "o1")!.reason).toContain("peer_signature");
      expect(h.calls.filter((c) => c.op === "lease" && c.body.action === "release").map((c) => c.body.reason)).toEqual(["stopped"]);
    }
  });

  test("租约已过期、结论已持久化：replay 只停 worker、单留着；下一轮取回回执才 acked，不发 stopped", async () => {
    const h = harness();
    await toStarted(h);
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    const real = h.A.result;
    h.A.result = () => replay;
    h.A.lease = () => ({ status: 409, body: { ok: false, v: 1, code: "conflict", error: "done" } });
    h.advanceTime(11 * 60_000);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("result_pending");
    expect(h.log.killed).toEqual([workerName("o1")]);
    expect(h.log.created).toHaveLength(1);
    h.A.result = real;
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("acked");
    expect(h.log.created).toHaveLength(1);
    expect(h.calls.filter((c) => c.op === "lease" && c.body.action === "release")).toEqual([]);
    expect(h.noticeKinds().filter((k) => k.startsWith("stopped"))).toEqual([]);
  });

  test("写单的交付正文已生成：replay 之后不重新推送、不重开 PR，原字节重发取回执", async () => {
    const h = harness();
    await toStarted(h);
    let pushes = 0, prs = 0;
    h.d.push = { ...h.d.push, work: async () => (pushes++, { ok: true }), pr: async (p) => (prs++, { ok: true, pr: p.pr }) };
    const work = { head: "f".repeat(40), summary: "s", selfCheck: "c" };
    advance(h.db, "o1", "started", "result_pending", { work, payload: body, payloadSha: sha(JSON.stringify(body)) } as Partial<LendRow>);
    const real = h.A.result;
    h.A.result = () => replay;
    await h.tick();
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("result_pending");
    h.A.result = real;
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("acked");
    expect([pushes, prs]).toEqual([0, 0]);
    const sent = h.calls.filter((c) => c.op === "result").map((c) => JSON.stringify(c.body));
    expect(new Set(sent)).toEqual(new Set([JSON.stringify(body)]));
    expect(sent).toHaveLength(3);
  });

  test("replay 之后回执的 orderId / sha256 / taskId 对不上：仍不能 acked", async () => {
    for (const bad of [{ orderId: "o2" }, { sha256: "0".repeat(64) }, { taskId: "T94" }]) {
      const h = harness();
      await toStarted(h);
      advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
      const real = h.A.result;
      h.A.result = () => replay;
      await h.tick();
      expect(getOrder(h.db, "o1")!.state).toBe("result_pending");
      h.A.result = (b) => {
        const r = real(b) as { status: number; body: { receipt: Record<string, unknown> } };
        return { status: 200, body: { ...r.body, receipt: { ...r.body.receipt, ...bad } } };
      };
      await h.tick();
      expect(getOrder(h.db, "o1")!.state).toBe("stopped");
    }
  });
});

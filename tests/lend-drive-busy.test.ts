/** agents-LENDBUSY1：A 回 503 busy（台账库写锁等超时）是临时错误：claim 留在 asked 下轮再领，结论留着待取回执下轮原样重发；别的拒绝码照旧。 */
import { describe, expect, test } from "bun:test";
import { transientLendCode, workerName } from "../src/lib/lend-drive.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { advance, getOrder, localDay, recordAsked } from "../src/lib/lend-journal.js";
import { FP, harness, polled, sha, TEXT, toStarted, wire } from "./lend-harness.js";

const BUSY = { status: 503, body: { ok: false, code: "busy", error: "台账库忙(写入等锁超过 5s),稍后重试" } };
const releases = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.op === "lease" && c.body.action === "release");

/** 一张写单停在 result_pending、交付正文已落（推送、开 PR 都做过了） */
function writePending(h: ReturnType<typeof harness>) {
  const now = h.d.now();
  recordAsked(h.db, { orderId: "w1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("w1"), step: "write", pr: null } }, now);
  const order = { ...wire("w1"), node: "write", step: "write", pr: null };
  advance(h.db, "w1", "asked", "claimed", { wire: { order, text: TEXT, write: { branch: lendBranch("T93", FP)!, base: "main" } }, day: localDay(now), leaseGen: 1,
    leaseUntil: now + 600_000, lastBeatAt: now }, now);
  advance(h.db, "w1", "claimed", "cloned", { dir: "/lend/work/w1" }, now);
  const agent = workerName("w1");
  h.registry.set(agent, { sessionId: "s-w1", cwd: "/lend/work/w1" });
  advance(h.db, "w1", "cloned", "started", { agent, sessionId: "s-w1", startedAt: now, submit: "sent", notices: { start: now } }, now);
  const body = { v: 1, orderId: "w1", gen: 1, deliver: { v: 1, orderId: "w1", head: "c".repeat(40), evidence: "https://github.com/shawnlu96/claudestra/pull/1729",
    summary: "实现了 x", selfCheck: "逐条对了", noChange: null }, branch: lendBranch("T93", FP)!, pr: 1729, session: { id: "s-w1", family: "codex" } };
  advance(h.db, "w1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) }, now);
  return body;
}

describe("agents-LENDBUSY1 A 回 busy 下轮再发", () => {
  test("[验收线 1] 审查单：结论第一次 503 busy、第二次收下：不 stopped、不 release，原样重发，回执一份", async () => {
    const h = harness();
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    const ok = h.A.result;
    h.A.result = () => BUSY;
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "result_pending", payload: body, payloadSha: sha(JSON.stringify(body)) });
    expect(h.log.lines.join("\n")).toContain("暂未成功（busy），下轮原样重发");
    h.A.result = ok;
    await h.tick();
    const sent = h.calls.filter((c) => c.op === "result").map((c) => JSON.stringify(c.body));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(getOrder(h.db, "o1")!.state).toBe("acked");
    expect(h.log.receipts.map((r) => r.state)).toEqual(["acked"]);
    expect(releases(h)).toEqual([]);
  });

  test("[验收线 1] 写单：交付第一次 503 busy、第二次收下：payload / PR 原样保留，不 stopped、不 release，回执一份", async () => {
    const h = harness({ entry: { roles: ["review", "write"] } });
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    const body = writePending(h);
    const ok = h.A.result;
    h.A.result = () => BUSY;
    await h.tick();
    expect(getOrder(h.db, "w1")).toMatchObject({ state: "result_pending", payload: body });
    h.A.result = ok;
    await h.tick();
    const sent = h.calls.filter((c) => c.op === "result").map((c) => c.body);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0])).toBe(JSON.stringify(sent[1]));
    expect(sent[1]).toMatchObject({ pr: 1729, deliver: { head: "c".repeat(40) } });
    expect(getOrder(h.db, "w1")!.state).toBe("acked");
    expect(h.log.receipts.map((r) => r.state)).toEqual(["acked"]);
    expect(releases(h)).toEqual([]);
  });

  test("[验收线 2] claim 第一次 busy、第二次成功：留在 asked，最终只领一次，不 declined", async () => {
    const h = harness();
    const ok = h.A.claim;
    h.A.claim = () => BUSY;
    for (let i = 0; i < 4 && !h.calls.some((c) => c.op === "claim"); i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
    expect(h.log.lines.join("\n")).toContain("暂未成功（busy），下轮再试");
    h.A.claim = ok;
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["o1", "o1"]);
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.created).toEqual([workerName("o1")]);
  });

  test("[验收线 3] busy 算临时码；conflict / gone 类等仍不算，结论被 conflict 拒收照旧按码收尾", async () => {
    expect(transientLendCode("busy")).toBe(true);
    for (const c of ["conflict", "cancelled", "lease_expired", "stale_gen", "not_found", "done", "invalid", "denied", "max_open"]) expect(transientLendCode(c)).toBe(false);
    const h = harness();
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    h.A.result = () => ({ status: 409, body: { ok: false, v: 1, code: "conflict", error: "撞了" } });
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("cancelled");
  });
});

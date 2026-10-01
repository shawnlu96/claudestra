/** i28-W4 B 侧 bridge 的出借 worker 派单工具：分流、一单一绑定、各工具（src/lib/lend-tools.ts，接线在 src/bridge/lend-tools.ts） */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { protoKey } from "../src/lib/lend-hello.js";
import { advance, getOrder, openLendJournal, recordAsked, setMeta } from "../src/lib/lend-journal.js";
import { e2eLendCall, isLendCaller, routeLendTool, type LendToolDeps } from "../src/lib/lend-tools.js";
import { markE2eResponse } from "../src/lib/peer-e2e-client.js";
import type { HttpPeer } from "../src/lib/peers.js";

const HEAD = "b".repeat(40);
const AGENT = "agent-lend-0123456789";
const root = mkdtempSync(join(tmpdir(), "lend-tools-"));
type Db = ReturnType<typeof openLendJournal>;

/** started 的一行；工作副本里放好一份 report.md */
function addStarted(db: Db, o: { orderId?: string; agent?: string; step?: string; peer?: string; sessionId?: string } = {}): string {
  const id = o.orderId ?? "t68:s1:r0:review:a0";
  const dir = join(root, `${id.replace(/[^\w]/g, "_")}_${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.md"), "# 审查报告\n正文");
  const write = o.step === "write" || o.step === "fix";
  recordAsked(db, { orderId: id, peer: o.peer ?? "team-a", fp: null, family: "codex", preview: {} }, 0);
  advance(db, id, "asked", "claimed", {
    wire: { order: { v: 1, orderId: id, taskId: "T1", step: o.step ?? "review", head: HEAD }, text: "A 写的派单全文",
      ...(write ? { write: { branch: "lend/t1", base: "main" } } : {}) }, leaseGen: 7 });
  advance(db, id, "claimed", "cloned", { dir });
  advance(db, id, "cloned", "started", { agent: o.agent ?? AGENT, sessionId: o.sessionId ?? "thr-1" });
  return id;
}

const who = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({ agent: AGENT, sessionId: "thr-1", family: "codex", verified: true, ...over });
interface Sent { peer: string; op: string; body: Record<string, unknown>; raw: string }
const sha = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

/** 假出站：记下发了什么；answer 缺省给 result 一张对得上的回执、给 ask 一个 askId */
function fake(db: Db | null, answer?: (s: Sent) => { status: number; body: unknown } | Error) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const deps: LendToolDeps = {
    db, log: (m) => logs.push(m), now: () => 5_000,
    call: async (peer, op, body) => {
      const s = { peer, op, body, raw: JSON.stringify(body) };
      sent.push(s);
      const a = answer?.(s) ?? (op === "ask" ? { status: 200, body: { ok: true, v: 1, askId: "ask_abc123" } }
        : { status: 200, body: { ok: true, v: 1, receipt: { orderId: body.orderId, sha256: sha(s.raw), eventSeq: 42, taskId: "T1", key: "k", sig: "s" } } });
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { deps, sent, logs };
}

const finding = { findingId: "race-1", family: "concurrency", severity: "P1", probe: "跑两遍", description: "会丢" };
const verdict = (orderId: string, over: Record<string, unknown> = {}) => ({
  v: 1, orderId, head: HEAD, verdict: "changes", p0: 0, p1: 1, p2: 0, findings: [finding], reportPath: "report.md", ...over,
});
const code = (r: Record<string, unknown>) => (r.ok === false ? r.code : "ok");

describe("分流：只有出借 worker 进 lend 路由", () => {
  test("agent-lend-* 进；本机 agent / 大总管 / 认不出的不进（落回本机 HANDLERS，行为不变）", () => {
    expect(isLendCaller({ agent: AGENT })).toBe(true);
    expect(isLendCaller({ agent: "agent-lend-x" })).toBe(true);
    for (const agent of ["agent-codex", "agent-task-i28-w4", "master", "lend-agent-x", null]) expect(isLendCaller({ agent })).toBe(false);
  });

  test("order-tools.ts 在 HANDLERS 之前分流，lend 路由拿不到 HANDLERS", () => {
    const src = readFileSync(join(import.meta.dir, "../src/bridge/order-tools.ts"), "utf8");
    const line = src.split("\n").find((l) => l.includes("routeOrderTool(msg.tool"))!;
    expect(line).toMatch(/isLendCaller\(identity\) \? await answerLendTool\(msg\.tool, identity, msg\.args\) : await routeOrderTool\(/);
  });
});

describe("bridge 层拦截与一单一绑定", () => {
  test("未验证 / 被代理降级的连接：一律 identity_unverified，什么都不发", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    const { deps, sent } = fake(db);
    for (const tool of ["take_review", "submit_verdict", "ask"]) {
      expect(code(await routeLendTool(tool, who({ verified: false }), { orderId: id }, deps))).toBe("identity_unverified");
    }
    expect(sent).toEqual([]);
  });

  test("本机 HANDLERS / DAG / PM / 频道类工具：出借 worker 调一律 lend_forbidden", async () => {
    const db = openLendJournal(":memory:");
    addStarted(db);
    const { deps } = fake(db);
    for (const tool of ["plan_feature", "rewrite_dag", "start_node", "show_dag", "reply", "fleet", "check_inbox", "project_info", "", 42]) {
      expect(code(await routeLendTool(tool, who(), {}, deps))).toBe("lend_forbidden");
    }
  });

  test("journal 里没有这个 agent 的活单 / 只有已结束的单 / 没在出借（没有 journal）→ no_order", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    expect(code(await routeLendTool("take_review", who({ agent: "agent-lend-other" }), {}, fake(db).deps))).toBe("no_order");
    advance(db, id, "started", "stopped", { reason: "t" });
    expect(code(await routeLendTool("take_review", who(), {}, fake(db).deps))).toBe("no_order");
    expect(code(await routeLendTool("take_review", who(), {}, fake(null).deps))).toBe("no_order");
  });

  test("参数里的 orderId 对不上 → order_mismatch；会话不是这一行记的 → session_mismatch；一个名字对上两行活单 → 全拒", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    const { deps, sent } = fake(db);
    expect(code(await routeLendTool("submit_verdict", who(), verdict("t68:s9:r0:review:a0"), deps))).toBe("order_mismatch");
    expect(code(await routeLendTool("take_review", who({ sessionId: "thr-other" }), {}, deps))).toBe("session_mismatch");
    expect(code(await routeLendTool("take_review", who({ sessionId: null }), {}, deps))).toBe("session_mismatch");
    addStarted(db, { orderId: "t68:s2:r0:review:a0" });
    expect(code(await routeLendTool("take_review", who(), { orderId: id }, deps))).toBe("binding_conflict");
    expect(sent).toEqual([]);
  });

  test("还没起 worker 的单（cloned）不收", async () => {
    const db = openLendJournal(":memory:");
    recordAsked(db, { orderId: "o9", peer: "team-a", fp: null, family: "codex", preview: {} }, 0);
    advance(db, "o9", "asked", "claimed", { wire: { order: { orderId: "o9", step: "review", head: HEAD }, text: "x" }, leaseGen: 1, agent: AGENT, sessionId: "thr-1" });
    expect(code(await routeLendTool("take_review", who(), {}, fake(db).deps))).toBe("not_started");
  });

  test("步骤认不出的单（不是 review / write / fix）：一律不收", async () => {
    const db = openLendJournal(":memory:");
    addStarted(db, { step: "restate" });
    expect(code(await routeLendTool("take_review", who(), {}, fake(db).deps))).toBe("invalid_order");
  });

  test("工具对步骤：审查单不能 take_order / deliver；写单不能 take_review / submit_verdict，take_order / deliver 在 W8 前明确拒", async () => {
    const review = openLendJournal(":memory:");
    addStarted(review);
    for (const tool of ["take_order", "deliver"]) expect(code(await routeLendTool(tool, who(), {}, fake(review).deps))).toBe("wrong_step");
    const write = openLendJournal(":memory:");
    addStarted(write, { orderId: "t68:s3:r0:write:a0", step: "write" });
    for (const tool of ["take_review", "submit_verdict"]) expect(code(await routeLendTool(tool, who(), {}, fake(write).deps))).toBe("wrong_step");
    for (const tool of ["take_order", "deliver"]) {
      const r = await routeLendTool(tool, who(), {}, fake(write).deps);
      expect(code(r)).toBe("write_closed");
      expect(String(r.error)).toContain("W8");
    }
  });

  test("take_review：返回 journal 里 claim 时的订单原文与 A 的派单全文，不出站", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    const { deps, sent } = fake(db);
    const r = await routeLendTool("take_review", who(), {}, deps);
    expect(r).toEqual({ ok: true, orders: [getOrder(db, id)!.wire!.order], errors: [], brief: "A 写的派单全文" });
    expect(sent).toEqual([]);
  });
});

describe("submit_verdict", () => {
  test("读副本里的报告 → result_pending → 同步转给这一行的 peer；peer / orderId / gen 取自 journal、原字节与记下的 sha256 一致", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db, { peer: "team-b" });
    const { deps, sent } = fake(db);
    const r = await routeLendTool("submit_verdict", who(), verdict(id), deps);
    expect(r).toMatchObject({ ok: true, orderId: id, duplicate: false, forwarded: true, receipt: { eventSeq: 42 } });
    const row = getOrder(db, id)!;
    expect(row.state).toBe("result_pending");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ peer: "team-b", op: "result", body: { v: 1, orderId: id, gen: 7, report: "# 审查报告\n正文" } });
    expect(sha(sent[0].raw)).toBe(row.payloadSha!);
  });

  test("重复提交同一正文：幂等、不写第二次、原字节再转一次拿回原回执；换了正文拒且不出站", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    const { deps, sent } = fake(db);
    const first = await routeLendTool("submit_verdict", who(), verdict(id), deps);
    const at = getOrder(db, id)!.updatedAt;
    const again = await routeLendTool("submit_verdict", who(), verdict(id), deps);
    expect(again).toMatchObject({ ok: true, duplicate: true, sha256: (first as Record<string, unknown>).sha256, forwarded: true });
    expect(getOrder(db, id)!.updatedAt).toBe(at);
    expect(sent[1].raw).toBe(sent[0].raw);
    const other = await routeLendTool("submit_verdict", who(), verdict(id, { verdict: "block" }), deps);
    expect(code(other)).toBe("submit_refused");
    expect(sent).toHaveLength(2);
  });

  test("软链报告、超过 64 KiB、副本外路径：拒，journal 不动、不出站", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    const dir = getOrder(db, id)!.dir!;
    writeFileSync(join(root, "secret.txt"), "SECRET");
    symlinkSync(join(root, "secret.txt"), join(dir, "evil.md"));
    writeFileSync(join(dir, "big.md"), "x".repeat(64 * 1024 + 1));
    const { deps, sent } = fake(db);
    for (const reportPath of ["evil.md", "big.md", join(root, "secret.txt"), "../secret.txt"]) {
      const r = await routeLendTool("submit_verdict", who(), verdict(id, { reportPath }), deps);
      expect(code(r)).toBe("bad_report");
      expect(JSON.stringify(r)).not.toContain("SECRET");
    }
    expect(getOrder(db, id)!.state).toBe("started");
    expect(sent).toEqual([]);
  });

  test("head 不是这张单的 / 参数多了字段（想塞 peer、gen）/ 计数对不上：都拒", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    const { deps, sent } = fake(db);
    expect(code(await routeLendTool("submit_verdict", who(), verdict(id, { head: "c".repeat(40) }), deps))).toBe("head_mismatch");
    expect(code(await routeLendTool("submit_verdict", who(), verdict(id, { peer: "team-x", gen: 99 }), deps))).toBe("invalid_verdict");
    expect(code(await routeLendTool("submit_verdict", who(), verdict(id, { p1: 0 }), deps))).toBe("invalid_verdict");
    expect(sent).toEqual([]);
  });

  test("同步转发没成（传输失败 / A 拒 / 回执对不上）：结论照样记下，回 forwarded:false，交调度服务原字节重发", async () => {
    const answers = [
      () => new Error("对方不是端到端加密的 peer"),
      () => ({ status: 409, body: { ok: false, code: "lease_lost", error: "租约没了" } }),
      () => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: "x", sha256: "0".repeat(64), eventSeq: 1, taskId: "T1", key: "k", sig: "s" } } }),
    ];
    for (const answer of answers) {
      const db = openLendJournal(":memory:");
      const id = addStarted(db);
      const { deps, logs } = fake(db, answer);
      const r = await routeLendTool("submit_verdict", who(), verdict(id), deps);
      expect(r).toMatchObject({ ok: true, forwarded: false });
      expect(getOrder(db, id)!.state).toBe("result_pending");
      expect(logs.length).toBe(1);
    }
  });
});

describe("ask", () => {
  test("A 是 proto 1 / 没协商：明确回 peer_no_ask，不出站", async () => {
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    const { deps, sent } = fake(db);
    expect(code(await routeLendTool("ask", who(), { v: 1, orderId: id, question: "这里要不要管并发？" }, deps))).toBe("peer_no_ask");
    setMeta(db, protoKey("team-a"), "1");
    expect(code(await routeLendTool("ask", who(), { v: 1, orderId: id, question: "这里要不要管并发？" }, deps))).toBe("peer_no_ask");
    expect(sent).toEqual([]);
  });

  test("A 是 proto 2：转 lend/ask，orderId / gen 取自 journal，回 askId；写单也能问", async () => {
    for (const step of ["review", "write"]) {
      const db = openLendJournal(":memory:");
      const id = addStarted(db, { step, orderId: `t68:s4:r0:${step}:a0` });
      setMeta(db, protoKey("team-a"), "2");
      const { deps, sent } = fake(db);
      expect(await routeLendTool("ask", who(), { v: 1, orderId: id, question: "要不要管并发？", options: ["要", "不要"] }, deps)).toEqual({ ok: true, askId: "ask_abc123" });
      expect(sent).toEqual([{ peer: "team-a", op: "ask", body: { v: 1, orderId: id, gen: 7, question: "要不要管并发？", options: ["要", "不要"] }, raw: expect.any(String) }]);
    }
  });

  test("proto 2 但对方没这个接口（404 / 403 messages_only）→ peer_no_ask；传输失败 → ask_failed（不静默）；问题不合格 → invalid_ask", async () => {
    const cases: [() => { status: number; body: unknown } | Error, string][] = [
      [() => ({ status: 404, body: null }), "peer_no_ask"],
      [() => ({ status: 403, body: { ok: false, code: "messages_only", error: "x" } }), "peer_no_ask"],
      [() => new Error("超时"), "ask_failed"],
    ];
    for (const [answer, want] of cases) {
      const db = openLendJournal(":memory:");
      const id = addStarted(db);
      setMeta(db, protoKey("team-a"), "2");
      expect(code(await routeLendTool("ask", who(), { v: 1, orderId: id, question: "问？" }, fake(db, answer).deps))).toBe(want);
    }
    const db = openLendJournal(":memory:");
    const id = addStarted(db);
    setMeta(db, protoKey("team-a"), "2");
    expect(code(await routeLendTool("ask", who(), { v: 1, orderId: id, question: "" }, fake(db).deps))).toBe("invalid_ask");
  });
});

describe("出站只走 E2E（e2eLendCall）", () => {
  const peer: HttpPeer = { name: "team-a", baseUrl: "https://a.example", outToken: "out-tok", publicKey: "pk", e2e: { fp: "f" } } as unknown as HttpPeer;
  const ports = (peers: HttpPeer[], post: (url: string) => Response, env: Record<string, string> = {}) => {
    const urls: string[] = [];
    return { urls, call: e2eLendCall({ peers: async () => peers, post: async (url) => (urls.push(url), post(url)), env, timeoutMs: 1_000 }) };
  };
  const e2eOk = () => markE2eResponse(new Response(JSON.stringify({ ok: true, v: 1, askId: "ask_1" }), { status: 200 }));

  test("合格的 E2E peer：发到 /api/v1/lend/<op>，应答是 E2E 的才认", async () => {
    const { urls, call } = ports([peer], e2eOk);
    expect(await call("team-a", "ask", { v: 1 })).toEqual({ status: 200, body: { ok: true, v: 1, askId: "ask_1" } });
    expect(urls).toEqual(["https://a.example/api/v1/lend/ask"]);
  });

  test("没有 E2E 记录 / 没钉钥 / 已禁用 / 环境里有代理：一个字节都不发；应答不是 E2E 回来的：当没到", async () => {
    const legacy = [{ ...peer, e2e: undefined }, { ...peer, publicKey: undefined }, { ...peer, disabled: true }] as HttpPeer[];
    for (const p of legacy) {
      const { urls, call } = ports([p], e2eOk);
      await expect(call("team-a", "result", { v: 1 })).rejects.toThrow();
      expect(urls).toEqual([]);
    }
    const proxied = ports([peer], e2eOk, { HTTPS_PROXY: "http://p:1" });
    await expect(proxied.call("team-a", "result", { v: 1 })).rejects.toThrow("代理");
    expect(proxied.urls).toEqual([]);
    const plain = ports([peer], () => new Response("{}", { status: 200 }));
    await expect(plain.call("team-a", "result", { v: 1 })).rejects.toThrow("端到端");
  });
});

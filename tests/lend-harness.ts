/** lend 循环的假依赖（tests/lend-loop.test.ts、tests/lend-health.test.ts 共用）：A 与 worker 都是假的，时钟手拨。 */
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import type { LendEntry } from "../src/lib/lend-config.js";
import type { CodexFailureSeen, QuotaView } from "../src/lib/lend-health.js";
import { getOrder, openLendJournal, type LendRow } from "../src/lib/lend-journal.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import type { LendOp } from "../src/lib/lend-remote.js";
import type { HttpPeer } from "../src/lib/peers.js";
import type { WorkerLiveness } from "../src/lib/worker-liveness.js";

export const HEAD = "e".repeat(40);
export const FP = "abcd-ef01-2345-6789";
export const ENTRY: LendEntry = { peer: "team-a", fp: FP, families: { codex: 2 }, roles: ["review"], repos: ["shawnlu96/claudestra"],
  quota: { ordersPerDay: 5, tokensPerDay: null }, confirm: "per-order" };
const PEER = { name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://abcd", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
export const TEXT = "【调度派单】T93 · review";
export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const polled = (orderId = "o1") => ({ orderId, taskId: "T93", step: "review", family: "codex", repo: "shawnlu96/claudestra", pr: 270, head: HEAD, round: 1, specRev: 1, offeredAt: 1 });
export const wire = (orderId = "o1") => ({ v: 1, orderId, taskId: "T93", specRev: 1, dagVersion: null, node: "R3", step: "review", round: 1, head: HEAD,
  repo: "shawnlu96/claudestra", pr: 270, inputs: ["规格"], outputs: ["报告"], acceptance: ["验收"], writeBack: "submit_verdict", findings: [], fallback: null });

/** 限时预先授权（specRev 2）：auto 必须带 until 才算数；harness 的时钟从 1970 年开始，2100 年远在未来 */
export const AUTO = { confirm: "auto", until: "2100-01-01T00:00:00.000Z" } as const;

type Reply = { status: number; body: unknown } | "throw";

export function harness(opts: { entry?: Partial<LendEntry>; peer?: Partial<HttpPeer>; env?: Record<string, string> } = {}) {
  const db = openLendJournal(":memory:");
  let t = 1_000_000;
  const calls: { op: LendOp; body: Record<string, unknown> }[] = [];
  const A: Record<LendOp, (b: Record<string, unknown>) => Reply> = {
    poll: () => ({ status: 200, body: { ok: true, v: 1, orders: [polled()], pollAfterMs: 30_000 } }),
    claim: (b) => ({ status: 200, body: { ok: true, v: 1, order: wire(String(b.orderId)), text: TEXT, sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } }),
    lease: (b) => ({ status: 200, body: { ok: true, v: 1, lease: b.action === "renew" ? { gen: 1, expiresAt: 0, ms: 600_000 } : null } }),
    result: (b) => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: b.orderId, sha256: sha(JSON.stringify(b)), eventSeq: 9, taskId: "T93", key: "k", sig: "s" } } }),
  };
  const asks = new Map<string, "waiting" | "approved" | "declined">();
  const registry = new Map<string, { sessionId?: string; cwd?: string }>();
  const log = { created: [] as string[], sent: [] as string[], killed: [] as string[], removed: [] as string[], receipts: [] as LendRow[], asksOpened: 0, informs: [] as string[],
    closedAsks: [] as string[], lines: [] as string[] };
  /** 存活探测的覆盖值（按 agent 名）；没设 = registry 里有就 running、没有就 no_window */
  const liveness = new Map<string, WorkerLiveness>();
  const failures = new Map<string, CodexFailureSeen>();
  const health = { quota: null as QuotaView | null, closeOk: true };
  const inform = { ok: true, delayMs: 0 };
  const entry = { ...ENTRY, ...opts.entry };
  const d: LoopDeps = {
    db, now: () => t, env: opts.env ?? {}, footer: () => "（交结论的办法）", log: (m) => void log.lines.push(m),
    failure: (agent) => failures.get(agent),
    closeAsks: async (agent) => (health.closeOk ? (log.closedAsks.push(agent), { ok: true }) : { ok: false, error: "台账忙" }),
    codexQuota: async () => health.quota,
    call: async (_peer, op, body) => {
      calls.push({ op, body });
      const r = A[op](body);
      if (r === "throw") throw new Error("网络断了");
      return r;
    },
    readLend: async () => ({ status: "ok", file: { version: 1, enabled: true, lend: [entry], borrow: [] } }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }),
    peers: async () => [{ ...PEER, ...opts.peer } as HttpPeer],
    ask: {
      open: async (p) => { log.asksOpened++; if (!asks.has(`ask-${p.orderId}`)) asks.set(`ask-${p.orderId}`, "waiting"); return { ok: true, askId: `ask-${p.orderId}` }; },
      inform: async (p) => { t += inform.delayMs; inform.delayMs = 0; if (!inform.ok) return { ok: false, error: "bridge 不在" }; log.informs.push(p.orderId); return { ok: true }; },
      verdict: (id) => { const s = asks.get(id) ?? "declined"; return s === "declined" ? { state: "declined", reason: "不批" } : { state: s }; },
    },
    clone: async (i) => ({ ok: true, dir: `/lend/work/${i.orderId}` }),
    removeDir: (id) => void log.removed.push(id),
    selfFp: () => FP, identity: () => ({ name: "lender", email: "lender@example.invalid" }),
    push: { probe: async () => ({ ok: true }), work: async () => ({ ok: true }), pr: async (p) => ({ ok: true, pr: p.pr }) },
    verifyReceipt: async () => true,
    writeReceipt: async (row) => void log.receipts.push(row),
    worker: {
      find: (n) => registry.get(n),
      create: async (n, dir) => { log.created.push(n); registry.set(n, { sessionId: "thr-1", cwd: dir }); return { ok: true }; },
      send: async (_n, _s, text) => { log.sent.push(text); return { ok: true, messageId: "m1" }; },
      kill: async (n) => { log.killed.push(n); registry.delete(n); return { ok: true }; },
      alive: async (n) => liveness.get(n) ?? (registry.has(n) ? "running" : "no_window"),
    },
  };
  return { db, d, A, asks, registry, log, calls, inform, liveness, failures, health, tick: () => lendTick(d), advanceTime: (ms: number) => { t += ms; }, ops: () => calls.map((c) => c.op) };
}

/** 一路走到 started（首条派单已发） */
export async function toStarted(h: ReturnType<typeof harness>) {
  await h.tick();
  h.asks.set("ask-o1", "approved");
  for (let i = 0; i < 4; i++) await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("started");
}

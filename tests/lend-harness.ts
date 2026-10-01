/**
 * lend 循环的假依赖（tests/lend-loop.test.ts、tests/lend-health.test.ts、tests/lend-revoke.test.ts 等共用）：A、worker、通知都是假的，时钟手拨，
 * lend.json 是内存里的一份 v2 文件（h.lend 可以就地改：收回 = 清掉 lend[]）。
 */
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import type { LendEntry, LendFile } from "../src/lib/lend-config.js";
import type { LendNoticeParams } from "../src/lib/lend-notice.js";
import type { CodexFailureSeen, QuotaView } from "../src/lib/lend-health.js";
import { getOrder, openLendJournal, type LendRow } from "../src/lib/lend-journal.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import type { LendOp } from "../src/lib/lend-remote.js";
import type { HttpPeer } from "../src/lib/peers.js";
import type { WorkerLiveness } from "../src/lib/worker-liveness.js";

export const HEAD = "e".repeat(40);
export const FP = "abcd-ef01-2345-6789";
/** harness 的时钟从 T0 开始；授权 6 天后到期（上限 7 天） */
const T0 = 1_000_000;
export const ENTRY: LendEntry = { peer: "team-a", fp: FP, families: { codex: 2 }, roles: ["review"], repos: ["shawnlu96/claudestra"],
  ordersPerDay: 5, grantedAt: new Date(T0).toISOString(), until: new Date(T0 + 6 * 86_400_000).toISOString() };
const PEER = { name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://abcd", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
export const TEXT = "【调度派单】T93 · review";
export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const polled = (orderId = "o1") => ({ orderId, taskId: "T93", step: "review", family: "codex", repo: "shawnlu96/claudestra", pr: 270, head: HEAD, round: 1, specRev: 1, offeredAt: 1 });
export const wire = (orderId = "o1") => ({ v: 1, orderId, taskId: "T93", specRev: 1, dagVersion: null, node: "R3", step: "review", round: 1, head: HEAD,
  repo: "shawnlu96/claudestra", pr: 270, inputs: ["规格"], outputs: ["报告"], acceptance: ["验收"], writeBack: "submit_verdict", findings: [], fallback: null });

type Reply = { status: number; body: unknown } | "throw";

export function harness(opts: { entry?: Partial<LendEntry>; peer?: Partial<HttpPeer>; env?: Record<string, string>; writeOpen?: boolean } = {}) {
  const db = openLendJournal(":memory:");
  let t = T0;
  const calls: { op: LendOp; body: Record<string, unknown> }[] = [];
  const A: Record<LendOp, (b: Record<string, unknown>) => Reply> = {
    poll: () => ({ status: 200, body: { ok: true, v: 1, orders: [polled()], pollAfterMs: 30_000 } }),
    claim: (b) => ({ status: 200, body: { ok: true, v: 1, order: wire(String(b.orderId)), text: TEXT, sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } }),
    lease: (b) => ({ status: 200, body: { ok: true, v: 1, lease: b.action === "renew" ? { gen: 1, expiresAt: 0, ms: 600_000 } : null } }),
    result: (b) => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: b.orderId, sha256: sha(JSON.stringify(b)), eventSeq: 9, taskId: "T93", key: "k", sig: "s" } } }),
  };
  /** 逐单确认已退役：只留着让旧用例里的 asks.set 无害（不再有人读） */
  const asks = new Map<string, "waiting" | "approved" | "declined">();
  const registry = new Map<string, { sessionId?: string; cwd?: string }>();
  const log = { created: [] as string[], sent: [] as string[], killed: [] as string[], removed: [] as string[], receipts: [] as LendRow[],
    notices: [] as LendNoticeParams[], retired: [] as string[], closedAsks: [] as string[], lines: [] as string[] };
  /** 存活探测的覆盖值（按 agent 名）；没设 = registry 里有就 running、没有就 no_window */
  const liveness = new Map<string, WorkerLiveness>();
  const failures = new Map<string, CodexFailureSeen>();
  const health = { quota: null as QuotaView | null, closeOk: true };
  /** 通知通道：ok=false 模拟 bridge 没收下；delayMs = 发通知这一下花掉的时间；onSend 在发出时调（模拟这段工夫里收回授权） */
  const inform = { ok: true, delayMs: 0, onSend: null as (() => void) | null };
  const lend: LendFile = { version: 2, enabled: true, lend: [{ ...ENTRY, ...opts.entry }], borrow: [] };
  const d: LoopDeps = {
    db, now: () => t, env: opts.env ?? {}, footer: () => "（交结论的办法）", log: (m) => void log.lines.push(m), writeOpen: opts.writeOpen,
    failure: (agent) => failures.get(agent),
    closeAsks: async (agent) => (health.closeOk ? (log.closedAsks.push(agent), { ok: true }) : { ok: false, error: "台账忙" }),
    codexQuota: async () => health.quota,
    call: async (_peer, op, body) => {
      calls.push({ op, body });
      const r = A[op](body);
      if (r === "throw") throw new Error("网络断了");
      return r;
    },
    readLend: async () => ({ status: "ok", file: structuredClone(lend) }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }),
    peers: async () => [{ ...PEER, ...opts.peer } as HttpPeer],
    notify: async (p) => {
      t += inform.delayMs;
      inform.delayMs = 0;
      inform.onSend?.();
      inform.onSend = null;
      if (!inform.ok) return { ok: false, error: "bridge 不在" };
      log.notices.push(p);
      return { ok: true };
    },
    retireAsk: async (id) => (log.retired.push(id), { ok: true }),
    clone: async (i) => ({ ok: true, dir: `/lend/work/${i.orderId}` }),
    removeDir: (id) => void log.removed.push(id),
    selfFp: () => FP, identity: () => ({ name: "lender", email: "lender@example.invalid" }),
    push: { probe: async () => ({ ok: true }), work: async () => ({ ok: true }), pr: async (p) => ({ ok: true, pr: p.pr }) },
    verifyReceipt: async () => true,
    writeReceipt: async (row) => void log.receipts.push(row),
    worker: {
      find: (n) => registry.get(n),
      create: async (n, dir, _purpose, gate) => { // 同生产：真正起进程前最后过一次闸门
        const denied = await gate();
        if (denied) return { ok: false, error: denied };
        log.created.push(n); registry.set(n, { sessionId: "thr-1", cwd: dir }); return { ok: true }; },
      send: async (_n, _s, text) => { log.sent.push(text); return { ok: true, messageId: "m1" }; },
      kill: async (n) => { log.killed.push(n); registry.delete(n); return { ok: true }; },
      alive: async (n) => liveness.get(n) ?? (registry.has(n) ? "running" : "no_window"),
    },
  };
  return { db, d, A, asks, registry, log, calls, inform, liveness, failures, health, lend, tick: () => lendTick(d), advanceTime: (ms: number) => { t += ms; },
    ops: () => calls.map((c) => c.op), noticeKinds: () => log.notices.map((n) => `${n.kind}:${n.orderId}`) };
}

/** 一路走到 started（首条派单已发）：poll → claim → clone → 开跑通知 + 起 worker → 首条派单 */
export async function toStarted(h: ReturnType<typeof harness>) {
  for (let i = 0; i < 5; i++) await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("started");
}

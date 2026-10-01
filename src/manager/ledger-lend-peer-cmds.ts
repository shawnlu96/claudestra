/**
 * `ledger lend-*` for lend protocol v2 (i28-W2, docs/design/remote-capacity.md §3):
 * - bridge only (owner identity, local-api/lend.ts and bridge/lend-dispatch.ts via runManager):
 *   lend-hello / lend-beat `-- <peer> <json>` take a lender's hello / batched beat; lend-pushed `-- <peer> <json>` records what
 *   the lender answered to a push (accepted → acknowledged, refused → withdrawn now).
 * - lend-peers [--peer <name>]: read-only, each borrow peer's protocol, hello age and placeable slots per family (scheduler / PM).
 * Built by ledger-lend-cmds.ts with its deps / notice helpers passed in (no runtime import back). tests/ledger-lend-peers.test.ts.
 */
import { lendRepoUrl } from "../lib/lend-git.js";
import { parseV2Request, parseV2Response, helloAnswer, V2_BODY_VERSION, type BeatRequest } from "../lib/lend-wire-v2.js";
import { refuse, sweepLend, type LendNotice } from "../lib/ledger-lend.js";
import { answerPush, beatLend, cleanEndedWrites, peerCapacity, recordHello, type CleanCheck } from "../lib/ledger-lend-peers.js";
import { LedgerError } from "../lib/ledger-store.js";
import { runBounded } from "../lib/run-bounded.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { LendCliDeps } from "./ledger-lend-cmds.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Where an order branch stands on the remote: absent, at a head, or null when it could not be told. */
export type BranchState = "absent" | { head: string } | null;

async function realBranchState(repo: string, branch: string): Promise<BranchState> {
  const r = await runBounded(["git", "ls-remote", lendRepoUrl(repo), `refs/heads/${branch}`], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 15_000 });
  if (r.timedOut || r.code !== 0) return null;
  const rows = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/));
  if (!rows.length) return "absent";
  const hit = rows.length === 1 && rows[0][1] === `refs/heads/${branch}` && /^[0-9a-f]{40}$/.test(rows[0][0] ?? "") ? rows[0][0] : null;
  return hit ? { head: hit } : null;
}

interface Helpers { deps(c: LedgerCli): LendCliDeps; tell(c: LedgerCli, notices: LendNotice[]): Promise<number> }

const PEER_RE = /^[\p{L}\p{N}_.-]{1,64}$/u;

/** `-- <peer> <json>` from the bridge, owner only; the body is JSON or the call is refused as invalid. */
function bridgeArgs(c: LedgerCli, cmd: string): { peer: string; body: unknown } {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", `${cmd} 只给 bridge 用（以 owner 身份调）`);
  const [, peer, raw] = c.p.pos;
  if (!peer || !PEER_RE.test(peer)) throw new LedgerError("invalid", "peer 名不合法");
  try {
    return { peer, body: JSON.parse(raw ?? "") };
  } catch {
    return refuse("invalid", "请求体不是合法 JSON");
  }
}

async function hello(c: LedgerCli, h: Helpers): Promise<Result> {
  const { peer, body } = bridgeArgs(c, "lend-hello");
  const req = parseV2Request("hello", body);
  if (!req.ok) return refuse("invalid", req.error);
  const fp = await h.deps(c).result.peerFp?.(peer) ?? null;
  // 旧的 hello（同一启动号、序号没涨）照样回应答但不入账；回包只能是这几个字段：bridge 只剥 ok / notified，多一个对方的严格解析就拒
  recordHello(c.db, peer, fp, req.value, c.deps.now());
  return { ok: true, v: V2_BODY_VERSION, ...helloAnswer() };
}

/**
 * A clean revocation of a write order counts only if A sees the order branch unpushed: absent (build orders) or still at the
 * head the order started from. Anything else, including a remote that cannot be read, is not clean.
 */
async function writeChecks(c: LedgerCli, h: Helpers, peer: string, req: BeatRequest): Promise<Map<string, CleanCheck>> {
  const state = h.deps(c).branchState ?? realBranchState;
  const out = new Map<string, CleanCheck>();
  for (const o of cleanEndedWrites(c.db, peer, req)) {
    const s = await state(o.repo, o.branch as string);
    const clean = s !== null && ((s === "absent" && o.step === "write") || (s !== "absent" && s.head === o.head));
    out.set(o.orderId, s === null ? "unknown" : clean ? "clean" : "dirty");
  }
  return out;
}

async function beat(c: LedgerCli, h: Helpers): Promise<Result> {
  const { peer, body } = bridgeArgs(c, "lend-beat");
  const req = parseV2Request("beat", body);
  if (!req.ok) return refuse("invalid", req.error);
  const notified = await h.tell(c, sweepLend(c.db, c.ctx()));
  const checks = await writeChecks(c, h, peer, req.value);
  const r = beatLend(c.db, c.ctx(), peer, req.value, checks);
  return { ok: true, v: V2_BODY_VERSION, orders: r.orders, notified: notified + (await h.tell(c, r.notices)) };
}

/** What a lender answered to one push, parsed exactly as the bridge received it; only this peer's pooled orders are touched. */
async function pushed(c: LedgerCli, h: Helpers): Promise<Result> {
  const { peer, body } = bridgeArgs(c, "lend-pushed");
  const r = parseV2Response("offer", body);
  if (!r.ok) return refuse("invalid", r.error);
  const { acked, notices, withdrawn } = answerPush(c.db, c.ctx(), peer, r.value);
  return { ok: true, acked, withdrawn, notified: await h.tell(c, notices) };
}

async function peers(c: LedgerCli, h: Helpers): Promise<Result> {
  const only = c.p.flags.peer;
  const now = c.deps.now();
  const list = (await h.deps(c).borrow()).filter((b) => !only || b.peer === only);
  return { ok: true, peers: list.map((b) => ({ ...peerCapacity(c.db, b.peer, b.maxOpen, now), maxOpen: b.maxOpen })) };
}

export function lendPeerCmds(h: Helpers): Record<string, CommandSpec> {
  return {
    "lend-hello": { valued: [], usage: "lend-hello -- <peer> <json>（bridge 专用：出借方报容量和授权）", run: (c) => hello(c, h) },
    "lend-beat": { valued: [], usage: "lend-beat -- <peer> <json>（bridge 专用：出借方批量心跳兼续租）", run: (c) => beat(c, h) },
    "lend-pushed": { valued: [], usage: "lend-pushed -- <peer> <json>（bridge 专用：推送的应答，接收的记确认，拒收的撤回）", run: (c) => pushed(c, h) },
    "lend-peers": { valued: ["peer"], usage: "lend-peers [--peer <名>]（各出借方的协议版本、hello 新鲜度和可放的单数）", run: (c) => peers(c, h) },
  };
}

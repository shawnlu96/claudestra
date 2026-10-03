/**
 * `manager lend inbox -- <peer> <fp> <正文>`：出借方 B 收 A 推来的单（POST /api/v1/lend/offer，bridge/local-api/lend-inbox.ts 鉴完权后调）。
 * 只认 bridge：以 owner 身份跑（没有频道号），也不是出借 worker（不带 LEND_WORKER_MARK）。不拿命令级写锁（不在 write-commands.ts 的
 * WRITE_SUBCOMMANDS 里）：它只写 lend journal，不写 lend.json；拿了锁，restart-all 期间收单会多等 20 秒，超过 A 那边的发送超时。
 * bridge 已核过 peer token + E2E + 钉钥 + 签名，这里再核一遍：peer 名、peer 记录（peerLendProblem），以及 fp 正是这个 peer 钉在 peers.json 的公钥指纹。
 * 核对不过、没有授权、位满了一律回 ok + refused 码（A 立刻撤回重排），收单闸在 lib/lend-inbox.ts。tests/lend-inbox-cli.test.ts。
 */
import { keyFingerprint } from "../lib/instance-key.js";
import { primeInboxClaude, type InboxClaude } from "../lib/lend-claude-ready.js";
import { admitOrders, type Admitted } from "../lib/lend-inbox.js";
import { readLend } from "../lib/lend-config.js";
import type { LendDeps } from "../lib/lend-drive.js";
import { openLendJournal } from "../lib/lend-journal.js";
import { readLendContext } from "../lib/lend-policy.js";
import { peerLendProblem } from "../lib/lend-remote.js";
import { LEND_BODY_MAX } from "../lib/lend-wire.js";
import { parseV2Request } from "../lib/lend-wire-v2.js";
import { findHttpPeer, type HttpPeer } from "../lib/peers.js";
import { FP_RE } from "../lib/relay-protocol.js";
import { LEND_WORKER_MARK } from "../lib/runtimes/clean-env.js";
import { output } from "./core.js";

const USAGE = "usage: lend inbox -- <peer> <fp> <json>（bridge 专用：收发起方推来的单）";
/** 同 lend-config.ts 的 peer 名规则：lend.json 里写不出的名字不可能有授权 */
const PEER_RE = /^[\w-]{1,32}$/;

type Out = ({ ok: true } & Admitted) | { ok: false; code: string; error: string };

export interface InboxDeps {
  env: Record<string, string | undefined>;
  findPeer(name: string): Promise<HttpPeer | null>;
  journalPath?: string;
  readLend: LendDeps["readLend"];
  context: LendDeps["context"];
  claude?: InboxClaude; // 当场探本机 Claude 的桩与时限（测试用）
}

const realDeps: InboxDeps = { env: process.env, findPeer: findHttpPeer, readLend: () => readLend(), context: () => readLendContext() };

/** 参数与身份都核完、交给收单闸；纯 JSON 结果（tests 直接调） */
export async function lendInbox(args: string[], deps: InboxDeps = realDeps): Promise<Out> {
  if (deps.env.DISCORD_CHANNEL_ID || deps.env[LEND_WORKER_MARK]) return { ok: false, code: "forbidden", error: "lend inbox 只给 bridge 用（以 owner 身份调）" };
  const [dash, peer, fp, body, ...rest] = args;
  if (dash !== "--" || !peer || !fp || body === undefined || rest.length) return { ok: false, code: "invalid", error: USAGE };
  if (!PEER_RE.test(peer) || !FP_RE.test(fp)) return { ok: false, code: "invalid", error: "peer 名或指纹不合法" };
  if (Buffer.byteLength(body) > LEND_BODY_MAX) return { ok: false, code: "invalid", error: `请求体超过 ${LEND_BODY_MAX} 字节` };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, code: "invalid", error: "请求体不是合法 JSON" };
  }
  const req = parseV2Request("offer", raw);
  if (!req.ok) return { ok: false, code: "invalid", error: req.error };
  const rec = await deps.findPeer(peer);
  const db = openLendJournal(deps.journalPath);
  try {
    const caller = { peer, fp: peerLendProblem(rec ?? undefined, peer) || !rec?.publicKey || keyFingerprint(rec.publicKey) !== fp ? null : fp };
    // 记录对不上（没钉钥、禁用、指纹不是钉住的那把）按「没有授权」整批拒：admitOrders 对 fp 为 null 的调用方一单不收
    const d = { db, now: () => Date.now(), readLend: deps.readLend, context: deps.context };
    await primeInboxClaude(d, caller, req.value.orders, deps.claude); // 本进程刚起、没有 Claude 结论：先对齐常驻循环写进 meta 的那份，否则 Claude 单恒 no_slot
    const r = await admitOrders(d, caller, req.value.orders, "push");
    return { ok: true, ...r };
  } finally { db.close(); }
}

export async function cmdLendInbox(args: string[]): Promise<void> {
  try {
    output({ ...(await lendInbox(args)) });
  } catch (e) {
    output({ ok: false, code: "internal", error: (e as Error).message });
  }
}

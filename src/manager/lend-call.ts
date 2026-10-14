/**
 * `manager lend call <peer> <op> --body '<json>'`：调度服务的 lend 循环经它调 A 的出借接口（lib/lend-remote.ts 解析）；op 是 v1 的
 * poll / claim / lease / result 或 v2 的 hello / beat / ask（A 是旧版时 v2 接口回 404，由 lend-remote 识别成 old_peer）。
 * 只给调度服务用（同 ledger 的调度服务身份：CLAUDESTRA_SCHEDULER_SERVICE=1 且不在 agent 频道里）；前提不满足（peer 没钉钥 / 没 E2E、
 * 环境里有代理变量）就不发请求。出站只走 E2E（relay.ts peerE2eOnlyFetch），不退回明文。
 * 输出 {ok:true, status, body}：只要请求到了对方并拿回响应就是 ok:true，对方的拒绝在 body 里；发不出去 / 不知道发没发出去是 ok:false。
 * LENDUI2：`lend call <peer> shot --meta '<json>' --png-file <path>` 传一张交付截图（lib/lend-ui-send.ts 经 lend-deps.ts 调）。图不进命令行：
 * 子进程自己读 LEND_ROOT/work 下的拷贝（O_NOFOLLOW、普通文件、nlink 1、≤ 1 MiB），用 lendShotBody 拼请求体；token 照旧只从 peers.json 读。
 * 拷贝名是 lend submit 核过的 `<sha256>.png`：读到的字节摘要必须等于文件名、并且已去过元数据（checkShotPng + 去 iCCP 后不变），
 * 否则 local_changed / invalid、不发请求。发出去的就是这一次读到并核过的字节（父进程核过之后被换掉也发不出去）。
 * tests/lend-call-shot.test.ts。
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { LEND_ROOT } from "../lib/lend-clone.js";
import { proxyVarsIn, peerLendProblem, type LendAnyOp } from "../lib/lend-remote.js";
import { readBytesIn } from "../lib/lend-submit.js";
import { checkShotPng, LEND_SHOT_LIMITS, lendShotBody, type LendShotSlot } from "../lib/lend-ui-wire.js";
import { dropIccp } from "../lib/lend-ui-submit.js";
import { fields, guard, ORDER_ID, pattern, pick, SHA40, whole } from "../lib/lend-wire-v2-schema.js";
import { SIZE, VIEW, type UiPhase } from "../lib/order-deliver-ui.js";
import type { HttpPeer } from "../lib/peers.js";
import { signedFor } from "../lib/instance-key.js";
import { LEND_WORKER_MARK } from "../lib/runtimes/clean-env.js";
import { output } from "./core.js";
import { peerE2eOnlyFetch } from "./relay.js";

const OPS: readonly LendAnyOp[] = ["poll", "claim", "lease", "result", "hello", "beat", "ask"];
const USAGE = "usage: lend call <peer> poll|claim|lease|result|hello|beat|ask --body '<json>' | lend call <peer> shot --meta '<json>' --png-file <截图拷贝>（调度服务专用）";
const MAX_BODY = 96 * 1024;
const META_MAX = 1024;
const SHOT_FETCH_MS = 40_000;
const PHASES: readonly UiPhase[] = ["before", "after"];
const COPY_NAME = /^([0-9a-f]{64})\.png$/;

/** 只给单测换掉出站与目录；生产不传 */
export interface LendCallIo {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  findPeer?: (name: string) => Promise<HttpPeer | undefined>;
  lendRoot?: string;
  bodyMax?: number;
}

export async function cmdLendCall(args: string[], io: LendCallIo = {}): Promise<void> {
  if (process.env.CLAUDESTRA_SCHEDULER_SERVICE !== "1" || process.env.DISCORD_CHANNEL_ID || process.env[LEND_WORKER_MARK]) return output({ ok: false, code: "forbidden", error: "lend call 只给调度服务用" });
  if (args[1] === "shot") return shotCall(args, io);
  const [peerName, op, flag, body] = args;
  if (!peerName || !OPS.includes(op as LendAnyOp) || flag !== "--body" || body === undefined || args.length !== 4) return output({ ok: false, error: USAGE });
  if (Buffer.byteLength(body) > MAX_BODY) return output({ ok: false, error: `请求体超过 ${MAX_BODY} 字节` });
  return post(peerName, op!, body, 45_000, io);
}

/** 前提（代理变量、peer 记录）→ 带实例签名、经 E2E 发出 → {ok, status, body} */
async function post(peerName: string, op: string, body: string, timeoutMs: number, io: LendCallIo): Promise<void> {
  const proxies = proxyVarsIn(process.env);
  if (proxies.length) return output({ ok: false, code: "precondition", error: `环境里有代理变量 ${proxies.join(", ")}，不发出借请求` });
  const peer = io.findPeer ? await io.findPeer(peerName) : ((await (await import("../lib/peers.js")).findHttpPeer(peerName)) ?? undefined);
  const problem = peerLendProblem(peer, peerName);
  if (problem) return output({ ok: false, code: "precondition", error: problem });
  try {
    const url = `${peer!.baseUrl!.replace(/\/+$/, "")}/api/v1/lend/${op}`;
    // 内层也要带实例签名（A 的出借路由要求，同 bridge/http-peer.ts）；每次调用现签，result 原样重发时签名不复用，不会被当成重放
    const res = await (io.fetch ?? peerE2eOnlyFetch)(url, {
      method: "POST", headers: { Authorization: `Bearer ${peer!.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) },
      body, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; /* 不是 JSON：交给 lend-remote 按 bad_response 处理，状态码照带 */ }
    output({ ok: true, status: res.status, body: parsed });
  } catch (e) {
    output({ ok: false, code: "transport", error: (e as Error).message });
  }
}

type ShotMeta = LendShotSlot & { orderId: string; gen: number; head: string };

/** meta 是封闭对象 {orderId, gen, head, view, size, phase}，≤ 1 KiB */
function parseShotMeta(text: string): { ok: true; value: ShotMeta } | { ok: false; error: string } {
  if (Buffer.byteLength(text) > META_MAX) return { ok: false, error: `--meta 超过 ${META_MAX} 字节` };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "--meta 要是 JSON 对象" }; }
  return guard(() => {
    const r = fields(raw, "meta", ["orderId", "gen", "head", "view", "size", "phase"]);
    return { orderId: pattern(r.orderId, "orderId", ORDER_ID), gen: whole(r.gen, "gen", 1, 1e9), head: pattern(r.head, "head", SHA40),
      view: pattern(r.view, "view", VIEW), size: pattern(r.size, "size", SIZE), phase: pick(r.phase, "phase", PHASES) };
  });
}

/** shot：参数、meta、拷贝、请求体都在本地核过才发；任何一项不过 = 不发请求 */
async function shotCall(args: string[], io: LendCallIo): Promise<void> {
  const [peerName, , metaFlag, metaText, fileFlag, file] = args;
  if (!peerName || metaFlag !== "--meta" || metaText === undefined || fileFlag !== "--png-file" || !file || args.length !== 6) return output({ ok: false, error: USAGE });
  const meta = parseShotMeta(metaText);
  if (!meta.ok) return output({ ok: false, code: "invalid", error: meta.error });
  const png = readBytesIn(join(io.lendRoot ?? LEND_ROOT, "work"), file, { max: LEND_SHOT_LIMITS.png, what: "截图拷贝", field: "--png-file" });
  if (!png.ok) return output({ ok: false, code: "invalid", error: png.error });
  const want = COPY_NAME.exec(basename(file))?.[1];
  if (!want) return output({ ok: false, code: "invalid", error: "--png-file 要是 <sha256>.png 的截图拷贝" });
  if (createHash("sha256").update(png.bytes).digest("hex") !== want) return output({ ok: false, code: "local_changed", error: "截图拷贝的摘要和文件名不符" });
  const clean = checkShotPng(png.bytes);
  if (!clean.ok || Buffer.compare(dropIccp(clean.data), png.bytes) !== 0) return output({ ok: false, code: "invalid", error: "截图拷贝没去干净元数据" });
  const body = lendShotBody(meta.value, png.bytes);
  const max = io.bodyMax ?? LEND_SHOT_LIMITS.body;
  if (Buffer.byteLength(body) > max) return output({ ok: false, code: "invalid", error: `请求体超过 ${max} 字节` });
  return post(peerName, "shot", body, SHOT_FETCH_MS, io);
}

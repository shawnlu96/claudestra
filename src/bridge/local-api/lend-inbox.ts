/**
 * POST /api/v1/lend/offer（docs/design/remote-capacity.md §8.2）：出借方 B 收发起方 A 的推送。只精确匹配这一条路径。
 * 鉴权复用 local-api/lend.ts 的 lendCallerRefusal（已兑换的 peer token + E2E 内层请求 + 钉住的公钥 + 实例签名），不另写一份；体积上限同 lend.ts。
 * 核完交给 `manager lend inbox -- <peer> <钉住的公钥指纹> <正文>`（owner 身份，15 秒超时），授权 / 名额 / 去重都在那边（lib/lend-inbox.ts）。
 * 没授权、出借关着、位满了都是 200 + refused 码，让 A 立刻撤回重排；从不回 404（A 会当成对方没有这个接口）。
 * 回包只有 {ok, v, accepted, refused}：A 严格解析，多一个字段整批作废。这里不 claim，claim 在调度服务下一个 pass。tests/lend-inbox-route.test.ts。
 */
import { keyFingerprint, SIG_HEADERS } from "../../lib/instance-key.js";
import { LEND_BODY_MAX } from "../../lib/lend-wire.js";
import { LEND_V2_STATUS, parseV2Response, V2_BODY_VERSION } from "../../lib/lend-wire-v2.js";
import type { Principal } from "../../lib/principals.js";
import { runManagerProcess, stderrTail } from "../../lib/run-manager.js";
import { apiJson } from "../api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "../config.js";
import { lendCallerRefusal } from "./lend.js";

/** 频道号置空 = 以 owner 身份跑（同 lend.ts） */
const ENV = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" };
/** A 的推送发送超时是 20 秒：这里留出余量 */
const CLI_TIMEOUT_MS = 15_000;

/** 收单子进程成功时 stderr 没人读：尾行转进 bridge 日志（Claude 位为什么报 0 位这类原因只打在那里） */
export const relayInboxStderr = (err: string): void => { const tail = stderrTail(err); if (tail) console.error(`[lend inbox] ${tail}`); };
const refused = (code: keyof typeof LEND_V2_STATUS, error: string) => apiJson(LEND_V2_STATUS[code], { ok: false, code, error });

export async function handleLendInbox(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/lend/offer") return null;
  if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
  const why = lendCallerRefusal(req, principal);
  if (why) return refused("unauthorized", why);
  if (Number(req.headers.get("content-length") || 0) > LEND_BODY_MAX) return refused("invalid", `请求体超过 ${LEND_BODY_MAX} 字节`);
  const body = await req.text();
  if (Buffer.byteLength(body) > LEND_BODY_MAX) return refused("invalid", `请求体超过 ${LEND_BODY_MAX} 字节`);
  const fp = keyFingerprint(req.headers.get(SIG_HEADERS.key) as string); // lendCallerRefusal 已核过：这就是钉住的那把
  const r = await runManagerProcess(["lend", "inbox", "--", principal.peer as string, fp, body],
    { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: CLI_TIMEOUT_MS, onStderr: relayInboxStderr });
  if (r?.ok !== true) {
    if (r?.code === "invalid") return refused("invalid", String(r.error ?? "请求体不合格"));
    return refused("unavailable", String(r?.error ?? "收单失败")); // 超时 / 起不来：A 按推送失败退避重推，推不到的由它的推送 TTL 收走
  }
  const answer = { ok: true, v: V2_BODY_VERSION, accepted: r.accepted, refused: r.refused };
  const self = parseV2Response("offer", answer); // 发出去之前按 A 的解析器自检：A 看不懂的回包等于没回
  return self.ok ? apiJson(200, answer) : refused("unavailable", `收单结果不合格：${self.error}`);
}

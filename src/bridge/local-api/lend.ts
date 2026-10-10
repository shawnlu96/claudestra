/**
 * lend/*（T93，docs/design/remote-capacity.md §0、§2.2、§8）：出借方 B 调发起方 A 的接口，body 结构在 lib/lend-wire.ts（v1）与 lend-wire-v2.ts（v2）。
 *   v1 POST /api/v1/lend/poll | claim | lease | result → manager `ledger lend-poll|claim|lease|write -- <peer> <原文>`（bridge 只读台账）
 *   v2 POST /api/v1/lend/hello | beat → `ledger lend-hello|lend-beat`；/lend/ask 在 bridge 里开 ask（asks 写连接在这里），只回 {askId}
 * 调用方只认 peer token，而且这一次请求必须是 E2E 解开的内层请求、对方公钥已钉住、请求头的钥匙就是钉的那把并带着签名：
 * api-auth 对带钥匙但签名不对的请求已经 401，所以走到这里、钥匙又对得上的就是验签通过的；老 peer（没 E2E、没钉钥、截止日前
 * 放行的不签名请求）一律 401，不退回明文。lease 过期、写单挂太久没人领由 startLendSweeper 每分钟兜一次（先只读判有没有，再起 CLI）；
 * 推送派单和推送超时撤回在 bridge/lend-dispatch.ts。对方公钥一钉住（api-auth 在路由前 commit），就经 `ledger lend-pin` 记事件。
 */
import { SIG_HEADERS } from "../../lib/instance-key.js";
import { openAskFull, patchAsk } from "../../lib/ledger-asks.js";
import { appendEvent } from "../../lib/ledger-write.js";
import { STALE_WRITE_SQL, WRITE_POOL_TTL_MS } from "../../lib/ledger-lend.js";
import { remoteCaller } from "../../lib/ledger-lend-peers.js";
import { getTask } from "../../lib/ledger-store.js";
import { LEND_BODY_MAX, LEND_STATUS, type LendEndpoint } from "../../lib/lend-wire.js";
import { LEND_V2_STATUS, parseV2Request, V2_BODY_VERSION } from "../../lib/lend-wire-v2.js";
import { DELIVERY_NOTE_STATUS } from "../../lib/lend-delivery-amend-code.js";
import { openOrderAsk } from "../../lib/order-ask.js";
import { notePeerQuota, type QuotaReport } from "../../lib/quota-week.js";
import type { Principal } from "../../lib/principals.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { apiJson } from "../api-respond.js";
import { askDb } from "../asks.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "../config.js";
import { startLendDispatch } from "../lend-dispatch.js";
import { ledgerDb } from "../ledger-feed.js";
import { onPeerKeyPinned, peerSignatureState } from "../peer-signature.js";
import { requestContextOf } from "../request-context.js";
import { sendLedgerNotice } from "../team-router.js";
import { strictUtf8 } from "../../lib/pool-review-proof-raw.js";
import { sharedLendApi } from "../shared-ledger-v2-lend-api.js";

type Endpoint = LendEndpoint | "hello" | "beat" | "ask";
const CLI: Record<Exclude<Endpoint, "ask">, string> = {
  poll: "lend-poll", claim: "lend-claim", lease: "lend-lease", result: "lend-write", hello: "lend-hello", beat: "lend-beat",
};
/** v1 与 v2 的拒绝码合在一起映射；v2 的码没有 404（404 = 对方版本太旧，见 lend-wire-v2.ts） */
const STATUS: Record<string, number> = { ...LEND_STATUS, ...LEND_V2_STATUS, ...DELIVERY_NOTE_STATUS };
/** 频道号置空 = 以 owner 身份跑（CLI 只认 owner 调这几条）；「--」之后全当位置参数 */
const ENV = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" };

/** 台账已收下的 hello 里的额度（i28-Q1，只给分配表看）；CLI 已按同一解析器验过，这里再解析只为取字段 */
function helloQuota(body: string): QuotaReport | undefined {
  try {
    const p = parseV2Request("hello", JSON.parse(body));
    return p.ok ? p.value.quota : undefined;
  } catch {
    // 不会发生（CLI 刚解析成功过）；万一发生就当对方没报额度，面板显示「—」
    return undefined;
  }
}

const refused = (code: string, error: string) => apiJson(STATUS[code] ?? 500, { ok: false, code, error });

/**
 * null = 这次请求可以碰 lend；否则是拒绝原因。只看这一次请求的事实，不看这个 peer 以前怎么样。
 * 出借方 B 收 A 推送的入口（W3 local-api/lend-inbox.ts）复用同一道闸。
 */
export function lendCallerRefusal(req: Request, principal: Principal): string | null {
  const peer = principal.peer;
  if (!peer || peer.startsWith("invite:")) return "lend 只收已兑换的 peer token";
  if (!requestContextOf(req).e2e) return "lend 只收端到端加密的请求（老 peer 先升级并建立 E2E）";
  const pin = peerSignatureState(peer);
  const key = req.headers.get(SIG_HEADERS.key);
  if (!pin?.publicKey || !key || key !== pin.publicKey || !req.headers.get(SIG_HEADERS.sig)) return "lend 只收钉了钥、带实例签名的请求";
  return null;
}

/**
 * 远端 worker 经 B 转来的提问：除 peer 外全部取自 lend_orders 那一行（RemoteCaller），只认这个 peer 持有、租约没过期、代数对得上的单；
 * askee 是这张卡的 PM，回包只有 askId，问题只以引用形式进通知（lib/order-ask.ts）。
 */
async function remoteAsk(body: string, peer: string): Promise<Response> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return refused("invalid", "请求体不是合法 JSON");
  }
  const req = parseV2Request("ask", raw);
  if (!req.ok) return refused("invalid", req.error);
  const db = ledgerDb();
  if (!db) return refused("unavailable", "这台机器没有台账");
  const who = remoteCaller(db, peer, req.value, Date.now());
  if ("refused" in who) return refused("not_held", who.refused);
  const task = getTask(db, who.taskId);
  if (!task) return refused("not_held", "这一单的卡已不在台账里");
  const r = await openOrderAsk(db, {
    open: (input, beforeWrite) => openAskFull(askDb(), input, Date.now(), { beforeWrite }), notify: (to, text, messageId) => sendLedgerNotice({ to, text, messageId }),
    markHanded: (id) => patchAsk(askDb(), id, { extra: { notice: "handed" } }), record: (ctx, input) => void appendEvent(askDb(), ctx, input),
  }, { task, orderId: who.orderId, from: `${who.worker}@${who.peer}`, keyPrefix: `lend-ask:g${who.gen}`,
    // 拿到 asks 写锁后再核一遍持单（等锁期间可能结清 / 失租）：结清时已关过这一单的提问，不能再开出新的
    recheck: () => { const again = remoteCaller(db, peer, req.value, Date.now()); return "refused" in again ? again.refused : null; } }, req.value);
  if ("refused" in r) return refused(r.code === "not_held" ? "not_held" : "unavailable", r.refused);
  // 审查单不转 PM：旧版对方只把拒绝原因给审查员看，规则原文放在 error 里它就能读到（lend-tools.ts askPeer）
  if ("answered" in r) return apiJson(409, { ok: false, code: "review_ask_answered", error: r.answered });
  return apiJson(200, { ok: true, v: V2_BODY_VERSION, askId: r.askId });
}

export async function handleLendApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(/^\/lend\/(poll|claim|lease|result|hello|beat|ask)$/);
  if (!m) return null;
  if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
  const why = lendCallerRefusal(req, principal);
  if (why) return refused("unauthorized", why);
  if (Number(req.headers.get("content-length") || 0) > LEND_BODY_MAX) return apiJson(413, { ok: false, code: "invalid", error: `请求体超过 ${LEND_BODY_MAX} 字节` });
  const body = strictUtf8(await req.arrayBuffer()); // POOLRV1: lossless text of the verified bytes; the result archive relies on it
  if (body === null) return apiJson(400, { ok: false, code: "invalid", error: "请求体不是合法 UTF-8" });
  if (Buffer.byteLength(body) > LEND_BODY_MAX) return apiJson(413, { ok: false, code: "invalid", error: `请求体超过 ${LEND_BODY_MAX} 字节` });
  const endpoint = m[1] as Endpoint;
  if (endpoint === "ask") return remoteAsk(body, principal.peer as string);
  const central = await sharedLendApi(endpoint, body, principal.peer as string);
  if (central) return central;
  const r = await runManagerProcess(["ledger", CLI[endpoint], "--", principal.peer as string, body], { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: 30_000 });
  if (r?.ok) {
    if (endpoint === "hello") notePeerQuota(principal.peer as string, helloQuota(body)); // 迟到的旧 hello 也会覆盖：只是参考数，下一次就更正
    const { ok: _ok, notified: _n, ...rest } = r as Record<string, unknown>;
    return apiJson(200, { ok: true, ...rest });
  }
  const code = (r?.current?.lend ?? r?.code) as string | undefined;
  if (code && code in STATUS) return refused(code, String(r?.error ?? code));
  return apiJson(code === "busy" ? 503 : 500, { ok: false, code: code ?? "internal", error: String(r?.error ?? "lend 处理失败") });
}

/** 钉钥只在首次签名请求那一刻发生，事后只剩 peer-keys.json 里的时间：台账这条让 PM 查得到是哪把钥匙、什么时候认下的 */
export function watchLendPins(): void {
  onPeerKeyPinned((peer, pin) => {
    void runManagerProcess(["ledger", "lend-pin", "--", peer, pin.fingerprint, pin.first ? "first" : "repin"], { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: 30_000 })
      .then((r) => { if (!r?.ok) console.warn(`⚠️ [lend] ${peer} 钉钥事件没记上：${r?.error ?? "无输出"}`); })
      .catch((e) => console.warn(`⚠️ [lend] ${peer} 钉钥事件起不来：${(e as Error).message}`));
  });
}

const SWEEP_MS = 60_000;
let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * 租约到期不能等对方下次来：到期没续的单每分钟结一次 unknown 并通知 PM；挂了太久没人领的写单退回本机（i28-R6）。
 * 库里两样都没有就不起进程。v2 的推送循环（含推送超时撤回，5 秒一查）跟着一起起。
 */
export function startLendSweeper(): void {
  if (sweeper) return;
  startLendDispatch();
  sweeper = setInterval(() => {
    let due = false;
    try {
      const now = Date.now();
      due = !!ledgerDb()?.query(`SELECT 1 FROM lend_orders WHERE (status = 'claimed' AND leaseUntil < ?)
        OR (${STALE_WRITE_SQL}) LIMIT 1`).get(now, now - WRITE_POOL_TTL_MS);
    } catch (e) {
      // 表还没建（库还没迁到 T93）或库暂时读不了：这一分钟不扫，下一分钟再看；没有到期的单也就没有要结的
      console.warn(`⚠️ [lend] 查到期租约失败：${(e as Error).message}`);
    }
    if (!due) return;
    void runManagerProcess(["ledger", "lend-sweep"], { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: 30_000 })
      .then((r) => { if (!r?.ok) console.warn(`⚠️ [lend] lend-sweep 失败：${r?.error ?? "无输出"}`); })
      .catch((e) => console.warn(`⚠️ [lend] lend-sweep 起不来：${(e as Error).message}`));
  }, SWEEP_MS);
  sweeper.unref?.();
}

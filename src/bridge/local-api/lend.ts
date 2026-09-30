/**
 * lend/*（T93，docs/design/remote-capacity.md §0、§2.2）：出借方 B 调发起方 A 的四个接口，body 结构在 lib/lend-wire.ts。
 *   POST /api/v1/lend/poll | claim | lease | result → manager `ledger lend-poll|claim|lease|write -- <peer> <原文>`（bridge 只读台账）
 * 调用方只认 peer token，而且这一次请求必须是 E2E 解开的内层请求、对方公钥已钉住、请求头的钥匙就是钉的那把并带着签名：
 * api-auth 对带钥匙但签名不对的请求已经 401，所以走到这里、钥匙又对得上的就是验签通过的；老 peer（没 E2E、没钉钥、截止日前
 * 放行的不签名请求）一律 401，不退回明文。lease 过期由 startLendSweeper 每分钟兜一次（先只读判有没有到期的，再起 CLI）。
 * 对方公钥一钉住（api-auth 在路由前 commit），就经 `ledger lend-pin` 给借它算力的项目各记一条事件。
 */
import { SIG_HEADERS } from "../../lib/instance-key.js";
import { LEND_BODY_MAX, LEND_STATUS, type LendEndpoint } from "../../lib/lend-wire.js";
import type { Principal } from "../../lib/principals.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { apiJson } from "../api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "../config.js";
import { ledgerDb } from "../ledger-feed.js";
import { onPeerKeyPinned, peerSignatureState } from "../peer-signature.js";
import { requestContextOf } from "../request-context.js";

const CLI: Record<LendEndpoint, string> = { poll: "lend-poll", claim: "lend-claim", lease: "lend-lease", result: "lend-write" };
/** 频道号置空 = 以 owner 身份跑（CLI 只认 owner 调这几条）；「--」之后全当位置参数 */
const ENV = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" };

const refused = (code: keyof typeof LEND_STATUS, error: string) => apiJson(LEND_STATUS[code], { ok: false, code, error });

/** null = 这次请求可以碰 lend；否则是拒绝原因。只看这一次请求的事实，不看这个 peer 以前怎么样 */
function lendCallerRefusal(req: Request, principal: Principal): string | null {
  const peer = principal.peer;
  if (!peer || peer.startsWith("invite:")) return "lend 只收已兑换的 peer token";
  if (!requestContextOf(req).e2e) return "lend 只收端到端加密的请求（老 peer 先升级并建立 E2E）";
  const pin = peerSignatureState(peer);
  const key = req.headers.get(SIG_HEADERS.key);
  if (!pin?.publicKey || !key || key !== pin.publicKey || !req.headers.get(SIG_HEADERS.sig)) return "lend 只收钉了钥、带实例签名的请求";
  return null;
}

export async function handleLendApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(/^\/lend\/(poll|claim|lease|result)$/);
  if (!m) return null;
  if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
  const why = lendCallerRefusal(req, principal);
  if (why) return refused("unauthorized", why);
  if (Number(req.headers.get("content-length") || 0) > LEND_BODY_MAX) return apiJson(413, { ok: false, code: "invalid", error: `请求体超过 ${LEND_BODY_MAX} 字节` });
  const body = await req.text();
  if (Buffer.byteLength(body) > LEND_BODY_MAX) return apiJson(413, { ok: false, code: "invalid", error: `请求体超过 ${LEND_BODY_MAX} 字节` });
  const endpoint = m[1] as LendEndpoint;
  const r = await runManagerProcess(["ledger", CLI[endpoint], "--", principal.peer as string, body], { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: 30_000 });
  if (r?.ok) {
    const { ok: _ok, notified: _n, ...rest } = r as Record<string, unknown>;
    return apiJson(200, { ok: true, ...rest });
  }
  const code = (r?.current?.lend ?? r?.code) as string | undefined;
  if (code && code in LEND_STATUS) return refused(code as keyof typeof LEND_STATUS, String(r?.error ?? code));
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

/** 租约到期不能等对方下次来：到期没续的单每分钟结一次 unknown 并通知 PM。库里没有到期的就不起进程 */
export function startLendSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    let due = false;
    try {
      due = !!ledgerDb()?.query("SELECT 1 FROM lend_orders WHERE status = 'claimed' AND leaseUntil < ? LIMIT 1").get(Date.now());
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

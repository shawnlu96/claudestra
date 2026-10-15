import { recoverPeerSend } from "./floka-peer/recovery.js";
import { peerCapabilities, pinOf, learnPeerCapabilities, type PeerCapabilities } from "./floka-peer/capability.js";
import { peerPolicy } from "./floka-peer/policy.js";
import { signRequestFamily } from "./floka-compat/signature/request.js";
import { E2E_HELLO_PATH } from "./peer-e2e-wire.js";
import { readJsonCapped } from "./body-reader.js";
/**
 * 出站那一半（docs/relay/e2e-design.md §5.1）：发往 required peer 的请求一律包进 E2E 会话，别的原样放行。
 * bridge 的 peerFetch（relay-link.ts）和 manager 的 peerCliFetch（manager/relay.ts）都先问这里，所以任何调用方都绕不开：
 * 目标是 required peer 却走不了加密（本机钥匙读不到、对方记录坏了）→ 抛错，绝不退回明文。
 * 外层传输（中继 / 直连、外层签名）由调用方以 raw 注入；这里只管会话。
 */
import { E2eOuterError, E2eInnerError, E2eLocalError, markE2eResponse, PeerE2eClient, type E2ePost } from "./peer-e2e-client.js";
import { e2ePeerOf, localE2e, peerForUrl, pinPeerE2eKey, readHttpPeers, type LocalE2e } from "./peer-e2e-local.js";
import type { HttpPeer } from "./peers.js";

export interface OutboundInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** 外层传输：发一个 POST（正文是二进制），调用方负责基址之外的一切（中继帧、外层实例签名） */
export type RawPost = (url: string, init: { method: "POST"; headers: Record<string, string>; body: Uint8Array }) => Promise<Response>;

export interface OutboundDeps {
  rename?: unknown;
  capabilities?: PeerCapabilities;
  local: () => Promise<LocalE2e | null>;
  peers: () => Promise<HttpPeer[]>;
  pin: typeof pinPeerE2eKey;
  /** 外层实例签名；manager 的 raw 自己会签（直连在 peerCliFetch 里、中继在 bridge 的 /relay/request 里），就不给 */
  sign?: (method: string, path: string, body: Uint8Array) => Record<string, string>;
}

const DUPLICATE_TEXT = "对方已经处理过这条（回复在路上丢了），不要重发";

export function createE2eOutbound(d: OutboundDeps) {
  const capabilities = d.capabilities ?? peerCapabilities;
  const clients = new Map<string, { client: PeerE2eClient; ident: string }>();

  /** 会话按 peer 缓存；client 里不留任何一次请求的传输或 signal（T59：缓存了第一次的 raw，signal 到期后第二次必失败） */
  function clientFor(rec: HttpPeer, local: LocalE2e, base: string, family: "claudestra" | "floka"): PeerE2eClient {
    const ident = JSON.stringify([base, rec.e2e, local.fp, family]);
    const hit = clients.get(rec.name);
    if (hit?.ident === ident) return hit.client;
    let current = e2ePeerOf(rec)!;
    const client = new PeerE2eClient({
      renameFamily: family, myFp: local.fp,
      peer: () => current,
      machine: async () => local.machine,
      mySignedKey: async () => local.signed,
      pinNewer: async (p, ek) => {
        current = { ...current, ek };
        await d.pin(p.name, ek);
      },
    });
    clients.set(rec.name, { client, ident });
    return client;
  }

  /**
   * 目标不是 required peer → null（调用方照旧明文发）；是 → 走会话，返回解开后的内层响应。
   * 两种重放拒绝换成调用方已有分支认得的响应：「对方重启过」→ 401 peer_signature（peerAuthHint 给话术），「已处理过」→ 409。
   * 只认 E2eInnerError（认证过的内层给的）：外层明文里写着同样 code 的是中继能伪造的，照原样抛给调用方按「状态未知」报。
   */
  async function fetch(url: string, init: OutboundInit, raw: RawPost): Promise<Response | null> {
    const rec = peerForUrl(url, await d.peers());
    if (!rec?.e2e) return null;
    const base = (rec.baseUrl || "").replace(/\/+$/, "");
    if (!e2ePeerOf(rec) || !base) throw new E2eLocalError("e2e_bad_peer", `peer ${rec.name} is marked end-to-end but its record lacks an address or fingerprint`);
    const local = await d.local();
    if (!local) throw new E2eLocalError("e2e_unavailable", "local E2E key unavailable; refusing to fall back to plaintext");
    const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : (init.body ?? new Uint8Array(0));
    try {
      const pin = pinOf(rec), family = capabilities.family(pin, d.rename, true);
      const post: E2ePost = async (path, bytes, contentType) => {
        const url = `${base}${path}`;
        const u = new URL(url);
        const signed = family === "claudestra" && d.sign ? d.sign("POST", u.pathname + u.search, bytes)
          : signRequestFamily(family, { method: "POST", path: u.pathname + u.search, body: bytes }, local.key);
        const response = await recoverPeerSend(url, signed,
          () => raw(url, { method: "POST", body: bytes, headers: { "content-type": contentType, ...signed } }),
          { pin, cache: capabilities, rejected: code => {
            // A missing record session permits the client's bounded retry; this call keeps its captured family.
            if (code === "e2e_session" && path !== E2E_HELLO_PATH) return;
            throw new E2eOuterError(code, "peer rejected the selected family; capability retired for future calls", path !== E2E_HELLO_PATH);
          } });
        if (path === E2E_HELLO_PATH && response.ok && pin && peerPolicy(d.rename).e2e.receive !== "off") {
          const reply = await readJsonCapped(new Response(response.clone().body), 8192) as { capabilities?: unknown } | null;
          learnPeerCapabilities(reply?.capabilities, pin, capabilities, d.rename);
        }
        return response;
      };
      return await clientFor(rec, local, base, family).fetch(init.method ?? "GET", url.slice(base.length), init.headers ?? {}, body, post);
    } catch (e) {
      if (!(e instanceof E2eInnerError)) throw e;
      if (e.code === "e2e_duplicate") return markE2eResponse(Response.json({ ok: false, error: DUPLICATE_TEXT }, { status: 409 }));
      throw e;
    }
  }

  return { fetch };
}

/** 生产用的那一份：状态全在 STATE_DIR；bridge 注入外层签名，manager 不注入 */
export const defaultOutboundDeps = (): Omit<OutboundDeps, "sign"> => ({ local: () => localE2e(), peers: readHttpPeers, pin: pinPeerE2eKey });

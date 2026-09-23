/**
 * 一键加入 peer 失败时「下一步该做什么」（纯函数，tests/peer-join-hints.test.ts）。
 *
 * 邀请本身只有「生成 → 粘贴」两步，真正卡人的是两道网络关：接方的机器到不到发方地址
 * （Tailscale 设备共享是单向的，对方共享给你 ≠ 你共享给对方），以及发方 bridge 端口的
 * 防火墙白名单。以前失败只回一句 fetch 的原始报错（"The operation timed out."），
 * 两边都不知道该谁去做什么。这里按错误形态分流，把「谁、做什么」说出来。
 *
 * 判据来自 Bun fetch 实测（2026-09-23）：超时 name=TimeoutError；端口被拒 / 防火墙
 * block return / 域名解析失败都是 code=ConnectionRefused（后两者 Bun 不区分）。
 */

export type JoinFailureKind = "timeout" | "refused" | "rejected" | "other";

/** 网络层异常 → 类别 */
export function classifyJoinError(e: { name?: string; code?: unknown; message?: string }): JoinFailureKind {
  if (e.name === "TimeoutError" || e.name === "AbortError" || /timed out/i.test(e.message ?? "")) return "timeout";
  if (e.code === "ConnectionRefused" || /ECONNREFUSED|Unable to connect|refused/i.test(e.message ?? "")) return "refused";
  return "other";
}

export interface HintCtx {
  /** 邀请串里的对方地址 */
  peerUrl: string;
  /** 我方的 Tailscale 地址（发给对方放行防火墙用），探不到就省略 */
  myAddr?: string;
  /** 扫 tailnet 找到的同端口 bridge 候选（跨 tailnet 共享时邀请里的 IP 可能是对方视角） */
  candidates?: string[];
}

export function joinFailureHint(kind: JoinFailureKind, ctx: HintCtx): string {
  const host = hostOf(ctx.peerUrl);
  const cand = ctx.candidates?.length
    ? `另外，tailnet 里这些地址有 bridge 在响应：${ctx.candidates.join("、")}——跨 tailnet 共享时邀请里写的是对方视角的地址，可以用其中之一重试（CLI 加 --peer-url，邀请串原样保留）。`
    : "";
  switch (kind) {
    case "timeout":
      return `你这台机器到不了 ${host}：请求发出去没有任何回应。用 Tailscale 的话，要对方在 Tailscale 后台把他的机器共享给你` +
        `（Machines → 他的机器 → Share），或者你们在同一个 tailnet 里——共享是单向的，你共享给他不算。弄好后原样再粘贴一次，邀请没被用掉。${cand}`;
    case "refused":
      return `能连到 ${host}，但它的 bridge 端口拒绝了你：对方给这个端口加了防火墙白名单却没放行你` +
        (ctx.myAddr ? `（把你的地址 ${ctx.myAddr} 发给对方，让他放行）` : "") +
        `，或者对方的 bridge 只监听本机（.env 的 BRIDGE_BIND）。对方处理好后原样再粘贴一次即可。${cand}`;
    case "rejected":
      return "对方收到了请求，但拒绝了这张邀请：可能已过期（24 小时）、已经用过或被撤销——请对方重新生成一张。";
    default:
      return "确认对方 bridge 在线、地址对外可达、邀请未过期未撤销。";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 本机的 Tailscale 地址（只读网卡，不调 CLI）；没有就 undefined */
export async function localTailnetAddr(): Promise<string | undefined> {
  const { detectBridgeUrls } = await import("./net-addr.js");
  const ts = detectBridgeUrls(0).find((c) => c.kind === "tailscale");
  return ts ? hostOf(ts.url).replace(/:\d+$/, "") : undefined;
}

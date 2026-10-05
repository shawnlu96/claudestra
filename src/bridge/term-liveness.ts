/**
 * 终端 viewer 的存活与满额驱逐（term-viewer.ts 调用）。半开连接（手机切后台、网络换了）下服务端写 SSE 不报错，
 * 流的 cancel 永远等不到，只能靠客户端定期来往判活：带 ka=1 打开的 viewer 每 TERM_ALIVE_INTERVAL 发一次 keepalive，
 * input / resize 也算；超时没来往就回收。不带 ka=1 的老客户端不受存活约束（否则没刷新的旧页面会被周期性断开）。
 */

/**
 * 超过这么久没有任何来往就回收。须明显大于前端 keepalive 间隔（20s，web/features/terminal/terminal-view.tsx）
 * 在 Chrome 隐藏标签强节流下的最坏间隔（链式定时器最多每分钟一次）+ 网络抖动，否则桌面后台标签会被误杀。
 */
export const TERM_ALIVE_TIMEOUT_MS = 90_000;
/** 存活巡检间隔：回收延迟上界 = TIMEOUT + 它 */
export const TERM_ALIVE_CHECK_MS = 5_000;

export interface LivenessView {
  /** 最近一次来往；undefined = 客户端没声明 keepalive（ka=1），不按存活回收 */
  lastSeen?: number;
}

export const viewerIdle = (v: LivenessView, now: number): boolean =>
  v.lastSeen !== undefined && now - v.lastSeen > TERM_ALIVE_TIMEOUT_MS;

/**
 * 满额时让位的 viewer：同一属主键里最早建的。只对设备凭据生效——设备凭据一台设备一条，驱逐的只会是这台设备
 * 自己留下的；Bearer token 可能多台设备共用，驱逐会误杀别的设备，照旧拒绝。别的属主（别的设备 / guest / peer）一律不碰。
 */
export function pickEvictee<T extends { tokenId: string; createdAt: number }>(sessions: Iterable<T>, ownerKey: string, deviceBound: boolean): T | null {
  if (!deviceBound) return null;
  let oldest: T | null = null;
  for (const s of sessions) if (s.tokenId === ownerKey && (!oldest || s.createdAt < oldest.createdAt)) oldest = s;
  return oldest;
}

/**
 * 客户端在 openTerminal 还在建 tmux / PTY 时就走了：Bun（中继入站同理）拿到 Response 时请求已中止，既不读也不 cancel
 * 它的 body，源流的 cancel → destroy 永远不跑。请求一 abort 就自己 cancel body；body 正被读（锁着）时 cancel 被拒，
 * 那条路上断开由读的一方 cancel。
 */
export function cancelOnAbort(res: Response, signal?: AbortSignal): Response {
  const cancel = () => void res.body?.cancel().catch(() => { /* 正被读（锁着）：断开时读的一方会 cancel 源流 */ });
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  return res;
}

/** 建 viewer 时的时间戳：ka=1 才从此刻开始计存活 */
export const viewerStamps = (keepalive: boolean, now = Date.now()): { createdAt: number; lastSeen?: number } =>
  keepalive ? { createdAt: now, lastSeen: now } : { createdAt: now };

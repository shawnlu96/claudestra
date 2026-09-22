/**
 * 重连决策（纯函数）：回前台 / 断流 / 点推送 / 重点会话时，这一次该怎么对齐。
 *
 * 以前七个分支埋在 chat-store.maybeReconnect 的 108 行里、读十来个私有字段，没法单测；
 * 注释里记着 07-16、07-24、07-25、07-28、09-07、09-16 至少六次「修好 A 又弄坏 B」
 * （D8-7）。现在 maybeReconnect 只负责执行这里给的计划，每次事故一条用例
 * （tests/web-reconnect-policy.test.ts）。各分支的来由保留在下面的注释里。
 */

export type ReconnectPlan =
  /** 不动：风暴地板 / 同 agent 历史请求在飞 / 历史浏览模式 */
  | { kind: "skip"; why: "floor" | "history-inflight" | "browsing"; inflightMs?: number }
  /** 流看起来健康：不重连，布一枚 12s 判活探针 */
  | { kind: "probe" }
  /** 快路径：只重连流，带 ?since 让 bridge 从环形缓冲重放 */
  | { kind: "fast"; since: number; deadStreamHiddenMs?: number }
  /** 差量：先按游标拉差量，再开流 */
  | { kind: "delta"; after: number; deadStreamHiddenMs?: number }
  /** 全量：重拉历史 + 重连流 */
  | { kind: "full"; deadStreamHiddenMs?: number };

export interface ReconnectInput {
  now: number;
  name: string;
  /** 断流后的自动重连（流已死） */
  fast?: boolean;
  /** 用户明确要看最新（点推送 / 重点当前会话 / 同步失败 pill 重试） */
  force?: boolean;
  lastReconnectAt: number;
  historyLoad: { agent: string; at: number } | null;
  browsing: boolean;
  stream: { hasReader: boolean; agent: string | null; lastByteAt: number };
  /** 进后台的时刻（0 = 没进过 / 已回前台后清零由调用方决定） */
  hiddenAt: number;
  lastEvent: { agent: string; seq: number };
  /** 历史游标的 lastSeq（没有游标 = null） */
  cursorLastSeq: number | null;
}

export const FLOOR_MS = 900;
export const FORCE_FLOOR_MS = 300;
export const HISTORY_YIELD_MS = 25_000;
export const STREAM_HEALTHY_MS = 30_000;
export const SUSPEND_SILENT_MS = 12_000;
export const SHORT_AWAY_MS = 5 * 60_000;

export function decideReconnect(i: ReconnectInput): ReconnectPlan {
  // v2.17.2 风暴地板(peer 报告:watchdog/哨兵/visibility/openAgent(same) 多个
  // 触发源在坏网络下 1-3s 一发互相叠加,每发都 detach+新建连接,配合 iOS 连接
  // 泄漏就是自激循环)。900ms 内只放行一次——自然死亡退避最短 1s,不受影响。
  // force(点推送 / 重点当前会话)是用户动作不是风暴,只挡 300ms 内的双派发
  // (插件 pushNotificationActionPerformed 与 ?agent= 深链两路都会 openAgent)。
  // 2026-09-07 owner「推送比消息先到,消息过一会才来」排查:visibility 的快路径
  // 抢先 100ms 开跑,force 被 900ms 地板整个吞掉。
  if (i.now - i.lastReconnectAt < (i.force ? FORCE_FLOOR_MS : FLOOR_MS)) return { kind: "skip", why: "floor" };

  // v2.17.2 在飞历史让路(慢中继上 448KB 历史要下载很久,期间 sentinel 又判流失联
  // 触发 full reconnect → openGen 自增把在飞下载作废重来,「历史永远拉不完」)。
  // 同 agent 的历史请求还新鲜(<25s,略小于其 30s fetch 超时)就不打断;force 也一样让路。
  if (i.historyLoad && i.historyLoad.agent === i.name && i.now - i.historyLoad.at < HISTORY_YIELD_MS) {
    return { kind: "skip", why: "history-inflight", inflightMs: i.now - i.historyLoad.at };
  }

  // 历史现场模式:用户在刻意看旧内容,回前台/断流对齐都不打扰(流本就断开)
  if (i.browsing) return { kind: "skip", why: "browsing" };

  // 流活着就别动它(owner 拍板 2026-07-24):服务端 5s 一个心跳,30s 内有字节 = 流健康。
  // fast = 流已死,不走这里;force = 用户要最新,流健康 ≠ 数据齐(bridge 重启纪元切换后
  // ?since 重放不出静默期消息),也不走这里。
  let deadStreamHiddenMs: number | undefined;
  if (
    !i.fast &&
    !i.force &&
    i.stream.hasReader &&
    i.stream.agent === i.name &&
    i.now - i.stream.lastByteAt < STREAM_HEALTHY_MS
  ) {
    // iOS 壳 / PWA 的后台 = 整个 WebView 挂起:流不是「活着」是「冻着」。桌面后台 tab
    // 照常收心跳,所以「后台 ≥12s 且期间一个字节都没到」只有挂起才会发生 → 视为死流。
    // 后台 <12s 判不了 → 布一枚 12s 探针(owner 2026-09-07「推送比消息先到」)。
    const silentSinceHidden = i.hiddenAt > 0 && i.stream.lastByteAt < i.hiddenAt;
    if (!(silentSinceHidden && i.now - i.hiddenAt >= SUSPEND_SILENT_MS)) return { kind: "probe" };
    deadStreamHiddenMs = i.now - i.hiddenAt;
  }

  // 快路径(owner 2026-07-16「catch up 更快更丝滑」):短暂离开(<5min)且有断点锚 →
  // 只重连流带 ?since。⚠ force 必须绕开:快路径不重拉历史,reply 没能从缓冲重放回来
  // 就永远缺这一条(owner 2026-07-25 点推送进来看不到回复)。
  const shortAway = i.hiddenAt > 0 && i.now - i.hiddenAt < SHORT_AWAY_MS;
  if (!i.force && (i.fast || shortAway) && i.lastEvent.agent === i.name && i.lastEvent.seq > 0) {
    return { kind: "fast", since: i.lastEvent.seq, deadStreamHiddenMs };
  }

  // v2.16 cursor 模型(owner 2026-07-28「推送点入 20s 无消息」):有游标就差量。
  // ⚠ force 必须绕开差量走全量(2026-09-16):差量 `after=<游标>` 是排他的,回合中途
  // 锚点恰落在游标上的 reply 不会再被差量拉回,只有全量重载才回来。
  if (!i.force && i.cursorLastSeq !== null) {
    return { kind: "delta", after: i.cursorLastSeq, deadStreamHiddenMs };
  }
  return { kind: "full", deadStreamHiddenMs };
}

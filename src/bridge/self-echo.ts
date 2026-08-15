/**
 * v2.19.0 自我消息对账 —— 「同一个 bot token 上还有别的实例吗」的秒级探测。
 *
 * 由来（2026-08-15）：另一台机器上的 Claudestra 拿着同一个 bot token 和一份
 * rsync 来的 registry，往本机的频道发了 8 条内容虚假的告警。定位它花了两个多
 * 小时 —— 因为消息本身不携带发信方信息，本机日志里又什么都没有，只能靠
 * 「这条消息的内容与本机事实矛盾」一点点反推。
 *
 * 但其实有一个**免费且确定**的信号一直摆在那儿：Discord 会把 bot 自己发的消息
 * 也作为 MESSAGE_CREATE 推给所有网关连接。所以本实例只要看到一条
 *   author == 我这个 bot，但 message id 不在「我刚发出去的」集合里
 * 就说明**有另一个进程用同一个 token 在发消息**。几秒钟，不用推理。
 *
 * 两个工程细节：
 * - **发送侧要全覆盖**，否则漏记一次就是一次假警。所以不去逐个调用点插桩，而是
 *   包住 discord.js 的 REST `post` —— 所有 `.send()` / `.reply()` / `followUp()`
 *   最终都从那儿出去，一个点覆盖全部。
 * - **门槛要保守**：交互回复等边角路径仍可能漏记，所以单条不报，要求 10 分钟内
 *   攒够 3 条陌生自发消息才告警，并且每条都单独打日志（带内容摘要）便于调参。
 */

import { trackSentMessage, isBotMessage, getBotUserId } from "./discord-api.js";

/** 攒够这么多条陌生自发消息才认定「有第二实例」 */
const ECHO_THRESHOLD = 3;
/** 统计窗口 */
const ECHO_WINDOW_MS = 10 * 60_000;
/** 告警冷却——认定一次就够了，别变成新的刷屏源 */
const ALERT_COOLDOWN_MS = 60 * 60_000;

const foreignEchoes: { at: number; channelId: string; preview: string }[] = [];
let lastAlertAt = 0;

/** 消息创建类路由：频道发消息 + webhook（interaction followUp 走这条） */
const MESSAGE_ROUTE_RE = /^\/channels\/\d+\/messages$|^\/webhooks\/\d+\/[^/]+$/;

/**
 * 包住 REST post，把每条我们自己创建的消息 id 记进 trackSentMessage。
 * 这是唯一的发送出口，比在十几个 `.send()` 调用点插桩可靠得多。
 */
export function installSelfSendTracker(client: {
  rest: { post: (route: string, options?: unknown) => Promise<unknown> };
}): void {
  const rest = client.rest as { post: (route: string, options?: unknown) => Promise<unknown> };
  const orig = rest.post.bind(rest);
  rest.post = async (route: string, options?: unknown) => {
    const res = await orig(route, options);
    try {
      if (MESSAGE_ROUTE_RE.test(route)) {
        const id = (res as { id?: unknown } | null)?.id;
        if (typeof id === "string") trackSentMessage(id);
      }
    } catch {
      /* 记账失败不能影响发消息本身 */
    }
    return res;
  };
}

export interface ForeignEchoAlert {
  count: number;
  windowMin: number;
  samples: { channelId: string; preview: string }[];
}

/**
 * messageCreate 里对每条「author 是自己」的消息调一次。
 * 返回非 null 表示达到阈值且过了冷却 —— 调用方去告警。
 */
export function noteSelfMessage(msg: {
  id: string;
  channelId: string;
  content?: string | null;
  author: { id: string };
}): ForeignEchoAlert | null {
  const me = getBotUserId();
  if (!me || msg.author.id !== me) return null;
  if (isBotMessage(msg.id)) return null; // 是本实例发的，正常

  const now = Date.now();
  const preview = (msg.content || "").replace(/\s+/g, " ").slice(0, 80);
  foreignEchoes.push({ at: now, channelId: msg.channelId, preview });
  while (foreignEchoes.length && now - foreignEchoes[0].at > ECHO_WINDOW_MS) foreignEchoes.shift();

  console.error(
    `👻 [self-echo] 收到一条本 bot 发出、但不是本实例发的消息 ` +
      `(channel=${msg.channelId}, 窗口内第 ${foreignEchoes.length} 条): ${preview}`,
  );

  if (foreignEchoes.length < ECHO_THRESHOLD) return null;
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return null;
  lastAlertAt = now;
  return {
    count: foreignEchoes.length,
    windowMin: Math.round(ECHO_WINDOW_MS / 60_000),
    samples: foreignEchoes.slice(-3).map((e) => ({ channelId: e.channelId, preview: e.preview })),
  };
}

/** 测试用：清空窗口状态 */
export function _resetSelfEchoState(): void {
  foreignEchoes.length = 0;
  lastAlertAt = 0;
}

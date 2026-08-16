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
 * 三个工程细节（第一条是 2026-08-16 上线当天被打脸补上的）：
 *
 * - **必须延迟判定**。网关回声和 HTTP 响应是两条独立通道，实测**回声先到**：
 *   `channel.send()` 的 await 还没返回（拿不到 message id，也就无从记账），
 *   MESSAGE_CREATE 已经推过来了。于是「id 不在集合里」对**每一条**自己发的
 *   消息都成立——上线当天它把自己发的告警也算成了第二实例。所以看到陌生自发
 *   消息先等一会儿再复核一次，等 HTTP 那边把 id 记上。
 * - **发送侧要全覆盖**，否则漏记一次就是一次假警。所以不去逐个调用点插桩，而是
 *   包住 discord.js 的 REST `post` —— 所有 `.send()` / `.reply()` / `followUp()`
 *   最终都从那儿出去，一个点覆盖全部。
 * - **门槛要保守**：单条不报，要求 10 分钟内攒够 3 条陌生自发消息才告警，
 *   并且每条都单独打日志（带内容摘要）便于调参。
 */

import { trackSentMessage, isBotMessage, getBotUserId } from "./discord-api.js";

/**
 * ⚠️ v2.19.1 告警**默认关闭**（2026-08-16 上线当天即误报）。
 *
 * 探测思路本身没问题，但它依赖「发送侧记账 100% 完整」这个前提——而实测
 * 记账几乎全漏（连本探测器自己发出的告警都被它当成外来消息计了一笔），
 * 于是每条正常回复都算一次「第二实例」。宁可不报也不能乱报:一个天天喊狼来了
 * 的探测器比没有更糟,它会把真事故也一起淹掉。
 *
 * 记账修好、并在日志里观察到「陌生自发消息」长期为 0 之后,再把这个开关打开。
 * 期间 console 日志照常打（不打扰用户,但保留观察窗口）。
 *
 * 已验证干净的路径:jsonl-watcher 的流式推送(-# 💬 / 📖 / 🔧)、reply 正常回复、
 * 建线程的 THREAD_CREATED 系统消息。
 * **尚未验证**:交互响应(按钮点击后的 deferReply + editReply)——那条消息由
 * `/interactions/:id/:token/callback` 产生,POST 响应是空的,拿不到 message id,
 * 很可能同样记不上账。开开关之前必须先跑一个含按钮点击的观察窗口。
 */
/** 每次读环境变量而不是模块加载时定死——便于单测，也便于运维改完重启即生效 */
const alertEnabled = () => process.env.CLAUDESTRA_SELF_ECHO_ALERT === "1";

/**
 * 复核延迟：网关回声常常跑在 HTTP 响应前面，等这么久再判一次。
 * 3s 对本地网络绰绰有余，而这条路径只在「疑似陌生」时才走，正常流量零开销。
 */
export const RECHECK_MS = 3_000;

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

/**
 * 只有「我们主动 POST 出去的」消息类型才有可比性。
 *
 * Discord 会以**我们的身份**代发系统消息 —— 最典型的是建线程时自动出现的
 * `THREAD_CREATED`(type 18)，内容就是线程名（实测被误判的那条是
 * `🐚 bg shell b0kprvgzy`，来自 bg 活动追踪开线程）。这类消息不是我们 POST
 * 的，拿不到它的 id，也就永远记不上账 —— 只能按类型排除，否则每开一个线程
 * 就是一次假警。
 *
 * 放行 Default(0) 和 Reply(19)：这两类才是真正经由我们的发送出口产生的。
 */
export function isTrackableMessageType(type: number | undefined): boolean {
  return type === undefined || type === 0 || type === 19;
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
export async function noteSelfMessage(
  msg: {
    id: string;
    channelId: string;
    content?: string | null;
    author: { id: string };
    type?: number;
  },
  opts: { recheckMs?: number } = {},
): Promise<ForeignEchoAlert | null> {
  const me = getBotUserId();
  if (!me || msg.author.id !== me) return null;
  if (!isTrackableMessageType(msg.type)) return null; // 见下：Discord 代发的系统消息
  if (isBotMessage(msg.id)) return null; // 是本实例发的，正常

  // 关键复核：回声可能比 HTTP 响应先到，此刻「没记账」不代表「不是我发的」
  await Bun.sleep(opts.recheckMs ?? RECHECK_MS);
  if (isBotMessage(msg.id)) return null;

  const now = Date.now();
  const preview = (msg.content || "").replace(/\s+/g, " ").slice(0, 80);
  foreignEchoes.push({ at: now, channelId: msg.channelId, preview });
  while (foreignEchoes.length && now - foreignEchoes[0].at > ECHO_WINDOW_MS) foreignEchoes.shift();

  console.error(
    `👻 [self-echo] 收到一条本 bot 发出、但不是本实例发的消息 ` +
      `(channel=${msg.channelId}, 窗口内第 ${foreignEchoes.length} 条): ${preview}`,
  );

  if (!alertEnabled()) return null; // 见文件头:记账未修好前只观察不告警
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

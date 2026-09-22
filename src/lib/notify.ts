/**
 * 本机 daemon（launcher / cron / manager）发给用户的系统通知专用通道。
 *
 * 为什么不能再走 `type: "reply"`：bce6351（2026-07-26）起 bridge 拒收认不出来源
 * agent 的 reply——那是为了堵「兜底通道的消息被 SSE 挂到字面 "?" agent 名下 + 调用方
 * 还收到成功」的洞，是对的。但 daemon 的 bridge-client 连接本来就不是任何 agent，
 * 于是它们的 21 处告警（金丝雀失败、升级未生效、二进制挂死、恢复失败、cron 失败…）
 * 从那天起全被拒，又全被 `catch {}` 吞掉，近两个月一条都没到 #control。
 *
 * 修法是给「系统通知」一个显式的消息类型，而不是放宽 reply：
 *   - bridge 侧 `case "notify"` 只接受我们自己的频道（规则见 notifyTargetVerdict），
 *     发件人是 bridge 自己，SSE 事件只挂在目标频道的真实 agent 名下——认不出就不发，
 *     永远不会出现 "?"；reply 那道「认不出来源就拒」的门原样保留；
 *   - 发不出去**不再静默**：stderr 打一行，并追加一条 JSONL 到
 *     LOG_DIR/undelivered-alerts.log，事后能查到哪些告警没送达。
 *
 * notify() 永不抛——告警失败不能反过来打断调用方的主流程。
 */

import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { bridgeRequest } from "./bridge-client.js";
import { LOG_DIR } from "./log-paths.js";

export const UNDELIVERED_ALERTS_LOG = join(LOG_DIR, "undelivered-alerts.log");

export interface NotifyRequest {
  /** 谁发的（日志 / SSE 标签用），如 "launcher" / "cron" / "manager" */
  source: string;
  chatId: string;
  text: string;
  components?: unknown[];
  files?: string[];
}

/** notify 的 ws 消息体。独立成纯函数，便于测试「不会退化成 reply」。 */
export function buildNotifyMessage(req: NotifyRequest): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: "notify",
    source: req.source,
    chatId: req.chatId,
    text: req.text,
  };
  if (req.components?.length) msg.components = req.components;
  if (req.files?.length) msg.files = req.files;
  return msg;
}

export type NotifyVerdict = { ok: true; known: boolean } | { ok: false; reason: string };

/**
 * bridge 侧：这条系统通知能不能投。
 *   - control / registry 有主的 agent 频道 → 放行，known=true（SSE 挂到真实 agent 名下）；
 *   - 其它 Discord 频道（cron-add --channel 指定的报告频道）→ 放行但 known=false：
 *     只发 Discord，**不发 SSE**——bce6351 堵的正是「事件挂到字面 "?" 名下」；
 *   - api:* 等非 Discord 地址、local-* 里没登记的 → 拒：系统通知没有 HTTP 等待方，
 *     投过去只会重演「没人收、还报成功」。
 */
export function notifyTargetVerdict(
  chatId: unknown,
  ctx: { controlChannelId: string; knownChannelIds: Iterable<string> },
): NotifyVerdict {
  if (typeof chatId !== "string" || !chatId.trim()) {
    return { ok: false, reason: "notify 缺少 chatId" };
  }
  if (ctx.controlChannelId && chatId === ctx.controlChannelId) return { ok: true, known: true };
  for (const id of ctx.knownChannelIds) {
    if (id && id === chatId) return { ok: true, known: true };
  }
  if (/^\d{17,20}$/.test(chatId)) return { ok: true, known: false };
  return { ok: false, reason: `notify 目标既不是已登记频道也不是 Discord 频道: ${chatId}` };
}

type Sender = (msg: Record<string, unknown>) => Promise<unknown>;

/**
 * 发送系统通知。成功 true；失败 false 并留痕（stderr + undelivered-alerts.log）。
 * `send` / `logFile` 可注入，测试用。
 */
export async function notify(
  req: NotifyRequest,
  deps: { send?: Sender; logFile?: string } = {},
): Promise<boolean> {
  const send = deps.send ?? bridgeRequest;
  const logFile = deps.logFile ?? UNDELIVERED_ALERTS_LOG;
  if (!req.chatId) {
    // 没配 control 频道之类——不是投递失败，是无处可投；照样留痕，别让告警凭空消失
    await recordUndelivered(logFile, req, "chatId 为空（未配置目标频道）");
    return false;
  }
  try {
    await send(buildNotifyMessage(req));
    return true;
  } catch (e) {
    const reason = (e as Error)?.message || String(e);
    console.error(`📣 [notify:${req.source}] 投递失败: ${reason} —— ${req.text.slice(0, 120)}`);
    await recordUndelivered(logFile, req, reason);
    return false;
  }
}

async function recordUndelivered(logFile: string, req: NotifyRequest, reason: string): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: req.source,
    chatId: req.chatId,
    reason,
    text: req.text.slice(0, 2000),
  });
  try {
    await mkdir(join(logFile, ".."), { recursive: true });
    await appendFile(logFile, line + "\n");
  } catch (e) {
    console.error(`📣 [notify:${req.source}] 连未送达记录都写不进 ${logFile}: ${(e as Error).message}`);
  }
}

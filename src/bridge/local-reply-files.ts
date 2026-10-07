/**
 * 本机 agent 之间的答复带附件（bridge.ts 两处调：reply 推回等它的 caller、reply 到别的 agent 频道的转发）。
 * 两边在同一台机器，给 caller 的就是本机路径；但不能给 agent 传来的原路径：原文件常在临时目录、回复完就删，
 * 所以先拷进 inbox，给副本的绝对路径。形状同 Discord / API 入站：channel 头的 attachments=（meta.attachments）
 * 加正文的 `[attachment: 路径]` 行（Pi 只认正文，网页历史也按正文行还原）。
 * 拷不过去的（不存在、是目录、拷贝失败）写进 warning，reply 结果带给发送方，不报成功。单测 tests/local-reply-files.test.ts。
 */
import { join } from "node:path";
import { withAttachmentLines } from "../lib/inbound-body.js";
import { attachmentDirs } from "./local-api/attachments.js";
import { copyOutboundToInbox } from "./local-api/media-refresh.js";
import type { Envelope } from "./router.js";

export interface LocalReplyFiles {
  /** inbox 里副本的绝对路径 */
  attachments: string[];
  warning?: string;
}

/** 把 reply 的 files 拷进 inbox；agent = 发送方（媒体索引按它记出站副本的归属，同 api-reply-files.ts） */
export async function stageLocalReplyFiles(paths: readonly string[] | undefined, agent: string, copy = copyOutboundToInbox): Promise<LocalReplyFiles> {
  const attachments: string[] = [];
  const failed: string[] = [];
  for (const p of paths ?? []) {
    const [c] = await copy([p], agent); // 一个一个拷：它拷失败（含文件不存在）只记日志跳过，这里要知道是哪个
    if (c) attachments.push(join(attachmentDirs().inboxDirs[0]!, c.attachment));
    else failed.push(p);
  }
  return failed.length ? { attachments, warning: `附件可能没送达：${failed.join("、")} 不存在或拷贝失败，对方 agent 收不到` } : { attachments };
}

/** 给投往本机 agent 的信封挂上附件（没有附件原样返回） */
export function withLocalAttachments(env: Envelope, attachments: readonly string[]): Envelope {
  if (!attachments.length) return env;
  return { ...env, content: withAttachmentLines(env.content, attachments), meta: { ...env.meta, attachments: [...attachments] } };
}

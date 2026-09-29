import { isOwnerSource } from "./delegate-marker.js";

/**
 * 「停」字识别：只认整句（去掉标点空白和 Markdown / 引号包装后不超过 8 个字）就是停字，或同一个停字叠用（停停停、stop stop stop，最多叠 3 遍）。
 * 句首停字后面接着说别的（「停！先别合」「Stop hook 为啥没触发」「等等，还有一个需求」）一律不算：那是一句话，交给 agent 自己判断，
 * CC / Codex 本来就会被人类消息抢占。命中 = 三种运行时都立即发打断键、不提醒续做。单测 tests/stop-words.test.ts（含误判清单）。
 * 表来自设计稿 §3.6，加上 owner 09-28 批的「等一下 / 等等 / wait」、09-29 批的「停下来 / 暂停 / 打住 / 中止 / hold on」
 * （「暂停一下再说」按 owner 原意也算停，所以整句列进表；「等一下我再说」「等等再说」仍不算）。
 */

const STOP_WORDS = [
  "停", "停下", "停止", "先停", "停一下", "停停", "别做了", "别跑了", "不要做了", "取消", "等一下", "等等",
  "停下来", "暂停", "暂停一下", "先暂停", "暂停一下再说", "暂停再说", "打住", "中止",
  "stop", "abort", "cancel", "halt", "wait", "holdon", // 比对前去掉了空白：hold on → holdon
];
/** 标点、空白（语音转写常带「。」），以及 Markdown 和引号的包装（**停**、`stop`、> 停、「停」） */
const PUNCT = /[\s,.!?;:~…、，。！？；：～"'“”‘’()（）【】\-—*`>_「」『』《》〈〉]+/g;
/** 不可见的格式字符（零宽空格等）：夹在停字中间也照认，和 lib/delegate-marker.ts 的规范化同一个口径 */
const FORMAT_CHARS = /[\p{Cf}\uFE00-\uFE0F]/gu;
const MAX_WHOLE = 8;
/** 叠用超过 8 个字时最多认几遍（stop stop stop、hold on hold on）；再多多半是语音转写跑飞 */
const MAX_REPEAT = 3;
/** 带着「继续 / 接着」的不是停（「停，继续」「stop! 好了继续吧」） */
const GO_ON_RE = /继续|接着|go on|continue|carry on/i;

export interface StopMatch {
  /** 是不是「停」 */
  stop: boolean;
}

/** s 是 w 叠了几遍（不是叠用 = 0） */
function repeatsOf(s: string, w: string): number {
  return s.length % w.length === 0 && s === w.repeat(s.length / w.length) ? s.length / w.length : 0;
}

export function matchStopWord(text: string): StopMatch {
  const norm = text.normalize("NFKC").replace(FORMAT_CHARS, "").trim().toLowerCase();
  if (!norm || GO_ON_RE.test(norm)) return { stop: false };
  const bare = norm.replace(PUNCT, "");
  if (!bare) return { stop: false };
  return { stop: STOP_WORDS.some((w) => { const n = repeatsOf(bare, w); return n > 0 && (bare.length <= MAX_WHOLE || n <= MAX_REPEAT); }) };
}

/**
 * 一条人类消息是不是 owner 的「停」：停字（和它解除叫停的反面）只认 owner 本人（lib/delegate-marker.ts isOwnerSource）。
 * 外源（非 owner 的 API 用户）发「停」按普通消息处理：否则他们能中止 owner 的活、挂住 Autopilot，或者随口一句话解除 owner 的「停」。
 */
export function ownerStopOf(env: { from: { kind: string; owner?: boolean; peer?: string }; content: string }): { owner: boolean; stop: boolean } {
  const owner = isOwnerSource(env.from);
  return { owner, stop: owner && matchStopWord(env.content).stop };
}

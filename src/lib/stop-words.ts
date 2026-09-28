/**
 * 「停」字识别：只认整句（去掉标点空白后不超过 8 个字）就是停字，或同一个停字叠用（停停停、stop stop）。
 * 句首停字后面接着说别的（「停！先别合」「Stop hook 为啥没触发」「等等，还有一个需求」）一律不算：那是一句话，交给 agent 自己判断，
 * CC / Codex 本来就会被人类消息抢占。命中 = 三种运行时都立即发打断键、不提醒续做。单测 tests/stop-words.test.ts（含误判清单）。
 * 表来自设计稿 §3.6，加上 owner 09-28 批的「等一下 / 等等 / wait」。
 */

const STOP_WORDS = [
  "停", "停下", "停止", "先停", "停一下", "停停", "别做了", "别跑了", "不要做了", "取消", "等一下", "等等",
  "stop", "abort", "cancel", "halt", "wait",
];
/** 标点、空白（语音转写常带「。」） */
const PUNCT = /[\s,.!?;:~…、，。！？；：～"'“”‘’()（）【】\-—]+/g;
const MAX_WHOLE = 8;
/** 带着「继续 / 接着」的不是停（「停，继续」「stop! 好了继续吧」） */
const GO_ON_RE = /继续|接着|go on|continue|carry on/i;

export interface StopMatch {
  /** 是不是「停」 */
  stop: boolean;
}

function isRepeatOf(s: string, w: string): boolean {
  return s.length % w.length === 0 && s === w.repeat(s.length / w.length);
}

export function matchStopWord(text: string): StopMatch {
  const norm = text.normalize("NFKC").trim().toLowerCase();
  if (!norm || GO_ON_RE.test(norm)) return { stop: false };
  const bare = norm.replace(PUNCT, "");
  return { stop: !!bare && bare.length <= MAX_WHOLE && STOP_WORDS.some((w) => isRepeatOf(bare, w)) };
}

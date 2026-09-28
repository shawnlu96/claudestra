/**
 * 「停」字识别：只认整句是停字，或句首停字紧跟标点 / 空格（「停！先别合」「等一下，先看看 X」）。
 * 命中 = 三种运行时都立即发打断键、不提醒续做；句子剩下的部分照常交给 agent。句中出现（「我等一下再看」）不算。
 * 表故意小：误判的代价是停掉一个回合，漏判的代价是 Codex / Pi 停不下来。单测 tests/stop-words.test.ts。
 */

const ZH_STOP = ["停", "停下", "停下来", "停止", "先停", "先停下", "停一下", "停停", "暂停", "别做了", "别跑了", "不要做了", "取消", "等一下", "等等", "先等等", "先等一下"];
/** 后面跟空格也算停的英文词 */
const EN_STOP_SPACE = ["stop", "abort", "halt"];
/** 只在整句或紧跟标点时算停：「wait for the build」「cancel the order」是正常请求 */
const EN_STOP_PUNCT = ["wait", "cancel"];

const ALL = [...ZH_STOP, ...EN_STOP_SPACE, ...EN_STOP_PUNCT];
/** 标点、空白、常见语气收尾（语音转写常带「。」） */
const PUNCT = /[\s,.!?;:~…、，。！？；：～"'“”‘’()（）【】\-—]+/g;
/** 句首停字后允许的分隔：标点或空格 */
const LEAD_SEP = /^[\s,.!?;:~…、，。！？；：～—\-]+/;
const MAX_WHOLE = 8;

export interface StopMatch {
  /** 是不是「停」 */
  stop: boolean;
  /** 停字之后剩下的内容（整句停 = 空串） */
  rest: string;
}

const NO: StopMatch = { stop: false, rest: "" };

function isRepeatOf(s: string, w: string): boolean {
  return s.length % w.length === 0 && s === w.repeat(s.length / w.length);
}

export function matchStopWord(text: string): StopMatch {
  const norm = text.normalize("NFKC").trim().toLowerCase();
  if (!norm) return NO;
  // 整句：去掉标点空白后是停字本身或同一停字叠用（停停停、stop stop）
  const bare = norm.replace(PUNCT, "");
  if (bare && bare.length <= MAX_WHOLE && ALL.some((w) => isRepeatOf(bare, w))) return { stop: true, rest: "" };
  // 句首：最长的停字优先（「停下来」不能被「停」截走后把「下来」当正文）
  for (const w of [...ALL].sort((a, b) => b.length - a.length)) {
    if (!norm.startsWith(w)) continue;
    const after = norm.slice(w.length);
    const sep = after.match(LEAD_SEP)?.[0] ?? "";
    if (!sep) continue;
    if (EN_STOP_PUNCT.includes(w) && !sep.trim()) continue; // wait / cancel 后面只有空格：是句子的一部分
    return { stop: true, rest: text.normalize("NFKC").trim().slice(w.length + sep.length).trim() };
  }
  return NO;
}

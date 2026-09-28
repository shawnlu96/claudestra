/**
 * 输入框 @ 委托里 agent / peer 名字的准入规则（twin：src/lib/mention-name.ts ⇄ web/lib/chat/mention-name.ts，guard 逐行核对）。
 * 名字会原样拼进 agent 看到的指令行，对方 agent 名又是对方给的不可信文本，所以只收显式字符集：
 * ASCII 字母数字、汉字、平假名 / 片假名、韩文音节，外加非首位的 _ . -。\p{L} 太宽——韩文填充符（渲染成空白）、
 * 西里尔同形字、ˮ ǃ ː 这类长得像标点的修饰字母都算字母。要求 NFKC 规范形，挡住全角 / 兼容字符冒充。
 * bridge 在 GET /peers/contacts 里先过一遍，网页拼指令前再过一遍（tests/web-mention.test.ts）。
 */
const NAME_CHARS = "A-Za-z0-9\\u3400-\\u4DBF\\u4E00-\\u9FFF\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC\\uAC00-\\uD7A3";
const SAFE_NAME_RE = new RegExp(`^[${NAME_CHARS}][${NAME_CHARS}_.-]{0,63}$`, "u");

export function isSafeMentionName(name: string): boolean {
  return SAFE_NAME_RE.test(name) && name === name.normalize("NFKC");
}

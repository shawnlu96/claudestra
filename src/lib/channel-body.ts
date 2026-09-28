/**
 * 会话记录里入站 channel 消息的正文整理（session-history.ts 解包 <channel> 之后用）：剥掉 bridge 注入的 framing header、
 * 剥掉「待你处理」答复给 agent 看的说明行。纯字符串函数。
 */

/**
 * 剥掉 bridge renderContentForLocal 注入的 framing header：正文开头的
 * [🌐 …] / [🤖 …] 方括号块是给 agent 的路由/行为指示，不是用户输入。header 内可能
 * 出现 "]"（如 [DIRECT] 标记），所以用 "]\n\n" 或行尾 "]" + 空行做块边界，而不是
 * 第一个 "]"。没匹配到已知 emoji 开头就原样保留（不误伤以 [ 开头的真实输入）。
 */
export function stripChannelHeader(body: string): string {
  if (!/^\[(🌐|🤖|🤝|📢|📣)/.test(body)) return body;
  // header 块与正文用空行分隔——兼容 LF 与 CRLF（L7：CRLF jsonl 下 "]\n\n" 匹配不到
  // 会把 framing 头留在正文）。仍要求"]"+空行做边界，不用单个换行（正文里可能出现
  // "]\n"，会误切）。
  const m = body.match(/]\r?\n\r?\n/);
  if (!m || m.index === undefined) return body;
  return body.slice(m.index + m[0].length).trim();
}

/**
 * 会话记录里一条入站 channel 消息的正文：owner 对「待你处理」的作答（trigger="ask_answer"，bridge/asks.ts answerContent）
 * 第一行是给 agent 看的说明，历史里只留 owner 发的原文——和网页的乐观气泡、直播回显对得上。attrs = <channel …> 的属性串
 */
export function ownerWordsOfAnswer(attrs: string, text: string): string {
  return /(?:^|\s)trigger="ask_answer"/.test(attrs) ? text.split("\n").slice(1).join("\n").trim() : text;
}

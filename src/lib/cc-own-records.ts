/**
 * Claude Code 自己写进会话记录的裸 user 条目（不是人打的字）→ 历史里的样子（lib/session-history.ts 的历史与搜索共用）：
 *   <command-name>/x</command-name> ± <command-message>… ± <command-args>… → system「/x 参数」；<local-command-stdout> → system（去 ANSI、截断）
 *   <task-notification>（后台任务完成通知）→ system「⚙️ 摘要」；[Request interrupted by user…] → system「回合已中断」（网页画分隔线）
 *   队列回放的裸斜杠命令（tmux 注入的 /compact 经 CC 队列多落一条纯文本，紧跟着还有 <command-name> 记录）→ 跳过
 * 只认 Claude Code 会话：Pi / Codex 不写这些标记，它们记录里的就是用户正文（外人从 Discord 直发 Pi 的原文能以任何字开头），
 * 按标记转换会把后面的正文藏掉（tests/pi-foreign-attachments.test.ts）。非 CC 会话的 user 记录整条走 plainUserText。
 */
import { commandRecordLine, commandStdoutLine } from "./inbound-body.js";

/** skip = 不进历史；system = 一行 system 条目；null = 不是 CC 自己的记录，照用户正文处理 */
export type CcOwnRecord = { skip: true } | { system: string } | null;

/** runtime 是 runtimeForSessionPath 的结果：Claude Code（及认不出的）为 undefined */
const isCcRuntime = (runtime: string | undefined): boolean => runtime === undefined || runtime === "claude-code";

/**
 * 非 CC 会话（Pi / Codex …）的 user 记录 → 历史正文：原文照登，只去掉包装标签；CC 会话返回 undefined（走来源解包）。
 * 只有 CC 的 <channel> 是按 MCP meta 写的结构化来源；Pi 的包装是翻译层按正文里的注入头合成的、Codex 的由 channel-server
 * 拼成文本，头里的「web-ui」「bridge」谁都能写。所以这里不认来源、不剥头、不补附件、不藏任何一条（bridge 通知也照登），
 * 网页按来源不明处理（不画卡片、不还原回投）。改回按头认 = 外人伪造头冒充本人 / 藏字（tests/pi-foreign-attachments.test.ts）
 */
export function plainUserText(rec: { isMeta?: unknown }, text: string, runtime: string | undefined): string | undefined {
  if (isCcRuntime(runtime)) return undefined;
  if (rec.isMeta !== true) return text;
  const body = /^\s*<channel\s[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/channel>\s*$/.exec(text)?.[1];
  return body === undefined ? text : body.replace(BATCH_SEAM_RE, "\n\n");
}

/** ACP 把排队的几条各自包好、空行拼成一轮（lib/acp/turn.ts next）：拼缝处的闭 / 开标签也去掉，正文一字不少，属性照旧不认 */
const BATCH_SEAM_RE = /\r?\n<\/channel>\r?\n\r?\n<channel\s[^>]*>\r?\n/g;

export function ccOwnRecord(trimmed: string, runtime: string | undefined): CcOwnRecord {
  if (!isCcRuntime(runtime)) return null;
  if (/^\[Request interrupted/.test(trimmed)) return { system: "回合已中断" };
  if (/^<task-notification>/.test(trimmed)) {
    const body = /<summary>([\s\S]*?)<\/summary>/.exec(trimmed)?.[1]?.trim();
    return { system: body ? `⚙️ ${body}` : "⚙️ 后台任务通知" };
  }
  if (/^<command-(name|message)>/.test(trimmed)) {
    const cmd = commandRecordLine(trimmed);
    return cmd ? { system: cmd } : { skip: true }; // 无 command-name 的畸形命令记录直接丢
  }
  const stdout = commandStdoutLine(trimmed);
  if (stdout !== undefined) return stdout ? { system: stdout } : { skip: true };
  // channel 入站是 isMeta 包装、TUI 直敲只落 <command-name>，都不走这里；不跳过队列回放的这条会渲染成双份
  if (/^\/[\w:-]+$/.test(trimmed)) return { skip: true };
  return null;
}

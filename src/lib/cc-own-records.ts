/**
 * Claude Code 自己写进会话记录的裸 user 条目（不是人打的字）→ 历史里的样子（lib/session-history.ts 的历史与搜索共用）：
 *   <command-name>/x</command-name> ± <command-message>… ± <command-args>… → system「/x 参数」；<local-command-stdout> → system（去 ANSI、截断）
 *   <task-notification>（后台任务完成通知）→ system「⚙️ 摘要」；[Request interrupted by user…] → system「回合已中断」（网页画分隔线）
 *   队列回放的裸斜杠命令（tmux 注入的 /compact 经 CC 队列多落一条纯文本，紧跟着还有 <command-name> 记录）→ 跳过
 * 只认 Claude Code 会话：Pi / Codex 不写这些标记，它们记录里的就是用户正文（外人从 Discord 直发 Pi 的原文能以任何字开头），
 * 按标记转换会把后面的正文藏掉（tests/pi-foreign-attachments.test.ts）。非 CC 会话的 user 记录整条走 plainUserText，对上入站账的除外（T74）。
 */
import { wrapChannelContent } from "./codex-thread.js";
import { commandRecordLine, commandStdoutLine } from "./inbound-body.js";
import { inboundSha, type InboundLookup } from "./inbound-ledger.js";

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

/**
 * T74：非 CC 记录按 bridge 入站账（lib/inbound-ledger.ts）核对。只按上面的拼缝切块，每块的 message_id 只当查账键，块正文 sha256 要等于账上的；
 * 全部对上、按拼缝拼回正好等于原文，才返回用账上 meta 重渲染的块（原文头属性一个字不用）。任何一块不过 → null，整条走 plainUserText。
 * 改成逐块放行 = 外源写一段假拼缝、把 owner 的真 mid + 原文嵌进自己那条，就能冒充 owner（tests/foreign-runtime-headers.test.ts「伪造拼缝」）
 */
export function verifiedForeignBlocks(text: string, lookup: InboundLookup): string[] | null {
  const t = text.trim();
  const blocks: string[] = [];
  let from = 0;
  for (const m of t.matchAll(BATCH_SEAM_RE)) {
    blocks.push(t.slice(from, m.index + m[0].indexOf("</channel>") + "</channel>".length));
    from = m.index + m[0].indexOf("<channel");
  }
  blocks.push(t.slice(from));
  if (blocks.join("\n\n") !== t) return null;
  const out: string[] = [];
  for (const block of blocks) {
    const m = /^<channel\s([^>]*)>\n([\s\S]*)\n<\/channel>$/.exec(block);
    const mid = m ? /(?:^|\s)message_id="([^"]+)"/.exec(m[1])?.[1] : undefined;
    const entry = mid ? lookup(mid) : null;
    if (!m || !entry || inboundSha(m[2]) !== entry.sha) return null;
    const { after_interrupt: _typedIn, ...meta } = entry.meta; // 宿主包装时也去掉它（lib/acp/host.ts inbound）
    out.push(wrapChannelContent(m[2], meta, "ledger"));
  }
  return out;
}

/** 历史 / 搜索的入口：非 CC 的 isMeta 记录恰好一块且对上账 → 重渲染的 <channel>，交给 CC 的解包路径；其余 undefined。多块全对也先保守（拆条是 PR-B） */
export function verifiedForeignRecord(rec: { isMeta?: unknown }, text: string, runtime: string | undefined, lookup?: InboundLookup): string | undefined {
  if (!lookup || isCcRuntime(runtime) || rec.isMeta !== true) return undefined;
  try {
    const blocks = verifiedForeignBlocks(text, lookup);
    return blocks?.length === 1 ? blocks[0] : undefined;
  } catch {
    return undefined; // 查账函数自己出错（注入的 lookup 坏了）= 查不到，这条按保守显示，整页历史照常返回
  }
}

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

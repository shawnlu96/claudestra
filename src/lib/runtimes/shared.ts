/** 三个适配器共用的小工具（只依赖 Bun/fs，不回头依赖 manager）。 */

/**
 * 会话尾部最后一条「用户说的话」（会话列表的副标题）。
 *
 * 之前长在 manager.ts 里、每个 scanner 各传一个 runtime 字符串进去；现在由适配器
 * 自己把翻译函数带上，扫描逻辑就不用再认识 runtime 这个概念了。
 */
export async function lastUserTextOf(
  filePath: string,
  size: number,
  translate: (line: string) => Record<string, any> | null,
): Promise<string> {
  try {
    const tailStart = Math.max(0, size - 500_000);
    const tailChunk = await Bun.file(filePath).slice(tailStart, size).text();
    const lines = tailChunk.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = translate(lines[i]);
      if (!entry || entry.type !== "user") continue;
      const content = entry.message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const block = content.find((b: any) => b.type === "text" && b.text?.length > 3);
        if (block) text = block.text;
      }
      if (text && text.length > 3) {
        // Claude Code 的入站消息包在 <channel> 里；Pi / Codex 是裸文本
        const m = text.match(/<channel[^>]*>([\s\S]*?)<\/channel>/);
        if (m) text = m[1].trim();
        return text.replace(/\n/g, " ").slice(0, 80);
      }
    }
  } catch { /* non-critical */ }
  return "";
}

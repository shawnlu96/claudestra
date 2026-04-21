/**
 * 从 Claude Code 的 JSONL session 文件里抽取最近一条 assistant 的文字输出。
 *
 * 用途：bridge 的 reply 兜底 —— master/agent 处理完 Discord 消息却没调 reply()
 * 工具时，我们从 jsonl 里捞它的 assistant 文字答案，代它 post 到 Discord，避免
 * 用户只看到 Stop hook 的 "✅ 完成" 空通知。
 *
 * Claude Code 把每个 session 的事件（user / assistant / tool_use / tool_result
 * 等）一行一个 JSON 对象写到：
 *   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 *
 * cwd-slug 规则：cwd 的 "/" 直接替换为 "-"（例如 "/Users/he/foo" → "-Users-he-foo"）
 */
import { existsSync } from "fs";
import { readdir, stat } from "fs/promises";

/** cwd 转换为 Claude Code 的 project 目录 slug */
export function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/** 找 cwd 对应 Claude Code project 目录里最新的 .jsonl（mtime 最大那个） */
export async function findLatestJsonl(cwd: string): Promise<string | null> {
  const slug = cwdToProjectSlug(cwd);
  const dir = `${process.env.HOME}/.claude/projects/${slug}`;
  if (!existsSync(dir)) return null;
  try {
    const files = await readdir(dir);
    let best: { path: string; mtime: number } | null = null;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = `${dir}/${f}`;
      try {
        const s = await stat(full);
        if (!best || s.mtimeMs > best.mtime) best = { path: full, mtime: s.mtimeMs };
      } catch { /* skip */ }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 jsonl 末尾倒着扫，找**最近一次** assistant 的文字（type:"text"）输出。
 * 跳过 tool_use / tool_result 行。返回合并后的 text，没找到返回 null。
 *
 * 可选 `sinceMs`：忽略 timestamp 比这更早的条目（粗粒度过滤，避免拿到上一轮残留）。
 */
export async function extractLatestAssistantText(
  jsonlPath: string,
  opts: { sinceMs?: number } = {}
): Promise<string | null> {
  try {
    const content = await Bun.file(jsonlPath).text();
    const lines = content.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj: any;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      if (obj.type !== "assistant") continue;
      if (opts.sinceMs) {
        const ts = Date.parse(obj.timestamp || "");
        if (Number.isFinite(ts) && ts < opts.sinceMs) return null; // 再往前都是旧的
      }
      const arr = obj?.message?.content;
      if (!Array.isArray(arr)) continue;
      const texts = arr.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text.trim()).filter(Boolean);
      if (texts.length === 0) continue;
      return texts.join("\n\n").trim();
    }
    return null;
  } catch {
    return null;
  }
}

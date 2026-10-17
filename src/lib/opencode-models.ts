/**
 * OpenCode 自己报的可用模型（`opencode models`，一行一个 provider/model），给网页新建弹窗的模型下拉（runtimes/catalog.ts）。
 * 不用 ACP session/new 回包里那份更全的列表：拿它要建一个会话，OpenCode 一建就落库，每次打开弹窗都会留一个空会话。
 * 代价是 CLI 少列几个免费模型（docs/runtimes/opencode-acp.md「已知限制」）。一次要 ~5s，按 5 分钟缓存；失败不缓存。
 */
import { defaultRunner, type Runner } from "./codex-thread.js";
import { opencodeBin, opencodeDirsEnv } from "./acp/opencode-bin.js";

const TTL_MS = 5 * 60_000;
let cache: { at: number; models: string[] } | null = null;

export function parseOpencodeModels(out: string): string[] {
  // provider/model，model 段可以再带斜杠（openrouter/anthropic/claude-x）
  return [...new Set(out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:@+/-]+$/.test(l)))];
}

export async function opencodeModels(run: Runner = defaultRunner, bin = opencodeBin(), now = Date.now()): Promise<string[]> {
  if (cache && now - cache.at < TTL_MS) return cache.models;
  if (!bin) return [];
  const dirs = Object.entries(opencodeDirsEnv()).map(([k, v]) => `${k}=${v}`); // 沙箱：用沙箱里那份 OpenCode 目录
  const r = await run([...(dirs.length ? ["/usr/bin/env", ...dirs] : []), bin, "models"], 20_000);
  const models = r.ok ? parseOpencodeModels(r.out) : [];
  if (!r.ok) console.error(`[opencode] opencode models 失败：${r.err.slice(0, 200)}`);
  if (models.length) cache = { at: now, models };
  return models;
}

/** 单测用 */
export function resetOpencodeModelsCache(): void {
  cache = null;
}

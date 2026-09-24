/**
 * Codex 的模型目录（网页 Codex 切换器的选项 + 顶栏在会话没写档位时的默认值）。
 *
 * 来源是 `codex debug models`（Codex 自己的目录，约 0.7s，带每个模型支持的推理档位和默认档）。
 * 不读 ~/.codex/models_cache.json：那份会被别的 Codex 客户端（桌面 App，版本更旧）覆盖，
 * 实测里面会缺 CLI 当前的默认模型。
 * 纯解析函数可单测（tests/codex-catalog.test.ts）；加载带 10 分钟内存缓存，agents 列表只读缓存、
 * 缺了就在后台补，不让列表等一次子进程。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_EFFORT_LEVELS, resolveCodexBinary } from "./codex-launch.js";
import { defaultRunner, type Runner } from "./codex-thread.js";

export interface CodexModel {
  id: string;
  name: string;
  /** 这个模型支持的推理档位（Codex 的名字：low / medium / high / xhigh / max / ultra …） */
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
}

/** `codex debug models` 的 JSON → 选择器要的清单（只留 visibility=list，按 priority 排） */
export function parseCodexCatalog(raw: unknown): CodexModel[] {
  const list = (raw as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m: any) => m && typeof m.slug === "string" && m.visibility === "list")
    .sort((a: any, b: any) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((m: any) => ({
      id: m.slug,
      name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
      efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((l: any) => l?.effort)
        .filter((e: unknown): e is string => typeof e === "string" && !!e),
      defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : null,
      contextWindow: typeof m.context_window === "number" ? m.context_window : null,
    }));
}

/** config.toml 顶层（第一个 [表] 之前）的 model / model_reasoning_effort；没写就是 null */
export function parseCodexConfigDefaults(toml: string): { model: string | null; effort: string | null } {
  const out = { model: null as string | null, effort: null as string | null };
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*(model|model_reasoning_effort)\s*=\s*"([^"]*)"/.exec(line);
    if (m && m[2]) out[m[1] === "model" ? "model" : "effort"] = m[2];
  }
  return out;
}

/** 会话里没写模型 / 档位时显示什么：config.toml 写了就用它，否则目录排第一的模型和该模型的默认档 */
export function codexDisplayDefaults(
  catalog: CodexModel[] | null,
  cfg: { model: string | null; effort: string | null },
  model: string | null,
): { model: string | null; effort: string | null } {
  const m = model ?? cfg.model ?? catalog?.[0]?.id ?? null;
  const effort = cfg.effort ?? catalog?.find((x) => x.id === m)?.defaultEffort ?? null;
  return { model: m, effort };
}

/**
 * 切换请求的校验（值会进 `codex resume` 的启动命令）：目录拉得到就只认目录里的模型、该模型支持的档位；
 * 拉不到退回 Codex 档位全集 + 字符白名单。返回错误文案，null = 可以切。
 */
export function validateCodexChoice(
  catalog: CodexModel[] | null,
  choice: { model: string; effort: string; targetModel: string | null },
): string | null {
  const { model, effort, targetModel } = choice;
  if (model && !/^[A-Za-z0-9._:-]+$/.test(model)) return "model 含非法字符";
  if (model && catalog && !catalog.some((m) => m.id === model)) return `未知的 Codex 模型：${model}`;
  if (!effort) return null;
  if (!(CODEX_EFFORT_LEVELS as readonly string[]).includes(effort)) return `未知的推理档位：${effort}`;
  const m = catalog?.find((x) => x.id === targetModel);
  if (m && m.efforts.length && !m.efforts.includes(effort)) return `${m.name} 不支持 ${effort}（可用：${m.efforts.join(" / ")}）`;
  return null;
}

const TTL_MS = 10 * 60_000;
let cache: { at: number; models: CodexModel[] } | null = null;
let inflight: Promise<CodexModel[] | null> | null = null;

/** 拉目录（带缓存）；codex 不在 / 子进程失败返回 null */
export async function loadCodexCatalog(run: Runner = defaultRunner): Promise<CodexModel[] | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  inflight ??= (async () => {
    try {
      const bin = (await resolveCodexBinary(run))?.real;
      if (!bin) return null;
      const r = await run([bin, "debug", "models"], 15_000);
      if (!r.ok) return null;
      const models = parseCodexCatalog(JSON.parse(r.out));
      if (models.length) cache = { at: Date.now(), models };
      return models.length ? models : null;
    } catch (e) {
      console.warn(`[codex-catalog] 读取 Codex 模型目录失败: ${(e as Error).message}`);
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 同步读缓存（过期也先给旧的）并在后台刷新：给 agents 列表这种不能等子进程的地方用 */
export function cachedCodexCatalog(): CodexModel[] | null {
  if (!cache || Date.now() - cache.at >= TTL_MS) void loadCodexCatalog();
  return cache?.models ?? null;
}

export function readCodexConfigDefaults(home: string = homedir()): { model: string | null; effort: string | null } {
  const p = join(home, ".codex", "config.toml");
  try {
    return existsSync(p) ? parseCodexConfigDefaults(readFileSync(p, "utf8")) : { model: null, effort: null };
  } catch {
    return { model: null, effort: null }; // 读不到就当没写默认值，显示回落到目录
  }
}

/**
 * Claude Code 的模型目录——web 的模型下拉（新建弹窗 / TopBar 切换器 / 设置页全局默认）
 * 从这里取，不再各写一份。
 *
 * CC 的 `/model` 菜单不是写死的：它拉一份服务端目录，落盘在
 * `~/.claude/cache/model-catalog/<账号>-<hash>-cc.json`（按账号过滤过，约 1h 过期，
 * CC 运行时自己刷新）。同一份目录也有公开的签名版本
 * `https://downloads.claude.ai/model-catalog/v1/catalog.json`（裸 GET，7 天有效，
 * 不按账号过滤）。两处地址都是从 CC 2.1.280 二进制里翻出来的，**不是公开契约**，
 * 格式变了就退到下一档。
 *
 * 取数顺序：本地缓存 → 公开端点 → claude-launch.ts 的别名表（最后兜底，保证下拉不空）。
 * 此前两张写死的表（后端别名表 + 前端 MODEL_CATALOG）一起落后上游：2026-09-22 目录里
 * 已有 Opus 5.5 / Opus 4.6，两张表都没有。
 */
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { MODEL_ALIASES } from "./claude-launch.js";

export interface CatalogModel {
  id: string;
  name: string;
  /** "main" = 主菜单；"overflow" = 折叠区（旧代） */
  section: string;
}

export interface ModelCatalog {
  source: "local-cache" | "remote" | "builtin";
  models: CatalogModel[];
}

export const REMOTE_CATALOG_URL = "https://downloads.claude.ai/model-catalog/v1/catalog.json";

export function modelCatalogDir(): string {
  return join(process.env.HOME || "~", ".claude", "cache", "model-catalog");
}

function toModels(raw: unknown): CatalogModel[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CatalogModel[] = [];
  for (const m of raw) {
    if (typeof m?.id !== "string" || !m.id) continue;
    out.push({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : labelFromId(m.id),
      section: typeof m.section === "string" ? m.section : "main",
    });
  }
  return out.length ? out : null;
}

/** 本地缓存文件：`{ catalog: { config: { models: [...] } } }` */
export function parseLocalCache(json: unknown): CatalogModel[] | null {
  return toModels((json as any)?.catalog?.config?.models);
}

/** 公开端点：`{ surfaces: { cc: { model_selector_config: [{ id: "cc", models: [...] }] } } }` */
export function parseRemoteCatalog(json: unknown): CatalogModel[] | null {
  const cfg = (json as any)?.surfaces?.cc?.model_selector_config;
  const cc = Array.isArray(cfg) ? cfg.find((c: any) => c?.id === "cc") ?? cfg[0] : cfg;
  return toModels(cc?.models);
}

/** `claude-opus-5-5` → `Opus 5.5`；`claude-haiku-4-5-20251001` → `Haiku 4.5`（去掉日期后缀） */
export function labelFromId(id: string): string {
  const parts = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  const family = parts.shift() ?? id;
  const head = family.charAt(0).toUpperCase() + family.slice(1);
  return parts.length ? `${head} ${parts.join(".")}` : head;
}

/** 别名表里的 model id 去重（裸名与带版本号别名指向同一个 id）。 */
export function builtinCatalog(): CatalogModel[] {
  return [...new Set(Object.values(MODEL_ALIASES))].map((id) => ({ id, name: labelFromId(id), section: "main" }));
}

async function readLocalCache(dir: string): Promise<CatalogModel[] | null> {
  // 多个账号登录过会有多份，取最新写入的那份
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith("-cc.json"));
  const withTime = await Promise.all(
    files.map(async (f) => ({ f, t: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  for (const { f } of withTime.sort((a, b) => b.t - a.t)) {
    try {
      const models = parseLocalCache(JSON.parse(await readFile(join(dir, f), "utf8")));
      if (models) return models;
    } catch { /* 坏文件跳过，看下一份 */ }
  }
  return null;
}

async function fetchRemote(url: string, timeoutMs: number): Promise<CatalogModel[] | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? parseRemoteCatalog(await res.json()) : null;
  } catch {
    return null;
  }
}

export interface LoadOpts {
  dir?: string;
  url?: string;
  timeoutMs?: number;
  /** 测试注入 */
  fetchRemote?: typeof fetchRemote;
}

export async function loadModelCatalog(opts: LoadOpts = {}): Promise<ModelCatalog> {
  const local = await readLocalCache(opts.dir ?? modelCatalogDir());
  if (local) return { source: "local-cache", models: local };
  const remote = await (opts.fetchRemote ?? fetchRemote)(opts.url ?? REMOTE_CATALOG_URL, opts.timeoutMs ?? 5000);
  if (remote) return { source: "remote", models: remote };
  return { source: "builtin", models: builtinCatalog() };
}

/**
 * v2.21+ Project 数据模型(owner 2026-08-28:「添加一个 project 的概念,多个 agent
 * 同属一个 project,共享一个或多个工作目录,UI 上能看出归属并方便管理」)。
 *
 * project = 归组元数据:一组工作目录 + 一组 agent。不参与消息路由——路由仍走
 * registry 的 channelId,project 只负责「谁和谁是一伙的、代码都在哪」。
 *
 * 存 ~/.claude-orchestrator/projects.json。写者纪律与 registry 相同:manager.ts
 * 是唯一写者(bridge 的管理端点委托 runManager),bridge 侧只读。
 * agent → project 的归属记在 registry 条目的 `projectId` 字段(⚠ 不能复用
 * 历史遗留的 `project` 字段——那里存的是创建时的原始 dir 字符串)。
 */

import { existsSync } from "fs";
import { mkdir, readFile, writeFile, rename } from "fs/promises";

const HOME = process.env.HOME || "";
const DIR = `${HOME}/.claude-orchestrator`;
export const PROJECTS_PATH = `${DIR}/projects.json`;

export interface ProjectDef {
  /** slug id(小写字母数字/-/_,≤32),CLI 与 registry.projectId 都用它 */
  id: string;
  /** 显示名(自由文本,CJK ok)。缺省 = id */
  name: string;
  emoji?: string;
  /** 工作目录集合(绝对路径)。一个 project 可以横跨多个仓,如 qingniao 的 miniapp + backend */
  dirs: string[];
  description?: string;
  createdAt: string;
}

export interface ProjectsData {
  projects: ProjectDef[];
}

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export async function readProjects(path = PROJECTS_PATH): Promise<ProjectsData> {
  if (!existsSync(path)) return { projects: [] };
  try {
    const raw = JSON.parse(await readFile(path, "utf-8"));
    const list = Array.isArray(raw?.projects) ? raw.projects : [];
    const projects: ProjectDef[] = [];
    for (const p of list) {
      if (!p || typeof p.id !== "string" || !p.id) continue;
      projects.push({
        id: p.id,
        name: typeof p.name === "string" && p.name ? p.name : p.id,
        emoji: typeof p.emoji === "string" ? p.emoji : undefined,
        dirs: Array.isArray(p.dirs) ? p.dirs.filter((d: unknown) => typeof d === "string" && d) : [],
        description: typeof p.description === "string" ? p.description : undefined,
        createdAt: typeof p.createdAt === "string" ? p.createdAt : "",
      });
    }
    return { projects };
  } catch {
    return { projects: [] };
  }
}

let writeSeq = 0;
export async function writeProjects(data: ProjectsData, path = PROJECTS_PATH): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/")) || DIR;
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  // 原子写(tmp+rename),与 registry/peers 同款——防并发读者读到半写 JSON
  const tmp = `${path}.${process.pid}.${writeSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

/** 目录归一:展开 ~、去尾斜杠。不做 realpath(symlink 语义交给调用方的输入) */
export function normalizeDir(dir: string): string {
  let d = dir.trim();
  if (d.startsWith("~")) d = HOME + d.slice(1);
  while (d.length > 1 && d.endsWith("/")) d = d.slice(0, -1);
  return d;
}

/**
 * 「傘形根」:家目录 / 根 / 系统临时目录这类无所不包的路径。作为 project dir 时
 * 只允许**精确匹配**,禁止前缀吞并——否则一个 cwd=$HOME 的 agent 自动建出的
 * project 会把家目录下所有后来者全吸进去(2026-08-28 首次迁移实测翻车)。
 */
export function isUmbrellaDir(d: string): boolean {
  return d === "/" || d === HOME || d === "/tmp" || d === "/private/tmp" || d === "/var/tmp";
}

/**
 * v2.21.3+ 该 agent 的归属是否**只靠傘形根 dir 的前缀**沾边——2026-08-28 首次迁移
 * 事故的残留形态(cwd=~/repos/x 的 agent 挂在 dirs=[$HOME] 的 project 下;owner
 * 2026-09-02 截图「家目录杂项 6 个 agent」实为 3 真 3 假)。
 * - 任一 dir 精确等于 cwd、或非傘形 dir 是 cwd 的前缀 → 归属成立,false
 * - 否则有傘形 dir 是 cwd 的前缀 → 误归属,true
 * - 完全不沾边(显式 --project 指到别处的 review/test agent)→ false,那是用户的决定
 */
export function isMisfiledByUmbrella(project: ProjectDef, dir: string): boolean {
  const d = normalizeDir(dir);
  let umbrellaHit = false;
  for (const raw of project.dirs) {
    const pd = normalizeDir(raw);
    if (d === pd) return false;
    if (d.startsWith(pd + "/")) {
      if (!isUmbrellaDir(pd)) return false;
      umbrellaHit = true;
    }
  }
  return umbrellaHit;
}

/**
 * 按目录找归属 project:cwd 等于某个 project dir、或位于其之下(前缀 + "/";
 * 傘形根 dir 不参与前缀匹配)。多个命中取 dir 最长(最具体)的那个。找不到返回 null。
 */
export function resolveProjectForDir(projects: ProjectDef[], dir: string): ProjectDef | null {
  const d = normalizeDir(dir);
  let best: { p: ProjectDef; len: number } | null = null;
  for (const p of projects) {
    for (const raw of p.dirs) {
      const pd = normalizeDir(raw);
      if (d === pd || (!isUmbrellaDir(pd) && d.startsWith(pd + "/"))) {
        if (!best || pd.length > best.len) best = { p, len: pd.length };
      }
    }
  }
  return best?.p ?? null;
}

/**
 * 从目录 basename 生成可用的 project id:小写化、非法字符转 "-"、截 32。
 * 与现有 id 冲突时(同名不同目录)加 -2/-3 后缀。CJK basename 会被清空 →
 * 回退 "proj"(显示名仍保留原文,不损失可读性)。
 */
export function slugifyProjectId(base: string, taken: Set<string>): string {
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
  if (!slug || !PROJECT_ID_RE.test(slug)) slug = "proj";
  if (!taken.has(slug)) return slug;
  for (let i = 2; ; i++) {
    const cand = `${slug.slice(0, 28)}-${i}`;
    if (!taken.has(cand)) return cand;
  }
}

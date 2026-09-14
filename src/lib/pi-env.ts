/**
 * Pi 环境管理：一个 Pi agent 到底带了哪些能力（看得见）+ 按 agent 决定带哪些（管得住）。
 *
 * 为什么需要：Pi 的能力不是一个整体，而是三层拼起来的 ——
 *   ① 全局 `~/.pi/agent/`（settings.json 的 packages[]/extensions[]、skills/、mcp.json、models.json）
 *   ② 项目 `<cwd>/.pi/`（settings.json、extensions/、skills/、.agents/skills）+ AGENTS.md/CLAUDE.md
 *   ③ 进程启动参数（--no-extensions / -e / --tools / --exclude-tools / --mcp-config …）
 * 三层都随「谁在用这台机器」而变。Claudestra 纳管 Pi 会话后，一个 cron 临时 agent 会
 * 静默继承桌面那十几个包（联网搜索、子代理、知识库…）——既不可知也不可控。
 *
 * 实测（pi 0.85.1，扩展 API 读真实加载结果）：
 *   默认               → 65 个工具 / 83 个命令（pi-lens、pi-subagents、fff、mcp、知识库…全在）
 *   --no-extensions    →  8 个工具（只剩内置 bash/edit/find/grep/ls/powershell/read/write）
 *   + --no-skills 等    →  8 个工具 / 1 个命令
 * 即 `--no-extensions` 连**包里的**扩展一起关掉（包通过 settings 的 packages[] 贡献扩展），
 * 所以「最小集」是真最小集，不是看起来最小。
 *
 * 本文件只做两件事：把档案翻译成启动参数（纯函数，可测）+ 从磁盘读出可观测清单。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** 一个 Pi agent 的能力档案。缺省 = 继承全局（不改动既有行为） */
export interface PiEnvProfile {
  /**
   * inherit（默认）= 用户全局环境全继承；minimal = 只留内置工具 + Claudestra 通道扩展。
   * minimal 会关掉扩展/技能/提示模板三类发现；**上下文文件（AGENTS.md/CLAUDE.md）保持开启**
   * ——那是「这个仓库怎么干活」的知识，关掉等于让 agent 瞎干，且与 Claude Code 侧行为不一致。
   */
  base?: "inherit" | "minimal";
  /** 额外加载的扩展（路径 / npm: / git:），base=minimal 时用来精确挑选 */
  extensions?: string[];
  /** 额外加载的技能目录或文件 */
  skills?: string[];
  /** 只启用这些工具（白名单）。与 excludeTools 同时给出时由 Pi 自己决定优先级，别这么用 */
  tools?: string[];
  /** 禁用这些工具（黑名单） */
  excludeTools?: string[];
  /** 指定 MCP 配置文件（base=minimal 时全局 mcp.json 不会加载，要 MCP 就用它显式给） */
  mcpConfig?: string;
  /**
   * 是否信任 agent 工作目录里的项目级 Pi 资源（`.pi/`、`.agents/skills`）。
   * 默认 true —— 与 Claude Code 侧一致（那边也是自动确认信任弹窗）。置 false 会加
   * `--no-approve`：项目里的扩展不加载、项目设置里的装包也不执行。
   * 记进档案是为了让这个选择**在界面上可见**，而不是藏在启动命令里。
   */
  trustProject?: boolean;
}

const BASE_VALUES = ["inherit", "minimal"] as const;

/** 把 registry 里的原始值归一成档案（脏数据不抛，按缺省处理） */
export function normalizePiEnvProfile(raw: unknown): PiEnvProfile {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const strArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const items = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return items.length ? items : undefined;
  };
  const base = typeof o.base === "string" && (BASE_VALUES as readonly string[]).includes(o.base)
    ? (o.base as PiEnvProfile["base"])
    : undefined;
  const out: PiEnvProfile = {};
  if (base) out.base = base;
  const ext = strArr(o.extensions);
  if (ext) out.extensions = ext;
  const skills = strArr(o.skills);
  if (skills) out.skills = skills;
  const tools = strArr(o.tools);
  if (tools) out.tools = tools;
  const exclude = strArr(o.excludeTools);
  if (exclude) out.excludeTools = exclude;
  if (typeof o.mcpConfig === "string" && o.mcpConfig.trim()) out.mcpConfig = o.mcpConfig.trim();
  if (typeof o.trustProject === "boolean") out.trustProject = o.trustProject;
  return out;
}

/** 判断 `-e` 的 source 是不是包源（npm:/git:/http）而不是文件路径 */
export function isPackageSource(source: string): boolean {
  return /^(npm:|git:|https?:)/.test(source.trim());
}

/**
 * 档案 → Pi 启动参数（不含 --approve/--no-approve，那个由 pi-launch 统一处理）。
 *
 * ⚠ 顺序不是随意的，实测（pi 0.85.1）：**包源（`-e npm:…`）必须排在文件路径之前**，
 * 否则包源被静默忽略——同样参数只换顺序，`npm:@ff-labs/pi-fff` 从「加载」变「不加载」：
 *   `--no-extensions -e npm:pkg -e /path/probe.ts`  → fff 工具在 ✓
 *   `--no-extensions -e /path/probe.ts -e npm:pkg`  → fff 工具没了 ✗（会话正常，快照有写）
 * 所以这里固定输出 [--no-*] → [包源] → [路径] 的顺序，调用方只管在后面接自己的 -e。
 */
export function piEnvFlags(env: PiEnvProfile | undefined): string[] {
  const profile = env ?? {};
  const flags: string[] = [];
  // ① 发现开关必须排在第一个 -e 之前
  if (profile.base === "minimal") {
    flags.push("--no-extensions", "--no-skills", "--no-prompt-templates");
  }
  if (profile.trustProject === false) flags.push("--no-approve");
  // ② 额外扩展：包源在前，路径在后（见上方实测）
  const extras = profile.extensions ?? [];
  for (const src of [...extras.filter(isPackageSource), ...extras.filter((s) => !isPackageSource(s))]) {
    flags.push("--extension", src);
  }
  for (const s of profile.skills ?? []) flags.push("--skill", s);
  if (profile.tools?.length) flags.push("--tools", profile.tools.join(","));
  if (profile.excludeTools?.length) flags.push("--exclude-tools", profile.excludeTools.join(","));
  if (profile.mcpConfig) flags.push("--mcp-config", profile.mcpConfig);
  return flags;
}

/** 档案的一句话描述（CLI / 界面用） */
export function describePiEnvProfile(env: PiEnvProfile | undefined): string {
  const p = env ?? {};
  const parts: string[] = [p.base === "minimal" ? "最小集（不继承全局）" : "继承全局"];
  if (p.extensions?.length) parts.push(`+扩展 ${p.extensions.length}`);
  if (p.skills?.length) parts.push(`+技能 ${p.skills.length}`);
  if (p.tools?.length) parts.push(`工具白名单 ${p.tools.length}`);
  if (p.excludeTools?.length) parts.push(`禁工具 ${p.excludeTools.join("/")}`);
  if (p.mcpConfig) parts.push(`MCP 配置 ${p.mcpConfig}`);
  if (p.trustProject === false) parts.push("不信任项目资源");
  return parts.join("，");
}

// ────────────────────────────────────────────────────────────
// 可观测：磁盘上的静态清单
// ────────────────────────────────────────────────────────────

export interface PiGlobalEnv {
  settingsPath: string;
  packages: string[];
  extensions: string[];
  skillPaths: string[];
  /** ~/.pi/agent/extensions/*.ts 里的本地扩展 */
  localExtensions: string[];
  /** ~/.pi/agent/skills/ 下的技能目录 */
  localSkills: string[];
  /** mcp.json 里配置的 MCP 服务器名 */
  mcpServers: string[];
  /** models.json 里的 provider 名 */
  providers: string[];
  /** 全局上下文/记忆文件是否在位 */
  memoryFiles: string[];
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

/** 读全局 Pi 环境（agentDir 默认 ~/.pi/agent） */
export function readPiGlobalEnv(agentDir = join(homedir(), ".pi", "agent")): PiGlobalEnv {
  const settingsPath = join(agentDir, "settings.json");
  const settings = readJson(settingsPath) ?? {};
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const mcp = readJson(join(agentDir, "mcp.json")) ?? {};
  const models = readJson(join(agentDir, "models.json")) ?? {};
  return {
    settingsPath,
    packages: strArr(settings.packages),
    extensions: strArr(settings.extensions),
    skillPaths: strArr(settings.skills),
    localExtensions: listDir(join(agentDir, "extensions")).filter((n) => n.endsWith(".ts")),
    localSkills: listDir(join(agentDir, "skills")),
    mcpServers: Object.keys(mcp?.mcpServers ?? {}),
    providers: Object.keys(models?.providers ?? {}),
    memoryFiles: ["MEMORY.md", "AGENTS.md", "CLAUDE.md"].filter((n) => existsSync(join(agentDir, n))),
  };
}

export interface PiProjectEnv {
  /** 项目级设置是否在位（它存在 ⇒ Pi 启动时会要求信任，除非 --approve/--no-approve） */
  settingsPresent: boolean;
  extensions: string[];
  skills: string[];
  mcpServers: string[];
  contextFiles: string[];
  /** 项目级 skills 也可能在 .agents/skills */
  agentSkills: string[];
}

/** 读某个工作目录里的项目级 Pi 资源 */
export function readPiProjectEnv(cwd: string): PiProjectEnv {
  const piDir = join(cwd, ".pi");
  const settings = readJson(join(piDir, "settings.json")) ?? {};
  const projectMcp = readJson(join(cwd, ".mcp.json")) ?? {};
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  return {
    settingsPresent: isFile(join(piDir, "settings.json")),
    extensions: listDir(join(piDir, "extensions")).filter((n) => n.endsWith(".ts")),
    skills: listDir(join(piDir, "skills")),
    mcpServers: Object.keys(projectMcp?.mcpServers ?? {}),
    contextFiles: ["AGENTS.md", "CLAUDE.md"].filter((n) => isFile(join(cwd, n))),
    agentSkills: listDir(join(cwd, ".agents", "skills")),
  };
}

// ────────────────────────────────────────────────────────────
// 可观测：运行时的真实清单（由 Pi 扩展在会话启动时写下）
// ────────────────────────────────────────────────────────────

export interface PiRuntimeSnapshot {
  at: string;
  agent: string;
  sessionId?: string;
  cwd?: string;
  piVersion?: string;
  toolCount: number;
  tools: string[];
  activeTools?: string[];
  commandCount: number;
  commands?: string[];
  model?: string;
  thinking?: string;
}

/** 运行时快照落点（Pi 扩展写、manager/web 读；与 registry 分开是为了不让 bridge 变写者） */
export function piEnvSnapshotPath(agent: string, home = homedir()): string {
  return join(home, ".claude-orchestrator", "pi-env", `${agent}.json`);
}

export function readPiRuntimeSnapshot(agent: string, home = homedir()): PiRuntimeSnapshot | null {
  const raw = readJson(piEnvSnapshotPath(agent, home));
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    at: typeof o.at === "string" ? o.at : "",
    agent: typeof o.agent === "string" ? o.agent : agent,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    piVersion: typeof o.piVersion === "string" ? o.piVersion : undefined,
    toolCount: typeof o.toolCount === "number" ? o.toolCount : arr(o.tools).length,
    tools: arr(o.tools),
    activeTools: arr(o.activeTools).length ? arr(o.activeTools) : undefined,
    commandCount: typeof o.commandCount === "number" ? o.commandCount : arr(o.commands).length,
    commands: arr(o.commands).length ? arr(o.commands) : undefined,
    model: typeof o.model === "string" ? o.model : undefined,
    thinking: typeof o.thinking === "string" ? o.thinking : undefined,
  };
}

/** 快照是否还新鲜（超过 maxAgeMs 视为过期：会话已经换过或早已结束） */
export function snapshotIsFresh(snap: PiRuntimeSnapshot | null, now = Date.now(), maxAgeMs = 7 * 24 * 3600_000): boolean {
  if (!snap?.at) return false;
  const t = Date.parse(snap.at);
  return Number.isFinite(t) && now - t <= maxAgeMs;
}

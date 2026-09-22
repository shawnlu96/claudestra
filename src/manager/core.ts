/**
 * manager 各命令族共用的核心：registry 读写、stdout JSON 输出、名字校验与 argv flag 解析。
 * 只放无副作用的定义——manager.ts 顶层就是 switch 执行，子模块绝不能反向 import 它。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { writeJsonAtomic } from "../lib/state-file.js";
import { existsSync } from "fs";
import { TMUX_SOCK as SOCK, MASTER_SESSION, AGENT_PREFIX, tmuxRaw } from "../lib/tmux-helper.js";
import { type PiEnvProfile } from "../lib/pi-env.js";

export const REGISTRY_PATH = `${process.env.HOME}/.claude-orchestrator/registry.json`;
// ============================================================
// Registry
// ============================================================

export interface AgentInfo {
  project: string;
  purpose: string;
  created: string;
  status: "active" | "stopped";
  channelId: string;
  notes: string;
  sessionId?: string;
  cwd: string;
  displayName?: string;
  /** 权限预设名（default/strict/readonly/paranoid/自定义） */
  disallowedPreset?: string;
  /** 原始 disallowedTools 字符串。如果设置了，优先于 preset */
  disallowedRaw?: string;
  /**
   * Session-scoped effort level（low/medium/high/xhigh/max/auto），由 launcher 启动 agent 时
   * 通过 `--effort <level>` CLI flag 传给 Claude Code。空 = 不传 flag → Claude Code 用
   * `~/.claude/settings.json` 全局 effortLevel。改完要 restart 才生效。
   */
  effort?: string;
  /**
   * 权限模式（default/acceptEdits/auto/bypassPermissions/dontAsk/plan），由启动时
   * 通过 `--permission-mode`（bypass 走 `--dangerously-skip-permissions`）传给
   * Claude Code。新建交互 agent 默认 auto；cron 用 bypass。空 = 老 agent（feature
   * 之前建的）→ 启动时回退 bypass，行为不变。改完要 restart 才生效。
   */
  permissionMode?: string;
  /**
   * v2.4.19+ 频道置顶公告（带「🖥 跳到 iTerm tab」focus 按钮）的 Discord message id。
   * create/resume 时发一次并记录；已有就跳过，防 restart 重复发。
   */
  focusMsgId?: string;
  /**
   * v2.4.20+ 按 agent 钉的模型（`--model`）。别名或 model id。空 = 跟随全局
   * ~/.claude/settings.json。改完 restart 生效（是启动 flag）。
   */
  model?: string;
  /**
   * v2.6.0+ R1：标记为「可对外暴露的专用 agent」（create --external）。
   * token-add 把未标 external 的 agent 加进 scope 时要求 --force —— 防止把
   * owner 日常在用、上下文里有机密的 agent 开放给外部人。
   */
  external?: boolean;
  /**
   * v2.21+ 归属 project 的 id(projects.json)。硬约束:每个 agent 必属一个
   * project(owner 2026-08-28);老数据由 project-migrate / 各写路径懒补齐。
   * ⚠ 与遗留的 `project` 字段无关——那存的是创建时的原始 dir 字符串。
   */
  projectId?: string;
  /**
   * v2.23+ 运行时："pi" = Pi agent，缺失 = Claude Code（历史数据零迁移）。
   * 决定用哪个启动器（lib/launch-command.ts）与怎么判就绪（tmux 标记 vs TUI 文案）。
   */
  runtime?: string;
  /**
   * v2.23+ Pi 能力档案（仅 Pi agent）：base=minimal 不继承用户全局环境，可额外挑扩展/
   * 技能、禁工具、指定 MCP 配置。缺失 = 继承全局（引入档案之前的行为）。改完要 restart。
   */
  piEnv?: PiEnvProfile;
}

export interface Registry {
  socket: string;
  agents: Record<string, AgentInfo>;
}

export async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) {
    const empty: Registry = { socket: SOCK, agents: {} };
    await saveRegistry(empty);
    return empty;
  }
  return JSON.parse(await readFile(REGISTRY_PATH, "utf-8")) as Registry;
}

/** 一次性迁移：worker- → agent-。由 update 命令显式调用。 */
export async function migrateWorkerToAgent(): Promise<{ migrated: boolean; entries: number }> {
  if (!existsSync(REGISTRY_PATH)) return { migrated: false, entries: 0 };
  const raw = JSON.parse(await readFile(REGISTRY_PATH, "utf-8"));
  if (!raw.workers || raw.agents) return { migrated: false, entries: 0 };

  raw.agents = {};
  for (const [key, val] of Object.entries(raw.workers)) {
    const newKey = key.replace(/^worker-/, "agent-");
    raw.agents[newKey] = val;
  }
  delete raw.workers;
  await writeJsonAtomic(REGISTRY_PATH, raw); // 原子写：迁移中途被杀不能留下半截 registry

  // 同步重命名 tmux window（可能因为 tmux 不在运行而失败，忽略即可）
  for (const newName of Object.keys(raw.agents)) {
    const oldTmux = newName.replace(/^agent-/, "worker-");
    if (oldTmux !== newName) {
      await tmuxRaw(["rename-window", "-t", `${MASTER_SESSION}:${oldTmux}`, newName]).catch(() => {});
    }
  }

  return { migrated: true, entries: Object.keys(raw.agents).length };
}

let regWriteSeq = 0;
export async function saveRegistry(reg: Registry) {
  await mkdir(`${process.env.HOME}/.claude-orchestrator`, { recursive: true });
  // 原子写：同目录临时文件 + rename（POSIX 下 rename 原子）。防并发 reader 读到
  // 半写文件（JSON.parse 抛错），也防单次写被撕裂。tmp 名带 pid + 进程内递增序号，
  // 两个 manager 进程 / 同进程连续写都不撞同一 tmp。
  // 注：这解决"半写/撕裂"，但不消除跨进程 read-modify-write 的 lost-update 窗口
  // （两进程各自 load→mutate→save 精确交错时后写覆盖先写）——该窗口概率低，
  // 真出问题再上文件锁。bridge 侧后台写者（clear 轮转）已尽量避开活跃 agent。
  const tmp = `${REGISTRY_PATH}.${process.pid}.${regWriteSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2));
  await rename(tmp, REGISTRY_PATH);
}

// ============================================================
// 辅助
// ============================================================

// 拒绝空白、shell 元字符、控制字符。CJK 和其他 Unicode 字母允许。
// 长度上限 48 — Discord 频道名上限 100，tmux window 名没硬限制，48 足够宽。
//
// v2.13.1+ 补上 `/`、`\`、`:`、`~` 和 `..`：agent 名会直接拼进文件路径 ——
// session-archive.ts 的 join(ARCHIVE_ROOT, agentName)、screenshot.ts 的
// `${TMP_DIR}/peek_${windowName}_...`。名字里带 `/` 或 `..` 就能把归档目录和
// 截图文件写到预期之外的位置（攻击者控制得了目录、控制不了完整文件名，所以是
// 目录创建 + 文件覆盖，不是 RCE，但没有任何理由允许）。
const NAME_BLOCKLIST_RE = /[\s"'`$;&|<>()*?{}\\/:~\x00-\x1f\x7f]/;
/** 单独挡 `..`（上面的字符类挡不住不含分隔符的纯 ".."） */
const NAME_TRAVERSAL_RE = /(^|[^\w])\.\.($|[^\w])|^\.+$/;

export function normalizeName(raw: string): string {
  return `${AGENT_PREFIX}${raw.replace(AGENT_PREFIX, "").toLowerCase()}`;
}

/**
 * 校验：只用于新建/resume。拒绝空白和 shell 元字符，防止命令注入。
 * 允许 CJK 等 Unicode 字符（Discord 频道名支持，tmux 也支持）。
 */
export function assertValidNewName(raw: string): void {
  const cleaned = raw.replace(AGENT_PREFIX, "");
  if (cleaned.length === 0 || cleaned.length > 48) {
    throw new Error(`agent 名称长度必须在 1~48 之间: "${raw}"`);
  }
  if (NAME_BLOCKLIST_RE.test(cleaned)) {
    throw new Error(
      `agent 名称含非法字符: "${raw}"（不能包含空白、路径分隔符 / \\ : ~ 或 shell 元字符 " ' \` $ ; & | < > ( ) * ? { }）`
    );
  }
  if (NAME_TRAVERSAL_RE.test(cleaned)) {
    throw new Error(`agent 名称不能包含 ".."：${JSON.stringify(raw)}`);
  }
}

export function formatAge(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function output(data: Record<string, unknown>) {
  console.log(JSON.stringify(data));
}

/**
 * 从 argv 残余里提取 --preset <name> 和 --disallowed "<raw>"，
 * 返回剩余的位置参数。支持 --preset=foo / --disallowed=foo 两种写法。
 */
export function extractPermFlags(args: string[]): {
  rest: string[];
  preset?: string;
  disallowedRaw?: string;
} {
  const rest: string[] = [];
  let preset: string | undefined;
  let disallowedRaw: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--preset") {
      preset = args[++i];
    } else if (a.startsWith("--preset=")) {
      preset = a.slice("--preset=".length);
    } else if (a === "--disallowed") {
      disallowedRaw = args[++i];
    } else if (a.startsWith("--disallowed=")) {
      disallowedRaw = a.slice("--disallowed=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, preset, disallowedRaw };
}


/**
 * 从 argv 提取 --purpose <text>，支持 --purpose=foo。
 *
 * 为什么需要它：purpose 原本只能作为**位置参数**传（`create <name> <dir> [purpose]`），
 * 而所有 flag 提取都在切分位置参数之前跑。于是 API 端
 * `POST /api/v1/agents {"purpose":"--disallowed=Read"}` 会被 extractPermFlags 抢先
 * 认成 flag，**整个替换掉默认的破坏性命令黑名单**，而且这个 flag 还会从存下来的
 * purpose 文本里消失（神不知鬼不觉）。`--mode=` / `--model=` / `--external` 同理。
 * 改用具名 flag 传 purpose 之后，它的内容无论长什么样都不会再被当成 flag 解析。
 */
export function extractPurposeFlag(args: string[]): { rest: string[]; purpose?: string } {
  const rest: string[] = [];
  let purpose: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--purpose") {
      purpose = args[++i];
    } else if (a.startsWith("--purpose=")) {
      purpose = a.slice("--purpose=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, purpose };
}

/**
 * 位置参数守卫：agent 名和目录不允许以 `-` 开头。
 * 这类值一旦长得像 flag，就会在后续任何一层被重新解释成 flag。
 */
export function rejectFlagLikePositional(...vals: (string | undefined)[]): string | null {
  for (const v of vals) {
    if (v && v.startsWith("-")) return `位置参数不能以 "-" 开头（收到 ${JSON.stringify(v)}）`;
  }
  return null;
}

/** 从 argv 提取 --effort <level>，支持 --effort=foo */
export function extractEffortFlag(args: string[]): { rest: string[]; effort?: string } {
  const rest: string[] = [];
  let effort: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--effort") {
      effort = args[++i];
    } else if (a.startsWith("--effort=")) {
      effort = a.slice("--effort=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, effort };
}

/** 从 argv 提取 --mode <permission-mode>，支持 --mode=foo */
export function extractModeFlag(args: string[]): { rest: string[]; mode?: string } {
  const rest: string[] = [];
  let mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode") {
      mode = args[++i];
    } else if (a.startsWith("--mode=")) {
      mode = a.slice("--mode=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, mode };
}

/** v2.4.20+ 从 argv 提取 --model <model>，支持 --model=foo */
export function extractModelFlag(args: string[]): { rest: string[]; model?: string } {
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model") {
      model = args[++i];
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, model };
}

/** v2.6.0+ 从 argv 提取布尔 flag（--external / --force 这类无值开关） */
export function extractBoolFlag(args: string[], flag: string): { rest: string[]; value: boolean } {
  const rest: string[] = [];
  let value = false;
  for (const a of args) {
    if (a === flag) value = true;
    else rest.push(a);
  }
  return { rest, value };
}

/** 抽取可重复的 `--flag <value>` / `--flag=value`（--add-ext 这类用） */
export function extractMultiFlag(args: string[], flag: string): { rest: string[]; values: string[] } {
  const rest: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const v = args[++i];
      if (v) values.push(v);
    } else if (a.startsWith(`${flag}=`)) {
      const v = a.slice(flag.length + 1);
      if (v) values.push(v);
    } else rest.push(a);
  }
  return { rest, values };
}

/** 抽取 `--flag <value>` / `--flag=value`（与 extractBoolFlag 同风格，--runtime 用） */
export function extractStringFlag(args: string[], flag: string): { rest: string[]; value?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) value = args[++i] || undefined;
    else if (a.startsWith(`${flag}=`)) value = a.slice(flag.length + 1) || undefined;
    else rest.push(a);
  }
  return { rest, value };
}

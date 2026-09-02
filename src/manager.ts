#!/usr/bin/env bun
/**
 * Agent Manager CLI
 *
 * 管理 Claude Code agent 的生命周期：创建、恢复、销毁、列表。
 * 可被大总管通过 Bash 调用，也可独立命令行使用。
 *
 * Usage:
 *   bun src/manager.ts create <name> <dir> [purpose]
 *   bun src/manager.ts resume <name> <sessionId> [dir]
 *   bun src/manager.ts kill <name>
 *   bun src/manager.ts list
 *   bun src/manager.ts sessions [search]
 */

import { hostname } from "os";
import { readFile, writeFile, mkdir, readdir, stat, rename } from "fs/promises";
import { existsSync, statSync, readdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

// ============================================================
// 配置
// ============================================================

import {
  TMUX_SOCK as SOCK,
  MASTER_SESSION,
  AGENT_PREFIX,
  tmuxRaw,
  tmuxSendEscape,
  windowTarget,
  tmuxSendLine,
  tmuxCapture,
  isIdle,
  listAgentWindows as listAgentWindowsShared,
  listWindowIdsByName,
  ensureSocketDir,
  isAutoConfirmableModal,
  detectSessionIdlePrompt,
  clearShellInitPrompts,
  isClaudeReady,
  isAtShell,
  probeTuiContract,
  windowHasChildProcess,
  windowChildPids,
  killPidsEscalating,
  deadShellVerdict,
} from "./lib/tmux-helper.js";
import {
  buildClaudeCommand,
  resolveDisallowed,
  listPresets,
  isKnownPreset,
  DISALLOWED_PRESETS,
  DEFAULT_PRESET,
  PERMISSION_MODES,
  isKnownPermissionMode,
  resolveModelAlias,
  listModelAliases,
  KNOWN_EFFORT_LEVELS,
  isKnownEffort,
} from "./lib/claude-launch.js";
import { printTmuxGuide } from "./lib/tmux-guide.js";
import { resolveBunPath } from "./lib/bun-path.js";
import { resolveNpm } from "./lib/npm-path.js";
import { projectsSlug, projectJsonlPath } from "./lib/jsonl-cost.js";
import { archiveSession, listArchivedSessions } from "./lib/session-archive.js";
import {
  readProjects,
  writeProjects,
  resolveProjectForDir,
  slugifyProjectId,
  normalizeDir,
  isMisfiledByUmbrella,
  PROJECT_ID_RE,
  type ProjectDef,
} from "./lib/projects.js";

const REGISTRY_PATH = `${process.env.HOME}/.claude-orchestrator/registry.json`;
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";
const CATEGORY_NAME = "agents";

// ============================================================
// Registry
// ============================================================

interface AgentInfo {
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
}

interface Registry {
  socket: string;
  agents: Record<string, AgentInfo>;
}

async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) {
    const empty: Registry = { socket: SOCK, agents: {} };
    await saveRegistry(empty);
    return empty;
  }
  return JSON.parse(await readFile(REGISTRY_PATH, "utf-8")) as Registry;
}

/** 一次性迁移：worker- → agent-。由 update 命令显式调用。 */
async function migrateWorkerToAgent(): Promise<{ migrated: boolean; entries: number }> {
  if (!existsSync(REGISTRY_PATH)) return { migrated: false, entries: 0 };
  const raw = JSON.parse(await readFile(REGISTRY_PATH, "utf-8"));
  if (!raw.workers || raw.agents) return { migrated: false, entries: 0 };

  raw.agents = {};
  for (const [key, val] of Object.entries(raw.workers)) {
    const newKey = key.replace(/^worker-/, "agent-");
    raw.agents[newKey] = val;
  }
  delete raw.workers;
  await writeFile(REGISTRY_PATH, JSON.stringify(raw, null, 2));

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
async function saveRegistry(reg: Registry) {
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

import { bridgeRequest } from "./lib/bridge-client.js";

/**
 * 通知 bridge 重新扫 skill 并重新注册 Discord slash commands。
 * agent 生命周期变化（create/resume/kill/restart）时调用。
 * bridge 没运行也无所谓 —— 失败静默。
 */
async function triggerSkillsRescan(
  action: "add" | "remove" | "full",
  agent?: string,
  cwd?: string
): Promise<void> {
  const port = process.env.BRIDGE_PORT || "3847";
  try {
    await fetch(`http://localhost:${port}/skills/rescan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, agent, cwd }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* bridge 可能未运行 */ }
}

/**
 * v2.4.19+ 在 agent 频道发置顶公告（带「🖥 跳到 iTerm tab」focus 按钮）。
 * messageId 记进 registry.focusMsgId，已有就不重发（restart 沿用同一频道）。
 * bridge 没跑 / 发失败都静默 —— 公告是 nice-to-have，不该挡 create/resume。
 */
async function announceFocusButton(tmuxName: string, channelId: string): Promise<void> {
  try {
    const reg = await loadRegistry();
    if (reg.agents[tmuxName]?.focusMsgId) return;
    const result = await bridgeRequest({
      type: "announce_focus",
      channelId,
      agentName: tmuxName,
    });
    if (result?.messageId && reg.agents[tmuxName]) {
      reg.agents[tmuxName].focusMsgId = result.messageId;
      await saveRegistry(reg);
    }
  } catch { /* non-critical */ }
}

async function windowExists(name: string): Promise<boolean> {
  const windows = await listAgentWindowsShared();
  return windows.includes(name);
}

async function isAgentIdle(name: string): Promise<boolean> {
  return isIdle(windowTarget(name));
}

async function captureLast(name: string, lines = 40): Promise<string> {
  return tmuxCapture(windowTarget(name), lines);
}

// mkdir 等原本内联的工具
async function ensureSocket() {
  await ensureSocketDir();
}

// ============================================================
// Claude Code Session 扫描
// ============================================================

interface ClaudeSession {
  sessionId: string;
  cwd: string;
  slug: string;
  modifiedAt: Date;
  lastUserMessage: string;
}

async function scanClaudeSessions(search?: string): Promise<ClaudeSession[]> {
  const projectsDir = join(process.env.HOME || "~", ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const sessions: ClaudeSession[] = [];
  const projectDirs = await readdir(projectsDir);

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;

    const files = await readdir(projPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file.includes("compact")) continue;
      const uuid = file.replace(".jsonl", "");
      if (!/^[0-9a-f]{8}-/.test(uuid)) continue;

      const filePath = join(projPath, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      try {
        const fd = Bun.file(filePath);
        const chunk = await fd.slice(0, 8192).text();
        const lines = chunk.split("\n").filter((l) => l.trim());

        let sessionId = uuid;
        let cwd = "";
        let slug = "";

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.sessionId) sessionId = obj.sessionId;
            if (obj.cwd && !cwd) cwd = obj.cwd;
            if (obj.slug && !slug) slug = obj.slug;
            if (cwd && slug) break;
          } catch { /* non-critical */ }
        }

        if (!cwd) continue;

        if (search) {
          const q = search.toLowerCase();
          const haystack = `${cwd} ${slug} ${sessionId}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }

        // 从文件尾部读取最后一条用户文字消息（跳过 tool_result）
        let lastUserMessage = "";
        try {
          const size = fileStat.size;
          const tailStart = Math.max(0, size - 500_000);
          const tailChunk = await fd.slice(tailStart, size).text();
          const tailLines = tailChunk.split("\n").filter((l) => l.trim());
          for (let i = tailLines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(tailLines[i]);
              if (entry.type !== "user") continue;
              const content = entry.message?.content;
              let text = "";
              if (typeof content === "string") {
                text = content;
              } else if (Array.isArray(content)) {
                const textBlock = content.find(
                  (b: any) => b.type === "text" && b.text?.length > 3
                );
                if (textBlock) text = textBlock.text;
              }
              if (text && text.length > 3) {
                // 提取 <channel> 标签内的实际内容
                const channelMatch = text.match(/<channel[^>]*>([\s\S]*?)<\/channel>/);
                if (channelMatch) text = channelMatch[1].trim();
                lastUserMessage = text.replace(/\n/g, " ").slice(0, 80);
                break;
              }
            } catch { /* non-critical */ }
          }
        } catch { /* non-critical */ }

        sessions.push({ sessionId, cwd, slug, modifiedAt: fileStat.mtime, lastUserMessage });
      } catch { /* non-critical */ }
    }
  }

  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions;
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

function normalizeName(raw: string): string {
  return `${AGENT_PREFIX}${raw.replace(AGENT_PREFIX, "").toLowerCase()}`;
}

/**
 * 校验：只用于新建/resume。拒绝空白和 shell 元字符，防止命令注入。
 * 允许 CJK 等 Unicode 字符（Discord 频道名支持，tmux 也支持）。
 */
function assertValidNewName(raw: string): void {
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

function formatAge(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function output(data: Record<string, unknown>) {
  console.log(JSON.stringify(data));
}

/**
 * 从 argv 残余里提取 --preset <name> 和 --disallowed "<raw>"，
 * 返回剩余的位置参数。支持 --preset=foo / --disallowed=foo 两种写法。
 */
function extractPermFlags(args: string[]): {
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
function extractPurposeFlag(args: string[]): { rest: string[]; purpose?: string } {
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
function rejectFlagLikePositional(...vals: (string | undefined)[]): string | null {
  for (const v of vals) {
    if (v && v.startsWith("-")) return `位置参数不能以 "-" 开头（收到 ${JSON.stringify(v)}）`;
  }
  return null;
}

/** 从 argv 提取 --effort <level>，支持 --effort=foo */
function extractEffortFlag(args: string[]): { rest: string[]; effort?: string } {
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
function extractModeFlag(args: string[]): { rest: string[]; mode?: string } {
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
function extractModelFlag(args: string[]): { rest: string[]; model?: string } {
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
function extractBoolFlag(args: string[], flag: string): { rest: string[]; value: boolean } {
  const rest: string[] = [];
  let value = false;
  for (const a of args) {
    if (a === flag) value = true;
    else rest.push(a);
  }
  return { rest, value };
}

// ============================================================
// 命令实现
// ============================================================

/**
 * 启动超时时补一句可操作的诊断。
 *
 * isClaudeReady 完全建立在 TUI 文案上（❯ + 模式 banner）。Claude Code 改了这两处
 * 渲染，症状就是"每次建 agent 都超时"，而错误信息里没有任何线索指向真正的原因 ——
 * 用户只会以为是自己装错了。这里在超时时顺手探一次契约：屏幕上明明有 CC 的界面
 * 却认不出任何标记，就把这条线索直接写进错误里。
 */
function readyTimeoutHint(pane: string): string {
  const c = probeTuiContract(pane);
  if (!c.suspect) return "";
  return (
    "。⚠️ 检测到 Claude Code 的界面在屏幕上，但认不出它的状态栏文案 —— " +
    "如果这是升级 Claude Code 之后才开始出现的，很可能是 TUI 文案变了，" +
    "需要更新 src/lib/tmux-helper.ts 里的 CC_MODE_BANNER_RE 等匹配规则"
  );
}

// ============================================================
// Projects（v2.21+，owner 2026-08-28「加 project 概念」）
// ============================================================

/**
 * 解析 agent 的归属 project(硬约束:每个 agent 必属一个 project)。
 * 显式 id 必须已存在;否则按 dir 匹配已有 project 的目录;仍没有就以 dir
 * basename 自动建一个——cron 临时 agent / 存量迁移都走这条路,invariant 不破。
 */
async function resolveOrCreateProject(
  dir: string,
  explicitId?: string,
): Promise<{ project: ProjectDef; created: boolean } | { error: string }> {
  const data = await readProjects();
  if (explicitId) {
    const p = data.projects.find((x) => x.id === explicitId);
    if (!p) {
      return {
        error: `project "${explicitId}" 不存在。先 project-add,或省略 --project 按目录自动归属。已有: ${data.projects.map((x) => x.id).join(", ") || "(无)"}`,
      };
    }
    return { project: p, created: false };
  }
  const hit = resolveProjectForDir(data.projects, dir);
  if (hit) return { project: hit, created: false };
  const nd = normalizeDir(dir);
  const base = nd.split("/").filter(Boolean).pop() || "proj";
  const id = slugifyProjectId(base, new Set(data.projects.map((p) => p.id)));
  const proj: ProjectDef = { id, name: base, dirs: [nd], createdAt: new Date().toISOString() };
  data.projects.push(proj);
  await writeProjects(data);
  return { project: proj, created: true };
}

/** project 上下文注入串(create 时进 --append-system-prompt,见 claude-launch)。 */
async function buildProjectContext(proj: ProjectDef, selfTmuxName: string): Promise<string> {
  const reg = await loadRegistry();
  const mates = Object.entries(reg.agents)
    .filter(([n, a]) => a.projectId === proj.id && a.status === "active" && n !== selfTmuxName)
    .map(([n, a]) => `${n}${a.purpose ? `(${a.purpose.slice(0, 40)})` : ""}`);
  const parts = [`你属于 project「${proj.name}」(${proj.id})。`, `项目目录: ${proj.dirs.join(", ")}。`];
  if (proj.description) parts.push(`项目说明: ${proj.description.slice(0, 120)}。`);
  parts.push(
    mates.length
      ? `同项目 agent: ${mates.join("、")}——跨仓/跨职责协作用 send_to_agent 找它们,也可用 project_info 工具随时查项目成员与目录。`
      : `目前项目里只有你一个 agent(project_info 工具可随时查最新成员)。`,
  );
  return parts.join(" ");
}

async function cmdProjectAdd(
  id: string,
  opts: { name?: string; emoji?: string; dirs?: string[]; desc?: string },
) {
  if (!PROJECT_ID_RE.test(id)) {
    output({ ok: false, error: `project id 需匹配 ${PROJECT_ID_RE}(小写字母数字/-/_,≤32): "${id}"` });
    return;
  }
  const data = await readProjects();
  if (data.projects.some((p) => p.id === id)) {
    output({ ok: false, error: `project "${id}" 已存在` });
    return;
  }
  const dirs = (opts.dirs || []).map(normalizeDir).filter(Boolean);
  if (dirs.length === 0) {
    output({ ok: false, error: "至少要一个工作目录: --dirs <a,b>" });
    return;
  }
  const proj: ProjectDef = {
    id,
    name: opts.name?.trim() || id,
    ...(opts.emoji ? { emoji: opts.emoji } : {}),
    dirs,
    ...(opts.desc ? { description: opts.desc } : {}),
    createdAt: new Date().toISOString(),
  };
  data.projects.push(proj);
  await writeProjects(data);
  output({ ok: true, project: proj });
}

async function cmdProjectList() {
  const data = await readProjects();
  const reg = await loadRegistry();
  const projects = data.projects.map((p) => ({
    ...p,
    agents: Object.entries(reg.agents)
      .filter(([, a]) => a.projectId === p.id)
      .map(([n, a]) => ({ name: n, status: a.status, purpose: a.purpose || "" })),
  }));
  // 未归属的 agent 一并透出——UI 的「未分组」提示 + 迁移遗漏排查
  const unassigned = Object.entries(reg.agents)
    .filter(([, a]) => !a.projectId)
    .map(([n]) => n);
  output({ ok: true, projects, unassigned });
}

async function cmdProjectEdit(
  id: string,
  opts: { name?: string; emoji?: string; dirs?: string[]; desc?: string },
) {
  const data = await readProjects();
  const p = data.projects.find((x) => x.id === id);
  if (!p) {
    output({ ok: false, error: `project "${id}" 不存在` });
    return;
  }
  if (opts.name !== undefined) p.name = opts.name.trim() || p.id;
  if (opts.emoji !== undefined) {
    if (opts.emoji) p.emoji = opts.emoji;
    else delete p.emoji;
  }
  if (opts.dirs !== undefined) {
    const dirs = opts.dirs.map(normalizeDir).filter(Boolean);
    if (dirs.length === 0) {
      output({ ok: false, error: "目录列表不能为空(project 至少要有一个工作目录)" });
      return;
    }
    p.dirs = dirs;
  }
  if (opts.desc !== undefined) {
    if (opts.desc) p.description = opts.desc;
    else delete p.description;
  }
  await writeProjects(data);
  output({ ok: true, project: p });
}

async function cmdProjectRemove(id: string) {
  const data = await readProjects();
  if (!data.projects.some((p) => p.id === id)) {
    output({ ok: false, error: `project "${id}" 不存在` });
    return;
  }
  const reg = await loadRegistry();
  const members = Object.entries(reg.agents)
    .filter(([, a]) => a.projectId === id)
    .map(([n]) => n);
  if (members.length > 0) {
    output({
      ok: false,
      error: `project "${id}" 还有 ${members.length} 个 agent(${members.join(", ")})。先 project-assign 移走或 kill+remove,再删。`,
    });
    return;
  }
  data.projects = data.projects.filter((p) => p.id !== id);
  await writeProjects(data);
  output({ ok: true, removed: id });
}

async function cmdProjectAssign(agentName: string, projectId: string) {
  const tmuxName = normalizeName(agentName);
  const data = await readProjects();
  const proj = data.projects.find((p) => p.id === projectId);
  if (!proj) {
    output({ ok: false, error: `project "${projectId}" 不存在。已有: ${data.projects.map((p) => p.id).join(", ") || "(无)"}` });
    return;
  }
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `agent "${tmuxName}" 不在 registry` });
    return;
  }
  const from = info.projectId;
  info.projectId = projectId;
  await saveRegistry(reg);
  // Phase 3:Discord 频道挪到 project 对应 category(web-only / bridge 离线时静默跳过)
  if (info.channelId) {
    await bridgeRequest({ type: "move_channel", channelId: info.channelId, category: proj.name }).catch(() => {});
  }
  output({ ok: true, agent: tmuxName, from: from || null, to: projectId });
}

/**
 * 存量迁移:registry 里没有 projectId 的 agent,按 cwd 归入已有 project 或自动
 * 建组。bridge 启动时跑一次,保证「每个 agent 必属一个 project」对老数据成立。
 */
async function cmdProjectMigrate() {
  const reg = await loadRegistry();
  const byId = new Map((await readProjects()).projects.map((p) => [p.id, p] as const));
  const assigned: Record<string, string> = {};
  const repaired: Record<string, string> = {};
  const moves: Array<{ channelId: string; category: string }> = [];
  for (const [name, info] of Object.entries(reg.agents)) {
    const dir = info.cwd || info.project || "";
    if (!dir) continue;
    const cur = info.projectId ? byId.get(info.projectId) : undefined;
    // 已有归属且站得住(dir 精确/非傘形前缀命中,或显式指到别处)→ 不动。
    // v2.21.3+ 只靠傘形根(家目录 / tmp)前缀沾边的归属 = 2026-08-28 首次迁移事故的
    // 残留(owner 2026-09-02 截图「家目录杂项 6 个 agent」实为 3 真 3 假)→ 按 dir 重解;
    // 归属的 project 已不存在也重解。
    if (cur && !isMisfiledByUmbrella(cur, dir)) continue;
    const r = await resolveOrCreateProject(dir);
    if ("error" in r) continue;
    if (r.project.id === info.projectId) continue;
    (info.projectId ? repaired : assigned)[name] = r.project.id;
    info.projectId = r.project.id;
    if (info.channelId) moves.push({ channelId: info.channelId, category: r.project.name });
  }
  const n = Object.keys(assigned).length + Object.keys(repaired).length;
  if (n === 0) {
    output({ ok: true, migrated: 0, repaired: 0 });
    return;
  }
  await saveRegistry(reg);
  // 纠正过的 agent 频道挪到新 project 的 category(同 project-assign;web-only / bridge 离线静默跳过)
  for (const m of moves) {
    await bridgeRequest({ type: "move_channel", channelId: m.channelId, category: m.category }).catch(() => {});
  }
  output({ ok: true, migrated: Object.keys(assigned).length, repaired: Object.keys(repaired).length, assigned, repairedAgents: repaired });
}

async function cmdCreate(
  name: string,
  dir: string,
  purpose: string = "",
  perms: { preset?: string; disallowedRaw?: string } = {},
  effort?: string,
  permissionMode?: string,
  model?: string,
  external?: boolean,
  projectFlag?: string,
) {
  assertValidNewName(name);
  const tmuxName = normalizeName(name);
  const channelName = tmuxName.replace(AGENT_PREFIX, "");

  // v2.21+ 每个 agent 必属一个 project:显式 --project > 按 dir 匹配 > 自动建组
  const projRes = await resolveOrCreateProject(dir, projectFlag);
  if ("error" in projRes) {
    output({ ok: false, error: projRes.error });
    return;
  }
  const proj = projRes.project;

  // 校验权限预设
  if (perms.preset && !isKnownPreset(perms.preset)) {
    output({
      ok: false,
      error: `未知的权限预设: "${perms.preset}"。可用: ${listPresets().join(", ")}`,
    });
    return;
  }

  if (effort && !isKnownEffort(effort)) {
    output({
      ok: false,
      error: `未知的 effort level: "${effort}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}`,
    });
    return;
  }

  // v2.4.11+: 新建 agent 默认 bypassPermissions（v2.1.0 - v2.4.10 默认 auto，回退）。
  // 实测 auto classifier 在 Claudestra 语境下是负优化：classifier 模型（Opus 4.7）
  // 过载会 fallback deny 全部 tool call、误判 reply 是"擅自向外发布"、每装一个新
  // MCP server 都得 install-cli 重写 allow list、每次 tool call 加几百 ms 延迟。
  // 真危险命令（rm -rf / git push --force / git reset --hard / chmod 777 等）已经
  // 在 --disallowedTools 硬黑名单里跟 permission mode 正交，bypass 也拦得住。
  // worker 都是 owner 主动 manager.ts create 创建 + agent prompt owner 写的，没
  // "路过 agent 偷跑命令"的威胁模型。auto 净亏。
  // v2.4.13+ 彻底把 "auto" 当 deprecated alias 归一到 bypassPermissions，老 registry
  // 里残留的 `permissionMode: "auto"` 显式值也不再让它复活。
  let mode = (permissionMode && permissionMode.trim()) || "bypassPermissions";
  if (mode === "auto") mode = "bypassPermissions";
  if (!isKnownPermissionMode(mode)) {
    output({
      ok: false,
      error: `未知的权限模式: "${mode}"。可用: ${PERMISSION_MODES.join(", ")}`,
    });
    return;
  }

  // 检查是否已存在
  if (await windowExists(tmuxName)) {
    output({ ok: false, error: `${tmuxName} 已存在` });
    return;
  }

  // 1. 创建 Discord 频道
  let channelId: string;
  try {
    const result = await bridgeRequest({
      type: "create_channel",
      name: channelName,
      // v2.21+ Phase 3:频道归入 project 对应的 Discord category(web-only 忽略)
      category: proj.name,
    });
    channelId = result.channelId;
  } catch (err) {
    output({ ok: false, error: `创建 Discord 频道失败: ${(err as Error).message}` });
    return;
  }

  // 频道建好后若后续任何步骤失败，都必须清理孤儿频道 + tmux window
  async function cleanup(reason: string) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId });
    } catch { /* non-critical */ }
    try {
      await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);
    } catch { /* non-critical */ }
    output({ ok: false, error: `${reason}（已清理残留频道 #${channelName} 和 tmux window）` });
  }

  let ready = false;
  let sessionId: string;
  const expandedDir = dir.replace(/^~/, process.env.HOME || "~");

  try {
    // 2. 创建 tmux window（在 master session 里）
    await ensureSocket();
    await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", expandedDir]);
    await Bun.sleep(500);

    // 3. 启动 Claude Code
    const target = windowTarget(tmuxName);
    sessionId = crypto.randomUUID();
    const cmd = buildClaudeCommand({
      channelId,
      bridgeUrl: BRIDGE_URL,
      sessionId,
      disallowedPreset: perms.preset,
      disallowedRaw: perms.disallowedRaw,
      effort,
      permissionMode: mode,
      model,
      // v2.16+ purpose 注入:此前 purpose 只进 registry,agent 本体看不到自己的职责
      purpose,
      agentName: tmuxName,
      // v2.21+ project 上下文注入:目录 + 同伴花名册
      projectContext: await buildProjectContext(proj, tmuxName),
    });
    // 新 tmux window 起来后 .zshrc / .bashrc 可能弹 oh-my-zsh / homebrew 的 Y/n
    // update prompt，会吞掉 send-keys 第一个字符。先清掉再发命令。
    await clearShellInitPrompts(target);
    await tmuxSendLine(target, cmd);

    // 4. 轮询等待就绪 — 与 restart 的 startClaudeInWindow 对齐（CLAUDE_READY_ROUNDS）
    let sessionIdlePicked = false;
    for (let i = 0; i < CLAUDE_READY_ROUNDS; i++) {
      await Bun.sleep(500);
      const pane = await captureLast(tmuxName, 10);
      // v2.0.22+: Session 闲置弹窗 → 自动选「恢复完整会话」，不卡着等用户点按钮
      if (detectSessionIdlePrompt(pane)) {
        if (!sessionIdlePicked) {
          await pickFullResume(target);
          sessionIdlePicked = true;
          await Bun.sleep(1500);
        }
        continue;
      }
      if (hasPromptToConfirm(pane)) {
        await tmuxRaw(["send-keys", "-t", target, "Enter"]);
        await Bun.sleep(500);
        continue;
      }
      if (isClaudeReady(pane)) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      await cleanup(`Claude Code 启动超时${readyTimeoutHint(await captureLast(name, 40).catch(() => ""))}`);
      return;
    }
  } catch (err) {
    await cleanup(`创建失败: ${(err as Error).message}`);
    return;
  }

  // v2.5.4: 会话内补发 /model，确保 pin 真正生效（--model 对 resume 场景不可靠）
  await enforceSessionModel(tmuxName, model);

  // 6. 更新 registry（只有启动成功才落盘）
  const reg = await loadRegistry();
  reg.agents[tmuxName] = {
    project: dir,
    projectId: proj.id,
    purpose,
    created: new Date().toISOString(),
    status: "active",
    channelId,
    notes: "",
    sessionId,
    cwd: expandedDir,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
    effort,
    permissionMode: mode,
    ...(model ? { model } : {}),
    ...(external ? { external: true } : {}),
  };
  await saveRegistry(reg);

  await triggerSkillsRescan("add", tmuxName, expandedDir);
  await announceFocusButton(tmuxName, channelId);

  output({
    ok: true,
    agent: tmuxName,
    channelId,
    channelName,
    sessionId,
    ready,
    project: proj.id,
    ...(projRes.created ? { projectCreated: true } : {}),
    preset: perms.preset || DEFAULT_PRESET,
    effort: effort || "(inherits ~/.claude/settings.json)",
    permissionMode: mode,
    message: ready
      ? `Agent ${tmuxName} 已创建，Discord 频道 #${channelName} 已就绪`
      : `Agent ${tmuxName} 已创建，但 Claude Code 可能还在启动中`,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code 就绪轮询预算：240 轮 × 500ms = 120s。曾是 60s，2026-07-10 实测
// 大 session（数 MB jsonl）resume + MCP 连接可超 60s，导致实际启动成功却报
// 「启动超时」（restart 还会误标 recreated）。
const CLAUDE_READY_ROUNDS = 240;

// shell 就绪轮询预算：30 轮 × 500ms = 15s（peer 2026-08-13 P0，见
// startClaudeInWindow 注释）。实测冷启动 zsh 出提示符 2.24s，开机并发时更久；
// 15s 对它留了 6 倍余量，而健康窗口第一拍即过，正常路径零额外开销。
const SHELL_READY_ROUNDS = 30;
const SHELL_READY_POLL_MS = 500;

async function cmdResume(
  name: string,
  sessionId: string,
  dir?: string,
  perms: { preset?: string; disallowedRaw?: string } = {},
  effort?: string,
  permissionMode?: string,
  model?: string,
  // v2.7+ --fork：--fork-session 分支副本（收编野生 bg 会话 / 源 session 被
  // bg agent 占用时）。就绪后探测实际新 session id 写 registry。
  forkSession = false,
) {
  if (!UUID_RE.test(sessionId)) {
    throw new Error(`非法 sessionId: "${sessionId}"（应为 UUID 格式）`);
  }
  assertValidNewName(name);
  const tmuxName = normalizeName(name);
  const channelName = tmuxName.replace(AGENT_PREFIX, "");

  if (perms.preset && !isKnownPreset(perms.preset)) {
    output({
      ok: false,
      error: `未知的权限预设: "${perms.preset}"。可用: ${listPresets().join(", ")}`,
    });
    return;
  }

  if (effort && !isKnownEffort(effort)) {
    output({
      ok: false,
      error: `未知的 effort level: "${effort}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}`,
    });
    return;
  }

  // v2.4.11+: resume 也回 bypassPermissions 默认（同 cmdCreate 注释里的理由）。
  // v2.4.13+: "auto" → bypassPermissions 归一，老 registry 里的显式 auto 不再复活。
  let mode = (permissionMode && permissionMode.trim()) || "bypassPermissions";
  if (mode === "auto") mode = "bypassPermissions";
  if (!isKnownPermissionMode(mode)) {
    output({
      ok: false,
      error: `未知的权限模式: "${mode}"。可用: ${PERMISSION_MODES.join(", ")}`,
    });
    return;
  }

  if (await windowExists(tmuxName)) {
    output({ ok: false, error: `${tmuxName} 已存在` });
    return;
  }

  // 如果没有指定目录，从 session 文件找
  let resolvedDir = dir?.replace(/^~/, process.env.HOME || "~") || "";
  if (!resolvedDir) {
    const sessions = await scanClaudeSessions();
    const match = sessions.find((s) => s.sessionId === sessionId);
    if (match) {
      resolvedDir = match.cwd;
    } else {
      output({ ok: false, error: `找不到 session ${sessionId} 的工作目录，请用第三个参数指定` });
      return;
    }
  }

  // v2.21+ resume 也满足「必属一个 project」:同名旧条目沿用,否则按目录归属
  const regPeek = await loadRegistry();
  let resumeProjectId = regPeek.agents[tmuxName]?.projectId;
  let resumeProjName: string | undefined;
  {
    const r = await resolveOrCreateProject(resolvedDir, resumeProjectId);
    if (!("error" in r)) {
      resumeProjectId = r.project.id;
      resumeProjName = r.project.name;
    } else {
      // registry 里记了个已被删的 project id——按目录重新归属
      const r2 = await resolveOrCreateProject(resolvedDir);
      if (!("error" in r2)) {
        resumeProjectId = r2.project.id;
        resumeProjName = r2.project.name;
      }
    }
  }

  // 创建 Discord 频道
  let channelId: string;
  try {
    const result = await bridgeRequest({
      type: "create_channel",
      name: channelName,
      category: resumeProjName || CATEGORY_NAME,
    });
    channelId = result.channelId;
  } catch (err) {
    output({ ok: false, error: `创建 Discord 频道失败: ${(err as Error).message}` });
    return;
  }

  async function cleanup(reason: string) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId });
    } catch { /* non-critical */ }
    try {
      await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);
    } catch { /* non-critical */ }
    output({ ok: false, error: `${reason}（已清理残留频道 #${channelName} 和 tmux window）` });
  }

  let ready = false;
  let forkBefore: Set<string> | null = null;

  try {
    // 创建 tmux window（在 master session 里）
    await ensureSocket();
    await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", resolvedDir]);
    await Bun.sleep(500);

    // 启动 Claude Code（resume 模式）
    const target = windowTarget(tmuxName);
    const displayName = channelName;
    const cmd = buildClaudeCommand({
      channelId,
      bridgeUrl: BRIDGE_URL,
      resumeId: sessionId,
      forkSession,
      displayName,
      disallowedPreset: perms.preset,
      disallowedRaw: perms.disallowedRaw,
      effort,
      permissionMode: mode,
      model,
    });
    await clearShellInitPrompts(target);
    if (forkSession) forkBefore = await listSessionJsonls(resolvedDir);
    await tmuxSendLine(target, cmd);

    // 轮询等待 — 与 restart 的 startClaudeInWindow 对齐（CLAUDE_READY_ROUNDS）
    let sessionIdlePicked = false;
    for (let i = 0; i < CLAUDE_READY_ROUNDS; i++) {
      await Bun.sleep(500);
      const pane = await captureLast(tmuxName, 10);
      // v2.0.22+: Session 闲置弹窗 → 自动选「恢复完整会话」，不卡着等用户点按钮
      if (detectSessionIdlePrompt(pane)) {
        if (!sessionIdlePicked) {
          await pickFullResume(target);
          sessionIdlePicked = true;
          await Bun.sleep(1500);
        }
        continue;
      }
      if (hasPromptToConfirm(pane)) {
        await tmuxRaw(["send-keys", "-t", target, "Enter"]);
        await Bun.sleep(500);
        continue;
      }
      if (isClaudeReady(pane)) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      await cleanup(`Claude Code 启动超时${readyTimeoutHint(await captureLast(name, 40).catch(() => ""))}`);
      return;
    }
  } catch (err) {
    await cleanup(`恢复失败: ${(err as Error).message}`);
    return;
  }

  // v2.5.4: 会话内补发 /model —— resume 是 --model 失效的重灾区（session 保留原模型）
  await enforceSessionModel(tmuxName, model);

  // v2.7+ fork 模式：registry 必须记 fork 出的实际新 session id，不是源 id
  let actualSessionId = sessionId;
  if (forkSession && forkBefore) {
    const newId = await waitForNewSessionId(resolvedDir, forkBefore);
    if (newId) {
      actualSessionId = newId;
      console.error(`[resume] --fork 探测到新 session ${newId.slice(0, 8)}（源 ${sessionId.slice(0, 8)}）`);
    } else {
      console.error(`[resume] ⚠️ --fork 未探测到新 session id，registry 暂记源 id`);
    }
  }

  // 更新 registry
  const reg = await loadRegistry();
  // v2.8+ 同名 agent 换 session：旧 session 退役先归档快照
  const prior = reg.agents[tmuxName];
  if (prior?.sessionId && prior.sessionId !== actualSessionId) {
    await archiveSession(tmuxName, prior.cwd, prior.sessionId).catch(() => {});
  }
  reg.agents[tmuxName] = {
    project: dir || resolvedDir.replace(process.env.HOME || "", "~"),
    ...(resumeProjectId ? { projectId: resumeProjectId } : {}),
    purpose: `resumed: ${sessionId.slice(0, 8)}${forkSession ? " (fork)" : ""}`,
    created: new Date().toISOString(),
    status: "active",
    channelId,
    notes: `claude session: ${actualSessionId}${forkSession ? ` (forked from ${sessionId.slice(0, 8)})` : ""}`,
    sessionId: actualSessionId,
    cwd: resolvedDir,
    displayName: channelName,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
    effort,
    permissionMode: mode,
    ...(model ? { model } : {}),
  };
  await saveRegistry(reg);

  // 截图发到新频道作为上下文预览
  if (ready) {
    try {
      const bunPath = resolveBunPath();
      const srcDir = import.meta.dir;
      const htmlPath = `/tmp/claude-orchestrator/resume_${Date.now()}.html`;
      const pngPath = `/tmp/claude-orchestrator/resume_${Date.now()}.png`;

      // tmux capture-pane -e → ansi2html → HTML
      const capture = Bun.spawn(
        ["tmux", "-S", SOCK, "capture-pane", "-t", windowTarget(tmuxName), "-p", "-e", "-S", "-50"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const ansi2html = Bun.spawn(
        [bunPath, "run", `${srcDir}/ansi2html.ts`, htmlPath],
        { stdin: capture.stdout, stdout: "pipe", stderr: "pipe" }
      );
      await ansi2html.exited;

      // HTML → PNG
      await Bun.spawn(
        [bunPath, "run", `${srcDir}/html2png.ts`, htmlPath, pngPath, "1200"],
        { stdout: "pipe", stderr: "pipe" }
      ).exited;

      // 发图片到 Discord
      const { existsSync } = await import("fs");
      if (existsSync(pngPath)) {
        await bridgeRequest({
          type: "reply",
          chatId: channelId,
          text: "**📜 恢复的会话终端预览**",
          files: [pngPath],
        });
      }
      // 清理
      try { await Bun.spawn(["rm", htmlPath, pngPath]).exited; } catch { /* non-critical */ }
    } catch { /* non-critical */ }
  }

  output({
    ok: true,
    agent: tmuxName,
    channelId,
    channelName,
    sessionId,
    ready,
    permissionMode: mode,
    message: ready
      ? `Agent ${tmuxName} 已恢复，Discord 频道 #${channelName} 已就绪`
      : `Agent ${tmuxName} 已恢复，但 Claude Code 可能还在启动中`,
  });
  await triggerSkillsRescan("add", tmuxName, resolvedDir);
  await announceFocusButton(tmuxName, channelId);
}

async function cmdKill(name: string) {
  const tmuxName = normalizeName(name);

  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }

  await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);

  // 删除对应的 Discord 频道
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  // v2.8+ 会话退役 → 归档 jsonl 快照（CC 的 cleanupPeriodDays 会清源文件）
  if (info?.sessionId) {
    await archiveSession(tmuxName, info.cwd, info.sessionId).catch(() => {});
  }
  if (info?.channelId) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId: info.channelId });
    } catch { /* non-critical */ }
  }
  if (reg.agents[tmuxName]) {
    reg.agents[tmuxName].status = "stopped";
  }

  // 清理 registry 里同名的大小写变体（历史遗留）
  for (const key of Object.keys(reg.agents)) {
    if (key.toLowerCase() === tmuxName && key !== tmuxName) {
      delete reg.agents[key];
    }
  }
  await saveRegistry(reg);

  await triggerSkillsRescan("remove", tmuxName);

  // v2.4.16+ 通知 bridge 清掉所有 inter-agent / cross-peer pending（避免被 kill
  // 的 agent 在别处被 resume 后吃陈年 pushback / nudge）。restart 走另一条路，
  // 不调这里。bridge 没启也无所谓 —— 静默失败。
  if (info?.channelId) {
    const port = process.env.BRIDGE_PORT || "3847";
    try {
      await fetch(`http://localhost:${port}/agent/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 带上 agent 名，bridge 据此丢掉它在事件总线里的环形缓冲（见 forgetAgent）
        body: JSON.stringify({ channelId: info.channelId, agent: tmuxName }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* bridge 可能未运行 */ }
  }

  output({
    ok: true,
    agent: tmuxName,
    message: `${tmuxName} 已销毁。`,
  });
}

/**
 * v2.10+ 永久移除（owner 2026-07-14:「临时起的 agent 不想在列表里污染我」）:
 * kill 收尾(归档 session/删频道/清 pending) + registry 条目整个删除——列表不再
 * 显示。归档文件保留(~/.claude-orchestrator/archive/):删列表 ≠ 删档案,
 * 会话历史仍可人工翻查;误删的 agent 用 create + resume --fork 可以重建。
 */
async function cmdRemove(name: string) {
  const tmuxName = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info && !(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  if (await windowExists(tmuxName)) {
    await tmuxRaw(["kill-window", "-t", windowTarget(tmuxName)]);
  }
  if (info?.sessionId) {
    await archiveSession(tmuxName, info.cwd, info.sessionId).catch(() => {});
  }
  if (info?.channelId) {
    try {
      await bridgeRequest({ type: "delete_channel", channelId: info.channelId });
    } catch { /* 已 kill 过的频道早删了,静默 */ }
  }
  delete reg.agents[tmuxName];
  for (const key of Object.keys(reg.agents)) {
    if (key.toLowerCase() === tmuxName && key !== tmuxName) delete reg.agents[key];
  }
  await saveRegistry(reg);
  await triggerSkillsRescan("remove", tmuxName);
  if (info?.channelId) {
    const port = process.env.BRIDGE_PORT || "3847";
    try {
      await fetch(`http://localhost:${port}/agent/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 带上 agent 名，bridge 据此丢掉它在事件总线里的环形缓冲（见 forgetAgent）
        body: JSON.stringify({ channelId: info.channelId, agent: tmuxName }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* bridge 可能未运行 */ }
  }
  output({ ok: true, agent: tmuxName, message: `${tmuxName} 已永久移除（会话归档保留）。` });
}

/**
 * 重命名一个 agent：tmux window 名 + registry key + Discord 频道名 + displayName 全部同步。
 * 不重启 Claude Code（内部显示名会在下次 restart 时更新到新名）。
 */
async function cmdRename(oldName: string, newName: string) {
  // 校验新名字合法 + 规范化
  try {
    assertValidNewName(newName);
  } catch (e) {
    output({ ok: false, error: (e as Error).message });
    return;
  }
  const oldTmux = normalizeName(oldName);
  const newTmux = normalizeName(newName);

  if (oldTmux === newTmux) {
    output({ ok: false, error: "新旧名字相同，没啥可改的" });
    return;
  }

  const reg = await loadRegistry();
  const info = reg.agents[oldTmux];
  if (!info) {
    output({ ok: false, error: `registry 里没有 ${oldTmux}` });
    return;
  }
  if (reg.agents[newTmux]) {
    output({ ok: false, error: `${newTmux} 已存在，换个名字` });
    return;
  }

  const newChannelName = newTmux.replace(AGENT_PREFIX, "");
  const steps: any[] = [];

  // 1. tmux window rename（只有 window 还在的时候才做）
  if (await windowExists(oldTmux)) {
    const r = await tmuxRaw(["rename-window", "-t", windowTarget(oldTmux), newTmux]).catch((e) => `error: ${e.message}`);
    steps.push({ step: "tmux rename-window", ok: !r || !r.toString().startsWith("error"), raw: r || "ok" });
  } else {
    steps.push({ step: "tmux rename-window", ok: false, skipped: "tmux window 不存在" });
  }

  // 2. registry 迁移
  reg.agents[newTmux] = { ...info, displayName: newChannelName };
  delete reg.agents[oldTmux];
  await saveRegistry(reg);
  steps.push({ step: "registry", ok: true });

  // 3. Discord 频道 rename
  if (info.channelId) {
    try {
      await bridgeRequest({ type: "rename_channel", channelId: info.channelId, name: newChannelName });
      steps.push({ step: "discord channel rename", ok: true });
    } catch (e) {
      steps.push({ step: "discord channel rename", ok: false, reason: (e as Error).message });
    }
  }

  // 4. 通知 bridge 刷 skill registry（agent 名字变了，skill 映射的 agentName 要同步）
  await triggerSkillsRescan("full");

  output({
    ok: true,
    from: oldTmux,
    to: newTmux,
    channelName: newChannelName,
    steps,
    hint: "Claude Code 内部 session 的显示名会在下次 restart 时更新到新名（现在仍是旧的，不影响功能）。",
  });
}

// ============================================================
// 优雅退出 + 重启
// ============================================================

/**
 * 检查 tmux pane 是否回到 shell 提示符。
 *
 * 策略：
 * 1. 排除法：pane 含 Claude Code TUI 的标志文字（"bypass permissions" / "esc to interrupt" /
 *    选项菜单 "❯ 1." ... 这些只在 Claude Code 运行时出现）→ 不是 shell
 * 2. 最后非空行结尾匹配常见 shell 提示符字符：$、%、#、>、➜、»、λ
 *    （注意：❯ 是 Claude Code 的输入提示符，也被 starship 等 shell 主题用，
 *     所以要配合排除法才能区分）
 *
 * 用户反馈 v1.7.4 的坑：oh-my-zsh "robbyrussell" 主题用 ➜，原来的
 * /[%$]/ 正则认不出来导致 restart 永远"启动超时"。
 */
/**
 * Agent 用：几何识别 modal 自动确认；session-idle 不自动按（permission-watcher
 * 会发 Discord 按钮让用户决定）。
 */
const hasPromptToConfirm = (pane: string) => isAutoConfirmableModal(pane);

// ────────────────────────────────────────────────
// v2.7+ fork-session 自愈（Claude Code agents 模式适配）
// ────────────────────────────────────────────────
//
// session 被 Claude Code 的 bg agent 占用时无法 --resume（bg daemon 会把被杀
// 的占用者 respawn 回来，进程层面赢不了 —— 2026-07-09 事故实证）。唯一可靠
// 破局是 `--resume <id> --fork-session` 分支副本。fork 出的新 session id 上游
// 不直接告知，靠启动前后 diff projects 目录探测，拿到后回写 registry。

/** cwd → ~/.claude/projects/<slug>/（slug 规则与 jsonl-watcher.getJsonlPath 一致） */
function projectsDirFor(cwd: string): string {
  return join(process.env.HOME || "~", ".claude", "projects", projectsSlug(cwd));
}

async function listSessionJsonls(cwd: string): Promise<Set<string>> {
  try {
    return new Set(
      (await readdir(projectsDirFor(cwd))).filter((f) => f.endsWith(".jsonl")),
    );
  } catch {
    return new Set();
  }
}

/** 启动前 diff：projects 目录里新出现的 jsonl → 新 session id（多个取 mtime 最新） */
async function detectNewSessionId(
  cwd: string,
  before: Set<string>,
): Promise<string | null> {
  try {
    const dir = projectsDirFor(cwd);
    const fresh = (await readdir(dir)).filter(
      (f) => f.endsWith(".jsonl") && !before.has(f),
    );
    if (fresh.length === 0) return null;
    if (fresh.length === 1) return fresh[0].replace(/\.jsonl$/, "");
    const withMtime = await Promise.all(
      fresh.map(async (f) => ({
        f,
        m: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0,
      })),
    );
    withMtime.sort((a, b) => b.m - a.m);
    return withMtime[0].f.replace(/\.jsonl$/, "");
  } catch {
    return null;
  }
}

/** 轮询探测 fork 出的新 session（jsonl 落盘可能滞后于 TUI 就绪） */
async function waitForNewSessionId(
  cwd: string,
  before: Set<string>,
  timeoutMs = 20_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await detectNewSessionId(cwd, before);
    if (found) return found;
    await Bun.sleep(1_000);
  }
  return null;
}

/**
 * v2.0.22+: 检测到 session-idle 弹窗时自动选「恢复完整会话」(option 2)。
 *
 *   ❯ 1. Resume from summary (recommended)   ← 默认高亮 = compact，丢上下文
 *     2. Resume full session as-is            ← 我们要的
 *     3. Don't ask me again
 *
 * 这个 modal **不接受 digit 跳转**（按 "2" 没用，Enter 还是确认高亮的 option 1），
 * 只能 arrow nav：Down 一次到 option 2 再 Enter。startClaudeInWindow / cmdCreate /
 * cmdResume 三个就绪轮询都用它，不再卡着等用户点 Discord 按钮。
 */
async function pickFullResume(target: string) {
  await tmuxRaw(["send-keys", "-t", target, "Down"]);
  await Bun.sleep(150);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);
}

/** 优雅退出一个 Claude Code agent，处理所有确认弹窗 */
async function gracefulExit(name: string): Promise<boolean> {
  const target = windowTarget(name);

  // 阶段 1: 多次 Ctrl+C 确保打断当前操作
  for (let i = 0; i < 3; i++) {
    await tmuxRaw(["send-keys", "-t", target, "C-c"]);
    await Bun.sleep(800);
    const pane = await captureLast(name, 5);
    if (isAtShell(pane)) return true;
    // 如果出现了 ❯ 提示符（Claude Code 空闲），可以继续退出
    if (/❯/.test(pane.split("\n").slice(-5).join("\n"))) break;
  }

  // 阶段 2: 发 Escape 清除任何菜单/弹窗（走双击护栏：连发两个 Esc = CC 的 Rewind 手势）
  await tmuxSendEscape(target);
  await Bun.sleep(500);

  // 阶段 3: 发 /exit
  await tmuxRaw(["send-keys", "-t", target, "-l", "--", "/exit"]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);

  // 阶段 4: 轮询处理各种确认提示，最多等 30 秒
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(name, 10);

    // 已经回到 shell
    if (isAtShell(pane)) return true;

    // Goodbye! 表示 Claude Code 正在退出
    if (pane.includes("Goodbye!")) {
      await Bun.sleep(1000);
      continue;
    }

    // 有确认提示 → 按 Enter
    if (hasPromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }

    // /exit 可能出现在自动补全列表里，需要再按一次 Enter
    if (pane.includes("/exit") && pane.includes("Exit the REPL")) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
  }

  // 阶段 5: 最后手段 — 强制杀进程
  const finalPane = await captureLast(name, 5);
  if (!isAtShell(finalPane)) {
    // 发 Ctrl+C 多次 + Ctrl+D
    await tmuxRaw(["send-keys", "-t", target, "C-c"]);
    await Bun.sleep(300);
    await tmuxRaw(["send-keys", "-t", target, "C-c"]);
    await Bun.sleep(300);
    await tmuxRaw(["send-keys", "-t", target, "C-d"]);
    await Bun.sleep(2000);
  }

  const check = await captureLast(name, 3);
  return isAtShell(check);
}

/**
 * 在已有的 tmux window 里启动 Claude Code，处理所有确认弹窗。
 * 返回 ready（是否就绪）+ recoveredFullSession（是否自动选了「恢复完整会话」，
 * 用于给频道发一条正面"已恢复"信号，取代 watcher 的按钮噪音）。
 */
/**
 * v2.5.4: 启动就绪后在会话内补一发 `/model`，强制 pin 的模型真正生效。
 *
 * 根因：`--model` 对 `--resume` 的会话经常不生效 —— session 保留它原来的模型，
 * registry 里的 model 只是"意图"。实测 12 个 agent 里 6 个 registry 写 fable、
 * 实际还在 opus。会话内 `/model` 是 TUI 层面的切换，可靠且幂等（已在目标模型时
 * 直接确认不弹框；换模型时弹 "Switch model?" 确认框，❯ 默认在 Yes，Enter 即可）。
 * 失败不阻塞启动 —— 看板显示的是 jsonl 真相，漂了能看见。
 *
 * ⚠ CC 2.1.x 起 TUI `/model` 会「saved as your default for new sessions」——直接
 * 改写 ~/.claude/settings.json 的 model,把这个 agent 的钉值传染给之后所有不带
 * --model 的新 session(2026-07-16 实测,test-eff 补发 haiku 把全局从 fable 改成了
 * haiku)。per-agent pin 不该有全局副作用:补发前快照全局值,补发后原样写回。
 */
const GLOBAL_CLAUDE_SETTINGS = `${process.env.HOME}/.claude/settings.json`;

/**
 * manager.ts 跑在哪个 tmux window 里（agent 自己调 manager 时非空）。
 * 2026-07-25 事故：`model all` 由 agent-claudestra 自己发起，enforceSessionModel
 * 把 `/model` 键进了发起者自己的 TUI —— 确认框要等本回合结束才可能被处理，而
 * 本回合正阻塞在这个函数里等确认框消失，纯自死锁。
 */
async function selfWindowName(): Promise<string | null> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  try {
    return (await tmuxRaw(["display-message", "-p", "-t", pane, "#{window_name}"])) || null;
  } catch {
    return null;
  }
}

async function enforceSessionModel(name: string, model?: string): Promise<boolean> {
  if (!model?.trim()) return true;
  const target = windowTarget(name);
  const resolved = resolveModelAlias(model.trim());
  // 自守：绝不给发起者自己的窗口发键（见 selfWindowName 注释）。registry 已写，
  // 下次 restart 时补发生效。
  if (name === (await selfWindowName())) {
    console.error(`[model] 跳过 ${name}（命令由该 agent 自己发起，restart 时补发）`);
    return false;
  }
  // 快照全局默认。null = 读失败(文件不存在/坏 JSON),跳过恢复,别越修越坏。
  let globalModel: string | undefined | null = null;
  try {
    const s = JSON.parse(await Bun.file(GLOBAL_CLAUDE_SETTINGS).text());
    globalModel = typeof s.model === "string" ? s.model : undefined;
  } catch {
    /* 无快照就不恢复 */
  }
  try {
    await tmuxRaw(["send-keys", "-t", target, "-l", `/model ${resolved}`]);
    await Bun.sleep(400);
    await tmuxRaw(["send-keys", "-t", target, "Enter"]);
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(700);
      // 60 行 = 整屏。15 行踩过坑：确认框标题距 pane 底部 16 行（说明文字 + 两个
      // 选项 + 输入框都在它下面），恰好落在窗口外 —— 检测不到就空转 8 轮退出，
      // 把确认框留在屏幕上阻塞该 agent（2026-07-25 一次性卡住 6 个）。
      const pane = await captureLast(name, 60);
      if (/Switch model\?/i.test(pane)) {
        await tmuxRaw(["send-keys", "-t", target, "Enter"]);
        continue;
      }
      if (/Set model to/i.test(pane)) return true;
    }
  } catch {
    /* 失败不阻塞启动 */
  } finally {
    if (globalModel !== null) {
      // CC 落盘晚于 TUI 反馈渲染(实测:检测到「Set model to」立即恢复仍被后到的
      // 写盘覆盖)——多轮延迟复查,漂了就写回。重读再只改 model 字段,期间 CC
      // 可能写过其它字段,拿旧快照全量覆盖会丢。
      for (let i = 0; i < 3; i++) {
        await Bun.sleep(1200);
        try {
          const s = JSON.parse(await Bun.file(GLOBAL_CLAUDE_SETTINGS).text());
          if (s.model !== globalModel) {
            if (globalModel === undefined) delete s.model;
            else s.model = globalModel;
            await Bun.write(GLOBAL_CLAUDE_SETTINGS, JSON.stringify(s, null, 2) + "\n");
          }
        } catch {
          /* 恢复失败不阻塞 */
        }
      }
    }
  }
  return false;
}

async function startClaudeInWindow(
  name: string,
  claudeCmd: string
): Promise<{ ready: boolean; recoveredFullSession: boolean; bgOccupied?: boolean }> {
  const target = windowTarget(name);

  // 确保在 shell 提示符。
  //
  // v2.19.0（peer 2026-08-13 P0：开机 9 个 restart 静默挂 3 个）：这里原本是
  // 「看一眼 → 不行等 2s → 再看一眼 → 放弃」的一次性判定。配合 cmdRestart 里
  // new-window 之后的 sleep(500)，新窗口从创建到判定截止总共只有 2.5s，而实测
  // 新建 tmux 窗口里 zsh（oh-my-zsh + conda base）出提示符要 2.24s——余量 0.26s。
  // 开机时 9 个窗口并发创建 + 系统冷启动，超时是必然而非偶然：失败的三次耗时
  // 恰好都是 2.57/2.60/2.67s，与「等满 2s 就放弃」的时间账吻合。
  //
  // 预算也严重失衡：claude 就绪轮询给了 120s，shell 就绪只给 2.5s——反了，
  // shell 起不来比 claude 起不来更致命（后者至少还有 fork 自愈）。改为轮询，
  // 就绪即走（健康窗口第一拍就过，不增加正常路径耗时）。
  let shellReady = false;
  for (let i = 0; i < SHELL_READY_ROUNDS; i++) {
    if (isAtShell(await captureLast(name, 3))) {
      shellReady = true;
      if (i > 0) console.error(`[restart] ${name} shell 就绪等了 ${(i * SHELL_READY_POLL_MS) / 1000}s`);
      break;
    }
    await Bun.sleep(SHELL_READY_POLL_MS);
  }
  if (!shellReady) {
    // 放大器 1（同报告）：原来这里是裸 return，整条失败路径在任何日志里都不
    // 存在——窗口建好了、claude 从没启动、registry 还写着 active，只有发消息
    // 没反应才会被发现。失败必须留痕。
    console.error(
      `[restart] ${name} shell 未就绪（等满 ${(SHELL_READY_ROUNDS * SHELL_READY_POLL_MS) / 1000}s），放弃启动`,
    );
    return { ready: false, recoveredFullSession: false };
  }

  // 发送启动命令前先清掉 shell init 阶段可能存在的 Y/n 交互（oh-my-zsh / homebrew）
  await clearShellInitPrompts(target);
  await tmuxSendLine(target, claudeCmd);

  // 轮询处理各种确认提示（预算见 CLAUDE_READY_ROUNDS）
  let sessionIdlePicked = false;
  for (let i = 0; i < CLAUDE_READY_ROUNDS; i++) {
    await Bun.sleep(500);
    const pane = await captureLast(name, 10);

    // Claude Code 就绪
    if (isClaudeReady(pane)) return { ready: true, recoveredFullSession: sessionIdlePicked };

    // v2.7+: session 被 bg agent 占用 → claude 报错退出。提前返回 bgOccupied，
    // 让 cmdRestart 走 --fork-session 自愈重试（见 projectsDirFor 上方注释）。
    if (/currently running as a background agent/i.test(pane)) {
      return { ready: false, recoveredFullSession: false, bgOccupied: true };
    }

    // v2.0.22+: Session 闲置弹窗 → 自动选「恢复完整会话」，不再卡着等用户点按钮。
    // picked 标记防止重复发键；发完给加载留窗口，下轮再判 ready。
    if (detectSessionIdlePrompt(pane)) {
      if (!sessionIdlePicked) {
        await pickFullResume(target);
        sessionIdlePicked = true;
        await Bun.sleep(1500);
      }
      continue;
    }

    // 有确认提示 → 按 Enter
    if (hasPromptToConfirm(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "Enter"]);
      await Bun.sleep(500);
      continue;
    }
  }

  // 最后再捕一次：用同样的严格条件兜底（不靠循环结束的瞬时状态）。
  // 严格条件 isClaudeReady 同时要求 ❯ 和 "bypass permissions"，避免 ❯ 出现在
  // "❯ 1. I am using this for local development" 这类选项菜单里被误判。
  const final = await captureLast(name, 10);
  return { ready: isClaudeReady(final), recoveredFullSession: sessionIdlePicked };
}

/**
 * v2.7+ 收编（分身替换）：把指定 session（典型来源是 agents 视图误触 fork 出的
 * bg 分身，其上下文比正式 agent 新）立为该 agent 的正式会话，然后走 cmdRestart
 * 拉起。restart 的 bg 占用自愈路径会自动 --fork-session 并回写实际新 session id，
 * 所以这里只需要改 registry —— 占用与否都能正确拉起。
 */
async function cmdAdopt(name: string, sessionId: string) {
  if (!UUID_RE.test(sessionId)) {
    output({ ok: false, error: `非法 sessionId: "${sessionId}"（应为 UUID 格式）` });
    return;
  }
  const tmuxName = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `${tmuxName} 不在 registry（野生会话收编请用 resume <新名> <sessionId> --fork）` });
    return;
  }
  const oldId = info.sessionId;
  // v2.8+ 被替换的旧 session 先归档快照
  if (oldId && oldId !== sessionId) {
    await archiveSession(tmuxName, info.cwd, oldId).catch(() => {});
  }
  info.sessionId = sessionId;
  info.notes = `claude session: ${sessionId} (adopted${oldId ? `, was ${oldId.slice(0, 8)}` : ""})`;
  await saveRegistry(reg);
  console.error(`[adopt] ${tmuxName} sessionId ${oldId?.slice(0, 8) ?? "(无)"} → ${sessionId.slice(0, 8)}，restart 拉起`);
  await cmdRestart(tmuxName);
}

/**
 * per-agent restart 跨进程互斥（v2.17.2，peer 2026-08-09 新证据：并发 restart
 * 期间启动命令被打进无关 agent 的窗口，把没参与竞态的 agent 打成空壳）。
 *
 * 关键：launcher 的 boot / periodic restore 是两个独立的 `bun run manager.ts
 * restart` **子进程**——进程内 Map 锁挡不住。cmdRestart 里 `gracefulExit →
 * kill → sleep(500) → new-window → send 启动命令` 全程无锁，两个子进程交错
 * 就能让 A 往 B 刚建的窗口发命令。P1 租约堵住了 launcher 侧的双跑，但 web /
 * 手动 restart 与 launcher 仍可能并发——文件锁是不依赖上游守规矩的纵深防御。
 */
const RESTART_LOCK_DIR = `${process.env.HOME}/.claude-orchestrator/locks`;
const RESTART_LOCK_STALE_MS = 3 * 60_000;

function tryLockRestart(tmuxName: string, depth = 0): boolean {
  const lock = `${RESTART_LOCK_DIR}/restart-${tmuxName}.lock`;
  try {
    mkdirSync(RESTART_LOCK_DIR, { recursive: true });
    const fd = openSync(lock, "wx"); // O_EXCL：已存在即抛
    writeSync(fd, `${process.pid}\n${Date.now()}`);
    closeSync(fd);
    return true;
  } catch {
    if (depth > 0) return false; // 只接管一次，避免抢锁循环
    try {
      const [pidS, tsS] = readFileSync(lock, "utf8").split("\n");
      const pid = parseInt(pidS, 10);
      const ts = parseInt(tsS, 10) || 0;
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { /* 死了 */ } }
      if (!alive || Date.now() - ts > RESTART_LOCK_STALE_MS) {
        unlinkSync(lock); // 陈旧（持有进程已死 / 超时）→ 接管
        return tryLockRestart(tmuxName, depth + 1);
      }
    } catch { /* 读锁失败按被占处理 */ }
    return false;
  }
}

/** 该 agent 是否正有 restart 在跑（cmdList 的 dead 判定要避开这段窗口期）。
 *  锁陈旧（进程已死 / 超 3min）按「没在跑」处理，与 tryLockRestart 的接管判据一致。 */
function isRestartInProgress(tmuxName: string): boolean {
  try {
    const raw = readFileSync(`${RESTART_LOCK_DIR}/restart-${tmuxName}.lock`, "utf8");
    const [pidStr, tsStr] = raw.split("\n");
    const pid = Number(pidStr);
    const ts = Number(tsStr);
    if (Number.isFinite(ts) && Date.now() - ts > 3 * 60_000) return false;
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); } catch { return false; } // 进程没了 = 孤儿锁
    }
    return true;
  } catch {
    return false; // 没锁
  }
}

function unlockRestart(tmuxName: string): void {
  try { unlinkSync(`${RESTART_LOCK_DIR}/restart-${tmuxName}.lock`); } catch { /* 已删 */ }
}

async function cmdRestart(name?: string) {
  const reg = await loadRegistry();
  const liveWindows = await listAgentWindowsShared();

  // 确定要重启的 agent 列表（不指定名字时，既包括活着的 window，也包括 registry 里 active 但 window 没了的 dead agent —
  // 这样 gracefulExit 超时导致 window 被杀的情况也能通过重启救回）
  let targets: string[];
  if (name) {
    const tmuxName = normalizeName(name);
    const inReg = !!reg.agents[tmuxName];
    if (!liveWindows.includes(tmuxName) && !inReg) {
      output({ ok: false, error: `${tmuxName} 不存在` });
      return;
    }
    targets = [tmuxName];
  } else {
    const deadButInReg = Object.keys(reg.agents).filter(
      (n) => reg.agents[n].status === "active" && !liveWindows.includes(n)
    );
    targets = [...liveWindows, ...deadButInReg];
  }

  if (targets.length === 0) {
    output({ ok: false, error: "没有需要重启的 agent" });
    return;
  }

  const results: { name: string; ok: boolean; error?: string; recreated?: boolean }[] = [];

  let regDirty = false;

  for (const tmuxName of targets) {
    const info = reg.agents[tmuxName];
    if (!info || !info.sessionId || !info.channelId) {
      results.push({ name: tmuxName, ok: false, error: "registry 中缺少 sessionId 或 channelId" });
      continue;
    }

    // per-agent 跨进程锁：另一个 restart 正在处理同一 agent 就跳过（不阻塞），
    // 防并发交错把启动命令打进无关窗口（peer 2026-08-09 新证据）
    if (!tryLockRestart(tmuxName)) {
      console.error(`[restart] ${tmuxName} 另一个 restart 正在进行，跳过（避免并发交错）`);
      results.push({ name: tmuxName, ok: false, error: "另一个 restart 正在进行，已跳过" });
      continue;
    }

    try {
    // 1. 看同名 window 数量决定路径。永远不要用 ambiguous name target 做 kill
    //    —— v2.4.2 之前这里走 `kill-window -t master:<name>`，tmux 遇到多份同名
    //    会报 "more than one window" 错误，外层 `.catch(() => {})` 吞掉错误后
    //    无条件 new-window，导致 launcher periodic 每分钟净增 1 个 zombie。
    //    关键：永远不创建新 Discord 频道，复用 info.channelId
    let recreated = false;
    const dupIds = await listWindowIdsByName(tmuxName);

    if (dupIds.length === 0) {
      // 真 dead，直接 new
      recreated = true;
    } else if (dupIds.length === 1) {
      // 正常一份 —— 优雅退出，失败 by-id kill 这一份再 new
      const exited = await gracefulExit(tmuxName);
      if (!exited) {
        // v2.21.1+ 死锁进程按键杀不动(peer 2026-08-30 真实救援):kill-window 的
        // SIGHUP 它也可能无视,孤儿继续占着 session → 新实例必「启动超时」且错因
        // 误导。先点名强杀子进程(SIGTERM→SIGKILL 升级)并确认死亡;杀不死就报
        // 真因终止,不再盲目走启动侧。
        const kids = await windowChildPids(dupIds[0]).catch(() => [] as number[]);
        const survivors = kids.length > 0 ? await killPidsEscalating(kids) : [];
        if (survivors.length > 0) {
          results.push({
            name: tmuxName,
            ok: false,
            error: `旧 Claude 进程未退出(pid=${survivors.join(",")}),SIGKILL 无效——可能卡在不可中断的内核态(D 状态),需人工检查后重试`,
          });
          continue;
        }
        console.error(
          `[restart] ${tmuxName} 优雅退出超时，已强杀子进程(${kids.join(",") || "无"})，kill-window @${dupIds[0]} + 重建`,
        );
        await tmuxRaw(["kill-window", "-t", dupIds[0]]).catch(() => {});
        await Bun.sleep(500);
        recreated = true;
      }
    } else {
      // 多份 zombie（历史 race / restart 死循环遗留）—— 全部 by-id kill 再 new
      console.error(`[restart] ${tmuxName} 发现 ${dupIds.length} 个同名 zombie window，全部 kill 后重建`);
      for (const id of dupIds) {
        // v2.21.1+ 同款强杀:zombie 窗口里的死锁进程不随 kill-window 退出
        const kids = await windowChildPids(id).catch(() => [] as number[]);
        if (kids.length > 0) await killPidsEscalating(kids);
        await tmuxRaw(["kill-window", "-t", id]).catch(() => {});
      }
      await Bun.sleep(500);
      recreated = true;
    }

    if (recreated) {
      const cwd = info.cwd || process.env.HOME || "/";
      await tmuxRaw(["new-window", "-t", MASTER_SESSION, "-n", tmuxName, "-c", cwd]);
      await Bun.sleep(500);
    }

    // 2. 重新启动 Claude Code — 沿用 registry 中存储的 channelId + 权限配置
    const displayName = info.displayName || tmuxName.replace(AGENT_PREFIX, "");
    // v2.16+ purpose 注入 restart 也带上(会话虽有历史,系统提示常驻比翻聊天记录可靠);
    // resume 写入的占位 purpose("resumed: xxx")无信息量,过滤
    const purposeForInject =
      info.purpose && !info.purpose.startsWith("resumed:") ? info.purpose : undefined;
    const cmd = buildClaudeCommand({
      channelId: info.channelId,
      bridgeUrl: BRIDGE_URL,
      resumeId: info.sessionId,
      displayName,
      disallowedPreset: info.disallowedPreset,
      disallowedRaw: info.disallowedRaw,
      effort: info.effort,
      // 老 agent（feature 前建的）info.permissionMode 为空 → buildClaudeCommand
      // 回退 bypassPermissions，行为不变。新 agent 沿用 registry 里存的模式。
      permissionMode: info.permissionMode,
      // v2.4.20+ restart 沿用 registry 里钉的模型（这是"改全局无效"的解法：
      // 显式 --model 覆盖 --resume 钉死的会话原模型）。
      model: info.model,
      purpose: purposeForInject,
      agentName: tmuxName,
    });

    let started = await startClaudeInWindow(tmuxName, cmd);

    // v2.7+ 自愈：session 被 bg agent 占用 → --fork-session 分支副本重试，
    // 就绪后探测 fork 出的新 session id 并回写 registry（否则 watcher/下次
    // restart 又会盯回被占用的旧 id）。
    if (!started.ready && started.bgOccupied) {
      const cwd = info.cwd || process.env.HOME || "/";
      console.error(`[restart] ${tmuxName} 的 session 被 bg agent 占用，改用 --fork-session 重试`);
      const before = await listSessionJsonls(cwd);
      const forkCmd = buildClaudeCommand({
        channelId: info.channelId,
        bridgeUrl: BRIDGE_URL,
        resumeId: info.sessionId,
        forkSession: true,
        displayName,
        disallowedPreset: info.disallowedPreset,
        disallowedRaw: info.disallowedRaw,
        effort: info.effort,
        permissionMode: info.permissionMode,
        model: info.model,
        purpose: purposeForInject,
        agentName: tmuxName,
      });
      started = await startClaudeInWindow(tmuxName, forkCmd);
      if (started.ready) {
        const newId = await waitForNewSessionId(cwd, before);
        if (newId) {
          // v2.8+ fork 换代：旧 session 从 registry 退役，先归档快照
          await archiveSession(tmuxName, cwd, info.sessionId).catch(() => {});
          reg.agents[tmuxName].sessionId = newId;
          reg.agents[tmuxName].notes = `claude session: ${newId} (forked from ${info.sessionId.slice(0, 8)})`;
          await saveRegistry(reg);
          console.error(`[restart] ${tmuxName} fork 出新 session ${newId.slice(0, 8)}，registry 已回写`);
        } else {
          console.error(`[restart] ⚠️ ${tmuxName} fork 成功但未探测到新 session id，registry 未更新`);
        }
        await bridgeRequest({
          type: "reply",
          chatId: info.channelId,
          text: `🔀 ${displayName} 原 session 被后台 agent 占用，已自动 fork 副本恢复（上下文完整）${newId ? "" : "，⚠️ 新 session id 探测失败请查 registry"}`,
        }).catch(() => {});
      }
    }

    // v2.5.4: 会话内补发 /model，restart 也是 --resume（同样会漂回 session 原模型）
    if (started.ready) await enforceSessionModel(tmuxName, info.model);

    // P2（peer 2026-08-09）：cmdRestart 此前全程不写 status——restart 一个
    // stopped agent 进程真起来、频道真注册，但 registry 永远停在 stopped，与
    // cmdList（硬编码 active）永久分叉：web 显示「未启动」、归档兜底跳过它、
    // restoreDeadAgents 只认 active 故永不自愈。成功即写回 active。
    if (started.ready && reg.agents[tmuxName] && reg.agents[tmuxName].status !== "active") {
      reg.agents[tmuxName].status = "active";
      regDirty = true;
    }

    // v2.21.1+ 超时报错附 session jsonl 体积(peer 建议):--resume 整读大文件,
    // 346MB 级的 session 启动本身就要一两分钟,省得排查时再人肉 stat
    let timeoutErr: string | undefined;
    if (!started.ready) {
      timeoutErr = "启动超时";
      try {
        const cwd = (info.cwd || "").replace(/^~/, process.env.HOME || "~");
        const sz = statSync(projectJsonlPath(cwd, info.sessionId)).size;
        if (sz > 50 * 1024 * 1024) {
          timeoutErr += `(session jsonl ${Math.round(sz / 1024 / 1024)}MB——resume 大会话本身可能就需 1-2 分钟,可考虑 clear/fork)`;
        }
      } catch { /* jsonl 不在原处,不加注 */ }
    }
    results.push({
      name: tmuxName,
      ok: started.ready,
      error: timeoutErr,
      recreated: recreated || undefined,
    });

    // v2.0.23+: 自动恢复了完整会话 → 给该 agent 频道发一条正面"已恢复"信号，
    // 取代 permission-watcher 那条让人摸不清状态的 session-idle 按钮消息。
    // 只在确实命中 session-idle 弹窗时发；普通秒级重启不打扰。
    if (started.ready && started.recoveredFullSession) {
      await bridgeRequest({
        type: "reply",
        chatId: info.channelId,
        text: `✅ ${displayName} 已重启，自动恢复完整会话（无 compact，上下文保留）`,
      }).catch(() => { /* 通知失败不影响重启结果 */ });
    }
    } finally {
      unlockRestart(tmuxName); // 无论成败/异常都释锁，别把 agent 永久锁死
    }
  }

  if (regDirty) await saveRegistry(reg); // P2：落回 status=active

  // 重启后做一次完整 skill 重扫（每个 agent cwd 可能项目级 skill 有变动）
  await triggerSkillsRescan("full");

  output({
    ok: results.every((r) => r.ok),
    results,
    message: results.map((r) => `${r.name}: ${r.ok ? "✅" : `❌ ${r.error}`}`).join("\n"),
  });
}

async function cmdList() {
  const tmuxWindows = await listAgentWindowsShared();
  const reg = await loadRegistry();

  const agents: Record<string, unknown>[] = [];

  for (const name of tmuxWindows) {
    const idle = await isAgentIdle(name);
    const info = reg.agents[name];
    // v2.19.0（peer 2026-08-13 P0 的「最该修的一条」）：启动失败后窗口**存在
    // 但里面没有 claude**，pane 停在 shell 提示符。dead 判定原来只看窗口在不
    // 在 → 判它活着 → restoreDeadAgents 的 periodic 巡检永远不会救它 →
    // 永久失联，而 web 显示一切正常。改为「窗口在但 pane 是裸 shell」也算 dead。
    // 两次采样确认，避开 claude 启动瞬间的过渡帧；正在 restart 的窗口（持锁）
    // 一律不判——那正是它该停在 shell 的时候。
    // registry 里没这条的孤儿窗口不判 dead：自愈救不了它（没有 sessionId /
    // channelId 可用），判了只会让 launcher 每分钟白试一次并往频道刷失败通知。
    if (info && !isRestartInProgress(name) && isAtShell(await captureLast(name, 5))) {
      await Bun.sleep(800);
      // 硬判据兜底（peer 2026-08-23 P0，日志实证误杀）：pane 文本是软判据，会被
      // web 终端 resize 触发的 CC 全屏重绘骗到——重绘窗口期 capture-pane 抓到的是
      // scrollback 里的旧裸 shell 行（那行提示符一直在），两次采样只隔 800ms、
      // 机器超卖时重绘超过 800ms 毫不意外 → isAtShell 连续成立 → 把正在干活的
      // agent 误判 dead 后 gracefulExit 杀掉重启。claude 活着必然是该 window shell
      // 的子进程，resize/重绘/滚动都骗不了它（launcher 判 master 死活、wedge-watcher
      // 都是这么做的）。⚠ windowHasChildProcess 返回 boolean|null：null=探测失败=
      // 不确定，必须当「不判 dead」——写 !hasChild 会把 null 当 false 反而更易误杀。
      const stillShell = isAtShell(await captureLast(name, 5));
      // stillShell 为真才去 spawn ps(省一次进程);否则 hasChild 留 null,判据 false
      const hasChild = stillShell ? await windowHasChildProcess(name) : null;
      if (deadShellVerdict(stillShell, hasChild)) {
        console.error(`[list] ⚠️ ${name} 窗口存在但停在 shell 且无子进程（claude 未启动/已退出），判为 dead 交给自愈`);
        agents.push({
          name,
          status: "dead",
          idle: false,
          project: info?.project || "unknown",
          projectId: info?.projectId || null,
          cwd: info?.cwd || "",
          purpose: info?.purpose || "",
          channelId: info?.channelId || "",
          sessionId: info?.sessionId || "",
          created: info?.created || "",
        });
        continue;
      }
    }
    // P2（peer 2026-08-09）：窗口活着但 registry 说 stopped = 两个数据源分叉。
    // cmdRestart 现在会写回 status，理论上不该再出现；真出现就是还有别的写入
    // 路径漏了——静默分叉会让 web 显示「未启动」、归档跳过、自愈不认，必须留痕。
    if (info && info.status && info.status !== "active") {
      console.error(`[list] ⚠️ ${name} 窗口存在但 registry status=${info.status}（数据源分叉，restart 一次可修）`);
    }
    agents.push({
      name,
      status: "active",
      idle,
      project: info?.project || "unknown",
      projectId: info?.projectId || null,
      cwd: info?.cwd || "",
      purpose: info?.purpose || "",
      channelId: info?.channelId || "",
      sessionId: info?.sessionId || "",
      // v2.14+ 创建时间透出 —— web 侧栏按它把新建的 agent 排到最前
      created: info?.created || "",
    });
  }

  // 也列出 registry 里 active 但 tmux 已死的
  for (const [name, info] of Object.entries(reg.agents)) {
    if (info.status === "active" && !tmuxWindows.includes(name)) {
      agents.push({
        name,
        status: "dead",
        idle: false,
        project: info.project,
        projectId: info.projectId || null,
        cwd: info.cwd || "",
        purpose: info.purpose,
        channelId: info.channelId,
        sessionId: info.sessionId,
        created: info.created || "",
      });
    }
  }

  output({ ok: true, agents });
}

async function cmdSessions(search?: string) {
  const sessions = await scanClaudeSessions(search);

  // 从 registry 建立 sessionId → displayName 映射
  const reg = await loadRegistry();
  const nameMap = new Map<string, string>();
  for (const info of Object.values(reg.agents)) {
    if (info.sessionId && info.displayName) {
      nameMap.set(info.sessionId, info.displayName);
    }
  }

  const display = sessions.slice(0, 25).map((s, i) => ({
    index: i + 1,
    sessionId: s.sessionId,
    name: nameMap.get(s.sessionId) || s.slug || s.sessionId.slice(0, 8),
    slug: s.slug,
    project: s.cwd.replace(process.env.HOME || "", "~"),
    age: formatAge(s.modifiedAt),
    lastMessage: s.lastUserMessage || "",
  }));

  output({
    ok: true,
    total: sessions.length,
    showing: display.length,
    sessions: display,
  });
}

// ============================================================
// Cron 管理命令
// ============================================================

import { loadJobs, saveJobs, parseCronExpression, nextCronTime, type CronJob } from "./cron.js";

async function cmdCronAdd(name: string, schedule: string, dir: string, prompt: string, reportChannelId?: string, targetAgent?: string) {
  // 验证 cron 表达式
  try {
    parseCronExpression(schedule);
  } catch (err) {
    output({ ok: false, error: (err as Error).message });
    return;
  }

  const jobs = await loadJobs();

  // 检查同名
  if (jobs.some((j) => j.name === name)) {
    output({ ok: false, error: `已存在同名任务: "${name}"` });
    return;
  }

  const job: CronJob = {
    id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    schedule,
    prompt,
    dir: dir.replace(/^~/, process.env.HOME || "~"),
    enabled: true,
    createdAt: new Date().toISOString(),
    ...(reportChannelId ? { reportChannelId } : {}),
    ...(targetAgent ? { targetAgent } : {}),
  };

  try {
    job.nextRun = nextCronTime(schedule).toISOString();
  } catch { /* non-critical */ }

  jobs.push(job);
  await saveJobs(jobs);

  output({
    ok: true,
    job: { id: job.id, name: job.name, schedule: job.schedule, nextRun: job.nextRun },
    message: `定时任务 "${name}" 已创建 (${schedule})`,
  });
}

async function cmdCronList() {
  const jobs = await loadJobs();
  output({
    ok: true,
    total: jobs.length,
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      dir: j.dir.replace(process.env.HOME || "", "~"),
      prompt: j.prompt.slice(0, 80),
      enabled: j.enabled,
      lastRun: j.lastRun || null,
      nextRun: j.nextRun || null,
      ...(j.targetAgent ? { targetAgent: j.targetAgent } : {}),
    })),
  });
}

/** v2.20+ 原地编辑:保 id/lastRun/createdAt(改频率≠换任务,owner 2026-08-26
 *  「改个频率要重建不合理」)。schedule 变更时重算 nextRun。 */
async function cmdCronEdit(
  nameOrId: string,
  patch: { schedule?: string; prompt?: string; name?: string; dir?: string }
) {
  if (patch.schedule) {
    try {
      parseCronExpression(patch.schedule);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      return;
    }
  }
  const jobs = await loadJobs();
  const job = jobs.find((j) => j.name === nameOrId || j.id === nameOrId);
  if (!job) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  if (patch.name && patch.name !== job.name && jobs.some((j) => j.name === patch.name)) {
    output({ ok: false, error: `已存在同名任务: "${patch.name}"` });
    return;
  }
  if (patch.name) job.name = patch.name;
  if (patch.prompt) job.prompt = patch.prompt;
  if (patch.dir) job.dir = patch.dir.replace(/^~/, process.env.HOME || "~");
  if (patch.schedule) {
    job.schedule = patch.schedule;
    if (job.enabled) {
      try { job.nextRun = nextCronTime(patch.schedule).toISOString(); } catch { /* non-critical */ }
    }
  }
  await saveJobs(jobs);
  output({
    ok: true,
    job: { id: job.id, name: job.name, schedule: job.schedule, nextRun: job.nextRun ?? null, lastRun: job.lastRun ?? null },
    message: `定时任务 "${job.name}" 已更新`,
  });
}

async function cmdCronRemove(nameOrId: string) {
  const jobs = await loadJobs();
  const idx = jobs.findIndex((j) => j.name === nameOrId || j.id === nameOrId);
  if (idx < 0) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  const removed = jobs.splice(idx, 1)[0];
  await saveJobs(jobs);
  output({ ok: true, removed: removed.name, message: `定时任务 "${removed.name}" 已删除` });
}

async function cmdCronToggle(nameOrId: string) {
  const jobs = await loadJobs();
  const job = jobs.find((j) => j.name === nameOrId || j.id === nameOrId);
  if (!job) {
    output({ ok: false, error: `找不到任务: "${nameOrId}"` });
    return;
  }
  job.enabled = !job.enabled;
  if (job.enabled) {
    try { job.nextRun = nextCronTime(job.schedule).toISOString(); } catch { /* non-critical */ }
  } else {
    job.nextRun = undefined;
  }
  await saveJobs(jobs);
  output({
    ok: true,
    name: job.name,
    enabled: job.enabled,
    message: `定时任务 "${job.name}" 已${job.enabled ? "启用" : "暂停"}`,
  });
}

async function cmdCronHistory(nameOrId?: string) {
  const historyPath = `${process.env.HOME}/.claude-orchestrator/cron-history.json`;
  let history: any[] = [];
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(await readFile(historyPath, "utf-8"));
    } catch { /* non-critical */ }
  }
  if (nameOrId) {
    history = history.filter((h) => h.jobName === nameOrId || h.jobId === nameOrId);
  }
  output({
    ok: true,
    total: history.length,
    records: history.slice(-20).reverse(),
  });
}

// ============================================================
// 版本检查 / 自动更新
// ============================================================

// ============================================================
// 权限管理
// ============================================================

function describePerm(info: AgentInfo): {
  preset: string;
  raw?: string;
  tools: string[];
} {
  if (info.disallowedRaw) {
    return {
      preset: "(custom)",
      raw: info.disallowedRaw,
      tools: info.disallowedRaw.trim().split(/\s+/).filter(Boolean),
    };
  }
  const preset = info.disallowedPreset || DEFAULT_PRESET;
  return {
    preset,
    tools: [...(DISALLOWED_PRESETS[preset] || [])],
  };
}

async function cmdPermissions(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    // 列出所有 agent 的权限
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => {
        const d = describePerm(info);
        return { name, preset: d.preset, toolCount: d.tools.length };
      });
    output({ ok: true, agents: rows });
    return;
  }

  if (sub === "presets") {
    const presets = listPresets().map((name) => ({
      name,
      toolCount: DISALLOWED_PRESETS[name].length,
      tools: [...DISALLOWED_PRESETS[name]],
    }));
    output({ ok: true, presets, default: DEFAULT_PRESET });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "usage: permissions get <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    const d = describePerm(info);
    output({
      ok: true,
      agent: tmuxName,
      preset: d.preset,
      disallowedRaw: d.raw,
      tools: d.tools,
    });
    return;
  }

  if (sub === "set") {
    // permissions set <name> --preset <name>
    // permissions set <name> --disallowed "..."
    const [name] = rest;
    if (!name) {
      output({
        ok: false,
        error: 'usage: permissions set <name> --preset <preset> | --disallowed "..."',
      });
      return;
    }
    const { preset, disallowedRaw } = extractPermFlags(rest.slice(1));
    if (!preset && !disallowedRaw) {
      output({
        ok: false,
        error: '需要指定 --preset 或 --disallowed。可用 preset: ' + listPresets().join(", "),
      });
      return;
    }
    if (preset && !isKnownPreset(preset)) {
      output({
        ok: false,
        error: `未知预设: "${preset}"。可用: ${listPresets().join(", ")}`,
      });
      return;
    }

    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.disallowedPreset = preset;
    info.disallowedRaw = disallowedRaw;
    await saveRegistry(reg);

    const d = describePerm(info);
    output({
      ok: true,
      agent: tmuxName,
      preset: d.preset,
      disallowedRaw: d.raw,
      tools: d.tools,
      hint: `新配置已写入 registry。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  if (sub === "reset") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "usage: permissions reset <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.disallowedPreset = undefined;
    info.disallowedRaw = undefined;
    await saveRegistry(reg);
    output({
      ok: true,
      agent: tmuxName,
      preset: DEFAULT_PRESET,
      hint: `已重置为默认预设。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  output({
    ok: false,
    error: `未知子命令: permissions ${sub}`,
    usage: [
      "permissions list                 — list every agent's permission preset",
      "permissions presets              — list available presets及其包含的工具",
      "permissions get <name>           — show one agent's permissions in detail",
      'permissions set <name> --preset <preset>｜--disallowed "..."',
      "permissions reset <name>         — reset to the default preset",
    ],
  });
}

// ============================================================
// Effort level 管理（per-agent --effort）
// ============================================================

async function cmdEffort(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => ({
        name,
        effort: info.effort || "(inherit)",
      }));
    output({ ok: true, agents: rows, hint: "(inherit) = 跟随 ~/.claude/settings.json 全局 effortLevel" });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "usage: effort get <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    output({
      ok: true,
      agent: tmuxName,
      effort: info.effort || "(inherit)",
    });
    return;
  }

  if (sub === "reset") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "usage: effort reset <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.effort = undefined;
    await saveRegistry(reg);
    output({
      ok: true,
      agent: tmuxName,
      effort: "(inherit)",
      hint: `已清除。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  // 默认形式：effort <agent> <level> 或 effort set <agent> <level>
  let agentName: string;
  let level: string;
  if (sub === "set") {
    [agentName, level] = rest;
  } else {
    agentName = sub;
    level = rest[0];
  }

  if (!agentName || !level) {
    output({
      ok: false,
      error: "usage: effort <agent> <level> | effort reset <agent> | effort list",
      validLevels: KNOWN_EFFORT_LEVELS,
    });
    return;
  }

  if (!isKnownEffort(level)) {
    output({
      ok: false,
      error: `未知的 effort level: "${level}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}`,
    });
    return;
  }

  const tmuxName = normalizeName(agentName);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `找不到 agent: ${tmuxName}` });
    return;
  }
  info.effort = level;
  await saveRegistry(reg);
  output({
    ok: true,
    agent: tmuxName,
    effort: level,
    hint: `已写入 registry。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
  });
}

/**
 * mode 子命令 —— 查看 / 改 agent 的权限模式（--permission-mode）。
 * 用法对齐 cmdEffort：
 *   mode list                列出所有 agent 的模式
 *   mode get <agent>         查单个
 *   mode <agent> <mode>      改（= mode set <agent> <mode>）
 * 改完要 restart 才生效（是启动 flag）。
 */
async function cmdMode(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => ({
        name,
        permissionMode: info.permissionMode || "(bypass, 老 agent)",
      }));
    output({
      ok: true,
      agents: rows,
      validModes: PERMISSION_MODES,
      hint: "(bypass, 老 agent) = feature 前建的，启动回退 bypassPermissions",
    });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "usage: mode get <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    output({
      ok: true,
      agent: tmuxName,
      permissionMode: info.permissionMode || "(bypass, 老 agent)",
    });
    return;
  }

  // 默认形式：mode <agent> <mode> 或 mode set <agent> <mode>
  let agentName: string;
  let modeVal: string;
  if (sub === "set") {
    [agentName, modeVal] = rest;
  } else {
    agentName = sub;
    modeVal = rest[0];
  }

  if (!agentName || !modeVal) {
    output({
      ok: false,
      error: "usage: mode <agent> <mode>｜mode get <agent>｜mode list",
      validModes: PERMISSION_MODES,
    });
    return;
  }

  if (!isKnownPermissionMode(modeVal)) {
    output({
      ok: false,
      error: `未知的权限模式: "${modeVal}"。可用: ${PERMISSION_MODES.join(", ")}`,
    });
    return;
  }

  const tmuxName = normalizeName(agentName);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `找不到 agent: ${tmuxName}` });
    return;
  }
  info.permissionMode = modeVal;
  await saveRegistry(reg);
  output({
    ok: true,
    agent: tmuxName,
    permissionMode: modeVal,
    hint: `已写入 registry。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
  });
}

/**
 * v2.4.20+ model 子命令 —— 查看 / 改 agent 的模型（--model）。用法对齐 cmdEffort：
 *   model list                  列出所有 agent 的模型 + 可用别名
 *   model get <agent>           查单个
 *   model <agent> <model>       改（= model set <agent> <model>）
 *   model reset <agent>         清除（跟随全局 settings.json）
 *   model all <model>           一把把所有 active agent 钉到同一模型
 * 改完要 restart 才生效（是启动 flag）。
 */
async function cmdModel(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => ({
        name,
        model: info.model ? resolveModelAlias(info.model) : "(inherit)",
      }));
    output({
      ok: true,
      agents: rows,
      aliases: listModelAliases(),
      hint: "(inherit) = 跟随 ~/.claude/settings.json 全局模型。别名或完整 model id 都可用。",
    });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) { output({ ok: false, error: "usage: model get <name>" }); return; }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) { output({ ok: false, error: `找不到 agent: ${tmuxName}` }); return; }
    output({ ok: true, agent: tmuxName, model: info.model ? resolveModelAlias(info.model) : "(inherit)" });
    return;
  }

  if (sub === "reset") {
    const [name] = rest;
    if (!name) { output({ ok: false, error: "usage: model reset <name>" }); return; }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) { output({ ok: false, error: `找不到 agent: ${tmuxName}` }); return; }
    info.model = undefined;
    await saveRegistry(reg);
    output({
      ok: true, agent: tmuxName, model: "(inherit)",
      hint: `已清除。restart ${tmuxName.replace(AGENT_PREFIX, "")} 生效。`,
    });
    return;
  }

  // model all <model> —— 一把钉所有 active agent（满足"把所有 agent 切 fable"）
  if (sub === "all") {
    const [modelVal] = rest;
    if (!modelVal) { output({ ok: false, error: "usage: model all <model>", aliases: listModelAliases() }); return; }
    const resolved = resolveModelAlias(modelVal);
    const reg = await loadRegistry();
    const changed: string[] = [];
    for (const [name, info] of Object.entries(reg.agents)) {
      if (info.status === "active") {
        info.model = modelVal;
        changed.push(name);
      }
    }
    await saveRegistry(reg);
    // v2.5.4: idle 的 agent 顺手在会话内立即生效（忙的跳过，restart 时会补发）
    const applied: string[] = [];
    for (const name of changed) {
      if ((await isAgentIdle(name).catch(() => false)) && (await enforceSessionModel(name, modelVal))) {
        applied.push(name);
      }
    }
    output({
      ok: true,
      model: resolved,
      changed,
      appliedLive: applied,
      hint: `已钉 ${changed.length} 个 active agent 到 ${resolved}；${applied.length} 个 idle 的已当场生效，其余在下次 restart 时自动补发 /model。`,
    });
    return;
  }

  // 默认：model <agent> <model> 或 model set <agent> <model>
  let agentName: string;
  let modelVal: string;
  if (sub === "set") {
    [agentName, modelVal] = rest;
  } else {
    agentName = sub;
    modelVal = rest[0];
  }

  if (!agentName || !modelVal) {
    output({ ok: false, error: "usage: model <agent> <model>｜model reset <agent>｜model all <model>｜model list", aliases: listModelAliases() });
    return;
  }

  const tmuxName = normalizeName(agentName);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) { output({ ok: false, error: `找不到 agent: ${tmuxName}` }); return; }
  info.model = modelVal;
  await saveRegistry(reg);
  // v2.5.4: idle 就当场在会话内生效；忙就等下次 restart 自动补发
  const appliedLive =
    (await isAgentIdle(tmuxName).catch(() => false)) && (await enforceSessionModel(tmuxName, modelVal));
  output({
    ok: true,
    agent: tmuxName,
    model: resolveModelAlias(modelVal),
    appliedLive,
    hint: appliedLive
      ? `已写入 registry 并当场生效（会话内 /model）。`
      : `已写入 registry。agent 正忙，会在下次 restart 时自动补发 /model 生效。`,
  });
}

// ============================================================
// 版本检查 / 自动更新
// ============================================================

const REPO_ROOT = `${import.meta.dir}/..`;

async function git(...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(["git", "-C", REPO_ROOT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

async function cmdVersion() {
  const { getLatestRelease, getLocalVersion, isNewer } = await import("./lib/github-release.js");

  const local = await getLocalVersion();
  const head = (await git("rev-parse", "HEAD")).out.slice(0, 7);
  const release = await getLatestRelease();

  const hasUpdate = release ? isNewer(release.version, local) : false;

  output({
    ok: true,
    version: local,
    head,
    latestRelease: release?.tag || null,
    latestVersion: release?.version || null,
    upToDate: !hasUpdate,
    summary: !release
      ? `v${local} @ ${head}（无法查询远端 release）`
      : hasUpdate
        ? `v${local} → ${release.tag} 可更新`
        : `已是最新 v${local} @ ${head}`,
  });
}

/** v2.16.3 update 附带的 web 构建(HedeMacBook-Pro owner 提案 + 五条实现约束)。
 *  返回值进 update 输出的 webBuild 字段——skipped/ok/error 三态,绝不静默。 */
async function maybeBuildWeb(
  fromRef: string,
  toRef: string
): Promise<{ built: boolean; restarted?: boolean; skipped?: string; error?: string }> {
  const webDir = `${REPO_ROOT}/web`;
  // 约束2:没装 web 的实例跳过,不拖垮整体 update
  if (!existsSync(`${webDir}/node_modules`)) return { built: false, skipped: "web 未安装(无 node_modules)" };
  // 约束3:本次 pull 没碰 web/ 就不花这个钱(next build 分钟级,自动更新 30 分钟一轮)
  const diff = await git("diff", "--name-only", `${fromRef}..${toRef}`, "--", "web/");
  if (!diff.ok) return { built: false, skipped: `diff 失败(${diff.err}),保守跳过` };
  const touched = diff.out.split("\n").filter(Boolean);
  if (!touched.length) return { built: false, skipped: "本次更新未触及 web/" };
  // v2.17.2:npm 走绝对路径 + 补 PATH(launchd 环境 ENOENT 静默漏建,peer 定案);
  // spawn 失败也必须冒泡进返回值,不能只留日志
  const npmBin = resolveNpm();
  if (!npmBin) {
    return { built: false, error: "找不到 npm(PATH/nvm/homebrew 都没有)——web 未构建,旧构建仍在服务" };
  }
  const npmEnv = { ...process.env, PATH: `${npmBin.binDir}:${process.env.PATH || ""}` } as Record<string, string>;
  try {
    // 依赖变了先装
    if (touched.some((f) => f === "web/package.json" || f === "web/package-lock.json")) {
      const ip = Bun.spawn([npmBin.npm, "install"], { cwd: webDir, env: npmEnv, stdout: "pipe", stderr: "pipe" });
      await ip.exited;
    }
    // 约束4:构建失败保留旧构建继续服务,但结果必须显式冒泡
    const bp = Bun.spawn([npmBin.npm, "run", "build"], { cwd: webDir, env: npmEnv, stdout: "pipe", stderr: "pipe" });
    const [bout, berr] = await Promise.all([new Response(bp.stdout).text(), new Response(bp.stderr).text()]);
    await bp.exited;
    if (bp.exitCode !== 0) {
      const tail = (berr || bout).split("\n").filter(Boolean).slice(-8).join("\n");
      console.error(`[update] web 构建失败(保留旧构建继续服务):\n${tail}`);
      return { built: false, error: `next build 失败(旧构建仍在服务): ${tail.slice(0, 500)}` };
    }
  } catch (e) {
    return { built: false, error: `web 构建 spawn 失败(${(e as Error).message})——旧构建仍在服务` };
  }
  // 约束1:重启只在我们「拥有监督者」时做(launchd 服务在场即 kickstart,KeepAlive
  // 保证拉起)。非 launchd 托管(裸 next start/pm2/别人的 supervisor)不猜不杀——
  // 按命令行 pkill 会漏真正的 next-server 监听进程,留下占端口孤儿更难查。
  const svc = Bun.spawn(
    ["launchctl", "print", `gui/${process.getuid?.() ?? 501}/com.claudestra.web`],
    { stdout: "ignore", stderr: "ignore" }
  );
  await svc.exited;
  if (svc.exitCode === 0) {
    const kick = Bun.spawn(
      ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 501}/com.claudestra.web`],
      { stdout: "ignore", stderr: "ignore" }
    );
    await kick.exited;
    return { built: true, restarted: kick.exitCode === 0 };
  }
  return { built: true, restarted: false, skipped: "web 非 launchd 托管——已构建,请自行重启 web 进程" };
}

/** update.lock 互斥。锁文件里是持有者 pid——已有锁时先验持有者是否还活着:
 *  v2.17.2(peer 取证):update 子进程常由 launcher 派生,installClaudestraCli
 *  bootout launcher 时 launchd 会把它连坐回收(macOS 责任链不随 detach 断),
 *  来不及 unlock → 孤儿锁把之后 30 分钟的一切更新(含 beta 自动前进)封死。
 *  持有 pid 已死的锁直接清除接管;活着的仍按 30 分钟陈旧闸。 */
async function takeUpdateLock(): Promise<{ ok: boolean; error?: string }> {
  const lockPath = `${process.env.HOME}/.claude-orchestrator/update.lock`;
  try {
    const st = statSync(lockPath);
    let holderAlive = false;
    try {
      const pid = parseInt((await Bun.file(lockPath).text()).trim(), 10);
      if (pid > 0) {
        process.kill(pid, 0); // 只探活不发信号
        holderAlive = true;
      }
    } catch { /* 读不到 pid / 进程不存在 → 孤儿 */ }
    if (holderAlive && Date.now() - st.mtimeMs < 30 * 60_000) {
      return { ok: false, error: "另一次 update 正在进行(持有进程在世,update.lock 未满 30 分钟)——稍后再试" };
    }
    if (!holderAlive) console.error("[update] 清除孤儿 update.lock(持有 pid 已死)");
  } catch { /* 无锁 */ }
  await writeFile(lockPath, String(process.pid)).catch(() => {});
  return { ok: true };
}

/** v2.17 beta 通道 update:紧跟 origin/main 的每个 commit(ff-only,天然在分支
 *  上不 detach)。release 通道走下面的 cmdUpdate 正式流程。 */
async function cmdUpdateBeta() {
  const updateLock = `${process.env.HOME}/.claude-orchestrator/update.lock`;
  const lock = await takeUpdateLock();
  if (!lock.ok) {
    output({ ok: false, error: lock.error });
    return;
  }
  const unlock = () => import("fs/promises").then((m) => m.rm(updateLock, { force: true })).catch(() => {});

  const status = await git("status", "--porcelain");
  if (!status.ok || status.out) {
    await unlock();
    output({ ok: false, error: status.ok ? "仓库有未提交的改动,先 commit/stash 再更新" : "不是 git 仓库" });
    return;
  }
  await git("fetch", "--quiet", "origin", "main");
  const preHead = (await git("rev-parse", "HEAD")).out.trim();
  const remote = (await git("rev-parse", "origin/main")).out.trim();
  if (!remote) { await unlock(); output({ ok: false, error: "取不到 origin/main" }); return; }
  if (preHead === remote) {
    // 已同步;若还挂在 detached 顺手挂回(beta 通道也可能从 release 时代的 detach 迁移来)
    await git("checkout", "main", "--quiet");
    await git("merge", "--ff-only", "origin/main", "--quiet");
    await unlock();
    output({ ok: true, channel: "beta", head: preHead.slice(0, 7), message: `beta 已是最新 @ ${preHead.slice(0, 7)}` });
    return;
  }
  const anc = await git("merge-base", "--is-ancestor", "HEAD", "origin/main");
  if (!anc.ok) {
    await unlock();
    output({ ok: false, error: `本地 HEAD 与 origin/main 分叉,beta 通道不强推——手动处理后再试(git log HEAD...origin/main)` });
    return;
  }
  const co = await git("checkout", "main", "--quiet");
  const ff = co.ok ? await git("merge", "--ff-only", "origin/main", "--quiet") : co;
  if (!ff.ok) { await unlock(); output({ ok: false, error: `ff 前进失败: ${ff.err}` }); return; }

  const biProc = Bun.spawn(["bun", "install"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  await biProc.exited;
  const rendered = await renderMasterClaude();
  const webBuild = await maybeBuildWeb(preHead, remote);
  const migrateProc = Bun.spawn(["bun", "run", `${REPO_ROOT}/src/manager.ts`, "migrate"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  await migrateProc.exited;
  await Bun.sleep(500);
  await tmuxRaw(["send-keys", "-t", `${MASTER_SESSION}:0`, "/exit", "Enter"]).catch(() => {});
  // ⚠ 先释锁再 reload daemon:bootout launcher 会让本进程被 launchd 连坐回收
  // (peer 取证),殉锁会把之后 30 分钟的更新全封死。临界区(git/build)已过,
  // 这里释放安全;进程死在 reload 里属预期,损失的只有收尾输出。
  await unlock();
  console.log(`[update] beta 临界区完成,即将 reload 3 daemons(本进程可能随 launcher bootout 被回收,属预期)`);
  const { installClaudestraCli } = await import("./lib/cli-install.js");
  const cliInstall = await installClaudestraCli(REPO_ROOT);
  output({
    ok: true,
    channel: "beta",
    from: preHead.slice(0, 7),
    to: remote.slice(0, 7),
    message: `beta 已前进 ${preHead.slice(0, 7)} → ${remote.slice(0, 7)} 并 reload daemon`,
    masterReRendered: rendered,
    webBuild,
    cliInstalled: cliInstall.errors.length === 0,
  });
}

async function cmdUpdate() {
  // v2.17 通道分流:beta 走 commit 级前进,release 走正式版流程
  {
    const { readConfig } = await import("./lib/config-store.js");
    if (((await readConfig()).autoUpdate.channel ?? "release") === "beta") {
      await cmdUpdateBeta();
      return;
    }
  }
  const { getLatestRelease, getLocalVersion, isNewer } = await import("./lib/github-release.js");

  // 1. 查询最新 release
  const release = await getLatestRelease();
  if (!release) {
    output({ ok: false, error: "无法查询 GitHub release（网络问题或没有发布过 release）" });
    return;
  }

  const local = await getLocalVersion();
  if (!isNewer(release.version, local)) {
    output({ ok: true, version: local, message: `已是最新版本 v${local}` });
    return;
  }

  // 2. 确认工作目录干净
  const status = await git("status", "--porcelain");
  if (!status.ok) {
    output({ ok: false, error: "不是 git 仓库，无法自动更新" });
    return;
  }
  if (status.out) {
    output({
      ok: false,
      error: "仓库有未提交的改动，请先 commit/stash 后再更新",
      dirty: status.out,
    });
    return;
  }

  // v2.16.3 并发闸(HedeMacBook-Pro 约束5):自动更新 30 分钟一轮,web 构建
  // 动辄分钟级,别被下一轮重入。v2.17.2 起孤儿锁(持有 pid 已死)直接接管。
  const updateLock = `${process.env.HOME}/.claude-orchestrator/update.lock`;
  const relLock = await takeUpdateLock();
  if (!relLock.ok) {
    output({ ok: false, error: relLock.error });
    return;
  }

  // web 构建的变更判定要用 checkout 前的 HEAD
  const preUpdateHead = (await git("rev-parse", "HEAD")).out.trim();

  // 3. fetch tags + checkout release tag
  await git("fetch", "--tags", "--quiet", "origin");
  const checkout = await git("checkout", release.tag, "--quiet");
  if (!checkout.ok) {
    await import("fs/promises").then((m) => m.rm(updateLock, { force: true })).catch(() => {});
    output({ ok: false, error: `git checkout ${release.tag} 失败: ${checkout.err}` });
    return;
  }

  // 3b. v2.16.3 挂回分支(HedeMacBook-Pro 报告:checkout <tag> 必然 detached
  //     HEAD——工作区内容对,但本地分支永不前进、stash 落在 no branch 上,
  //     版本冻结类故障的温床)。无分叉才 ff 挂回;分叉(开发机本地有超前
  //     commit)保持 detached 并在输出里说明,绝不静默。
  const reattach = await (async (): Promise<{ ok: boolean; detail: string }> => {
    for (const br of ["main", "master"]) {
      const has = await git("rev-parse", "--verify", "--quiet", `refs/heads/${br}`);
      if (!has.ok) continue;
      const anc = await git("merge-base", "--is-ancestor", br, release.tag);
      if (!anc.ok) return { ok: false, detail: `本地 ${br} 与 ${release.tag} 分叉,保持 detached(开发机属预期);手工挂回: git checkout ${br} && git merge --ff-only ${release.tag}` };
      const co = await git("checkout", br, "--quiet");
      if (!co.ok) return { ok: false, detail: `checkout ${br} 失败: ${co.err}` };
      const ff = await git("merge", "--ff-only", release.tag, "--quiet");
      if (!ff.ok) return { ok: false, detail: `ff 合并失败: ${ff.err}` };
      return { ok: true, detail: `已挂回 ${br} @ ${release.tag}` };
    }
    return { ok: false, detail: "未找到 main/master 本地分支,保持 detached" };
  })();
  if (!reattach.ok) console.error(`[update] ⚠️ ${reattach.detail}`);

  // 4. bun install（依赖可能变了）
  const biProc = Bun.spawn(["bun", "install"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  await biProc.exited;

  // 4b. 重新渲染 master/CLAUDE.md（新版本可能更新了 master prompt；不刷新的话 master 还用老 context）
  const rendered = await renderMasterClaude();

  // 4c. v2.16.3 web 构建纳入 update(HedeMacBook-Pro owner 提案:此前 bridge 侧
  //     生效、web 侧继续跑旧构建的「半生效」状态最难排查)。内部自带四道闸:
  //     未装 web 跳过 / 本次未触及 web/ 跳过 / 构建失败保留旧构建并显式冒泡 /
  //     仅 launchd 托管时才自动重启。
  const webBuild = await maybeBuildWeb(preUpdateHead, release.tag);

  // 5. 执行新版 manager 的 migrate 子命令（新版可能带格式迁移逻辑）
  //    关键：用 subprocess 跑 NEW 版代码，当前进程跑的还是旧版
  const migrateProc = Bun.spawn(
    ["bun", "run", `${REPO_ROOT}/src/manager.ts`, "migrate"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }
  );
  await migrateProc.exited;

  // v2.4.0+: 不再 pm2 restart。install-cli 用 launchctl bootout+bootstrap 来
  // reload 三个 daemon plist，每次都生效新代码；如果检测到老 pm2 进程也会顺手
  // stop 掉避免双跑。pm2 从启动链彻底解耦。

  // 6b. 告诉正在跑的 master Claude Code 退出，launcher 会用新 CLAUDE.md 重启它
  //     （daemon reload 只重启 bridge/launcher/cron 三个后台进程，不会动 tmux 里
  //      的 master session — 不这么做的话老 master 会继续跑着旧的 CLAUDE.md 上下文）
  await Bun.sleep(500);
  await tmuxRaw(["send-keys", "-t", `${MASTER_SESSION}:0`, "/exit", "Enter"]).catch(() => {});

  // 7. install-cli —— 写 CLI wrapper + 3 个 daemon plist + 迁移老 pm2/老 autostart
  //    plist + stop 老 pm2 daemon + launchctl bootstrap 三个新 plist（这一步等同于
  //    重启 daemon，自动加载新代码）。Idempotent —— 每次 update 跑一次都安全；老用户
  //    从 v2.3.x 升级到 v2.4.0 的第一次 update 就把所有迁移做完，全无感。
  // ⚠ 先释锁再 reload daemon(与 beta 路径同理,peer 取证的连坐回收也可能发生
  // 在 release 自动更新——launcher 派生的 update 子进程死在 bootout launcher 时)
  await import("fs/promises").then((m) => m.rm(updateLock, { force: true })).catch(() => {});
  console.log(`[update] 临界区完成,即将 reload 3 daemons(本进程可能随 launcher bootout 被回收,属预期)`);
  const { installClaudestraCli } = await import("./lib/cli-install.js");
  const cliInstall = await installClaudestraCli(REPO_ROOT);

  output({
    ok: true,
    from: `v${local}`,
    to: release.tag,
    message: `已更新到 ${release.tag} 并 reload 三个 launchd daemon`,
    masterReRendered: rendered,
    // web 构建结果显式冒泡(skipped 带原因 / ok / error 带尾部日志)——绝不静默
    webBuild,
    // 分支挂回结果(detached HEAD 修复,v2.16.3)——同样绝不静默
    branch: reattach,
    cliInstalled: cliInstall.errors.length === 0,
    cliWrapper: cliInstall.cliWrapper || undefined,
    daemons: cliInstall.daemons.map((d) => ({ label: d.label, loaded: d.loaded, warning: d.warning })),
    pm2Stopped: cliInstall.pm2Stopped.length > 0 ? cliInstall.pm2Stopped : undefined,
    oldAutostartPlist: cliInstall.oldAutostartPlist,
    oldPm2StartupPlist: cliInstall.oldPm2StartupPlist,
    migratedHookCommand: cliInstall.migratedHookCommand || undefined,
    bumpedTmuxDashboardLimit: cliInstall.bumpedTmuxDashboardLimit,
    allowedMcpTools: cliInstall.allowedMcpTools,
    cliErrors: cliInstall.errors.length > 0 ? cliInstall.errors : undefined,
    cliWarnings: cliInstall.warnings.length > 0 ? cliInstall.warnings : undefined,
  });
}

/**
 * 用当前 .env 里的 USER_NAME 重新渲染 master/CLAUDE.md from template。
 * 新版本可能更新了 master prompt（新工具、新命令），不重渲染的话 master 启动时读的还是旧 CLAUDE.md。
 */
async function renderMasterClaude(): Promise<{ rendered: boolean; reason?: string }> {
  const { existsSync } = await import("fs");
  const templatePath = `${REPO_ROOT}/master/CLAUDE.md.template`;
  if (!existsSync(templatePath)) return { rendered: false, reason: "template 不存在" };

  // 从 .env 读 USER_NAME / MASTER_DIR(manager 可能从任意 cwd 被调起,Bun 只
  // 自动加载 cwd 的 .env——env 里没有就直接翻仓库根的 .env)
  const readEnvVar = async (key: string): Promise<string> => {
    if (process.env[key]) return process.env[key]!;
    if (!existsSync(`${REPO_ROOT}/.env`)) return "";
    try {
      const envText = await Bun.file(`${REPO_ROOT}/.env`).text();
      const m = envText.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    } catch {
      return "";
    }
  };
  const userName = (await readEnvVar("USER_NAME")) || "User";
  // v2.16+ MASTER_DIR 可移出仓库(省掉 master 加载仓库根 CLAUDE.md 的 ~11k token),
  // 渲染目标跟着走;模板内命令用 {{REPO_ROOT}} 绝对路径,不再依赖 cwd 相对定位
  const masterDir = (await readEnvVar("MASTER_DIR")) || `${REPO_ROOT}/master`;

  try {
    let tpl = await Bun.file(templatePath).text();
    tpl = tpl.replaceAll("{{USER_NAME}}", userName).replaceAll("{{REPO_ROOT}}", REPO_ROOT);
    await mkdir(masterDir, { recursive: true });
    await Bun.write(`${masterDir}/CLAUDE.md`, tpl);
    return { rendered: true };
  } catch (e) {
    return { rendered: false, reason: (e as Error).message };
  }
}

async function cmdInviteLink(args: string[]) {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) {
    output({ ok: false, error: "DISCORD_BOT_TOKEN 未设置，无法生成邀请链接" });
    return;
  }

  // Bot token 第一段是 base64(appId)。appId === bot user ID === client_id
  let appId = "";
  try {
    const firstSeg = token.split(".")[0];
    appId = Buffer.from(firstSeg, "base64").toString("utf-8");
    if (!/^\d{17,20}$/.test(appId)) throw new Error("decoded not snowflake");
  } catch {
    output({ ok: false, error: "从 DISCORD_BOT_TOKEN 解出 App ID 失败。token 格式可能不对" });
    return;
  }

  // v2.11: --peer 最小权限链接已随 Discord peer 机制移除，只保留 owner 用途。
  // Discord 权限 bitfield：https://discord.com/developers/docs/topics/permissions
  // Owner 完整权限（建频道、发消息、附件、反应、改 role 等）
  const OWNER_PERMS =
    (1 << 10) +   // VIEW_CHANNEL       = 1024
    (1 << 11) +   // SEND_MESSAGES      = 2048
    (1 << 16) +   // READ_MESSAGE_HISTORY = 65536
    (1 <<  4) +   // MANAGE_CHANNELS    = 16
    (1 << 28) +   // MANAGE_ROLES       = 268435456
    (1 << 15) +   // ATTACH_FILES       = 32768
    (1 <<  6) +   // ADD_REACTIONS      = 64
    (1 << 14);    // EMBED_LINKS        = 16384

  const scopes = ["bot", "applications.commands"];

  const params = new URLSearchParams({
    client_id: appId,
    permissions: String(OWNER_PERMS),
    scope: scopes.join(" "),
  });
  const url = `https://discord.com/api/oauth2/authorize?${params.toString()}`;

  output({
    ok: true,
    kind: "owner",
    appId,
    permissions: OWNER_PERMS,
    scopes,
    url,
    message: `这是一个 **owner 完整权限** 邀请链接（含 Manage Channels 等）。你自己安装 bot 到你服务器用这个。`,
  });
}

// ============================================================
// v2.6.0+ HTTP API token（多前端架构 Phase B，设计 §3.4 / §5.1 / R1）
// ============================================================

/**
 * token-add <name> --agents a,b [--force] [--no-mirror]
 * 生成一个 API token，scope 限定在指定 agent。secret 只显示这一次。
 * R1 防呆：目标 agent 未标 external:true（create --external）时要求 --force。
 */
async function cmdTokenAdd(name: string, agentsCsv: string, force: boolean, noMirror: boolean, terminal: boolean) {
  const { readPrincipals, writePrincipals, newTokenPrincipal, tokenIdOf } =
    await import("./lib/principals.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!name || agents.length === 0) {
    output({ ok: false, error: 'token-add <name> --agents <a,b|*> [--force] [--no-mirror] [--terminal]' });
    return;
  }

  // scope 里的 agent 校验：存在性 + R1 external 检查（"*" 跳过存在性，仍警告）
  const reg = await loadRegistry();
  const warnings: string[] = [];
  for (const a of agents) {
    if (a === "*") {
      if (!force) {
        output({
          ok: false,
          error: `--agents "*" 会把全部 agent 开放给这个 token（master 除外）。上下文共享有泄密风险（R1），确认请加 --force。`,
        });
        return;
      }
      warnings.push(`"*" scope：所有普通 agent 都对此 token 可见`);
      continue;
    }
    // "master" 是特殊 scope 值（大总管不在 registry）：显式列出 + --force 才放行
    if (a === "master") {
      if (!force) {
        output({
          ok: false,
          error: `--agents 含 "master" 会把大总管开放给这个 token（上下文最敏感，R1）。确认请加 --force。`,
        });
        return;
      }
      warnings.push(`"master" scope：大总管对此 token 可见`);
      continue;
    }
    const info = reg.agents[a] || reg.agents[`agent-${a}`];
    if (!info) {
      output({ ok: false, error: `agent "${a}" 不存在（registry 里没有 ${a} / agent-${a}）` });
      return;
    }
    if (!info.external && !force) {
      output({
        ok: false,
        error:
          `agent "${a}" 未标记为对外专用（external）。把日常在用的 agent 开放给外部 token，` +
          `对方可以套出该 agent 上下文里的既有内容（R1 共享上下文风险）。` +
          `建议：为外部用途新建专用 agent（create <name> <dir> --external）；` +
          `确实要开放这个就加 --force。`,
      });
      return;
    }
    if (!info.external) warnings.push(`"${a}" 未标 external，已用 --force 强制开放`);
  }

  if (terminal) {
    warnings.push(`--terminal：此 token 可开远程终端（往 agent 的 tmux 注入按键 = 宿主 shell 级访问，可绕过 --disallowedTools）`);
  }

  const file = await readPrincipals();
  const p = newTokenPrincipal(name, agents, { terminal });
  if (noMirror) p.mirror = false;
  file.principals.push(p);
  await writePrincipals(file);

  output({
    ok: true,
    tokenId: tokenIdOf(p),
    name,
    agents,
    mirror: p.mirror,
    terminal: p.terminal === true,
    secret: p.secret,
    secretNote: "⚠️ secret 只显示这一次，请立即保存。调用方式: Authorization: Bearer <secret>",
    warnings,
    usage: `curl -H "Authorization: Bearer ${p.secret}" -X POST http://<bridge>/api/v1/agents/${agents[0] === "*" ? "<agent>" : agents[0]}/messages -H "Content-Type: application/json" -d '{"text":"你好","wait":60}'`,
  });
}

// ── v2.11+ HTTP peer 握手（docs/design-http-peers.md §3）─────────────────

/** peer 名校验:名字要进 `x@peer` / `peer:name.agent` 寻址语法,"@" "." 空白都会
 *  撞分隔符(review 2026-07-19 #11) */
function validPeerName(name: string): boolean {
  return /^[\w-]{1,32}$/.test(name);
}

/** 握手串自报名:对方界面上「谁邀请的我」。USER_NAME 是 setup 时配置的称呼。 */
function selfPeerName(): string {
  return (process.env.USER_NAME || "").trim().replace(/[^\w-]/g, "") || hostname().split(".")[0];
}

/** invite/join 共用的 scope 校验（token-add 同款 R1 规则,不动原函数避免回归） */
async function checkPeerScope(agents: string[], force: boolean): Promise<{ error?: string; warnings: string[] }> {
  const reg = await loadRegistry();
  const warnings: string[] = [];
  for (const a of agents) {
    if (a === "*") {
      if (!force) return { error: `--agents "*" 会把全部 agent 开放给 peer（R1 共享上下文风险）。确认请加 --force。`, warnings };
      warnings.push(`"*" scope：所有普通 agent 都对此 peer 可见`);
      continue;
    }
    if (a === "master") {
      // v2.15+ 无条件拒绝，--force 也不行（owner 2026-07-27:「大总管不可能被
      // peer 分享出去」）。消费侧 agentInScope 对 peer token 有同款硬闸兜历史。
      return { error: `大总管不可开放给 peer——这是硬规则，--force 也不放行。`, warnings };
    }
    const info = reg.agents[a] || reg.agents[`agent-${a}`];
    if (!info) return { error: `agent "${a}" 不存在`, warnings };
    if (!info.external && !force) {
      return { error: `agent "${a}" 未标 external——peer 可套出其上下文既有内容（R1）。建议为 peer 用途 create --external 专用 agent；确实要开放就加 --force。`, warnings };
    }
    if (!info.external) warnings.push(`"${a}" 未标 external，已用 --force 强制开放`);
  }
  return { warnings };
}

/** 为 peer 签 token 并登记 principal。返回 {tokenId, secret} */
async function issuePeerToken(peerName: string, agents: string[]): Promise<{ tokenId: string; secret: string }> {
  const { readPrincipals, writePrincipals, newTokenPrincipal, tokenIdOf } = await import("./lib/principals.js");
  const file = await readPrincipals();
  // 同名 peer 的旧 token 先禁用（重跑握手不留悬空凭据）
  for (const p of file.principals) {
    if (p.peer === peerName && !p.disabled) p.disabled = true;
  }
  const p = newTokenPrincipal(`peer-${peerName}`, agents, { peer: peerName });
  file.principals.push(p);
  await writePrincipals(file);
  return { tokenId: tokenIdOf(p), secret: p.secret! };
}

/**
 * peer 握手的 `--url` 没给时自动探测本机对外地址。
 *
 * 手抄这个地址是三步握手里最容易出错的一环：IP 记错一位、忘带端口、或者把
 * 127.0.0.1 填进去（对方永远连不上，而错误要拖到 peer-http-test 才暴露）。
 * 探测优先 Tailscale（100.64/10，唯一跨网络可达），其次内网地址。
 * 返回 null 表示确实探不到，调用方照旧报错要求人工给 --url。
 */
async function resolveMyBridgeUrl(myUrl: string): Promise<{ url: string; note?: string } | null> {
  // bridge 默认只绑 127.0.0.1——邀请串里的对外地址再对,对方也连不进来。
  // 生成邀请这一刻就把话说明白,别拖到对方兑换失败才暴露(loopback 显式 --url 同理)。
  const bind = (process.env.BRIDGE_BIND || "127.0.0.1").trim();
  const bindWarn = bind === "127.0.0.1" || bind === "localhost" || bind === "::1"
    ? `⚠️ bridge 当前只监听 ${bind}（BRIDGE_BIND 未开放）——对方无法连入。在 .env 设 BRIDGE_BIND=0.0.0.0（或 Tailscale IP）并重启 bridge 后邀请才可用。`
    : "";
  if (myUrl) return { url: myUrl, note: bindWarn || undefined };
  const { detectBridgeUrls } = await import("./lib/net-addr.js");
  const port = parseInt(process.env.BRIDGE_PORT || "3847");
  const cands = detectBridgeUrls(port);
  if (cands.length === 0) return null;
  const best = cands[0]!;
  const others = cands.slice(1).map((c) => `${c.url}(${c.kind})`);
  return {
    url: best.url,
    note: `--url 未给，自动用 ${best.kind === "tailscale" ? "Tailscale" : "内网"} 地址 ${best.url}（网卡 ${best.iface}）` +
      (others.length ? `；其它候选: ${others.join(", ")}` : "") +
      (best.kind === "lan" ? "。⚠️ 内网地址只在同一局域网可达，跨网络请改用 Tailscale 或反代域名。" : "") +
      (bindWarn ? ` ${bindWarn}` : ""),
  };
}

async function cmdPeerHttpInvite(peerName: string, agentsCsv: string, myUrl: string, force: boolean, rotate: boolean) {
  const { upsertHttpPeer, encodePeerHandshake, findHttpPeer } = await import("./lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || agents.length === 0) {
    output({ ok: false, error: "peer-http-invite <peerName> --agents <a,b> [--url <我方bridge地址>] [--force] [--rotate]（--url 不给会自动探测本机 Tailscale/内网地址）" });
    return;
  }
  const resolvedI = await resolveMyBridgeUrl(myUrl);
  if (!resolvedI) {
    output({ ok: false, error: "探测不到本机对外地址（没有 Tailscale 也没有内网网卡），请显式给 --url <http://host:port>" });
    return;
  }
  myUrl = resolvedI.url;
  if (!validPeerName(peerName)) {
    output({ ok: false, error: `peer 名只能是字母/数字/下划线/连字符(1-32 位)——"@" "." 空格会撞 send_to_agent 的寻址语法` });
    return;
  }
  // 重跑保护:签新 token 会禁用旧 token,已完成握手的 peer 会立刻断联(review #9)
  {
    const existing = await findHttpPeer(peerName);
    if (existing?.outToken && existing?.baseUrl && !rotate) {
      output({ ok: false, error: `peer "${peerName}" 已完成握手。重新 invite 会作废对方手里的 token(对方立刻断联,需重新走完三步)。确认轮换请加 --rotate。` });
      return;
    }
  }
  if (!/^https?:\/\//.test(myUrl)) {
    output({ ok: false, error: `--url 必须是 http(s):// 开头的对外可达地址（Tailscale IP / 内网 IP / 反代域名）` });
    return;
  }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { tokenId, secret } = await issuePeerToken(peerName, agents);
  await upsertHttpPeer({ name: peerName, inTokenId: tokenId });
  const invite = encodePeerHandshake({ v: 1, name: selfPeerName(), url: myUrl.replace(/\/+$/, ""), token: secret });
  output({
    ok: true, peer: peerName, exposedAgents: agents, inTokenId: tokenId,
    warnings: resolvedI.note ? [...check.warnings, resolvedI.note] : check.warnings,
    myUrl,
    invite,
    next: `把 invite 串发给对方 → 对方跑: peer-http-join <你的名字> '<invite串>' --agents <他开放的> --url <他的地址> → 他把回执串发回 → 你跑: peer-http-accept ${peerName} '<回执串>'`,
  });
}

async function cmdPeerHttpJoin(peerName: string, handshakeStr: string, agentsCsv: string, myUrl: string, force: boolean, rotate: boolean) {
  const { upsertHttpPeer, parsePeerHandshake, encodePeerHandshake, findHttpPeer } = await import("./lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || !handshakeStr || agents.length === 0) {
    output({ ok: false, error: "peer-http-join <peerName> '<邀请串>' --agents <a,b> [--url <我方地址>] [--force] [--rotate]（--url 不给会自动探测本机 Tailscale/内网地址）" });
    return;
  }
  const resolvedJ = await resolveMyBridgeUrl(myUrl);
  if (!resolvedJ) {
    output({ ok: false, error: "探测不到本机对外地址（没有 Tailscale 也没有内网网卡），请显式给 --url <http://host:port>" });
    return;
  }
  myUrl = resolvedJ.url;
  if (!validPeerName(peerName)) {
    output({ ok: false, error: `peer 名只能是字母/数字/下划线/连字符(1-32 位)` });
    return;
  }
  {
    const existing = await findHttpPeer(peerName);
    if (existing?.outToken && existing?.baseUrl && !rotate) {
      output({ ok: false, error: `peer "${peerName}" 已完成握手。重新 join 会作废双方 token。确认轮换请加 --rotate。` });
      return;
    }
  }
  const hs = parsePeerHandshake(handshakeStr);
  if (!hs) { output({ ok: false, error: "邀请串无法解析（应为 peer-http-invite 输出的 base64 串）" }); return; }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { tokenId, secret } = await issuePeerToken(peerName, agents);
  await upsertHttpPeer({ name: peerName, baseUrl: hs.url, outToken: hs.token, inTokenId: tokenId });
  const receipt = encodePeerHandshake({ v: 1, name: selfPeerName(), url: myUrl.replace(/\/+$/, ""), token: secret });
  output({
    ok: true, peer: peerName, peerUrl: hs.url, exposedAgents: agents, inTokenId: tokenId,
    warnings: resolvedJ.note ? [...check.warnings, resolvedJ.note] : check.warnings,
    myUrl,
    receipt,
    next: `把 receipt 串发回对方 → 对方跑: peer-http-accept <你在他那的名字> '<receipt串>'。然后双方各自 peer-http-test 验证。`,
  });
}

async function cmdPeerHttpAccept(peerName: string, handshakeStr: string) {
  const { findHttpPeer, upsertHttpPeer, parsePeerHandshake } = await import("./lib/peers.js");
  if (!peerName || !handshakeStr) {
    output({ ok: false, error: "peer-http-accept <peerName> '<回执串>'" });
    return;
  }
  const existing = await findHttpPeer(peerName);
  if (!existing) {
    output({ ok: false, error: `HTTP peer "${peerName}" 不存在——先跑 peer-http-invite ${peerName} ...` });
    return;
  }
  const hs = parsePeerHandshake(handshakeStr);
  if (!hs) { output({ ok: false, error: "回执串无法解析" }); return; }
  await upsertHttpPeer({ name: peerName, baseUrl: hs.url, outToken: hs.token });
  output({ ok: true, peer: peerName, peerUrl: hs.url, note: `握手完成。跑 peer-http-test ${peerName} 验证连通。` });
}

async function cmdPeerHttpTest(peerName: string) {
  const { findHttpPeer } = await import("./lib/peers.js");
  const peer = await findHttpPeer(peerName);
  if (!peer) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  if (!peer.outToken || !peer.baseUrl) {
    output({ ok: false, error: `握手未完成（${!peer.baseUrl ? "缺对方地址" : "缺 outToken"}）——invite 后要等 accept 回执` });
    return;
  }
  try {
    const res = await fetch(`${peer.baseUrl}/api/v1/agents`, {
      headers: { Authorization: `Bearer ${peer.outToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      output({ ok: false, error: `对方返回 ${res.status}: ${body?.error || "未知"}`, hint: res.status === 401 ? "token 无效/已 revoke——重新握手" : undefined });
      return;
    }
    const agents = (body?.agents || []).map((a: any) => ({ name: a.name, status: a.status }));
    output({ ok: true, peer: peerName, url: peer.baseUrl, reachable: true, remoteAgents: agents, note: `send_to_agent usage: target="<their-agent>@${peerName}"` });
  } catch (e) {
    output({ ok: false, error: `连接失败: ${(e as Error).message}`, hint: "确认对方 bridge 在线、BRIDGE_BIND 对外可达、URL/端口正确" });
  }
}

async function cmdPeerHttpList() {
  const { readPeers } = await import("./lib/peers.js");
  const data = await readPeers();
  const peers = (data.httpPeers || []).map((p) => ({
    name: p.name,
    baseUrl: p.baseUrl || "(等待对方回执)",
    handshakeDone: !!(p.outToken && p.baseUrl),
    inTokenId: p.inTokenId,
    disabled: !!p.disabled,
    addedAt: p.addedAt,
  }));
  output({ ok: true, count: peers.length, httpPeers: peers });
}

/** v2.11.1+ 改 peer 入站 scope（token 不换,对方无感;web peer 管理 UI 的后端） */
async function cmdPeerHttpScope(peerName: string, agentsCsv: string, force: boolean) {
  const { findHttpPeer } = await import("./lib/peers.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!peerName || agents.length === 0) {
    output({ ok: false, error: "peer-http-scope <peerName> --agents <a,b|*> [--force]" });
    return;
  }
  const peer = await findHttpPeer(peerName);
  if (!peer) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const { readPrincipals, writePrincipals, tokenIdOf } = await import("./lib/principals.js");
  const file = await readPrincipals();
  const p = file.principals.find((x) => x.peer === peerName && !x.disabled);
  if (!p) {
    output({ ok: false, error: `peer "${peerName}" 没有有效 token——先完成握手（invite/join）` });
    return;
  }
  p.agents = agents;
  await writePrincipals(file);
  output({ ok: true, peer: peerName, exposedAgents: agents, tokenId: tokenIdOf(p), warnings: check.warnings, note: "入站 scope 已更新，立即生效（token 不变）" });
}

async function cmdPeerHttpRemove(peerName: string) {
  const { removeHttpPeer } = await import("./lib/peers.js");
  const { readPrincipals, writePrincipals } = await import("./lib/principals.js");
  const removed = await removeHttpPeer(peerName);
  if (!removed) { output({ ok: false, error: `HTTP peer "${peerName}" 不存在` }); return; }
  // 我签出去的 token 一并禁用——对方立刻失去入站能力
  const file = await readPrincipals();
  let revoked = 0;
  for (const p of file.principals) {
    if (p.peer === peerName && !p.disabled) { p.disabled = true; revoked++; }
  }
  if (revoked) await writePrincipals(file);
  output({ ok: true, removed: peerName, tokensRevoked: revoked, note: "对方持有的 token 已失效;我方存的对方 token 已删除" });
}

// ── v2.15+ 一键邀请（invite v2:免回执自动握手,docs/design-http-peers.md）──

/** 按 token 短 id 禁用 principal。onlyUnredeemed=true 时仅动 peer 字段仍是
 *  "invite:*" 占位的（已兑换的 token 归 peer 管理面管,不在这里误伤）。 */
async function disableTokenById(tokenId: string, onlyUnredeemed: boolean): Promise<boolean> {
  const { readPrincipals, writePrincipals } = await import("./lib/principals.js");
  const file = await readPrincipals();
  const p = file.principals.find((x) => x.id === `token:${tokenId}`);
  if (!p || p.disabled) return false;
  if (onlyUnredeemed && !(p.peer || "").startsWith("invite:")) return false;
  p.disabled = true;
  await writePrincipals(file);
  return true;
}

/** 过期邀请清扫：吊销预签 token + 从 pendingInvites 移除。邀请串里带的是
 *  真 Bearer——不吊销的话「24h 过期」就是句空话。invite-new/list/redeem 前都跑。 */
async function sweepExpiredInvites(): Promise<number> {
  const { readPeers, writePeers, inviteExpired } = await import("./lib/peers.js");
  const data = await readPeers();
  const expired = (data.pendingInvites || []).filter((i) => inviteExpired(i));
  if (expired.length === 0) return 0;
  for (const inv of expired) await disableTokenById(inv.inTokenId, true);
  data.pendingInvites = (data.pendingInvites || []).filter((i) => !inviteExpired(i));
  await writePeers(data);
  return expired.length;
}

/** 自报名净化 + 撞名后缀。对方的名字是自报的——撞上已有 peer 时必须换名,
 *  否则一张新邀请就能顶掉既有 peer 的 baseUrl/outToken(peer 劫持)。
 *  sameAs 返回 true 表示「就是同一个 peer」(合并而非后缀)。 */
async function uniquePeerName(
  rawName: string,
  sameAs: (existing: import("./lib/peers.js").HttpPeer) => boolean,
): Promise<string> {
  const { readPeers } = await import("./lib/peers.js");
  const base = rawName.trim().replace(/[^\w-]/g, "").slice(0, 24) || "peer";
  const data = await readPeers();
  const all = data.httpPeers || [];
  let name = base;
  for (let n = 2; n < 100; n++) {
    const hit = all.find((p) => p.name === name);
    if (!hit || sameAs(hit)) return name;
    name = `${base}-${n}`;
  }
  return `${base}-${Date.now() % 10000}`;
}

/** 生成一键邀请：预签入站 token + 登记待兑换记录,输出 v2 邀请串。 */
async function cmdPeerInviteNew(agentsCsv: string, myUrl: string, force: boolean) {
  const { addPendingInvite, encodePeerInviteV2, INVITE_TTL_MS } = await import("./lib/peers.js");
  const { randomBytes } = await import("crypto");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (agents.length === 0) {
    output({ ok: false, error: "peer-invite-new --agents <a,b|*> [--url <我方地址>] [--force]" });
    return;
  }
  await sweepExpiredInvites();
  const resolved = await resolveMyBridgeUrl(myUrl);
  if (!resolved) {
    output({ ok: false, error: "探测不到本机对外地址（没有 Tailscale 也没有内网网卡），请显式给 --url <http://host:port>" });
    return;
  }
  myUrl = resolved.url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(myUrl)) {
    output({ ok: false, error: `--url 必须是 http(s):// 开头的对外可达地址` });
    return;
  }
  const check = await checkPeerScope(agents, force);
  if (check.error) { output({ ok: false, error: check.error }); return; }
  const id = `inv_${randomBytes(4).toString("hex")}`;
  const joinSecret = randomBytes(24).toString("hex");
  // 占位 peer 名 "invite:<id>"——兑换时改成对方自报名。占位前缀同时是
  // 「未兑换」的判定依据(过期清扫只吊销这类)。
  const { tokenId, secret } = await issuePeerToken(`invite:${id}`, agents);
  const now = Date.now();
  await addPendingInvite({
    id, joinSecret, inTokenId: tokenId, agents, url: myUrl,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  });
  const invite = encodePeerInviteV2({ v: 2, name: selfPeerName(), url: myUrl, token: secret, join: joinSecret });
  output({
    ok: true, id, agents, myUrl, expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    warnings: resolved.note ? [...check.warnings, resolved.note] : check.warnings,
    invite,
    next: "把邀请串发给对方（走任意私聊渠道）→ 对方粘贴即完成。24h 未兑换自动作废。",
  });
}

async function cmdPeerInviteList() {
  const { readPeers, encodePeerInviteV2 } = await import("./lib/peers.js");
  const { readPrincipals } = await import("./lib/principals.js");
  const swept = await sweepExpiredInvites();
  const [data, pf] = await Promise.all([readPeers(), readPrincipals()]);
  const invites = (data.pendingInvites || []).map((i) => {
    const tok = pf.principals.find((x) => x.id === `token:${i.inTokenId}` && !x.disabled);
    return {
      id: i.id, agents: i.agents, createdAt: i.createdAt, expiresAt: i.expiresAt,
      // token secret 还在才拼得出完整串（供「再复制一次」;secret 本就落在本机文件里）
      invite: tok?.secret ? encodePeerInviteV2({ v: 2, name: selfPeerName(), url: i.url, token: tok.secret, join: i.joinSecret }) : null,
    };
  });
  output({ ok: true, count: invites.length, invites, ...(swept ? { sweptExpired: swept } : {}) });
}

async function cmdPeerInviteRevoke(id: string) {
  const { removePendingInvite } = await import("./lib/peers.js");
  if (!id) { output({ ok: false, error: "peer-invite-revoke <inv_id>" }); return; }
  const inv = await removePendingInvite(id);
  if (!inv) { output({ ok: false, error: `邀请 "${id}" 不存在（可能已兑换或已过期清扫）` }); return; }
  const revoked = await disableTokenById(inv.inTokenId, true);
  output({ ok: true, revoked: id, tokenDisabled: revoked, note: "邀请串已作废，其内嵌 token 已吊销" });
}

/** 兑换（我是邀请方,bridge /api/v1/peers/redeem 委托进来）。对方自报
 *  name/url/token——url+token 可缺:缺 = 单向 peer(对方能访问我,我访问不了对方)。 */
async function cmdPeerInviteRedeem(joinSecret: string, peerName: string, peerUrl: string, peerToken: string) {
  const { findPendingInviteByJoinSecret, removePendingInvite, upsertHttpPeer, inviteExpired } = await import("./lib/peers.js");
  const { readPrincipals, writePrincipals } = await import("./lib/principals.js");
  if (!joinSecret || !peerName) { output({ ok: false, error: "peer-invite-redeem --join <secret> --name <对方名> [--url <对方地址>] [--token <对方token>]" }); return; }
  const inv = await findPendingInviteByJoinSecret(joinSecret);
  if (!inv) { output({ ok: false, error: "邀请无效或已被使用" }); return; }
  if (inviteExpired(inv)) {
    await removePendingInvite(inv.id);
    await disableTokenById(inv.inTokenId, true);
    output({ ok: false, error: "邀请已过期（24h）——请对方重新生成" });
    return;
  }
  if (peerUrl && !/^https?:\/\//.test(peerUrl)) { output({ ok: false, error: "对方 url 必须是 http(s):// 开头" }); return; }
  // 撞名后缀:同 inTokenId 视为同一 peer(幂等重放),否则换名防劫持
  const finalName = await uniquePeerName(peerName, (p) => p.inTokenId === inv.inTokenId);
  // 预签 token 的占位 peer 名改成对方真名——GET /peers 的 principals ⋈ 靠它
  const file = await readPrincipals();
  const tok = file.principals.find((x) => x.id === `token:${inv.inTokenId}`);
  if (!tok || tok.disabled) {
    await removePendingInvite(inv.id);
    output({ ok: false, error: "邀请对应的 token 已被吊销" });
    return;
  }
  tok.peer = finalName;
  tok.name = `peer-${finalName}`;
  await writePrincipals(file);
  await upsertHttpPeer({
    name: finalName, inTokenId: inv.inTokenId,
    ...(peerUrl ? { baseUrl: peerUrl.replace(/\/+$/, "") } : {}),
    ...(peerToken ? { outToken: peerToken } : {}),
  });
  await removePendingInvite(inv.id);
  output({ ok: true, peer: finalName, agents: inv.agents, oneWay: !peerToken, inviteId: inv.id });
}

/** v2.16.1 跨 tailnet 候选扫描:邀请地址连不上时,扫本机 tailscale 视角的
 *  peer IP 同端口找活着的 bridge(1.5s 超时并行 GET /api/v1/agents,有 HTTP
 *  响应即候选——401 也算,那正是 token 门禁在工作)。只探测不发凭据。 */
async function scanTailnetBridges(failedUrl: string): Promise<string[]> {
  const port = (() => { try { return new URL(failedUrl).port || "3847"; } catch { return "3847"; } })();
  const failedHost = (() => { try { return new URL(failedUrl).hostname; } catch { return ""; } })();
  // tailscale CLI:PATH 里的优先,mac App 路径兜底
  let out = "";
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const proc = Bun.spawn([bin, "status", "--json"], { stdout: "pipe", stderr: "ignore" });
      out = await new Response(proc.stdout).text();
      await proc.exited;
      if (out.trim().startsWith("{")) break;
    } catch { /* 下一个候选 */ }
  }
  if (!out.trim().startsWith("{")) return [];
  const ips: string[] = [];
  try {
    const j = JSON.parse(out) as { Peer?: Record<string, { TailscaleIPs?: string[]; Online?: boolean }> };
    for (const p of Object.values(j.Peer || {})) {
      if (p.Online === false) continue;
      const v4 = (p.TailscaleIPs || []).find((ip) => /^100\./.test(ip));
      if (v4 && v4 !== failedHost) ips.push(v4);
    }
  } catch { return []; }
  const hits = await Promise.all(
    ips.slice(0, 20).map(async (ip) => {
      try {
        await fetch(`http://${ip}:${port}/api/v1/agents`, { signal: AbortSignal.timeout(1500) });
        return `http://${ip}:${port}`; // 任何 HTTP 响应(含 401)= 有 bridge
      } catch {
        return null;
      }
    })
  );
  return hits.filter((x): x is string => !!x);
}

/** 加入（我是被邀方）：粘贴 v2 邀请串一步完成。默认不向对方开放任何 agent
 *  （--agents 显式给才反向开放）——对称访问 = 对方也生成一张邀请给我。 */
async function cmdPeerJoinAuto(inviteStr: string, agentsCsv: string, myUrl: string, force: boolean, peerUrlOverride = "") {
  const { parsePeerInviteV2, parsePeerHandshake, upsertHttpPeer, removeHttpPeer, readPeers, writePeers, findHttpPeer } = await import("./lib/peers.js");
  if (!inviteStr) { output({ ok: false, error: "peer-join-auto '<邀请串>' [--agents <a,b>] [--url <我方地址>] [--peer-url <对方地址覆盖>] [--force]" }); return; }
  const hs = parsePeerInviteV2(inviteStr);
  // v2.16.1 跨 tailnet 纠偏:邀请串嵌的是**发方视角**的 tailscale IP,跨 tailnet
  // 设备共享下接方看到的是映射地址(2026-07-31 实战:串里 .46,我方视角 .45)。
  // --peer-url 显式覆盖;连不上时下方兜底扫描会给出候选提示。
  if (hs && peerUrlOverride.trim()) hs.url = peerUrlOverride.trim().replace(/\/+$/, "");
  if (!hs) {
    output({
      ok: false,
      error: parsePeerHandshake(inviteStr)
        ? "这是旧版三步握手的邀请串——用 peer-http-join 走旧流程，或让对方升级后重新生成一键邀请"
        : "邀请串无法解析（应为 peer-invite-new 输出的 base64 串）",
    });
    return;
  }
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  // 撞名:同 baseUrl 视为同一 peer(重新加入/换 token),否则后缀防覆盖
  const finalName = await uniquePeerName(hs.name, (p) => p.baseUrl === hs.url);
  const before = structuredClone(await findHttpPeer(finalName));
  let myTokenId = "", mySecret = "";
  if (agents.length > 0) {
    const check = await checkPeerScope(agents, force);
    if (check.error) { output({ ok: false, error: check.error }); return; }
    const resolved = await resolveMyBridgeUrl(myUrl);
    if (!resolved) { output({ ok: false, error: "反向开放需要我方对外地址,探测失败——请给 --url" }); return; }
    myUrl = resolved.url.replace(/\/+$/, "");
    const issued = await issuePeerToken(finalName, agents);
    myTokenId = issued.tokenId;
    mySecret = issued.secret;
  }
  await upsertHttpPeer({
    name: finalName, baseUrl: hs.url, outToken: hs.token,
    ...(myTokenId ? { inTokenId: myTokenId } : {}),
  });
  // 回调对方 redeem——失败必须回滚:半截 peer 会在列表里装成能用的样子
  type RedeemRes = { ok?: boolean; error?: string; agents?: string[]; peer?: string } | null;
  let redeemRes: RedeemRes = null;
  let redeemErr = "";
  try {
    const res = await fetch(`${hs.url}/api/v1/peers/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        join: hs.join, name: selfPeerName(),
        ...(mySecret ? { url: myUrl, token: mySecret } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    redeemRes = (await res.json().catch(() => null)) as RedeemRes;
    if (!res.ok || !redeemRes?.ok) redeemErr = redeemRes?.error || `对方返回 ${res.status}`;
  } catch (e) {
    redeemErr = `连不上对方 bridge: ${(e as Error).message}`;
  }
  if (redeemErr) {
    if (before) {
      const data = await readPeers();
      data.httpPeers = (data.httpPeers || []).map((p) => (p.name === finalName ? before : p));
      await writePeers(data);
    } else {
      await removeHttpPeer(finalName);
    }
    if (myTokenId) await disableTokenById(myTokenId, false);
    // 连接类失败 → 扫 tailnet 同端口找可达的 bridge 候选(只做无凭据的 GET 探测,
    // 兑换凭据绝不往未确认的地址发)。跨 tailnet 共享的映射地址错位就靠这提示自救。
    let hint = "确认对方 bridge 在线、地址对外可达、邀请未过期未撤销";
    if (/连不上对方 bridge/.test(redeemErr)) {
      const cands = await scanTailnetBridges(hs.url).catch(() => [] as string[]);
      if (cands.length) {
        hint = `邀请串里的地址不可达,但 tailnet 里这些地址有 bridge 在响应: ${cands.join(", ")}` +
          `。跨 tailnet 设备共享下邀请嵌的是对方视角 IP——很可能就是其中之一,用 --peer-url <地址> 重试(邀请串原样保留)。`;
      }
    }
    output({ ok: false, error: `加入失败（已回滚）: ${redeemErr}`, hint });
    return;
  }
  output({
    ok: true, peer: finalName, peerUrl: hs.url,
    remoteAgents: redeemRes?.agents ?? [],
    exposedAgents: agents,
    note: `已接入。send_to_agent 目标写法: "<对方agent>@${finalName}"` +
      (agents.length === 0 ? "。当前未向对方开放任何 agent——需要对称访问就生成一张自己的邀请发回去。" : ""),
  });
}

async function cmdTokenList() {
  const { readPrincipals, tokenIdOf } = await import("./lib/principals.js");
  const file = await readPrincipals();
  const tokens = file.principals
    .filter((p) => p.id.startsWith("token:"))
    .map((p) => ({
      tokenId: tokenIdOf(p),
      name: p.name,
      agents: p.agents,
      disabled: !!p.disabled,
      mirror: p.mirror !== false,
      createdAt: p.createdAt,
      secretPreview: p.secret ? `${p.secret.slice(0, 8)}…` : "",
    }));
  output({ ok: true, count: tokens.length, tokens });
}

async function cmdTokenRevoke(idOrName: string) {
  const { readPrincipals, writePrincipals, findToken, tokenIdOf } =
    await import("./lib/principals.js");
  const file = await readPrincipals();
  const p = findToken(file, idOrName);
  if (!p) {
    output({ ok: false, error: `找不到 token: ${idOrName}（token-list 查看现有的）` });
    return;
  }
  file.principals = file.principals.filter((x) => x !== p);
  await writePrincipals(file);
  output({ ok: true, revoked: tokenIdOf(p), name: p.name, message: "token 已删除，立即失效" });
}

async function cmdCost(args: string[]) {
  const { rollupJsonl, projectJsonlPath, findJsonlBySessionId, mergeByModel } =
    await import("./lib/jsonl-cost.js");

  // 参数解析
  let agentFilter: string | null = null;
  let sinceTs = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      sinceTs = d.getTime();
    } else if (a === "--week") {
      sinceTs = Date.now() - 7 * 24 * 3600_000;
    } else if (a === "--agent" && args[i + 1]) {
      agentFilter = args[i + 1];
      i++;
    } else if (!a.startsWith("--")) {
      agentFilter = a;
    }
  }

  const reg = await loadRegistry();
  const rows: any[] = [];
  for (const [name, info] of Object.entries(reg.agents)) {
    if (agentFilter && name !== agentFilter) continue;
    if (!info.sessionId) continue;
    let path = info.cwd ? projectJsonlPath(info.cwd, info.sessionId) : "";
    if (!path || !(await Bun.file(path).exists())) {
      const found = findJsonlBySessionId(info.sessionId);
      if (found) path = found;
      else continue;
    }
    const usage = await rollupJsonl(path, sinceTs);
    for (const u of usage) {
      rows.push({ agent: name, ...u });
    }
  }

  // 按 agent 汇总
  const byAgent = new Map<string, any>();
  for (const r of rows) {
    const cur = byAgent.get(r.agent) || {
      agent: r.agent, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, requests: 0, models: new Set<string>(),
    };
    cur.input += r.input;
    cur.cacheCreation += r.cacheCreation;
    cur.cacheRead += r.cacheRead;
    cur.output += r.output;
    cur.requests += r.requests;
    cur.models.add(r.model);
    byAgent.set(r.agent, cur);
  }

  const perAgent = [...byAgent.values()].map((x) => ({
    agent: x.agent,
    models: [...x.models],
    input: x.input,
    cacheCreation: x.cacheCreation,
    cacheRead: x.cacheRead,
    output: x.output,
    totalTokens: x.input + x.cacheCreation + x.cacheRead + x.output,
    requests: x.requests,
  }));
  perAgent.sort((a, b) => b.totalTokens - a.totalTokens);

  const total = mergeByModel(rows);

  output({
    ok: true,
    scope: agentFilter ? `agent=${agentFilter}` : "all",
    period: sinceTs ? `since ${new Date(sinceTs).toISOString()}` : "all-time",
    perAgent,
    byModel: total,
    grand: {
      input: perAgent.reduce((s, r) => s + r.input, 0),
      cacheCreation: perAgent.reduce((s, r) => s + r.cacheCreation, 0),
      cacheRead: perAgent.reduce((s, r) => s + r.cacheRead, 0),
      output: perAgent.reduce((s, r) => s + r.output, 0),
      totalTokens: perAgent.reduce((s, r) => s + r.totalTokens, 0),
      requests: perAgent.reduce((s, r) => s + r.requests, 0),
    },
  });
}

async function cmdMetrics(args: string[]) {
  const { readMetrics } = await import("./lib/metrics.js");

  // 参数
  let sinceTs = 0;
  let agentFilter: string | null = null;
  let rawOutput = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--today") {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      sinceTs = d.getTime();
    } else if (a === "--week") {
      sinceTs = Date.now() - 7 * 24 * 3600_000;
    } else if (a === "--since" && args[i + 1]) {
      sinceTs = new Date(args[++i]).getTime();
    } else if (a === "--agent" && args[i + 1]) {
      agentFilter = args[++i];
    } else if (a === "--raw") {
      rawOutput = true;
    }
  }

  let records = await readMetrics(sinceTs);
  if (agentFilter) {
    records = records.filter((r) => r.agent === agentFilter || r.meta?.agent === agentFilter);
  }

  if (rawOutput) {
    output({ ok: true, records });
    return;
  }

  // 按 event 汇总
  const byEvent = new Map<string, number>();
  const byAgent = new Map<string, { [k: string]: number }>();
  for (const r of records) {
    byEvent.set(r.event, (byEvent.get(r.event) || 0) + 1);
    const key = r.agent || r.channelId || "unknown";
    const cur = byAgent.get(key) || {};
    cur[r.event] = (cur[r.event] || 0) + 1;
    byAgent.set(key, cur);
  }

  output({
    ok: true,
    total: records.length,
    period: sinceTs ? `since ${new Date(sinceTs).toISOString()}` : "all-time",
    byEvent: Object.fromEntries(byEvent),
    byAgent: Object.fromEntries(byAgent),
  });
}

async function cmdTmuxScreenshot(name: string) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  const bunPath = resolveBunPath();
  const srcDir = import.meta.dir;
  const ts = Date.now();
  const htmlPath = `/tmp/claude-orchestrator/tmux_${tmuxName}_${ts}.html`;
  const pngPath = `/tmp/claude-orchestrator/tmux_${tmuxName}_${ts}.png`;
  await mkdir("/tmp/claude-orchestrator", { recursive: true }).catch(() => {});

  const capture = Bun.spawn(
    ["tmux", "-S", SOCK, "capture-pane", "-t", windowTarget(tmuxName), "-p", "-e", "-S", "-50"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const a2h = Bun.spawn(
    [bunPath, "run", `${srcDir}/ansi2html.ts`, htmlPath],
    { stdin: capture.stdout, stdout: "pipe", stderr: "pipe" }
  );
  await a2h.exited;
  await Bun.spawn(
    [bunPath, "run", `${srcDir}/html2png.ts`, htmlPath, pngPath, "1200"],
    { stdout: "pipe", stderr: "pipe" }
  ).exited;

  const { existsSync } = await import("fs");
  if (!existsSync(pngPath)) {
    output({ ok: false, error: "截图生成失败" });
    return;
  }
  output({ ok: true, agent: tmuxName, path: pngPath });
}

async function cmdTmuxSendKeys(name: string, keys: string[]) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  // keys 可以是 "Enter" "Escape" "Left" "C-c" 或普通字符串（用 -l 字面模式）
  for (const k of keys) {
    const special = /^(Enter|Escape|Esc|Left|Right|Up|Down|Tab|BTab|BSpace|C-[a-z]|M-[a-z]|Space)$/i.test(k);
    const args = special
      ? ["send-keys", "-t", windowTarget(tmuxName), k]
      : ["send-keys", "-t", windowTarget(tmuxName), "-l", "--", k];
    await tmuxRaw(args);
    await Bun.sleep(50);
  }
  output({ ok: true, agent: tmuxName, keys });
}

async function cmdTmuxCapture(name: string, lines: number) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  const pane = await tmuxCapture(windowTarget(tmuxName), lines);
  output({ ok: true, agent: tmuxName, lines, pane });
}

async function cmdTmuxWaitIdle(name: string, timeoutMs: number) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAgentIdle(tmuxName)) {
      output({ ok: true, agent: tmuxName, idle: true, waitedMs: timeoutMs - (deadline - Date.now()) });
      return;
    }
    await Bun.sleep(500);
  }
  output({ ok: false, agent: tmuxName, idle: false, error: `等待 ${timeoutMs}ms 超时`, timedOut: true });
}

async function cmdAutoUpdate(sub: string, ...rest: string[]) {
  const { readConfig, setAutoUpdate, setUpdateChannel } = await import("./lib/config-store.js");

  if (sub === "status" || sub === "" || sub === "get") {
    const cfg = await readConfig();
    const chan = cfg.autoUpdate.channel ?? "release";
    output({
      ok: true,
      autoUpdate: cfg.autoUpdate,
      message: `Claudestra: ${cfg.autoUpdate.claudestra ? "on" : "off"} · Claude Code: ${cfg.autoUpdate.claudeCode ? "on" : "off"} · 通道: ${chan}`,
    });
    return;
  }

  // v2.17 auto-update channel beta|release —— beta 紧跟 origin/main 每个 commit
  if (sub === "channel") {
    const chan = rest[0]?.toLowerCase();
    if (chan !== "beta" && chan !== "release") {
      output({ ok: false, error: "usage: auto-update channel <beta|release>" });
      return;
    }
    const cfg = await setUpdateChannel(chan);
    output({
      ok: true,
      autoUpdate: cfg.autoUpdate,
      message: chan === "beta"
        ? "已切到 beta 通道:update/自动更新将紧跟 origin/main 的每个 commit(未经 release 验证,自担风险)"
        : "已切回 release 通道:只跟正式发布版本",
    });
    return;
  }

  // auto-update claudestra on|off  |  auto-update claude on|off
  const targetAlias: Record<string, "claudestra" | "claudeCode"> = {
    claudestra: "claudestra",
    self: "claudestra",
    claude: "claudeCode",
    "claude-code": "claudeCode",
    claudecode: "claudeCode",
    cc: "claudeCode",
  };
  const target = targetAlias[sub.toLowerCase()];
  const state = rest[0]?.toLowerCase();

  if (!target || (state !== "on" && state !== "off")) {
    output({
      ok: false,
      error: `usage: auto-update <claudestra|claude> <on|off>  |  auto-update status`,
    });
    return;
  }

  const cfg = await setAutoUpdate(target, state === "on");
  output({
    ok: true,
    autoUpdate: cfg.autoUpdate,
    message: `${target} 自动更新已${state === "on" ? "开启" : "关闭"}`,
  });
}

// ============================================================
// CLI 入口
// ============================================================

const [cmd, ...args] = process.argv.slice(2);

/**
 * v2.19.0 写操作认主（见 lib/owner-guard.ts）。
 *
 * daemon 侧的守卫只拦「进程启动」；在一台拿着别人状态目录副本的机器上手动跑
 * `manager.ts restart/create/kill` 照样会改 registry、往别人的频道建 agent、
 * 抢同一批 Discord 链路。所以改状态的命令也要认主。
 *
 * 只拦**写**，读操作（list / sessions / cost / doctor / version / token-list …）
 * 一律放行——在备机上查看状态是完全正当的需求，恰恰是排障时最需要的。
 */
const WRITE_COMMANDS = new Set([
  "create", "resume", "adopt", "kill", "remove", "restart", "rename", "archive",
  "clear", "cron-add", "cron-remove", "cron-toggle", "cron-edit",
  "peer-http-invite", "peer-http-join", "peer-http-accept", "peer-http-scope", "peer-http-remove",
  "peer-invite-new", "peer-join-auto", "peer-invite-revoke",
  "token-add", "token-revoke",
  "project-add", "project-edit", "project-remove", "project-assign", "project-migrate",
]);
if (cmd && WRITE_COMMANDS.has(cmd)) {
  const { readOwnerMarker, ownerVerdict, machineUuid } = await import("./lib/owner-guard.js");
  const self = { uuid: machineUuid(), host: (await import("os")).hostname() };
  const v = ownerVerdict(readOwnerMarker(), self, process.env.CLAUDESTRA_TAKEOVER === "1");
  if (!v.ok) {
    output({
      ok: false,
      error:
        `本机不是这套 Claudestra 的主机，拒绝执行写操作 \`${cmd}\`。` +
        `标记里的主机是 ${v.owner.host}（写于 ${v.owner.at}），本机是 ${self.host}。` +
        `多半是在热备/还原出来的副本上操作——registry 和 channelId 都是主机的，` +
        `执行下去会造成双响。确需在本机接管：先停掉主机，再带 CLAUDESTRA_TAKEOVER=1 重试。`,
    });
    process.exit(1);
  }
}

// v2.20.1+ 写命令跨进程串行(Codex review 2026-08-26):bridge 的 runManager、
// cron、CLI 可能并发跑写命令,registry 等状态文件的 load→mutate→save 会互相
// 覆盖(saveRegistry 只防撕裂不防丢更新)。命令级锁一把关掉全部窗口;拿不到
// (20s)降级放行——advisory,宁可退回旧竞态也不卡死命令。进程退出兜底释放。
let writeLock: { release: () => void } | null = null;
if (cmd && WRITE_COMMANDS.has(cmd)) {
  const { acquireLock } = await import("./lib/file-lock.js");
  writeLock = await acquireLock(`${process.env.HOME}/.claude-orchestrator/.manager-write.lock`);
  if (!writeLock) console.error("⚠ 写锁 20s 未拿到,降级继续(并发写命令可能竞态)");
  else process.on("exit", () => writeLock?.release());
}

try {
switch (cmd) {
  case "create": {
    // v2.21+ --project <id>(也接受 --project=id):显式指定归属 project
    let projectFlag: string | undefined;
    const afterProject: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--project") projectFlag = args[++i] || undefined;
      else if (a.startsWith("--project=")) projectFlag = a.slice("--project=".length) || undefined;
      else afterProject.push(a);
    }
    const { rest: afterExternal, value: external } = extractBoolFlag(afterProject, "--external");
    const { rest: afterModel, model } = extractModelFlag(afterExternal);
    const { rest: afterMode, mode } = extractModeFlag(afterModel);
    const { rest: afterEffort, effort } = extractEffortFlag(afterMode);
    const { rest: afterPurpose, purpose: purposeFlag } = extractPurposeFlag(afterEffort);
    const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(afterPurpose);
    const [name, dir, ...purposeParts] = posArgs;
    const flagLike = rejectFlagLikePositional(name, dir);
    if (flagLike) {
      output({ ok: false, error: flagLike });
      break;
    }
    if (!name || !dir) {
      output({
        ok: false,
        error: 'create <name> <dir> [purpose|--purpose <text>] [--project <id>] [--preset <preset>] [--disallowed "..."] [--effort <level>] [--mode <permission-mode>] [--model <model>] [--external]',
      });
      break;
    }
    await cmdCreate(name, dir, purposeFlag ?? purposeParts.join(" "), { preset, disallowedRaw }, effort, mode, model, external, projectFlag);
    break;
  }

  // v2.21+ Projects(owner 2026-08-28)
  case "project-add": {
    const opts: { name?: string; emoji?: string; dirs?: string[]; desc?: string } = {};
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--name") opts.name = args[++i];
      else if (a === "--emoji") opts.emoji = args[++i];
      else if (a === "--dirs") opts.dirs = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      else if (a === "--desc") opts.desc = args[++i];
      else pos.push(a);
    }
    const [id] = pos;
    if (!id) {
      output({ ok: false, error: "project-add <id> --dirs <a,b> [--name <显示名>] [--emoji <e>] [--desc <说明>]" });
      break;
    }
    await cmdProjectAdd(id, opts);
    break;
  }
  case "project-list":
    await cmdProjectList();
    break;
  case "project-edit": {
    const opts: { name?: string; emoji?: string; dirs?: string[]; desc?: string } = {};
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--name") opts.name = args[++i] ?? "";
      else if (a === "--emoji") opts.emoji = args[++i] ?? "";
      else if (a === "--dirs") opts.dirs = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      else if (a === "--desc") opts.desc = args[++i] ?? "";
      else pos.push(a);
    }
    const [id] = pos;
    if (!id) {
      output({ ok: false, error: "project-edit <id> [--name <显示名>] [--emoji <e>] [--dirs <a,b>] [--desc <说明>]" });
      break;
    }
    await cmdProjectEdit(id, opts);
    break;
  }
  case "project-remove": {
    const [id] = args;
    if (!id) {
      output({ ok: false, error: "project-remove <id>(须先清空成员)" });
      break;
    }
    await cmdProjectRemove(id);
    break;
  }
  case "project-assign": {
    const [agentName, projectId] = args;
    if (!agentName || !projectId) {
      output({ ok: false, error: "project-assign <agent> <projectId>" });
      break;
    }
    await cmdProjectAssign(agentName, projectId);
    break;
  }
  case "project-migrate":
    await cmdProjectMigrate();
    break;

  // v2.6.0+ HTTP API token 管理（多前端架构 Phase B）
  case "token-add": {
    const { rest: afterForce, value: force } = extractBoolFlag(args, "--force");
    const { rest: afterMirror, value: noMirror } = extractBoolFlag(afterForce, "--no-mirror");
    const { rest: afterTerm, value: terminal } = extractBoolFlag(afterMirror, "--terminal");
    // --agents a,b（也接受 --agents=a,b）
    let agentsCsv = "";
    const posArgs: string[] = [];
    for (let i = 0; i < afterTerm.length; i++) {
      const a = afterTerm[i];
      if (a === "--agents") agentsCsv = afterTerm[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice("--agents=".length);
      else posArgs.push(a);
    }
    await cmdTokenAdd(posArgs.join(" "), agentsCsv, force, noMirror, terminal);
    break;
  }
  case "token-list":
    await cmdTokenList();
    break;
  case "token-revoke": {
    const [idOrName] = args;
    if (!idOrName) {
      output({ ok: false, error: "token-revoke <tokenId|name>" });
      break;
    }
    await cmdTokenRevoke(idOrName);
    break;
  }

  case "resume": {
    const { rest: afterFork, value: fork } = extractBoolFlag(args, "--fork");
    const { rest: afterModel, model } = extractModelFlag(afterFork);
    const { rest: afterMode, mode } = extractModeFlag(afterModel);
    const { rest: afterEffort, effort } = extractEffortFlag(afterMode);
    const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(afterEffort);
    const [name, sessionId, dir] = posArgs;
    if (!name || !sessionId) {
      output({
        ok: false,
        error: 'resume <name> <sessionId> [dir] [--fork] [--preset <preset>] [--disallowed "..."] [--effort <level>] [--mode <permission-mode>] [--model <model>]',
      });
      break;
    }
    await cmdResume(name, sessionId, dir, { preset, disallowedRaw }, effort, mode, model, fork);
    break;
  }

  // v2.7+ 收编：adopt <name> <sessionId> —— 把 bg 分身/任意 session 立为正式会话并重启
  case "adopt": {
    const [name, sessionId] = args;
    if (!name || !sessionId) {
      output({ ok: false, error: "usage: adopt <name> <sessionId> — 把指定 session（如 bg 分身）收编为该 agent 的正式会话并重启拉起" });
      break;
    }
    await cmdAdopt(name, sessionId);
    break;
  }

  // v2.8+ 手动归档：archive <name> —— 立即快照该 agent 当前 session 的 jsonl
  case "archive": {
    const [name] = args;
    if (!name) {
      output({ ok: false, error: "usage: archive <name> — 立即归档该 agent 当前 session 的对话 jsonl" });
      break;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info?.sessionId) {
      output({ ok: false, error: `${tmuxName} 不在 registry 或无 sessionId` });
      break;
    }
    const r = await archiveSession(tmuxName, info.cwd, info.sessionId);
    const all = await listArchivedSessions(tmuxName);
    output({ ok: r.ok, note: r.note, archived: r.archived, sessions: all });
    break;
  }

  // set-session：把 agent 的官方 sessionId 切到新值（先归档旧会话）。
  // 供 bridge 的 clear 端点用：TUI 里 /clear 会轮转 sessionId，registry 若不跟着
  // 换，jsonl-watcher 会盯死文件。registry 写入必须经 manager（唯一写者不变式）。
  case "set-session": {
    const [name, newSid] = args;
    if (!name || !newSid) {
      output({ ok: false, error: "usage: set-session <name> <sessionId>" });
      break;
    }
    if (!/^[0-9a-f-]{8,64}$/i.test(newSid)) {
      output({ ok: false, error: `sessionId 形状非法: ${newSid}` });
      break;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `${tmuxName} 不在 registry` });
      break;
    }
    const oldSid = info.sessionId || null;
    // 旧会话退役 → 归档快照（对齐 kill/fork 轮转的退役语义）
    if (oldSid && oldSid !== newSid) {
      await archiveSession(tmuxName, info.cwd, oldSid).catch(() => {});
    }
    info.sessionId = newSid;
    await saveRegistry(reg);
    output({ ok: true, name: tmuxName, sessionId: newSid, previousSessionId: oldSid });
    break;
  }

  // set-claude <name> [--model m] [--effort e] —— 记录 per-agent 模型/effort
  // （bridge 的 claude-settings 端点切换后同步调用;restart 时 --model/--effort 沿用）
  case "set-claude": {
    const [name, ...rest] = args;
    let model: string | undefined;
    let effort: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--model" && rest[i + 1]) model = rest[++i];
      else if (rest[i] === "--effort" && rest[i + 1]) effort = rest[++i];
    }
    if (!name || (!model && !effort)) {
      output({ ok: false, error: "usage: set-claude <name> [--model <m>] [--effort <e>]" });
      break;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `${tmuxName} 不在 registry` });
      break;
    }
    if (model) (info as any).model = model;
    if (effort) (info as any).effort = effort;
    await saveRegistry(reg);
    output({ ok: true, name: tmuxName, model: (info as any).model ?? null, effort: (info as any).effort ?? null });
    break;
  }

  case "kill": {
    const [name] = args;
    if (!name) {
      output({ ok: false, error: "usage: kill <name>" });
      break;
    }
    await cmdKill(name);
    break;
  }

  case "remove": {
    const [name] = args;
    if (!name) {
      output({ ok: false, error: "usage: remove <name>（kill + 从列表永久移除,归档保留）" });
      break;
    }
    await cmdRemove(name);
    break;
  }

  case "rename": {
    const [oldName, newName] = args;
    if (!oldName || !newName) {
      output({ ok: false, error: "usage: rename <old-name> <new-name>" });
      break;
    }
    await cmdRename(oldName, newName);
    break;
  }

  case "list":
    await cmdList();
    break;

  // v2.4.19+ 给现存 active agent 补发置顶 focus 公告（新建/恢复的自动发，这个
  // 是给"feature 上线前就在跑"的老 agent 用的一次性 backfill）
  case "announce-focus": {
    const [nameArg] = args;
    const reg = await loadRegistry();
    const targets = Object.entries(reg.agents).filter(([n, info]) =>
      info.status === "active" && info.channelId &&
      (!nameArg || n === normalizeName(nameArg))
    );
    const results: Record<string, string> = {};
    for (const [n, info] of targets) {
      if (info.focusMsgId) { results[n] = "已有，跳过"; continue; }
      await announceFocusButton(n, info.channelId);
      const after = await loadRegistry();
      results[n] = after.agents[n]?.focusMsgId ? "✅ 已发" : "❌ 失败";
    }
    output({ ok: true, results });
    break;
  }

  case "sessions":
    await cmdSessions(args.join(" ") || undefined);
    break;

  case "restart": {
    const [name] = args;
    await cmdRestart(name || undefined);
    break;
  }

  case "cron-add": {
    const [name, schedule, ...restRaw] = args;
    const rest = [...restRaw];
    // --channel <id>：结果通知发到指定频道（默认 CONTROL_CHANNEL_ID）
    let reportChannelId: string | undefined;
    const chIdx = rest.indexOf("--channel");
    if (chIdx >= 0) {
      reportChannelId = rest[chIdx + 1];
      rest.splice(chIdx, 2);
    }
    // v2.4.18+ --target-agent <name>：把 prompt 打到已存在的 agent（继承上下文/记忆），
    // 不再 spawn 临时 agent。设了这个的话，<dir> 参数可省（agent 有自己的 cwd）。
    let targetAgent: string | undefined;
    const taIdx = rest.indexOf("--target-agent");
    if (taIdx >= 0) {
      targetAgent = rest[taIdx + 1];
      rest.splice(taIdx, 2);
    }
    let dir: string | undefined;
    if (targetAgent) {
      // 有 target-agent 时下一个位置参数只有看着像路径才当 dir，否则并入 prompt
      if (rest.length >= 1 && (rest[0].startsWith("/") || rest[0].startsWith("~") || rest[0].startsWith("."))) {
        dir = rest.shift();
      } else {
        dir = "-"; // 占位，不会被 executeOnExistingAgent 实际使用
      }
    } else {
      dir = rest.shift();
    }
    if (!name || !schedule || !dir || rest.length === 0) {
      output({ ok: false, error: 'usage: cron-add <name> "<cron>" <dir> <prompt...> [--channel <id>] [--target-agent <agent>]\n  <dir> may be omitted when --target-agent is given' });
      break;
    }
    await cmdCronAdd(name, schedule, dir, rest.join(" "), reportChannelId, targetAgent);
    break;
  }

  case "cron-list":
    await cmdCronList();
    break;

  case "cron-remove": {
    const [nameOrId] = args;
    if (!nameOrId) {
      output({ ok: false, error: "usage: cron-remove <name|id>" });
      break;
    }
    await cmdCronRemove(nameOrId);
    break;
  }

  case "cron-edit": {
    const [nameOrId, ...rest] = args;
    const patch: { schedule?: string; prompt?: string; name?: string; dir?: string } = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i];
      const v = rest[i + 1];
      if (v === undefined) break;
      if (k === "--schedule") patch.schedule = v;
      else if (k === "--prompt") patch.prompt = v;
      else if (k === "--name") patch.name = v;
      else if (k === "--dir") patch.dir = v;
    }
    if (!nameOrId || Object.keys(patch).length === 0) {
      output({ ok: false, error: 'usage: cron-edit <name|id> [--schedule "<cron>"] [--prompt "<text>"] [--name <new>] [--dir <dir>]' });
      break;
    }
    await cmdCronEdit(nameOrId, patch);
    break;
  }

  case "cron-toggle": {
    const [nameOrId] = args;
    if (!nameOrId) {
      output({ ok: false, error: "usage: cron-toggle <name|id>" });
      break;
    }
    await cmdCronToggle(nameOrId);
    break;
  }

  case "cron-history":
    await cmdCronHistory(args[0] || undefined);
    break;

  case "version":
    await cmdVersion();
    break;

  case "update":
    await cmdUpdate();
    break;

  case "auto-update": {
    const [sub, ...rest] = args;
    await cmdAutoUpdate(sub || "status", ...rest);
    break;
  }

  case "cost": {
    await cmdCost(args);
    break;
  }

  case "invite-link": {
    await cmdInviteLink(args);
    break;
  }

  // v2.11: Discord peer 已移除，老命令留引导提示（用户手滑打老命令时不至于一脸懵）
  case "peer-expose":
  case "peer-revoke":
  case "peer-status":
  case "peer-list": {
    output({ ok: false, error: "Discord-based peers were removed in v2.11 — use HTTP peers instead: peer-http-invite / peer-http-join / peer-http-accept (see README)" });
    break;
  }

  // v2.11+ HTTP peer 握手/管理（docs/design-http-peers.md）
  case "peer-http-invite": {
    const { rest: afterRotateI, value: rotate } = extractBoolFlag(args, "--rotate");
    const { rest: afterForce, value: force } = extractBoolFlag(afterRotateI, "--force");
    let agentsCsv = "", myUrl = "";
    const pos: string[] = [];
    for (let i = 0; i < afterForce.length; i++) {
      const a = afterForce[i];
      if (a === "--agents") agentsCsv = afterForce[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
      else if (a === "--url") myUrl = afterForce[++i] || "";
      else if (a.startsWith("--url=")) myUrl = a.slice(6);
      else pos.push(a);
    }
    await cmdPeerHttpInvite(pos[0] || "", agentsCsv, myUrl, force, rotate);
    break;
  }
  case "peer-http-join": {
    const { rest: afterRotateJ, value: rotate } = extractBoolFlag(args, "--rotate");
    const { rest: afterForce, value: force } = extractBoolFlag(afterRotateJ, "--force");
    let agentsCsv = "", myUrl = "";
    const pos: string[] = [];
    for (let i = 0; i < afterForce.length; i++) {
      const a = afterForce[i];
      if (a === "--agents") agentsCsv = afterForce[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
      else if (a === "--url") myUrl = afterForce[++i] || "";
      else if (a.startsWith("--url=")) myUrl = a.slice(6);
      else pos.push(a);
    }
    await cmdPeerHttpJoin(pos[0] || "", pos[1] || "", agentsCsv, myUrl, force, rotate);
    break;
  }
  case "peer-http-accept":
    await cmdPeerHttpAccept(args[0] || "", args[1] || "");
    break;
  case "peer-http-test":
    await cmdPeerHttpTest(args[0] || "");
    break;
  case "peer-http-list":
    await cmdPeerHttpList();
    break;
  case "peer-http-scope": {
    const { rest: afterForce, value: force } = extractBoolFlag(args, "--force");
    let agentsCsv = "";
    const pos: string[] = [];
    for (let i = 0; i < afterForce.length; i++) {
      const a = afterForce[i];
      if (a === "--agents") agentsCsv = afterForce[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
      else pos.push(a);
    }
    await cmdPeerHttpScope(pos[0] || "", agentsCsv, force);
    break;
  }
  case "peer-http-remove":
    await cmdPeerHttpRemove(args[0] || "");
    break;

  // v2.15+ 一键邀请（免回执自动握手）
  case "peer-invite-new": {
    const { rest: afterForce, value: force } = extractBoolFlag(args, "--force");
    let agentsCsv = "", myUrl = "";
    for (let i = 0; i < afterForce.length; i++) {
      const a = afterForce[i];
      if (a === "--agents") agentsCsv = afterForce[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
      else if (a === "--url") myUrl = afterForce[++i] || "";
      else if (a.startsWith("--url=")) myUrl = a.slice(6);
    }
    await cmdPeerInviteNew(agentsCsv, myUrl, force);
    break;
  }
  case "peer-invite-list":
    await cmdPeerInviteList();
    break;
  case "peer-invite-revoke":
    await cmdPeerInviteRevoke(args[0] || "");
    break;
  case "peer-invite-redeem": {
    let join = "", name = "", url = "", token = "";
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--join") join = args[++i] || "";
      else if (a === "--name") name = args[++i] || "";
      else if (a === "--url") url = args[++i] || "";
      else if (a === "--token") token = args[++i] || "";
    }
    await cmdPeerInviteRedeem(join, name, url, token);
    break;
  }
  case "peer-join-auto": {
    const { rest: afterForce, value: force } = extractBoolFlag(args, "--force");
    let agentsCsv = "", myUrl = "", peerUrl = "";
    const pos: string[] = [];
    for (let i = 0; i < afterForce.length; i++) {
      const a = afterForce[i];
      if (a === "--agents") agentsCsv = afterForce[++i] || "";
      else if (a.startsWith("--agents=")) agentsCsv = a.slice(9);
      else if (a === "--url") myUrl = afterForce[++i] || "";
      else if (a.startsWith("--url=")) myUrl = a.slice(6);
      // v2.16.1: 覆盖邀请串里的对方地址(跨 tailnet 共享下串里嵌的是发方
      // 视角 IP,接方视角是另一个映射地址——2026-07-31 实战踩坑)
      else if (a === "--peer-url") peerUrl = afterForce[++i] || "";
      else if (a.startsWith("--peer-url=")) peerUrl = a.slice(11);
      else pos.push(a);
    }
    await cmdPeerJoinAuto(pos[0] || "", agentsCsv, myUrl, force, peerUrl);
    break;
  }
  case "metrics": {
    await cmdMetrics(args);
    break;
  }

  case "tmux-screenshot": {
    const [name] = args;
    if (!name) { output({ ok: false, error: "usage: tmux-screenshot <agent>" }); break; }
    await cmdTmuxScreenshot(name);
    break;
  }

  case "tmux-send-keys": {
    const [name, ...rest] = args;
    if (!name || rest.length === 0) { output({ ok: false, error: "usage: tmux-send-keys <agent> <keys...>" }); break; }
    await cmdTmuxSendKeys(name, rest);
    break;
  }

  case "tmux-capture": {
    const [name, linesArg] = args;
    if (!name) { output({ ok: false, error: "usage: tmux-capture <agent> [lines]" }); break; }
    const lines = parseInt(linesArg || "40", 10);
    await cmdTmuxCapture(name, lines);
    break;
  }

  case "tmux-wait-idle": {
    const [name, timeoutArg] = args;
    if (!name) { output({ ok: false, error: "usage: tmux-wait-idle <agent> [timeout_ms]" }); break; }
    const timeout = parseInt(timeoutArg || "30000", 10);
    await cmdTmuxWaitIdle(name, timeout);
    break;
  }

  case "migrate": {
    const res = await migrateWorkerToAgent();
    output({ ok: true, ...res });
    break;
  }

  case "permissions":
  case "perm":
  case "perms": {
    const [sub, ...rest] = args;
    await cmdPermissions(sub || "list", ...rest);
    break;
  }

  case "effort": {
    const [sub, ...rest] = args;
    await cmdEffort(sub || "list", ...rest);
    break;
  }

  case "mode": {
    const [sub, ...rest] = args;
    await cmdMode(sub || "list", ...rest);
    break;
  }

  case "model": {
    const [sub, ...rest] = args;
    await cmdModel(sub || "list", ...rest);
    break;
  }

  case "install-cli": {
    // v2.3.0+: 把 `claudestra` 命令装到 PATH + 配 LaunchAgent 开机自启。
    // 给现有装机的人；首次 setup.ts 安装末尾也会跑这同一份逻辑。
    const { installClaudestraCli } = await import("./lib/cli-install.js");
    const REPO = `${import.meta.dir}/..`;
    const result = await installClaudestraCli(REPO);
    if (result.errors.length > 0) {
      output({ ok: false, error: result.errors.join("; "), warnings: result.warnings, result });
    } else {
      output({
        ok: true,
        cliWrapper: result.cliWrapper,
        daemons: result.daemons.map((d) => ({ label: d.label, loaded: d.loaded, warning: d.warning })),
        pm2Stopped: result.pm2Stopped.length > 0 ? result.pm2Stopped : undefined,
        oldAutostartPlist: result.oldAutostartPlist,
        oldPm2StartupPlist: result.oldPm2StartupPlist,
        removedOldAutostartWrapper: result.removedOldAutostartWrapper || undefined,
        migratedHookCommand: result.migratedHookCommand || undefined,
        bumpedTmuxDashboardLimit: result.bumpedTmuxDashboardLimit,
        allowedMcpTools: result.allowedMcpTools,
        warnings: result.warnings,
        hint: "打 `claudestra` 试试 —— launchd 3 个 daemon + 进 master TUI。重启机器后服务也会自动起来。",
      });
    }
    break;
  }

  case "tmux-help":
  case "tmux":
    printTmuxGuide();
    break;

  // 装完/出问题时的自检。默认走**人类可读**输出（这个命令的产物是给人截图发给
  // 维护者的），--json 给程序用。
  case "doctor": {
    const { runDoctor, formatDoctor } = await import("./lib/doctor.js");
    const checks = await runDoctor(`${import.meta.dir}/..`);
    if (args.includes("--json")) {
      output({ ok: checks.every((c) => c.status !== "fail"), checks });
    } else {
      console.log(formatDoctor(checks));
    }
    break;
  }

  default:
    output({
      ok: false,
      error: `Unknown command: ${cmd || "(empty)"}`,
      usage: [
        "create <name> <dir> [purpose]  — create an agent",
        "resume <name> <sessionId> [dir] — resume a past session",
        "kill <name>                     — destroy an agent",
        "rename <old-name> <new-name>    — rename (tmux window + registry + Discord channel)",
        "restart [name]                  — restart an agent (all agents if omitted)",
        "list                            — list all agents",
        "sessions [search]               — browse past Claude Code sessions",
        'cron-add <name> "<cron>" <dir> <prompt...> [--channel <id>] [--target-agent <agent>] — add a cron job (--target-agent sends the prompt to an existing agent, inheriting its context; otherwise a temporary agent is spawned each run)',
        "cron-list                       — list cron jobs",
        "cron-remove <name|id>           — remove a cron job",
        "cron-toggle <name|id>           — enable/pause a cron job",
        "cron-history [name|id]          — show run history",
        "permissions list                — list every agent's permission preset",
        "permissions presets             — list available presets",
        "permissions get <name>          — show one agent's permissions in detail",
        'permissions set <name> --preset <preset>｜--disallowed "..."',
        "permissions reset <name>        — reset to the default preset",
        "effort list                     — list every agent's effort setting",
        "effort get <name>               — show one agent's effort",
        "effort <name> <low|medium|high|xhigh|max|auto>  — set an agent's effort (takes effect after restart)",
        "effort reset <name>             — clear the override (fall back to the global settings.json value)",
        "tmux-help                       — print the tmux crash course (incl. iTerm2 -CC mode)",
        "doctor [--json]                 — health-check the whole install (runtime, config, daemons, bridge, MCP, agents)",
        "version                         — show the current version and whether an update is available",
        "update                          — git pull and reload the three launchd daemons",
        "auto-update status              — show auto-update toggles",
        "auto-update claudestra on|off   — toggle Claudestra auto-update (default on)",
        "auto-update claude on|off       — toggle Claude Code auto-update (default on)",
        "auto-update channel beta|release — beta follows every commit on origin/main (default: release)",
        "cost [--agent <name>] [--today|--week]  — aggregate token usage per agent or overall",
        "invite-link                     — generate the Discord bot invite URL (owner perms, for your own server)",
        "metrics [--today|--week|--since <ISO>] [--agent <n>] [--raw]  — summarise the bridge event log",
        "tmux-screenshot <agent>         — screenshot an agent's tmux window (returns a PNG path)",
        "tmux-send-keys <agent> <keys...>  — send keys/text to an agent (Enter/Escape/Left/C-c …)",
        "tmux-capture <agent> [lines]    — read the last N lines of an agent's pane",
        "tmux-wait-idle <agent> [ms]     — block until the agent is idle again (default 30s)",
      ],
    });
}
} catch (err) {
  output({ ok: false, error: (err as Error).message });
  process.exit(1);
} finally {
  writeLock?.release();
}

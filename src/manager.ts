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

import { writeClaudeSettings } from "./lib/session-recall.js";
import { DEFAULT_BRIDGE_PORT } from "./lib/bridge-url.js";
import { repoEnvVar } from "./lib/env-file.js";
import { RUNTIME_DIR, runtimePath, statePath, UPDATE_LOCK } from "./lib/paths.js";
import { resolveBridgeUrl } from "./lib/bridge-url.js";
import { readFile, writeFile, mkdir, readdir, stat, rename } from "fs/promises";
import { existsSync, statSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";

// ============================================================
// 配置
// ============================================================

import {
  TMUX_SOCK as SOCK,
  MASTER_SESSION,
  AGENT_PREFIX,
  tmuxRaw,
  tmuxRawStrict,
  sessionTarget,
  windowTarget,
  tmuxCapture,
  isIdle,
  listAgentWindows as listAgentWindowsShared,
  listWindowIdsByName,
  ensureSocketDir,
  clearShellInitPrompts,
  isAtShell,
  probeTuiContract,
  windowHasChildProcess,
  windowChildPids,
  killPidsEscalating,
  deadShellVerdict,
} from "./lib/tmux-helper.js";
import {
  resolveDisallowed,
  listPresets,
  isKnownPreset,
  DEFAULT_PRESET,
  PERMISSION_MODES,
  isKnownPermissionMode,
  resolveModelAlias,
  listModelAliases,
  KNOWN_EFFORT_LEVELS,
  isKnownEffort,
} from "./lib/claude-launch.js";
import { piAgentDir, piSessionIdFromFilename } from "./lib/pi-session.js";
import { translateSessionLine } from "./lib/session-source.js";
import { resolveSessionIdForWindow, readLiveCcSessionEntries } from "./lib/cc-sessions.js";
import { readBypassConsent } from "./lib/bypass-consent.js";
import { writeMasterResume } from "./lib/master-session.js";
import { agentNameFromDir } from "./lib/agent-name.js";
import { ancestorPids, mayTakeOver, preflightProblems, recoverCommand, resumeOutcome, takeoverCandidates, type TakeoverCandidate } from "./lib/takeover.js";
import {
  allSources,
  claudeCodeAdapter,
  controlFor,
  managedFor,
  requireManaged,
  type DiscoveredSession,
  type LaunchSpec,
  type ManagedRuntimeAdapter,
  type ReadyResult,
} from "./lib/runtimes/index.js";
import { listSessionJsonls } from "./lib/runtimes/claude-code.js";
import { gracefulExitWindow } from "./lib/runtimes/graceful-exit.js";
import { tmuxWindowOps } from "./lib/runtimes/window-ops.js";
import { agentRuntime, isMasterAgent, readRegistryAgents } from "./lib/registry.js";
import { describePiEnvProfile, normalizePiEnvProfile, piEnvSnapshotPath, readPiGlobalEnv, readPiProjectEnv, readPiRuntimeSnapshot, snapshotIsFresh, type PiEnvProfile } from "./lib/pi-env.js";
import { printTmuxGuide } from "./lib/tmux-guide.js";
import { resolveBunPath } from "./lib/bun-path.js";
import { REPO_ROOT, SRC_DIR } from "./lib/repo-root.js";
import { resolveNpm } from "./lib/npm-path.js";
import { projectsSlug } from "./lib/jsonl-cost.js";
import { archiveSession, listArchivedSessions } from "./lib/session-archive.js";
import {
  readProjects,
  writeProjects,
  resolveProjectForDir,
  slugifyProjectId,
  normalizeDir,
  isMisfiledByUmbrella,
  rosterLine,
  type ProjectDef,
} from "./lib/projects.js";
import { loadRegistry, migrateWorkerToAgent, saveRegistry, normalizeName, assertValidNewName, formatAge, output, extractPermFlags, extractPurposeFlag, rejectFlagLikePositional, extractEffortFlag, extractModeFlag, extractModelFlag, extractBoolFlag, extractMultiFlag, extractStringFlag } from "./manager/core.js";
import { cmdProjectAdd, cmdProjectList, cmdProjectEdit, cmdProjectRemove, cmdProjectAssign } from "./manager/projects.js";
import { cmdCronAdd, cmdCronList, cmdCronEdit, cmdCronRemove, cmdCronToggle, cmdCronHistory } from "./manager/cron.js";
import { cmdPermissions } from "./manager/permissions.js";
import { cmdTokenAdd, cmdTokenList, cmdTokenRevoke } from "./manager/tokens.js";
import { cmdPeerHttpInvite, cmdPeerHttpJoin, cmdPeerHttpAccept, cmdPeerHttpTest, cmdPeerHttpList, cmdPeerHttpScope, cmdPeerHttpRemove, cmdPeerInviteNew, cmdPeerInviteList, cmdPeerInviteRevoke, cmdPeerInviteRedeem, cmdPeerJoinAuto } from "./manager/peers.js";
import { cmdCost, cmdMetrics } from "./manager/cost.js";
import { cmdAutoUpdate } from "./manager/auto-update.js";
import { isWriteInvocation } from "./manager/write-commands.js";

const BRIDGE_URL = resolveBridgeUrl();
const CATEGORY_NAME = "agents";

import { bridgeRequest } from "./lib/bridge-client.js";
import { notify } from "./lib/notify.js";
import { writeJsonAtomic } from "./lib/state-file.js";
import { stderrTail } from "./lib/run-manager.js";
import { readyFailureText, modelPinPlan, modelPinRefusal, restartExceptionResult, bigSessionNote } from "./lib/restart-result.js";
import { installAfterPull, DEP_MANIFESTS } from "./lib/post-pull.js";

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
  const { bridgeHttpBase } = await import("./lib/bridge-port.js");
  try {
    await fetch(`${bridgeHttpBase()}/skills/rescan`, {
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
  // pane 判据只认 Claude Code 的 TUI（❯ / 横幅），套在别的运行时上恒判「忙」。
  // idleSource=hook 的运行时（Pi）忙闲只由回合结束上报决定，CLI 进程看不到那份
  // 内存状态 ⇒ 这里一律答「空闲」。
  const bare = name.replace(/^agent-/, "");
  const reg = await loadRegistry();
  const info = reg.agents?.[name] ?? reg.agents?.[bare] ?? reg.agents?.[`agent-${bare}`];
  if (controlFor(info?.runtime).idleSource === "hook") return true;
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

/** 我们自己 socket 上所有 pane id —— 判断某个 CC 进程在不在我们的 tmux 里 */
async function ourPaneIds(): Promise<Set<string>> {
  const out = await tmuxRaw(["list-panes", "-a", "-F", "#{pane_id}"]).catch(() => "");
  return new Set(out.split("\n").map((x) => x.trim()).filter(Boolean));
}

/** 等一个 pid 消失；到点还在就返回 false（不默认 SIGKILL——那是用户正在用的东西） */
async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return true; }
    await Bun.sleep(300);
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

/**
 * v2.24+ takeover —— 把跑在 Claudestra 之外的 Claude Code「重启进」我们的 tmux。
 *
 * 进程搬不动（控制终端出生即定），但会话状态全在 jsonl 里，所以：让原进程干净退出
 * （SIGTERM，等它落盘），再在我们的 tmux 里 resume **同一个 sessionId**。对用户就是
 * 「同一个会话换了个地方继续」。判据与安全阀见 lib/takeover.ts。
 */
async function cmdTakeover(target?: string, opts: { all?: boolean; force?: boolean; name?: string } = {}) {
  // 只认「活着且确实是登记里那个进程」的条目：pid 复用的过期登记会让 SIGTERM 打错人
  const [alive, panes, reg] = await Promise.all([
    readLiveCcSessionEntries(),
    ourPaneIds(),
    readRegistryAgents().catch(() => []),
  ]);
  const managed = new Set(reg.map((a) => a.sessionId).filter(Boolean) as string[]);
  const taken = new Set(reg.map((a) => a.name.replace(/^agent-/, "")));
  // 从 CC 的 `!` 模式 / Bash 工具里跑 setup 或 takeover 时，那个 CC 是我们的祖先：绝不能列、更不能 SIGTERM
  const ancestors = ancestorPids(process.pid, (p) => {
    const r = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(p)], { stdout: "pipe", stderr: "ignore" });
    const n = Number(r.stdout.toString().trim());
    return r.exitCode === 0 && Number.isFinite(n) ? n : null;
  });
  const cands = takeoverCandidates(alive.filter((e) => !ancestors.has(e.pid)), panes, managed);

  if (!target && !opts.all) {
    output({ ok: true, candidates: cands.map((c) => ({
      sessionId: c.sessionId, cwd: c.cwd, pid: c.pid, verdict: c.verdict,
      suggestedName: agentNameFromDir(c.cwd, taken),
    })), hint: cands.length
      ? "takeover <sessionId> 接管一个；takeover --all 全部；正在跑回合的要加 --force"
      : "没有跑在 Claudestra 之外的 Claude Code" });
    return;
  }

  const picked: TakeoverCandidate[] = opts.all ? cands : cands.filter((c) => c.sessionId === target || c.sessionId.startsWith(target!));
  if (picked.length === 0) {
    output({ ok: false, error: target ? `没找到可接管的会话 ${target}（它可能已经在 Claudestra 里，或进程已退出）` : "没有可接管的会话" });
    return;
  }

  // SIGTERM 之前的全局预检：这边起不来就一个进程都不动
  const bridgePort = repoEnvVar("BRIDGE_PORT", REPO_ROOT) || String(DEFAULT_BRIDGE_PORT);
  const [bypassAccepted, masterSession, bridgeReachable] = await Promise.all([
    readBypassConsent(),
    tmuxRawStrict(["has-session", "-t", sessionTarget(MASTER_SESSION)]).then(() => true, () => false),
    fetch(`http://127.0.0.1:${bridgePort}/stats`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
  ]);
  const problems = preflightProblems({ bypassAccepted, masterSession, bridgeReachable });
  if (problems.length) {
    output({ ok: false, error: `没有动任何进程：${problems.join("；")}`, problems });
    return;
  }

  const results: Array<Record<string, unknown>> = [];
  let halted = false;
  for (const c of picked) {
    if (halted) {
      results.push({ sessionId: c.sessionId, ok: false, skipped: true, error: "前一个接管失败，剩下的没动" });
      continue;
    }
    const gate = mayTakeOver(c, !!opts.force);
    if (!gate.ok) { results.push({ sessionId: c.sessionId, ok: false, error: gate.reason }); continue; }
    // 逐条预检（名字 / 窗口 / sessionId）——cmdResume 里同样的校验发生在 kill 之后，来不及
    const name = opts.name && picked.length === 1 ? opts.name : agentNameFromDir(c.cwd, taken);
    let preErr = "";
    try { assertValidNewName(name); } catch (e) { preErr = (e as Error).message; }
    if (!preErr && taken.has(name.replace(/^agent-/, ""))) preErr = `agent 名 ${name} 已被占用（换一个 --name）`;
    if (!preErr && (await windowExists(normalizeName(name)))) preErr = `${normalizeName(name)} 窗口已存在（换一个 --name）`;
    if (!preErr && !UUID_RE.test(c.sessionId)) preErr = `sessionId 不是 UUID：${c.sessionId}`;
    if (preErr) { results.push({ sessionId: c.sessionId, ok: false, error: `没有动原进程：${preErr}` }); continue; }
    taken.add(name);

    try { process.kill(c.pid, "SIGTERM"); } catch { /* 刚好自己退了 */ }
    const gone = await waitPidGone(c.pid, 20_000);
    if (!gone) {
      results.push({ sessionId: c.sessionId, ok: false,
        error: `原进程 ${c.pid} 收到 SIGTERM 后 20 秒仍在；没有强杀（那是你正在用的窗口）。请手动退出它再重试` });
      continue;
    }
    // 原进程已退出 ⇒ session 没人占用，直接 resume 同一个 id（不是 fork，上下文一条不丢）。
    // cmdResume 自己往 stdout 打 JSON：这里截下来判成败，只输出 takeover 的一份汇总。
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { captured.push(a.map(String).join(" ")); };
    let thrown = "";
    try {
      await cmdResume(name, c.sessionId, c.cwd);
    } catch (e) {
      thrown = (e as Error).message;
    } finally {
      console.log = origLog;
    }
    for (const l of captured) if (!l.trim().startsWith("{")) console.error(l);
    const res = thrown ? { ok: false, error: thrown } : resumeOutcome(captured);
    if (res.ok) {
      results.push({ sessionId: c.sessionId, ok: true, name, agent: res.agent, pid: c.pid });
    } else {
      // 原进程已经关了、这边又没起来：给出手动接回的命令，并停下剩余的
      results.push({ sessionId: c.sessionId, ok: false, name, pid: c.pid, error: res.error,
        recover: recoverCommand(c.cwd, c.sessionId) });
      halted = true;
    }
  }
  output({ ok: results.every((r) => r.ok), results });
}

/** 会话列表的一条。形状由 lib/runtimes 定义，三种来源统一。 */
type ClaudeSession = DiscoveredSession;

/**
 * 本机**所有**会话，三种来源合并、按最近活动排序。
 *
 * v2.24 起不再是三个 scanXxxSessions + 一个手写的合并：每种运行时的扫描逻辑归各自
 * 的适配器（lib/runtimes/），这里只负责并起来。加一种运行时不用动这个函数。
 *
 * 单个来源炸了不连累其它来源——扫盘要面对权限、坏文件、目录被删这些事，
 * 一处异常让整张会话列表变空是最差的结果。
 */
async function scanAllSessions(search?: string): Promise<ClaudeSession[]> {
  const batches = await Promise.all(
    allSources().map((s) =>
      s.scanSessions(search).catch((e) => {
        console.error(`[sessions] ${s.id} 扫描失败: ${(e as Error).message}`);
        return [] as ClaudeSession[];
      }),
    ),
  );
  return batches.flat().sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

// ============================================================
/**
 * 等子进程结束；非 0 退出返回「exit=N：stderr 末几行」，成功返回 null。
 * stdout/stderr 都读走——pipe 了不读，输出一多子进程就卡在写管道上。
 */
async function spawnFailure(proc: { exited: Promise<number>; stdout: ReadableStream; stderr: ReadableStream }, tailLines = 3): Promise<string | null> {
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return null;
  const tail = stderrTail(err, tailLines);
  return `exit=${code}${tail ? `：${tail}` : ""}`;
}

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
    .map(([n, a]) => rosterLine(n, a.purpose || "", agentRuntime(a)));
  const hasPiMate = Object.entries(reg.agents).some(
    ([n, a]) => a.projectId === proj.id && a.status === "active" && n !== selfTmuxName && agentRuntime(a) === "pi",
  );
  const parts = [`你属于 project「${proj.name}」(${proj.id})。`, `项目目录: ${proj.dirs.join(", ")}。`];
  if (proj.description) parts.push(`项目说明: ${proj.description.slice(0, 120)}。`);
  // 不标出来的话，Claude Code agent 会默认同事的工具集跟自己一样（Pi 侧没有
  // Task/子代理、没有它那些 MCP），派活容易踩空
  if (hasPiMate) {
    parts.push("带 [Pi] 的同事跑在 Pi coding agent 上（工具集与 Claude Code 不同，别假设它有你有的工具）；派活/协作仍用 send_to_agent。");
  }
  parts.push(
    mates.length
      ? `同项目 agent: ${mates.join("、")}——跨仓/跨职责协作用 send_to_agent 找它们,也可用 project_info 工具随时查项目成员与目录。`
      : `目前项目里只有你一个 agent(project_info 工具可随时查最新成员)。`,
  );
  return parts.join(" ");
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
  runtimeFlag?: string,
  piBaseFlag?: string,
) {
  assertValidNewName(name);
  // runtime 只决定「用哪个适配器」（启动命令 / 就绪判据 / registry 字段），
  // 其余（频道 / 窗口 / project / registry 形状）各运行时完全一致。
  let adapter: ManagedRuntimeAdapter;
  try {
    adapter = requireManaged(runtimeFlag);
  } catch (e) {
    output({ ok: false, error: (e as Error).message });
    return;
  }
  if (piBaseFlag && piBaseFlag !== "minimal" && piBaseFlag !== "inherit") {
    output({ ok: false, error: `未知的 --pi-base: "${piBaseFlag}"。可用: inherit, minimal` });
    return;
  }
  // 可执行文件不在就早败：否则会照建频道 + 窗口，卡满就绪预算后才报错
  const avail = await adapter.available();
  if (!avail.ok) {
    output({ ok: false, error: `--runtime ${adapter.id} 建不出能用的 agent：${avail.hint}` });
    return;
  }
  // 能力档案：只认 --pi-base（更细的增删走 manager pi-env-set，避免 create 参数爆炸）
  const piEnv: PiEnvProfile | undefined = piBaseFlag ? { base: piBaseFlag as PiEnvProfile["base"] } : undefined;
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
  let spec: LaunchSpec;
  const expandedDir = dir.replace(/^~/, process.env.HOME || "~");

  try {
    // 2. 创建 tmux window（在 master session 里）
    await ensureSocket();
    await tmuxRawStrict(["new-window", "-t", sessionTarget(MASTER_SESSION), "-n", tmuxName, "-c", expandedDir]);
    await Bun.sleep(500);

    // 3. 启动会话
    spec = {
      mode: "new",
      channelId,
      bridgeUrl: BRIDGE_URL,
      sessionId: crypto.randomUUID(),
      effort,
      permissionMode: mode,
      model,
      // v2.16+ purpose 注入:此前 purpose 只进 registry,agent 本体看不到自己的职责
      purpose,
      agentName: tmuxName,
      cwd: expandedDir,
      // v2.21+ project 上下文注入:目录 + 同伴花名册
      projectContext: await buildProjectContext(proj, tmuxName),
      extras: { disallowedPreset: perms.preset, disallowedRaw: perms.disallowedRaw, piEnv },
    };
    if (adapter.prepareSession) spec.sessionId = (await adapter.prepareSession(spec)).sessionId;
    const started = (await launchInWindow(tmuxName, adapter, spec)).result;
    ready = started.ready;
    if (!started.ready) {
      // 按 reason 出文案（对话框原文 / 秒退 / 占用）；CC 状态栏契约提示只对「超时」有意义
      const hint = started.reason === "timeout" ? readyTimeoutHint(await captureLast(name, 40).catch(() => "")) : "";
      await cleanup(`${adapter.label} ${readyFailureText(started)}${hint}`);
      return;
    }
  } catch (err) {
    await cleanup(`创建失败: ${(err as Error).message}`);
    return;
  }
  const sessionId = spec.sessionId;

  // v2.5.4: 会话内补发 /model，确保 pin 真正生效（--model 对 resume 场景不可靠）。
  // 启动参数即权威的运行时（Pi）不补发：/model 在那边是另一套语义。
  if (adapter.control.modelEnforcement === "in-session") await enforceSessionModel(tmuxName, model);

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
    // 运行时字段由适配器给：Claude Code 返回 {}，老 agent 的 registry 逐字节不变
    ...adapter.registryFields(spec),
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

// 会话就绪轮询预算：240 轮 × 500ms = 120s（各运行时共用）。曾是 60s，2026-07-10 实测
// 大 session（数 MB jsonl）resume + MCP 连接可超 60s，导致实际启动成功却报
// 「启动超时」（restart 还会误标 recreated）。
const CLAUDE_READY_ROUNDS = 240;

// shell 就绪轮询预算：30 轮 × 500ms = 15s（peer 2026-08-13 P0，见
// waitForShell 注释）。实测冷启动 zsh 出提示符 2.24s，开机并发时更久；
// 15s 对它留了 6 倍余量，而健康窗口第一拍即过，正常路径零额外开销。
const SHELL_READY_ROUNDS = 30;
const SHELL_READY_POLL_MS = 500;

/**
 * 等窗口回到 shell 提示符（restart 复用 / 重建窗口时用）。
 *
 * 轮询而不是「看一眼 → 等 2s → 放弃」：新窗口里 zsh（oh-my-zsh + conda）出提示符
 * 实测 2.24s，开机并发时更久，一次性判定会让 restart 静默起不来（peer 2026-08-13
 * P0：开机 9 个挂 3 个）。健康窗口第一拍就过，正常路径零额外开销。
 */
async function waitForShell(name: string): Promise<boolean> {
  for (let i = 0; i < SHELL_READY_ROUNDS; i++) {
    if (isAtShell(await captureLast(name, 3))) {
      if (i > 0) console.error(`[restart] ${name} shell 就绪等了 ${(i * SHELL_READY_POLL_MS) / 1000}s`);
      return true;
    }
    await Bun.sleep(SHELL_READY_POLL_MS);
  }
  // 失败必须留痕：否则窗口建好了、会话从没启动、registry 还写着 active
  console.error(`[restart] ${name} shell 未就绪（等满 ${(SHELL_READY_ROUNDS * SHELL_READY_POLL_MS) / 1000}s），放弃启动`);
  return false;
}

/**
 * 在已建好的窗口里起一个会话 —— create / resume / restart 共用的唯一一份启动流程：
 * [等 shell] → 清 shell init 的 Y/n 交互 → [fork 前快照] → 适配器 beforeLaunch →
 * 发启动命令 → 适配器等就绪。运行时差异全在适配器里。
 *
 * 清 Y/n 必须在发命令之前：oh-my-zsh / homebrew 的更新提示会吞掉 send-keys 的第一个字符。
 */
async function launchInWindow(
  tmuxName: string,
  adapter: ManagedRuntimeAdapter,
  spec: LaunchSpec,
  opts: { waitShell?: boolean; cwd?: string } = {},
): Promise<{ result: ReadyResult; baseline?: unknown }> {
  const win = tmuxWindowOps(tmuxName);
  if (opts.waitShell && !(await waitForShell(tmuxName))) {
    return { result: { ready: false, reason: "timeout", detail: "shell 未就绪", recoveredFullSession: false } };
  }
  await clearShellInitPrompts(win.target);
  const baseline =
    spec.mode === "fork" && opts.cwd && adapter.forkBaseline ? await adapter.forkBaseline(opts.cwd) : undefined;
  await adapter.beforeLaunch?.(win);
  await win.sendLine(adapter.buildLaunchCommand(spec));
  const result = await adapter.waitReady(win, { rounds: CLAUDE_READY_ROUNDS, pollMs: 500 });
  return { result, baseline };
}

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
  runtimeFlag?: string,
) {
  const adapter = requireManaged(runtimeFlag);
  const avail = await adapter.available();
  if (!avail.ok) throw new Error(`无法用 --runtime ${adapter.id} 收编会话：${avail.hint}`);
  // 会话 id 格式各家不同（Claude Code 是 UUID，Pi 收任意自造 id）
  if (!adapter.isValidSessionId(sessionId)) {
    throw new Error(`非法 sessionId: "${sessionId}"（不是合法的 ${adapter.label} 会话 id；其它运行时的会话请加 --runtime <id>）`);
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
    // v2.23+ 两种 runtime 都找：Pi 会话也能从列表里直接 resume 收编
    const sessions = await scanAllSessions();
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
  let spec: LaunchSpec;
  let baseline: unknown;

  try {
    // 创建 tmux window（在 master session 里）
    await ensureSocket();
    await tmuxRawStrict(["new-window", "-t", sessionTarget(MASTER_SESSION), "-n", tmuxName, "-c", resolvedDir]);
    await Bun.sleep(500);

    spec = {
      mode: forkSession ? "fork" : "resume",
      channelId,
      bridgeUrl: BRIDGE_URL,
      sessionId,
      displayName: channelName,
      cwd: resolvedDir,
      effort,
      permissionMode: mode,
      model,
      extras: {
        disallowedPreset: perms.preset,
        disallowedRaw: perms.disallowedRaw,
        // 沿用 registry 里已有的能力档案（resume 不改档案，但必须复现它）
        piEnv: normalizePiEnvProfile((await loadRegistry()).agents[tmuxName]?.piEnv),
      },
    };
    const launched = await launchInWindow(tmuxName, adapter, spec, { cwd: resolvedDir });
    ready = launched.result.ready;
    baseline = launched.baseline;
    if (!launched.result.ready) {
      const hint = launched.result.reason === "timeout" ? readyTimeoutHint(await captureLast(name, 40).catch(() => "")) : "";
      await cleanup(`${adapter.label} ${readyFailureText(launched.result)}${hint}`);
      return;
    }
  } catch (err) {
    await cleanup(`恢复失败: ${(err as Error).message}`);
    return;
  }

  // v2.5.4: 会话内补发 /model —— resume 是 --model 失效的重灾区（session 保留原模型）。
  if (adapter.control.modelEnforcement === "in-session") await enforceSessionModel(tmuxName, model);

  // v2.7+ fork 模式：registry 必须记 fork 出的实际新 session id，不是源 id
  let actualSessionId = sessionId;
  if (forkSession && adapter.discoverSessionId) {
    const found = await adapter
      .discoverSessionId({ windowName: tmuxName, cwd: resolvedDir, exclude: sessionId, baseline })
      .catch(() => null);
    if (found) {
      actualSessionId = found.sessionId;
      console.error(`[resume] --fork 探测到新 session ${found.sessionId.slice(0, 8)}（源 ${sessionId.slice(0, 8)}，${found.via}）`);
    } else {
      console.error(`[resume] ⚠️ --fork 未探测到新 session id，registry 暂记源 id（bridge 回合结束时会按 CC sessions 登记自愈）`);
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
    notes: `${adapter.noteTag} session: ${actualSessionId}${forkSession ? ` (forked from ${sessionId.slice(0, 8)})` : ""}`,
    sessionId: actualSessionId,
    cwd: resolvedDir,
    displayName: channelName,
    disallowedPreset: perms.preset,
    disallowedRaw: perms.disallowedRaw,
    effort,
    permissionMode: mode,
    ...(model ? { model } : {}),
    // resume 不提供档案编辑，但**不能把已有的档案弄丢**（丢了下次 restart 就变回继承全局）
    ...adapter.registryFields({ ...spec, extras: { piEnv: prior?.piEnv } }),
  };
  await saveRegistry(reg);

  // 截图发到新频道作为上下文预览
  if (ready) {
    try {
      const bunPath = resolveBunPath();
      const srcDir = SRC_DIR;
      const htmlPath = runtimePath(`resume_${Date.now()}.html`);
      const pngPath = runtimePath(`resume_${Date.now()}.png`);

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
        await notify({
          source: "manager",
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
    const { bridgeHttpBase } = await import("./lib/bridge-port.js");
    try {
      await fetch(`${bridgeHttpBase()}/agent/cleanup`, {
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
    const { bridgeHttpBase } = await import("./lib/bridge-port.js");
    try {
      await fetch(`${bridgeHttpBase()}/agent/cleanup`, {
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
// ────────────────────────────────────────────────
// v2.7+ fork-session 自愈（Claude Code agents 模式适配）
// ────────────────────────────────────────────────
//
// session 被 Claude Code 的 bg agent 占用时无法 --resume（bg daemon 会把被杀
// 的占用者 respawn 回来，进程层面赢不了 —— 2026-07-09 事故实证）。唯一可靠
// 破局是 `--resume <id> --fork-session` 分支副本。fork 出的新 session id 上游
// 不直接告知，由适配器的 discoverSessionId 探测（runtimes/claude-code.ts），拿到后回写 registry。

/** cwd → ~/.claude/projects/<slug>/（slug 规则与 jsonl-watcher.getJsonlPath 一致） */
function projectsDirFor(cwd: string): string {
  return join(process.env.HOME || "~", ".claude", "projects", projectsSlug(cwd));
}

/**
 * 优雅退出一个会话：清场 → 键入退出指令 → 处理收尾弹窗 → 最后强杀。
 * 按键序列在 runtimes/graceful-exit.ts（适配器可用 exitPrelude 接管清场；缺省 Claude Code，大总管走这条）。
 */
async function gracefulExit(name: string, adapter: ManagedRuntimeAdapter = claudeCodeAdapter): Promise<boolean> {
  return gracefulExitWindow(tmuxWindowOps(name), adapter);
}

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
    // 与 claude-settings 共用 runSwitchCommand：只认底部真框、核对目标家族再代按，
    // 以「这次命令的结果行出现」判落地——旧实现全屏搜 "Set model to"，scrollback 里
    // 上一次切换的结果行会在框画出来之前就放行，框留在屏幕上没人按。
    const { runSwitchCommand } = await import("./lib/tmux-helper.js");
    const r = await runSwitchCommand(target, "model", resolved, { sendDelayMs: 400 });
    if (r.outcome === "applied" || r.outcome === "confirmed") return true;
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
            await writeClaudeSettings(GLOBAL_CLAUDE_SETTINGS, s);
          }
        } catch {
          /* 恢复失败不阻塞 */
        }
      }
    }
  }
  return false;
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
const RESTART_LOCK_DIR = statePath("locks");
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

/**
 * 仓库根 .env 里的一个变量（manager 可能从任意 cwd 被调起，Bun 只自动加载 cwd 的
 * .env——所以 env 里没有就直接翻 REPO_ROOT/.env）。
 */
async function readRepoEnvVar(key: string): Promise<string> {
  return repoEnvVar(key, REPO_ROOT);
}

/** 大总管的工作目录（与 launcher / bridge 同一语义：env / .env 优先，默认仓库里的 master/）。 */
async function masterDir(): Promise<string> {
  return (await readRepoEnvVar("MASTER_DIR")) || `${REPO_ROOT}/master`;
}

/**
 * v2.24+ 重启大总管——**不在这里拉起它**。
 *
 * 大总管的启动归 launcher 独占（bridge 的生命周期端点也拒绝 master）。这里两件事：
 * 写下「接回原会话」的交接单（lib/master-session.ts），然后把它的 Claude Code
 * 优雅退掉；launcher 的 15 秒巡检看到窗口退回 shell，就会带 `--resume` 把它拉回来。
 * 自己动手拉的话会和 launcher 抢同一个窗口——两条命令打进同一个 pane，谁都起不来。
 *
 * 用途是「Claude Code 重新登录后让所有会话认新凭证」：凭证只在进程启动时读一次，
 * 已经在跑的进程既刷不动旧 token 也不回头重读 keychain（owner 2026-09-22 实遇）。
 */
async function restartMaster(): Promise<{ name: string; ok: boolean; error?: string; note?: string }> {
  const target = windowTarget("0");
  const dir = await masterDir();

  // 先验明正身，判据抄 launcher 的 ensureMasterAtZero：窗口名不是 agent-*，且
  // pane 的当前目录就是 MASTER_DIR。index 0 被某个 agent 占位的情况真实发生过
  // （2026-08-27 peer 实报），那时候朝 master:0 发 /exit 就是误杀无辜窗口。
  const meta = (await tmuxRaw([
    "display-message", "-p", "-t", target, "#{window_name}\t#{pane_current_path}",
  ]).catch(() => "")).trim();
  const [winName = "", paneCwd = ""] = meta.split("\t");
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  if (!meta || winName.startsWith(AGENT_PREFIX) || real(paneCwd) !== real(dir)) {
    return {
      name: "master",
      ok: false,
      error: `window 0 不是大总管（name=${winName || "?"} cwd=${paneCwd || "?"}），交给 launcher 归位`,
    };
  }

  // 窗口里得真有 Claude Code 在跑，否则它本来就停着，launcher 会拉起，不用我们插手。
  const alive = await windowHasChildProcess(target).catch(() => null);
  if (alive !== true) {
    return { name: "master", ok: false, error: "大总管窗口里没有在跑的 Claude Code（交给 launcher 拉起）" };
  }

  // sessionId：先问 Claude Code 自己的进程登记（启动那一刻就写好了），
  // 问不到再退回 MASTER_DIR 的 projects 目录里最新的那份 jsonl。
  let sessionId =
    (await resolveSessionIdForWindow("0", dir, { timeoutMs: 1500 }).catch(() => null))?.sessionId ?? "";
  if (!sessionId) {
    const projDir = projectsDirFor(dir);
    const newest = [...(await listSessionJsonls(dir))]
      .map((f) => ({ f, m: (() => { try { return statSync(join(projDir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m)[0];
    if (newest?.f) sessionId = newest.f.replace(/\.jsonl$/, "");
  }

  const handed = sessionId ? await writeMasterResume(sessionId, "restart --include-master") : false;
  if (!handed) {
    console.error("[restart] ⚠️ 没拿到大总管的 sessionId，重启后会是全新会话（上下文不接回）");
  }

  // 退出判据：gracefulExit 看 pane 文本，再用「窗口 shell 还有没有子进程」复核一次
  //（大总管的 pane 尾部常年是 Claude 的输出，文本判据比 agent 窗口更容易误判）。
  const exited =
    (await gracefulExit("0")) || (await windowHasChildProcess(target).catch(() => true)) === false;
  if (!exited) {
    return { name: "master", ok: false, error: "大总管没能退出（窗口仍有进程），本次未重启" };
  }
  return {
    name: "master",
    ok: true,
    note: handed
      ? `已退出，launcher 会在 15 秒内用 --resume ${sessionId.slice(0, 8)} 拉回来（上下文保留）`
      : "已退出，launcher 会在 15 秒内拉起（⚠️ 未拿到 sessionId，将是全新会话）",
  };
}

async function cmdRestart(name?: string, opts: { includeMaster?: boolean } = {}) {
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

  if (targets.length === 0 && !opts.includeMaster) {
    output({ ok: false, error: "没有需要重启的 agent" });
    return;
  }

  const results: { name: string; ok: boolean; error?: string; recreated?: boolean; note?: string }[] = [];

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
    // 运行时由 registry 决定；只读来源 / 认不出的 runtime 不能由我们拉起
    const adapter = managedFor(info.runtime);
    if (!adapter) {
      results.push({ name: tmuxName, ok: false, error: `runtime "${info.runtime}" 不能由 Claudestra 启动` });
      continue;
    }
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
      const exited = await gracefulExit(tmuxName, adapter);
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
      await tmuxRawStrict(["new-window", "-t", sessionTarget(MASTER_SESSION), "-n", tmuxName, "-c", cwd]);
      await Bun.sleep(500);
    }

    // 2. 重新启动 — 沿用 registry 中存储的 channelId + 权限配置
    const displayName = info.displayName || tmuxName.replace(AGENT_PREFIX, "");
    // v2.16+ purpose 注入 restart 也带上(会话虽有历史,系统提示常驻比翻聊天记录可靠);
    // resume 写入的占位 purpose("resumed: xxx")无信息量,过滤
    const purposeForInject =
      info.purpose && !info.purpose.startsWith("resumed:") ? info.purpose : undefined;
    const spec: LaunchSpec = {
      mode: "resume",
      channelId: info.channelId,
      bridgeUrl: BRIDGE_URL,
      sessionId: info.sessionId,
      displayName,
      effort: info.effort,
      // 老 agent（feature 前建的）info.permissionMode 为空 → 启动器回退 bypassPermissions
      permissionMode: info.permissionMode,
      // v2.4.20+ 显式 --model 覆盖 --resume 钉死的会话原模型（"改全局无效"的解法）
      model: info.model,
      purpose: purposeForInject,
      agentName: tmuxName,
      ...(info.cwd ? { cwd: info.cwd } : {}),
      extras: {
        disallowedPreset: info.disallowedPreset,
        disallowedRaw: info.disallowedRaw,
        // v2.23+ 能力档案随 registry 复现，否则重启后静默变回「继承全局」
        piEnv: normalizePiEnvProfile(info.piEnv),
      },
    };

    let started = (await launchInWindow(tmuxName, adapter, spec, { waitShell: true })).result;

    // v2.7+ 自愈：会话被占用（CC 的 bg agent）→ fork 一份副本重试，就绪后探测
    // 新 session id 回写 registry（否则 watcher / 下次 restart 又会盯回被占用的旧 id）。
    if (!started.ready && started.reason === "occupied") {
      const cwd = info.cwd || process.env.HOME || "/";
      console.error(`[restart] ${tmuxName} 的 session 被 bg agent 占用，改用 fork 重试`);
      const forked = await launchInWindow(tmuxName, adapter, { ...spec, mode: "fork" }, { waitShell: true, cwd });
      started = forked.result;
      if (started.ready) {
        const found = adapter.discoverSessionId
          ? await adapter
              .discoverSessionId({ windowName: tmuxName, cwd, exclude: info.sessionId, baseline: forked.baseline })
              .catch(() => null)
          : null;
        const newId = found?.sessionId;
        if (newId) {
          // v2.8+ fork 换代：旧 session 从 registry 退役，先归档快照
          await archiveSession(tmuxName, cwd, info.sessionId).catch(() => {});
          reg.agents[tmuxName].sessionId = newId;
          reg.agents[tmuxName].notes = `${adapter.noteTag} session: ${newId} (forked from ${info.sessionId.slice(0, 8)})`;
          await saveRegistry(reg);
          console.error(`[restart] ${tmuxName} fork 出新 session ${newId.slice(0, 8)}（${found.via}），registry 已回写`);
        } else {
          console.error(`[restart] ⚠️ ${tmuxName} fork 成功但未探测到新 session id，registry 未更新`);
        }
        await notify({
          source: "manager",
          chatId: info.channelId,
          text: `🔀 ${displayName} 原 session 被后台 agent 占用，已自动 fork 副本恢复（上下文完整）${newId ? "" : "，⚠️ 新 session id 探测失败请查 registry"}`,
        }).catch(() => {});
      }
    }

    // v2.5.4: 会话内补发 /model，restart 也是 --resume（同样会漂回 session 原模型）。
    // 只对 in-session 的运行时补发——Pi 的 --model 是启动期权威值，以前这里没排除它，
    // 会把 `/model <id>` 当普通消息打进 Pi 会话。
    if (started.ready && adapter.control.modelEnforcement === "in-session") {
      await enforceSessionModel(tmuxName, info.model);
    }

    // P2（peer 2026-08-09）：cmdRestart 此前全程不写 status——restart 一个
    // stopped agent 进程真起来、频道真注册，但 registry 永远停在 stopped，与
    // cmdList（硬编码 active）永久分叉：web 显示「未启动」、归档兜底跳过它、
    // restoreDeadAgents 只认 active 故永不自愈。成功即写回 active。
    if (started.ready && reg.agents[tmuxName] && reg.agents[tmuxName].status !== "active") {
      reg.agents[tmuxName].status = "active";
      regDirty = true;
    }

    // 按 reason 出文案并附 detail（以前一律「启动超时」）；超时再附大会话体积提示
    let timeoutErr: string | undefined;
    if (!started.ready) {
      timeoutErr = readyFailureText(started) + (started.reason === "timeout" ? bigSessionNote(info.cwd, info.sessionId) : "");
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
      await notify({
        source: "manager",
        chatId: info.channelId,
        text: `✅ ${displayName} 已重启，自动恢复完整会话（无 compact，上下文保留）`,
      }).catch(() => { /* 通知失败不影响重启结果 */ });
    }
    } catch (e) {
      // 单个 agent 的异常（如 Codex 按 registry 值抛错）只记进它自己的结果，继续下一个——以前穿出循环，整轮全丢
      const entry = restartExceptionResult(tmuxName, e);
      console.error(`[restart] ❌ ${tmuxName} ${entry.error}`);
      if (!results.some((r) => r.name === tmuxName)) results.push(entry);
    } finally {
      unlockRestart(tmuxName); // 无论成败/异常都释锁，别把 agent 永久锁死
    }
  }

  if (regDirty) await saveRegistry(reg); // P2：落回 status=active

  // 重启后做一次完整 skill 重扫（每个 agent cwd 可能项目级 skill 有变动）
  await triggerSkillsRescan("full");

  // 大总管放最后：它退出后由 launcher 拉起，不占我们这轮的等待时间
  if (opts.includeMaster) results.push(await restartMaster());

  output({
    ok: results.every((r) => r.ok),
    results,
    message: results
      .map((r) => `${r.name}: ${r.ok ? `✅${r.note ? ` ${r.note}` : ""}` : `❌ ${r.error}`}`)
      .join("\n"),
  });
}

async function cmdList() {
  const tmuxWindows = await listAgentWindowsShared();
  const reg = await loadRegistry();

  const agents: Record<string, unknown>[] = [];

  // v2.23+ 大总管显式补一条：它的 tmux 窗口名就是 `master`（不带 agent- 前缀），
  // 而 listAgentWindows 只收 agent-* ⇒ 它一直被漏掉（owner 2026-09-14「大管家怎么
  // 没了」）。数据取 registry 的 agent-master 条目，只要窗口在就进列表。
  try {
    const th = await import("./lib/tmux-helper.js");
    const winNames = (await th.tmuxRaw(["list-windows", "-t", "master", "-F", "#{window_name}"]))
      .split("\n")
      .map((x) => x.trim());
    if (winNames.includes("master") && !tmuxWindows.includes("master")) {
      const m: any = (reg as any).agents?.["agent-master"] || {};
      agents.push({
        name: "master",
        channelId: m.channelId || "",
        status: "active",
        idle: await isAgentIdle("master"),
        cwd: m.cwd || "",
        runtime: m.runtime || "claude-code",
        sessionId: m.sessionId || "",
        purpose: m.purpose || "",
        created: m.created || "",
      });
    }
  } catch {
    /* tmux 不可用（Web-only 等）就不补 */
  }

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
          // v2.23+ 运行时标识：Pi 会话与 Claude Code agent 同属一个 project，
          // 靠这个字段在列表面上区分（web 侧栏/面板用它显示徽章）
          runtime: agentRuntime(info),
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
      // v2.23+ 运行时标识（同上）
      runtime: agentRuntime(info),
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
    // ⚠ 大总管必须跳过，否则**恒判 dead**：tmuxWindows 只收 `agent-*` 窗口，而大总管
    //   的窗口名是裸 `master`（launcher 定名；未迁移的老窗口是 claude / 版本号），
    //   registry 的键却是 `agent-master` ⇒ 这条永远不在集合里。它由上面那条合成的
    //   `master` 行代表（窗口定名后才会出现）。
    //   代价是实打实的：launcher 的 periodic 自愈每分钟把它当 dead 捡起来 restart，
    //   而 master 的 channelId 在 registry 里按设计为空、`manager restart` 硬要求
    //   sessionId + channelId ⇒ 永远失败。实测 2026-09-15 02:04 起每 ~75s 一次，
    //   到发现时已累计 3678 次失败重启，纯空转还刷满 launcher 日志。
    if (isMasterAgent(name)) continue;
    if (info.status === "active" && !tmuxWindows.includes(name)) {
      agents.push({
        name,
        status: "dead",
        idle: false,
        project: info.project,
        projectId: info.projectId || null,
        // v2.23+ 运行时标识（同上）
        runtime: agentRuntime(info),
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
  const sessions = await scanAllSessions(search);

  // 从 registry 建立 sessionId → displayName 映射
  const reg = await loadRegistry();
  const nameMap = new Map<string, string>();
  for (const info of Object.values(reg.agents)) {
    if (info.sessionId && info.displayName) {
      nameMap.set(info.sessionId, info.displayName);
    }
  }

  // v2.23+ 给 web 端也留原始字段：ISO 时间（排序/相对时间自己算）、cwd（点开要看历史）。
  // 上限从 25 放到 100 —— Discord 面板自己 slice(15)，CLI 是人读的，两者都不受影响。
  const display = sessions.slice(0, 100).map((s, i) => ({
    index: i + 1,
    sessionId: s.sessionId,
    name: nameMap.get(s.sessionId) || s.slug || s.sessionId.slice(0, 8),
    slug: s.slug,
    project: s.cwd.replace(process.env.HOME || "", "~"),
    cwd: s.cwd,
    runtime: s.runtime ?? "claude-code",
    age: formatAge(s.modifiedAt),
    modifiedAt: s.modifiedAt.toISOString(),
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
    // 只钉会话内生效的运行时（CC）；Codex / Pi 的模型是启动参数，写进 Claude 别名会让下次启动抛错
    const plan = modelPinPlan(reg.agents, (rt) => managedFor(rt)?.control.modelEnforcement);
    const changed = plan.pin;
    for (const name of changed) reg.agents[name].model = modelVal;
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
      skipped: plan.skipped,
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
  const enforcement = managedFor(info.runtime)?.control.modelEnforcement; // Codex / Pi 的模型是启动参数，不接受 model 命令
  if (enforcement !== "in-session") { output({ ok: false, agent: tmuxName, error: modelPinRefusal(info.runtime, enforcement) }); return; }
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

/** v2.16.3 update 附带的 web 构建。返回值进 update 输出的 webBuild 字段——skipped/ok/error 三态,绝不静默。
 *  判据与 install-cli / doctor 共用(lib/web-build.ts,按 hash 比对):此前按「本次 diff 是否触及
 *  web/」触发,某一轮构建失败后下一轮 diff 不再含 web/,就永远不重试。 */
async function maybeBuildWeb(): Promise<{ built: boolean; restarted?: boolean; restored?: boolean; skipped?: string; error?: string }> {
  const { rebuildWebIfStale } = await import("./lib/web-build.js");
  // 没装 web 的实例跳过,不拖垮整体 update
  if (!existsSync(`${REPO_ROOT}/web/node_modules`)) return { built: false, skipped: "web 未安装(无 node_modules)" };
  // 构建会删掉正在服务的 .next(成败都一样),所以构建后一律重启 launchd 托管的 web
  const r = await rebuildWebIfStale(REPO_ROOT, { restartService: true });
  if (!r.attempted) return { built: false, ...(r.error ? { error: r.error } : { skipped: r.skipped }) };
  if (!r.ok) {
    const tail = (r.log ?? []).join("\n");
    console.error(`[update] web 构建失败:\n${tail}`);
    return { built: false, restarted: r.restarted, restored: r.restored, error: `${r.error ?? "web 构建失败"}: ${tail.slice(0, 500)}` };
  }
  return r.restarted
    ? { built: true, restarted: true }
    : { built: true, restarted: false, skipped: "web 非 launchd 托管——已构建,请自行重启 web 进程" };
}

/** update.lock 互斥。锁文件里是持有者 pid——已有锁时先验持有者是否还活着:
 *  v2.17.2(peer 取证):update 子进程常由 launcher 派生,installClaudestraCli
 *  bootout launcher 时 launchd 会把它连坐回收(macOS 责任链不随 detach 断),
 *  来不及 unlock → 孤儿锁把之后 30 分钟的一切更新(含 beta 自动前进)封死。
 *  持有 pid 已死的锁直接清除接管;活着的仍按 30 分钟陈旧闸。 */
async function takeUpdateLock(): Promise<{ ok: boolean; error?: string }> {
  const lockPath = UPDATE_LOCK;
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
  const updateLock = UPDATE_LOCK;
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

  // 依赖清单变了还装不上 → 回退到 preHead，不 /exit、不 reload（见 lib/post-pull.ts）
  const install = await installAfterPull({
    runInstall: () => spawnFailure(Bun.spawn([resolveBunPath(), "install"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }), 20),
    depsChanged: async () => !(await git("diff", "--quiet", preHead, remote, "--", ...DEP_MANIFESTS)).ok,
    rollback: async () => { const r = await git("reset", "--keep", preHead); return r.ok ? null : r.err || "git reset 失败"; },
  });
  if (!install.ok) {
    await unlock();
    output({
      ok: false, channel: "beta", step: install.step, rolledBack: install.rolledBack,
      error: `bun install 失败（${install.err}）——${install.rolledBack ? `已回退到 ${preHead.slice(0, 7)}` : `回退也失败了：${install.rollbackError}`}；未 reload daemon`,
    });
    return;
  }
  if (install.warning) console.error(`[update] ⚠️ ${install.warning}`);
  const rendered = await renderMasterClaude();
  const webBuild = await maybeBuildWeb();
  const migrateProc = Bun.spawn([resolveBunPath(), "run", `${REPO_ROOT}/src/manager.ts`, "migrate"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const migrateError = await spawnFailure(migrateProc);
  if (migrateError) console.error(`[update] ⚠️ migrate 失败（继续）: ${migrateError}`);
  await Bun.sleep(500);
  await tmuxRaw(["send-keys", "-t", `${MASTER_SESSION}:0`, "/exit", "Enter"]).catch(() => {});
  // ⚠ 先释锁再 reload daemon:bootout launcher 会让本进程被 launchd 连坐回收
  // (peer 取证),殉锁会把之后 30 分钟的更新全封死。临界区(git/build)已过,
  // 这里释放安全;进程死在 reload 里属预期,损失的只有收尾输出。
  await unlock();
  console.log(`[update] beta 临界区完成,即将 reload 3 daemons(本进程可能随 launcher bootout 被回收,属预期)`);
  const { installClaudestraCli } = await import("./lib/cli-install.js");
  const cliInstall = await installClaudestraCli(REPO_ROOT, { skipWebBuild: true }); // 上面 maybeBuildWeb 已判过/建过
  const { installRepoSkills } = await import("./lib/skills-install.js");
  const skillsInstalled = installRepoSkills(REPO_ROOT);
  output({
    ok: true,
    channel: "beta",
    skills: skillsInstalled,
    from: preHead.slice(0, 7),
    to: remote.slice(0, 7),
    message: `beta 已前进 ${preHead.slice(0, 7)} → ${remote.slice(0, 7)} 并 reload daemon`,
    masterReRendered: rendered,
    webBuild,
    cliInstalled: cliInstall.errors.length === 0,
    ...(migrateError ? { migrateError } : {}),
    ...(install.warning ? { installWarning: install.warning } : {}),
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
  const updateLock = UPDATE_LOCK;
  const relLock = await takeUpdateLock();
  if (!relLock.ok) {
    output({ ok: false, error: relLock.error });
    return;
  }

  // 3. fetch tags + checkout release tag
  await git("fetch", "--tags", "--quiet", "origin");
  // 记下升级前的 HEAD：bun install 失败且依赖清单变了时回退到这里（lib/post-pull.ts）
  const preUpdateHead = (await git("rev-parse", "HEAD")).out.trim();
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
  //    以前只 await exited：断网/锁文件冲突时照样 reload 三个 daemon，新代码缺依赖起不来。
  //    依赖清单变了还装不上 → 回退到升级前，不 /exit、不 reload（见 lib/post-pull.ts）
  const install = await installAfterPull({
    runInstall: () => spawnFailure(Bun.spawn([resolveBunPath(), "install"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }), 20),
    depsChanged: async () => !(await git("diff", "--quiet", preUpdateHead, release.tag, "--", ...DEP_MANIFESTS)).ok,
    rollback: async () => { const r = await git("checkout", preUpdateHead, "--quiet"); return r.ok ? null : r.err || "git checkout 失败"; },
  });
  if (!install.ok) {
    await import("fs/promises").then((m) => m.rm(updateLock, { force: true })).catch(() => {});
    output({
      ok: false, step: install.step, rolledBack: install.rolledBack,
      error: `bun install 失败（${install.err}）——${install.rolledBack ? `已回退到 ${preUpdateHead.slice(0, 7)}` : `回退也失败了：${install.rollbackError}`}；未 reload daemon`,
    });
    return;
  }
  if (install.warning) console.error(`[update] ⚠️ ${install.warning}`);

  // 4b. 重新渲染 master/CLAUDE.md（新版本可能更新了 master prompt；不刷新的话 master 还用老 context）
  const rendered = await renderMasterClaude();

  // 4c. v2.16.3 web 构建纳入 update(此前 bridge 侧生效、web 侧继续跑旧构建的「半生效」
  //     状态最难排查)。闸门:未装 web 跳过 / 构建未过期跳过 / 脏树不建 / 失败换回旧构建
  //     并显式冒泡 / 仅 launchd 托管时才自动重启。
  const webBuild = await maybeBuildWeb();

  // 5. 执行新版 manager 的 migrate 子命令（新版可能带格式迁移逻辑）
  //    关键：用 subprocess 跑 NEW 版代码，当前进程跑的还是旧版
  const migrateProc = Bun.spawn(
    [resolveBunPath(), "run", `${REPO_ROOT}/src/manager.ts`, "migrate"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }
  );
  const migrateError = await spawnFailure(migrateProc);
  if (migrateError) console.error(`[update] ⚠️ migrate 失败（继续）: ${migrateError}`);

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
  const cliInstall = await installClaudestraCli(REPO_ROOT, { skipWebBuild: true }); // 上面 maybeBuildWeb 已判过/建过
  const { installRepoSkills } = await import("./lib/skills-install.js");
  const skillsInstalled = installRepoSkills(REPO_ROOT);
  for (const sk of skillsInstalled) if (sk.action !== "ok") console.log(`[skills] ${sk.name}: ${sk.action} — ${sk.detail}`);

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
    migrateError: migrateError || undefined,
    installWarning: install.warning,
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

  const userName = (await readRepoEnvVar("USER_NAME")) || "User";
  // v2.16+ MASTER_DIR 可移出仓库(省掉 master 加载仓库根 CLAUDE.md 的 ~11k token),
  // 渲染目标跟着走;模板内命令用 {{REPO_ROOT}} 绝对路径,不再依赖 cwd 相对定位
  const masterDirPath = await masterDir();

  try {
    let tpl = await Bun.file(templatePath).text();
    tpl = tpl.replaceAll("{{USER_NAME}}", userName).replaceAll("{{REPO_ROOT}}", REPO_ROOT);
    await mkdir(masterDirPath, { recursive: true });
    await Bun.write(`${masterDirPath}/CLAUDE.md`, tpl);
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

async function cmdTmuxScreenshot(name: string) {
  const tmuxName = normalizeName(name);
  if (!(await windowExists(tmuxName))) {
    output({ ok: false, error: `${tmuxName} 不存在` });
    return;
  }
  const bunPath = resolveBunPath();
  const srcDir = SRC_DIR;
  const ts = Date.now();
  const htmlPath = runtimePath(`tmux_${tmuxName}_${ts}.html`);
  const pngPath = runtimePath(`tmux_${tmuxName}_${ts}.png`);
  await mkdir(RUNTIME_DIR, { recursive: true }).catch(() => {});

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
 * 哪些算写见 manager/write-commands.ts（带测试）。
 */
if (isWriteInvocation(cmd, args)) {
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

// ============================================================
// v2.23+ Pi 能力管理
// ============================================================

/** `pi-env <agent>`：看清一个 Pi agent 到底带哪些能力（档案 + 磁盘静态清单 + 运行时实况） */
async function cmdPiEnv(name: string) {
  const tmuxName = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `${tmuxName} 不在 registry` });
    return;
  }
  if (agentRuntime(info) !== "pi") {
    output({
      ok: false,
      error: `${tmuxName} 是 Claude Code agent（runtime=${info.runtime ?? "claude-code"}），pi-env 只对 Pi agent 有意义`,
    });
    return;
  }

  const global = readPiGlobalEnv();
  const cwd = (info.cwd || "").replace(/^~/, process.env.HOME || "~");
  const project = cwd ? readPiProjectEnv(cwd) : null;
  const profile = normalizePiEnvProfile(info.piEnv);
  const snap = readPiRuntimeSnapshot(tmuxName);
  const fresh = snapshotIsFresh(snap);

  // 期望 vs 实况：实况里出现了档案不该有的东西（比如 minimal 却带着用户的包），
  // 或者该有的东西没出现 —— 这是「档案没生效 / 全局环境变了」的唯一可见信号。
  const notes: string[] = [];
  if (profile.base === "minimal" && fresh && snap) {
    const foreign = snap.tools.filter((t) =>
      ["mcp", "web_search", "hb", "knowledge_search", "spawn_session", "subagent"].includes(t),
    );
    if (foreign.length) notes.push(`档案是 minimal，但实况里出现了全局扩展的工具：${foreign.join(", ")}`);
  }
  if (!fresh && snap) notes.push("运行时快照已过期（agent 可能重启过或早已停）");

  output({
    ok: true,
    agent: tmuxName,
    runtime: "pi",
    profile: Object.keys(profile).length ? profile : null,
    profileText: describePiEnvProfile(profile),
    global: {
      settingsPath: global.settingsPath,
      packages: global.packages,
      extensions: global.extensions,
      localExtensions: global.localExtensions,
      localSkills: global.localSkills,
      mcpServers: global.mcpServers,
      providers: global.providers,
    },
    project,
    runtimeSnapshot: fresh ? snap : null,
    snapshotPath: piEnvSnapshotPath(tmuxName),
    notes,
    hint: "改档案: manager pi-env-set <agent> --base minimal|inherit [--add-ext <src>] [--exclude-tool <t>] [--no-trust]，改完要 restart",
  });
}

/** `pi-env-set <agent> …`：改一个 Pi agent 的能力档案（改完要 restart 才生效） */
async function cmdPiEnvSet(
  name: string,
  opts: {
    base?: string;
    addExt?: string[];
    addSkill?: string[];
    excludeTool?: string[];
    mcpConfig?: string;
    trust?: boolean;
    reset?: boolean;
  },
) {
  const tmuxName = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `${tmuxName} 不在 registry` });
    return;
  }
  if (agentRuntime(info) !== "pi") {
    output({ ok: false, error: `${tmuxName} 不是 Pi agent（runtime=${info.runtime ?? "claude-code"}）` });
    return;
  }
  if (opts.base && opts.base !== "minimal" && opts.base !== "inherit") {
    output({ ok: false, error: `未知的 --base: "${opts.base}"。可用: inherit, minimal` });
    return;
  }

  const next: PiEnvProfile = opts.reset ? {} : normalizePiEnvProfile(info.piEnv);
  if (opts.base) {
    if (opts.base === "inherit") delete next.base;
    else next.base = "minimal";
  }
  if (opts.addExt?.length) next.extensions = [...new Set([...(next.extensions ?? []), ...opts.addExt])];
  if (opts.addSkill?.length) next.skills = [...new Set([...(next.skills ?? []), ...opts.addSkill])];
  if (opts.excludeTool?.length) next.excludeTools = [...new Set([...(next.excludeTools ?? []), ...opts.excludeTool])];
  if (opts.mcpConfig) next.mcpConfig = opts.mcpConfig;
  if (opts.trust !== undefined) next.trustProject = opts.trust;

  const cleaned = normalizePiEnvProfile(next);
  if (Object.keys(cleaned).length) reg.agents[tmuxName].piEnv = cleaned;
  else delete reg.agents[tmuxName].piEnv;
  await saveRegistry(reg);

  output({
    ok: true,
    agent: tmuxName,
    profile: Object.keys(cleaned).length ? cleaned : null,
    profileText: describePiEnvProfile(cleaned),
    restartRequired: true,
    hint: `跑 manager restart ${tmuxName.replace(AGENT_PREFIX, "")} 让档案生效；查看: manager pi-env ${tmuxName.replace(AGENT_PREFIX, "")}`,
  });
}

// cron、CLI 可能并发跑写命令,registry 等状态文件的 load→mutate→save 会互相
// 覆盖(saveRegistry 只防撕裂不防丢更新)。命令级锁一把关掉全部窗口;拿不到
// (20s)降级放行——advisory,宁可退回旧竞态也不卡死命令。进程退出兜底释放。
let writeLock: { release: () => void } | null = null;
if (isWriteInvocation(cmd, args)) {
  const { acquireLock } = await import("./lib/file-lock.js");
  writeLock = await acquireLock(statePath(".manager-write.lock"));
  if (!writeLock) console.error("⚠ 写锁 20s 未拿到,降级继续(并发写命令可能竞态)");
  else process.on("exit", () => writeLock?.release());
}

try {
switch (cmd) {
  // v2.23+ Pi 能力管理：看清（只读）/ 改档案（写）
  case "pi-env": {
    const [name] = args;
    if (!name) {
      output({ ok: false, error: "usage: pi-env <agent> — 看这个 Pi agent 带哪些扩展/技能/工具/MCP（档案 + 静态清单 + 运行时实况）" });
      break;
    }
    await cmdPiEnv(name);
    break;
  }
  case "pi-env-set": {
    const { rest: a1, value: base } = extractStringFlag(args, "--base");
    const { rest: a2, value: mcpConfig } = extractStringFlag(a1, "--mcp-config");
    const { rest: a3, values: addExt } = extractMultiFlag(a2, "--add-ext");
    const { rest: a4, values: addSkill } = extractMultiFlag(a3, "--add-skill");
    const { rest: a5, values: excludeTool } = extractMultiFlag(a4, "--exclude-tool");
    const { rest: a6, value: noTrust } = extractBoolFlag(a5, "--no-trust");
    const { rest: a7, value: trust } = extractBoolFlag(a6, "--trust");
    const { rest: posArgs, value: reset } = extractBoolFlag(a7, "--reset");
    const [name] = posArgs;
    if (!name) {
      output({
        ok: false,
        error: 'usage: pi-env-set <agent> [--base inherit|minimal] [--add-ext <src>]... [--add-skill <path>]... [--exclude-tool <name>]... [--mcp-config <path>] [--no-trust|--trust] [--reset]',
      });
      break;
    }
    await cmdPiEnvSet(name, {
      base,
      addExt,
      addSkill,
      excludeTool,
      mcpConfig,
      trust: noTrust ? false : trust ? true : undefined,
      reset,
    });
    break;
  }

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
    const { rest: afterRuntime, value: runtimeFlag } = extractStringFlag(afterExternal, "--runtime");
    const { rest: afterPiBase, value: piBaseFlag } = extractStringFlag(afterRuntime, "--pi-base");
    const { rest: afterModel, model } = extractModelFlag(afterPiBase);
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
        error: 'create <name> <dir> [purpose|--purpose <text>] [--project <id>] [--runtime claude-code|pi] [--pi-base inherit|minimal] [--preset <preset>] [--disallowed "..."] [--effort <level>] [--mode <permission-mode>] [--model <model>] [--external]',
      });
      break;
    }
    await cmdCreate(name, dir, purposeFlag ?? purposeParts.join(" "), { preset, disallowedRaw }, effort, mode, model, external, projectFlag, runtimeFlag, piBaseFlag);
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
    const { rest: afterRuntime, value: runtimeFlag } = extractStringFlag(afterFork, "--runtime");
    const { rest: afterModel, model } = extractModelFlag(afterRuntime);
    const { rest: afterMode, mode } = extractModeFlag(afterModel);
    const { rest: afterEffort, effort } = extractEffortFlag(afterMode);
    const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(afterEffort);
    const [name, sessionId, dir] = posArgs;
    if (!name || !sessionId) {
      output({
        ok: false,
        error: 'resume <name> <sessionId> [dir] [--runtime pi] [--fork] [--preset <preset>] [--disallowed "..."] [--effort <level>] [--mode <permission-mode>] [--model <model>]',
      });
      break;
    }
    await cmdResume(name, sessionId, dir, { preset, disallowedRaw }, effort, mode, model, fork, runtimeFlag);
    break;
  }

  // v2.24+ takeover —— 把跑在 Claudestra 之外的 Claude Code 重启进我们的 tmux
  case "takeover": {
    const { rest: afterAll, value: all } = extractBoolFlag(args, "--all");
    const { rest: afterForce, value: force } = extractBoolFlag(afterAll, "--force");
    const { rest: posArgs, value: nameFlag } = extractStringFlag(afterForce, "--name");
    await cmdTakeover(posArgs[0], { all, force, name: nameFlag });
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
    // --include-master：连大总管一起重启（Claude Code 重新登录后让所有会话认新凭证）。
    // 只在「全体重启」时有意义——指名道姓重启某个 agent 时带它是自相矛盾的。
    const rest = args.filter((a) => a !== "--include-master");
    const includeMaster = args.length !== rest.length;
    const [name] = rest;
    if (name && includeMaster) {
      output({ ok: false, error: "--include-master 只能用于全体重启（不要同时指定 agent 名）" });
      break;
    }
    await cmdRestart(name || undefined, { includeMaster });
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
    // v2.21.3+ --effort <level>:临时 agent 的档位(缺省 medium;targetAgent 模式忽略)
    let effort: string | undefined;
    const efIdx = rest.indexOf("--effort");
    if (efIdx >= 0) {
      effort = rest[efIdx + 1];
      rest.splice(efIdx, 2);
    }
    // v2.21.4+ --project <id>:临时 agent 归到指定 project(缺省按 dir 自动解析)
    let project: string | undefined;
    const pjIdx = rest.indexOf("--project");
    if (pjIdx >= 0) {
      project = rest[pjIdx + 1];
      rest.splice(pjIdx, 2);
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
      output({ ok: false, error: 'usage: cron-add <name> "<cron>" <dir> <prompt...> [--channel <id>] [--target-agent <agent>] [--effort <low|medium|high|xhigh|max>] [--project <id>]\n  <dir> may be omitted when --target-agent is given; --effort / --project apply to the temporary agent only (default medium / resolved by dir)' });
      break;
    }
    await cmdCronAdd(name, schedule, dir, rest.join(" "), reportChannelId, targetAgent, effort, project);
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
    const patch: { schedule?: string; prompt?: string; name?: string; dir?: string; effort?: string; project?: string } = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i];
      const v = rest[i + 1];
      if (v === undefined) break;
      if (k === "--schedule") patch.schedule = v;
      else if (k === "--prompt") patch.prompt = v;
      else if (k === "--name") patch.name = v;
      else if (k === "--dir") patch.dir = v;
      else if (k === "--effort") patch.effort = v;
      else if (k === "--project") patch.project = v; // "-" = 清除
    }
    if (!nameOrId || Object.keys(patch).length === 0) {
      output({ ok: false, error: 'usage: cron-edit <name|id> [--schedule "<cron>"] [--prompt "<text>"] [--name <new>] [--dir <dir>] [--effort <level>] [--project <id|->]' });
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
  case "peer-http-accept": await cmdPeerHttpAccept(args[0] || "", args[1] || ""); break;
  case "peer-http-test": await cmdPeerHttpTest(args[0] || ""); break;
  case "peer-invite-inspect": await (await import("./manager/peers-inspect.js")).cmdPeerInviteInspect(args[0] || ""); break;
  case "peer-http-list": await cmdPeerHttpList(); break;
  // 中继（bridge/relay-link.ts）：配对短码 / 二维码给手机与浏览器，状态查询；实现在 manager/relay.ts
  case "pair": await (await import("./manager/relay.js")).cmdPair(args.includes("--json")); break;
  case "relay-status": await (await import("./manager/relay.js")).cmdRelayStatus(); break;
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
  case "peer-http-remove": await cmdPeerHttpRemove(args[0] || ""); break;
  case "peer-http-tidy": await (await import("./manager/peers-tidy.js")).cmdPeerHttpTidy(args.includes("--apply")); break;

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
  case "peer-invite-list": await cmdPeerInviteList(); break;
  case "peer-invite-revoke": await cmdPeerInviteRevoke(args[0] || ""); break;
  case "peer-invite-redeem": {
    let join = "", name = "", url = "", token = "", iid = "", fp = "";
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--join") join = args[++i] || "";
      else if (a === "--name") name = args[++i] || "";
      else if (a === "--url") url = args[++i] || "";
      else if (a === "--token") token = args[++i] || "";
      else if (a === "--iid") iid = args[++i] || "";
      else if (a === "--fp") fp = args[++i] || ""; // 经中继兑换时 bridge 带上的对方指纹
    }
    await cmdPeerInviteRedeem(join, name, url, token, iid, fp);
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

  case "install-skills": {
    // v2.21.3+ 仓库 skills/ → ~/.claude/skills 软链(owner 2026-09-03:skill 一直
    // 在仓库里却没人装,MacBook 的软链悬空了两个月)。update / install-cli 也会顺手跑。
    const { installRepoSkills } = await import("./lib/skills-install.js");
    const results = installRepoSkills(REPO_ROOT);
    output({ ok: !results.some((r) => r.action === "warn"), skills: results });
    break;
  }

  case "install-hooks": {
    // v2.21.5+ SessionStart 记忆召回 hook(~/mem0-mcp/recall.py + HANDOFF.md 注入)。
    // setup / install-cli / update 都会顺手跑;这条给「只想挂/修 hook、不想动 daemon」的场合。
    const { ensureRecallHookInstalled } = await import("./lib/cli-install.js");
    const r = await ensureRecallHookInstalled(resolveBunPath(), REPO_ROOT);
    output({ ok: true, recallHook: r.status, command: r.command,
      note: r.status === "skipped" ? "本机没有 ~/mem0-mcp/recall.py,未注册(可设 MEM0_RECALL_SCRIPT)" : undefined });
    break;
  }

  case "install-cli": {
    // v2.3.0+: 把 `claudestra` 命令装到 PATH + 配 LaunchAgent 开机自启。
    // 给现有装机的人；首次 setup.ts 安装末尾也会跑这同一份逻辑。
    const { installClaudestraCli } = await import("./lib/cli-install.js");
    const REPO = REPO_ROOT;
    // 仓库 skill 顺手装上(软链,幂等)
    const { installRepoSkills } = await import("./lib/skills-install.js");
    const skills = installRepoSkills(REPO);
    for (const s of skills) if (s.action !== "ok") console.log(`[skills] ${s.name}: ${s.action} — ${s.detail}`);
    const result = await installClaudestraCli(REPO);
    if (result.errors.length > 0) {
      output({ ok: false, error: result.errors.join("; "), warnings: result.warnings, result });
    } else {
      output({
        ok: true,
        cliWrapper: result.cliWrapper,
        daemons: result.daemons.map((d) => ({ label: d.label, loaded: d.loaded, warning: d.warning, ...(d.keptExisting ? { keptExisting: true } : {}) })),
        // v2.24+ web 服务装没装上 —— 装上了给 url，没装给**缺什么**。
        // 这条不输出的话，前置条件缺一项（比如没跑过 setup、没有 web/.env.local）
        // 就是彻底静默：daemon 不装、端口不监听、命令行一个字都不说，
        // 用户只能看到「装完了但网页打不开」。
        webDaemon: result.webDaemon,
        // web 构建过期时的自动重建结果（没重建 = 构建与代码一致或被闸门拦下，skipped 说明原因）
        webBuild: result.webBuild,
        // 装完自验的结论提到最外层:「命令报成功但网页打不开」来回过六轮,
        // 就是因为成败藏在一个要自己去翻的字段里。
        ...(result.webDaemon?.installed && !result.webDaemon.serving
          ? { webServiceFailed: result.webDaemon.error, webServiceLog: result.webDaemon.log }
          : {}),
        pm2Stopped: result.pm2Stopped.length > 0 ? result.pm2Stopped : undefined,
        oldAutostartPlist: result.oldAutostartPlist,
        oldPm2StartupPlist: result.oldPm2StartupPlist,
        removedOldAutostartWrapper: result.removedOldAutostartWrapper || undefined,
        migratedHookCommand: result.migratedHookCommand || undefined,
        bumpedTmuxDashboardLimit: result.bumpedTmuxDashboardLimit,
        allowedMcpTools: result.allowedMcpTools,
        warnings: result.warnings,
        hint: result.webDaemon?.installed && !result.webDaemon.serving
          ? "⚠️ web 服务装上了但没跑起来 —— 看上面的 webServiceLog；其余 daemon 正常。"
          : "打 `claudestra` 试试 —— launchd 3 个 daemon + 进 master TUI。重启机器后服务也会自动起来。",
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
    const checks = await runDoctor(REPO_ROOT);
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
        "takeover [sessionId|--all]      — restart a Claude Code running OUTSIDE Claudestra into our tmux (SIGTERM the original, then resume the same session; --force for a busy one). No args = list candidates.",
        'cron-add <name> "<cron>" <dir> <prompt...> [--channel <id>] [--target-agent <agent>] [--effort <level>] [--project <id>] — add a cron job (--target-agent sends the prompt to an existing agent, inheriting its context; otherwise a temporary agent is spawned each run, at --effort (default medium), filed under --project (default: resolved by dir))',
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
        "install-skills                  — symlink the repo's skills/ (save-compact …) into ~/.claude/skills (idempotent; update/install-cli run it too)",
        "version                         — show the current version and whether an update is available",
        "update                          — git pull and reload the three launchd daemons",
        "auto-update status              — show auto-update toggles",
        "auto-update claudestra on|off   — toggle Claudestra auto-update (default on)",
        "auto-update claude on|off       — toggle Claude Code auto-update (default on)",
        "auto-update channel beta|release — beta follows every commit on origin/main (default: release)",
        "cost [--agent <name>] [--today|--week]  — aggregate token usage per agent or overall",
        "invite-link                     — generate the Discord bot invite URL (owner perms, for your own server)",
        "pair [--json]                   — print a QR code / link / 8-char code so a phone or browser can pair with this machine through the relay (RELAY_URL in .env)",
        "relay-status                    — show the relay connection (address, fingerprint, contacts online)",
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

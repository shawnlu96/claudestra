/**
 * Claude Code 适配器。
 *
 * 会话来源部分：路径可预测、行就是最终形状，大部分方法是直通。
 * 生命周期部分：原来在 manager.ts 里抄了三份的就绪轮询（create / resume /
 * startClaudeInWindow）、gracefulExit 的收尾弹窗、fork 后的会话 id 探测，都收在这里。
 */
import { existsSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveSessionIdForWindow } from "../cc-sessions.js";
import { buildClaudeCommand, type LaunchOptions } from "../claude-launch.js";
import { findJsonlBySessionId, projectJsonlPath, projectsDir } from "../jsonl-cost.js";
import {
  detectSessionIdlePrompt,
  isAtShell,
  isClaudeReady,
  probeTuiContract,
} from "../tmux-helper.js";
import { isAutoConfirmableModal } from "../modal-confirm.js";
import { belowTrustLeftover, looksLikeTrustPrompt, modalFooterAtBottom, TRUST_CAPTURE_LINES, trustPromptKey, trustPromptMoves, trustRefusal } from "../trust-prompt.js";
import { lastUserTextOf } from "./shared.js";
import { roleLaunch } from "../team-roles.js";
import type {
  AnyRecord,
  DiscoveredSession,
  LaunchSpec,
  ManagedRuntimeAdapter,
  ReadyResult,
  RuntimeControl,
  WindowOps,
} from "./types.js";

/** 像信任框却认不全时，连着这么多轮（pollMs 500）就报 blocked-dialog */
const TRUST_UNCLEAR_ROUNDS = 6;
const TRUST_UNCLEAR_DETAIL = "屏幕上有目录信任弹窗但认不全（带编号、文案变了或叠着别的框），没有自动确认；请自己 attach 进 tmux 确认后再 restart";

/** 信任弹窗显示的是真实路径（/tmp → /private/tmp）；目录不在就按原样比 */
function realPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return realpathSync(p);
  } catch {
    return p; // 目录没了照原样返回：trustRefusal 比不上就拒绝，不会多信任
  }
}

export function claudeProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAUDE_CODE_CONTROL: RuntimeControl = {
  // Esc 不用 C-c：主回合空闲、只剩后台子 agent 时，C-c 会停掉全部后台 agent（CC 2.1.283 实测 + 源码的 suppressBackgroundAgentKill），
  // Esc 永远不碰后台 agent；主回合在跑时两者一样打断。事件态滞后把空闲误判成忙时，Esc 也是空操作。docs/architecture/interrupts.md
  interruptKeys: ["Escape"],
  preemptOnHumanMessage: true,
  idleSource: "pane",
  // --model 对 --resume 的会话经常不生效（会话保留原模型），启动后要会话内补发 /model
  modelEnforcement: "in-session",
  paneHeuristics: true,
};

/**
 * LaunchSpec → buildClaudeCommand 的选项。new 走 --session-id，resume / fork 走
 * --resume（fork 再加 --fork-session）。可选字段原样转交，不补默认值。
 */
export function claudeLaunchOptions(spec: LaunchSpec): LaunchOptions {
  const x = spec.extras ?? {};
  const str = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : undefined);
  return {
    channelId: spec.channelId,
    bridgeUrl: spec.bridgeUrl,
    ...(spec.mode === "new"
      ? { sessionId: spec.sessionId }
      : { resumeId: spec.sessionId, forkSession: spec.mode === "fork" }),
    displayName: spec.displayName,
    disallowedPreset: str("disallowedPreset"),
    disallowedRaw: str("disallowedRaw"),
    effort: spec.effort,
    permissionMode: spec.permissionMode,
    model: spec.model,
    purpose: spec.purpose,
    agentName: spec.agentName,
    settingsAgent: spec.settingsName,
    projectContext: spec.projectContext,
    role: roleLaunch(x.role),
  };
}

/** cwd 对应的 projects 目录里现有的 jsonl 文件名（fork 前后 diff 用） */
export async function listSessionJsonls(cwd: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(projectsDir(cwd))).filter((f) => f.endsWith(".jsonl")));
  } catch {
    return new Set();
  }
}

/** 启动前 diff：projects 目录里新出现的 jsonl → 新 session id（多个取 mtime 最新） */
async function detectNewSessionId(cwd: string, before: Set<string>): Promise<string | null> {
  try {
    const dir = projectsDir(cwd);
    const fresh = (await readdir(dir)).filter((f) => f.endsWith(".jsonl") && !before.has(f));
    if (fresh.length === 0) return null;
    if (fresh.length === 1) return fresh[0].replace(/\.jsonl$/, "");
    const withMtime = await Promise.all(
      fresh.map(async (f) => ({ f, m: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    withMtime.sort((a, b) => b.m - a.m);
    return withMtime[0].f.replace(/\.jsonl$/, "");
  } catch {
    return null;
  }
}

/** 轮询探测 fork 出的新 session（jsonl 要到第一条消息才落盘，可能滞后于 TUI 就绪） */
async function waitForNewSessionId(cwd: string, before: Set<string>, timeoutMs = 20_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await detectNewSessionId(cwd, before);
    if (found) return found;
    await Bun.sleep(1_000);
  }
  return null;
}

/**
 * session 闲置弹窗 → 选「恢复完整会话」(option 2)。默认高亮的 option 1 是
 * 「从摘要恢复」= 丢上下文；这个 modal 不接受数字跳转，只能 Down 一次再 Enter。
 */
async function pickFullResume(win: WindowOps): Promise<void> {
  await win.sendKey("Down");
  await win.sleep(150);
  await win.sendKey("Enter");
}

export const claudeCodeAdapter: ManagedRuntimeAdapter = {
  id: "claude-code",
  label: "Claude Code",
  manageable: true,
  control: CLAUDE_CODE_CONTROL,
  inbound: "mcp-channel",
  turnEnd: "claude-hook",
  exitCommand: "/exit",
  noteTag: "claude",

  async scanSessions(search?: string): Promise<DiscoveredSession[]> {
    const root = claudeProjectsRoot();
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];
    for (const projDir of await readdir(root).catch(() => [] as string[])) {
      const projPath = join(root, projDir);
      const projStat = await stat(projPath).catch(() => null);
      if (!projStat?.isDirectory()) continue;
      for (const file of await readdir(projPath).catch(() => [] as string[])) {
        if (!file.endsWith(".jsonl") || file.includes("compact")) continue;
        const uuid = file.replace(".jsonl", "");
        if (!/^[0-9a-f]{8}-/.test(uuid)) continue;
        const filePath = join(projPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        let sessionId = uuid;
        let cwd = "";
        let slug = "";
        try {
          const chunk = await Bun.file(filePath).slice(0, 8192).text();
          for (const line of chunk.split("\n")) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.sessionId) sessionId = obj.sessionId;
              if (obj.cwd && !cwd) cwd = obj.cwd;
              if (obj.slug && !slug) slug = obj.slug;
              if (cwd && slug) break;
            } catch { /* 半行/坏行跳过 */ }
          }
        } catch { /* non-critical */ }
        if (!cwd) continue;
        if (search && !`${cwd} ${sessionId}`.toLowerCase().includes(search.toLowerCase())) continue;

        out.push({
          sessionId,
          cwd,
          slug: slug || cwd.split("/").filter(Boolean).pop() || "",
          modifiedAt: fileStat.mtime,
          lastUserMessage: await lastUserTextOf(filePath, fileStat.size, this.translateLine),
          runtime: "claude-code",
        });
      }
    }
    return out;
  },

  sessionPath: (cwd, sessionId) => projectJsonlPath(cwd, sessionId),
  findSessionById: (sessionId) => findJsonlBySessionId(sessionId),

  listSessionsForCwd(cwd) {
    const dir = projectsDir(cwd);
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes("compact"))
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  },

  ownsPath: (path, home = homedir()) => path.startsWith(claudeProjectsRoot(home) + "/"),

  /** 文件名就是 `<sessionId>.jsonl` */
  sessionIdFromPath(path) {
    const name = basename(path);
    return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) || null : null;
  },

  /** 行本来就是 Claude Code 形状，原样返回 */
  translateLine(line: string): AnyRecord | null {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" ? (parsed as AnyRecord) : null;
    } catch {
      return null;
    }
  },

  // ── 生命周期 ──

  isValidSessionId: (id) => UUID_RE.test(id),
  /** claude 是 Claudestra 的前提，不做预检（与改造前一致） */
  available: async () => ({ ok: true }),
  buildLaunchCommand: (spec) => buildClaudeCommand(claudeLaunchOptions(spec)),

  async waitReady(win: WindowOps, budget): Promise<ReadyResult> {
    let sessionIdlePicked = false;
    let trustSeen = false;
    let trustUnclear = 0;
    for (let i = 0; i < budget.rounds; i++) {
      await win.sleep(budget.pollMs);
      const pane = await win.capture(10);

      if (isClaudeReady(pane)) return { ready: true, recoveredFullSession: sessionIdlePicked };

      // 会话被 bg agent 占用 → claude 报错退出；早返回让调用方走 --fork-session 自愈
      if (/currently running as a background agent/i.test(pane)) {
        return { ready: false, reason: "occupied", recoveredFullSession: false };
      }

      // 闲置弹窗：只选一次，发完给加载留窗口，下轮再判 ready
      if (detectSessionIdlePrompt(pane)) {
        if (!sessionIdlePicked) {
          await pickFullResume(win);
          sessionIdlePicked = true;
          await win.sleep(1500);
        }
        continue;
      }

      // 目录信任弹窗默认高亮 No, exit：截整个框，完整干净、目录恰好是本次 cwd 才发一个键，高亮停在 Yes 才回车（lib/trust-prompt.ts）
      const full = looksLikeTrustPrompt(pane) ? await win.capture(TRUST_CAPTURE_LINES) : "";
      const trustMoves = full ? trustPromptMoves(full) : null;
      if (trustMoves !== null) {
        trustSeen = true;
        trustUnclear = 0;
        const refusal = trustRefusal(full, realPath(budget.cwd), realPath(homedir())!, { resolve: (p) => realPath(p)! });
        if (refusal) return { ready: false, reason: "blocked-dialog", detail: refusal, recoveredFullSession: false };
        await win.sendKey(trustPromptKey(trustMoves));
        await win.sleep(trustMoves === 0 ? 1000 : 300);
        continue;
      }
      // 像信任框却认不全（带编号、文案变了、叠着别的框）：一个键都不发，连着几轮（约 3 秒，排除正在画）还这样就直接报，不空等满预算。
      // 只数屏幕底部真是一个框的轮次：restart 复用旧窗口时旧 CC 最后一帧里的信任框文字底下还有 shell，新 CC 画得再慢也不算
      trustUnclear = full && modalFooterAtBottom(full) ? trustUnclear + 1 : 0;
      if (trustUnclear >= TRUST_UNCLEAR_ROUNDS) {
        return { ready: false, reason: "blocked-dialog", detail: TRUST_UNCLEAR_DETAIL, recoveredFullSession: false };
      }
      // 弹窗残影下面接了 shell 提示符 = CC 在弹窗上退出了，别再等满预算。第一次截屏前就退了的也算，但头几轮不判：新 CC 还没接管屏幕
      const below = trustSeen || i >= 3 ? belowTrustLeftover(pane) : null;
      if (below !== null && isAtShell(below)) {
        return { ready: false, reason: "exited", detail: "目录信任弹窗之后 Claude Code 退出了", recoveredFullSession: false };
      }
      if (isAutoConfirmableModal(pane)) {
        await win.sendKey("Enter");
        await win.sleep(500);
        continue;
      }
    }
    // 最后再用同样的严格条件捕一次，不靠循环结束的瞬时状态
    const final = await win.capture(10);
    if (isClaudeReady(final)) return { ready: true, recoveredFullSession: sessionIdlePicked };
    const detail = looksLikeTrustPrompt(final) ? TRUST_UNCLEAR_DETAIL : undefined;
    return { ready: false, reason: "timeout", ...(detail ? { detail } : {}), recoveredFullSession: sessionIdlePicked };
  },

  async onExitPane(pane, win) {
    // Goodbye! = 正在退出，等它
    if (pane.includes("Goodbye!")) {
      await win.sleep(1000);
      return "handled";
    }
    // 退出阶段不替用户接受新的目录信任：往 No, exit 挪（它本来就是退出）
    const trustMoves = looksLikeTrustPrompt(pane) ? trustPromptMoves(await win.capture(TRUST_CAPTURE_LINES), "no") : null;
    if (trustMoves !== null) {
      await win.sendKey(trustPromptKey(trustMoves));
      await win.sleep(trustMoves === 0 ? 1000 : 300);
      return "handled";
    }
    if (isAutoConfirmableModal(pane)) {
      await win.sendKey("Enter");
      await win.sleep(500);
      return "handled";
    }
    // /exit 落进了补全列表，要再按一次 Enter
    if (pane.includes("/exit") && pane.includes("Exit the REPL")) {
      await win.sendKey("Enter");
      await win.sleep(500);
      return "handled";
    }
    return "none";
  },

  // CC 到第一条消息才写 jsonl；projectJsonlPath 找不到时返回推算路径，所以还要再核一次存在
  hasSession: (sessionId, cwd) =>
    cwd ? existsSync(projectJsonlPath(cwd, sessionId)) : findJsonlBySessionId(sessionId) !== null,

  forkBaseline: (cwd) => listSessionJsonls(cwd),

  /**
   * 先问 Claude Code 自己的进程登记（~/.claude/sessions/<pid>.json，进程一起来就有
   * 新 id）；有 fork 前快照时再用目录 diff 兜底——fork 出的 jsonl 要到第一条消息
   * 才创建，只靠 diff 会错过窗口。
   */
  async discoverSessionId(ctx) {
    const viaCc = await resolveSessionIdForWindow(ctx.windowName, ctx.cwd, {
      exclude: ctx.exclude,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    if (viaCc) return { sessionId: viaCc.sessionId, via: "CC sessions 登记" };
    if (ctx.baseline instanceof Set) {
      const id = await waitForNewSessionId(ctx.cwd, ctx.baseline as Set<string>);
      if (id) return { sessionId: id, via: "目录 diff" };
    }
    return null;
  },

  /** CC agent 的 registry 不写 runtime 字段（历史数据零迁移） */
  registryFields: () => ({}),
};

/**
 * 启动超时时补一句可操作的诊断。
 *
 * isClaudeReady 完全建立在 TUI 文案上（❯ + 模式 banner）。Claude Code 改了这两处
 * 渲染，症状就是"每次建 agent 都超时"，而错误信息里没有任何线索指向真正的原因 ——
 * 用户只会以为是自己装错了。这里在超时时顺手探一次契约：屏幕上明明有 CC 的界面
 * 却认不出任何标记，就把这条线索直接写进错误里。
 */
export function readyTimeoutHint(pane: string): string {
  const c = probeTuiContract(pane);
  if (!c.suspect) return "";
  return (
    "。⚠️ 检测到 Claude Code 的界面在屏幕上，但认不出它的状态栏文案 —— " +
    "如果这是升级 Claude Code 之后才开始出现的，很可能是 TUI 文案变了，" +
    "需要更新 src/lib/tmux-helper.ts 里的 CC_MODE_BANNER_RE 等匹配规则"
  );
}

/**
 * Claude Code 适配器。
 *
 * 会话来源部分：路径可预测、行就是最终形状，大部分方法是直通。
 * 生命周期部分：原来在 manager.ts 里抄了三份的就绪轮询（create / resume /
 * startClaudeInWindow）、gracefulExit 的收尾弹窗、fork 后的会话 id 探测，都收在这里。
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveSessionIdForWindow } from "../cc-sessions.js";
import { buildClaudeCommand, type LaunchOptions } from "../claude-launch.js";
import { findJsonlBySessionId, projectJsonlPath, projectsDir } from "../jsonl-cost.js";
import {
  acceptTrustPrompt,
  detectSessionIdlePrompt,
  isAutoConfirmableModal,
  isClaudeReady,
  trustPromptMoves,
} from "../tmux-helper.js";
import { lastUserTextOf } from "./shared.js";
import type {
  AnyRecord,
  DiscoveredSession,
  LaunchSpec,
  ManagedRuntimeAdapter,
  ReadyResult,
  RuntimeControl,
  WindowOps,
} from "./types.js";

function claudeProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAUDE_CODE_CONTROL: RuntimeControl = {
  interruptKeys: ["C-c"],
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
    projectContext: spec.projectContext,
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

      // 目录信任弹窗默认高亮 No, exit，不能直接 Enter：选 Yes 再继续
      const trustMoves = trustPromptMoves(pane);
      if (trustMoves !== null) {
        await acceptTrustPrompt(win.target, trustMoves);
        await win.sleep(1000);
        continue;
      }
      if (isAutoConfirmableModal(pane)) {
        await win.sendKey("Enter");
        await win.sleep(500);
        continue;
      }
    }
    // 最后再用同样的严格条件捕一次，不靠循环结束的瞬时状态
    const final = await win.capture(10);
    return isClaudeReady(final)
      ? { ready: true, recoveredFullSession: sessionIdlePicked }
      : { ready: false, reason: "timeout", recoveredFullSession: sessionIdlePicked };
  },

  async onExitPane(pane, win) {
    // Goodbye! = 正在退出，等它
    if (pane.includes("Goodbye!")) {
      await win.sleep(1000);
      return "handled";
    }
    const trustMoves = trustPromptMoves(pane);
    if (trustMoves !== null) {
      await acceptTrustPrompt(win.target, trustMoves);
      await win.sleep(1000);
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

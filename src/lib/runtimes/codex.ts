/**
 * Codex 适配器（v2.24+）：会话来源 + 生命周期，`manageable: true`。
 *
 * 链路（细节与限制见 docs/runtimes/codex.md）：
 *   new    → prepareSession 跑一轮 `codex exec --json` 引导出 thread id（新线程在第一轮之前
 *            没有 rollout，`codex queue` 会报 no rollout found）→ TUI 用 `codex resume <id>`
 *   resume → `codex resume <id>`；fork → `codex fork <id>`（新 id 由 discoverSessionId 按锁探测）
 *   就绪   → channel-server（Codex 起的 MCP 子进程）注册成功后写 tmux 窗口选项 @claudestra_ready=1
 *   入站   → channel-server 的 CodexQueueSink 经 `codex queue` 投进线程（先按线程写锁查活）
 *   回合末 → hooks.Stop / hooks.Interrupt → typing-hook → bridge /hook
 *
 * 各步骤依赖的外部动作（跑 codex、查窗口子进程、查锁）都经 CodexAdapterDeps 注入，
 * 单测与 scripts/codex-adapter-e2e.ts（独立 tmux socket）都靠它换掉生产实现。
 */
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { channelInstructions } from "../channel-instructions.js";
import {
  bootstrapArgs,
  buildCodexCommand,
  codexPermissionFlags,
  parseBootstrapThreadId,
  probeCodexQueue,
  resolveCodexBinary,
} from "../codex-launch.js";
import {
  codexLineToClaudeShape,
  codexSessionIdFromFilename,
  codexSessionsRoot,
  findCodexSessionPath,
  isCodexSessionPath,
  listCodexSessionFiles,
  newCodexTranslateState,
  readCodexMeta,
} from "../codex-session.js";
import { defaultRunner, heldThreadIds, type Runner } from "../codex-thread.js";
import { REPO_ROOT } from "../repo-root.js";
import { isAtShell, PI_READY_OPTION, windowChildPids, windowTarget } from "../tmux-helper.js";
import { lastUserTextOf } from "./shared.js";
import type {
  AnyRecord,
  DiscoverContext,
  DiscoveredSession,
  LaunchSpec,
  ManagedRuntimeAdapter,
  ReadyResult,
  RuntimeControl,
  WindowOps,
} from "./types.js";

/**
 * bridge 侧的约束：
 * - 空闲的 Codex 收到一次 C-c 会在 0.8s 内直接退出（2026-09-23 实测），打断只能发 Esc
 * - `codex queue` 对忙着的线程是排到下一轮（不插进当前回合），不需要也不该抢占
 */
export const CODEX_CONTROL: RuntimeControl = {
  interruptKeys: ["Escape"],
  preemptOnHumanMessage: false,
  idleSource: "hook",
  modelEnforcement: "launch-flag",
  paneHeuristics: false,
};

/** channel-server 注册成功后写的就绪标记（与 Pi 扩展同一个窗口选项） */
export const CODEX_READY_OPTION = PI_READY_OPTION;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 线程被别的进程占着写（另一个 TUI / ChatGPT.app 的 app-server）：resume 起不来，restart 会改 fork 重试 */
export const OCCUPIED_RE = /already has an active writer/i;

/**
 * 启动期对话框。**绝不替用户按 Enter**：更新框默认高亮「Update now」，hooks 审查框按下去
 * 等于替 owner 批准，信任框同理——一律立即失败，把屏幕上那句话带回给调用方。
 * （正常启动参数已关掉这三个：check_for_update_on_startup=false / --dangerously-bypass-hook-trust /
 * projects 信任内联表。还弹出来 = Codex 版本变了或参数没生效，需要人看。）
 */
export const BLOCKING_DIALOG_RE = /Hooks need review|Do you trust|Update available/i;

function countMatches(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return (text.match(g) || []).length;
}

/** pane 里命中的那一行（报错信息用） */
function matchedLine(pane: string, re: RegExp): string {
  return (pane.split("\n").find((l) => re.test(l)) || "").trim().slice(0, 200);
}

/** 同步读 rollout 首行的 cwd（buildLaunchCommand 是同步的；首行 session_meta 可能好几 KB） */
export function codexSessionCwdSync(sessionId: string, find: (sid: string) => string | null = findCodexSessionPath): string | null {
  const path = find(sessionId);
  if (!path) return null;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.toString("utf8", 0, n).split("\n")[0];
      const rec = JSON.parse(first);
      const cwd = rec?.payload?.cwd;
      return rec?.type === "session_meta" && typeof cwd === "string" && cwd ? cwd : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export interface CodexAdapterDeps {
  run: Runner;
  /** 交互式 codex 的绝对路径（登录 shell 解析 + npm 壳换原生二进制） */
  resolveBin(): Promise<string | null>;
  /** exec 引导：返回 stdout / stderr / 退出码 */
  execBootstrap(argv: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }>;
  /** 窗口名 → pane 的直接子进程（原生 codex 就是直接子进程，见 resolveCodexBinary） */
  childPids(windowName: string): Promise<number[]>;
  /** pid 持有的线程写锁 */
  heldThreadIds(pid: number): Promise<string[]>;
  /** 会话 id → rollout 首行的 cwd */
  sessionCwd(sessionId: string): string | null;
  /** channel-server / typing-hook 用的 bun */
  bunBin: string;
  /** Claudestra 仓库根（拼 channel-server / typing-hook 路径与频道规则用） */
  repoRoot: string;
  now(): number;
}

async function spawnBootstrap(argv: string[], cwd: string) {
  // stdin 必须是空的：否则 exec 会等 stdin 的「additional input」
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* 已退出 */ } }, 180_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out, err };
}

export function defaultCodexDeps(): CodexAdapterDeps {
  return {
    run: defaultRunner,
    resolveBin: async () => (await resolveCodexBinary(defaultRunner))?.real ?? null,
    execBootstrap: spawnBootstrap,
    childPids: (name) => windowChildPids(windowTarget(name)),
    heldThreadIds: (pid) => heldThreadIds(pid),
    sessionCwd: (sid) => codexSessionCwdSync(sid),
    bunBin: process.execPath,
    repoRoot: REPO_ROOT,
    now: () => Date.now(),
  };
}

/** ws://host:3847 → "3847"（typing-hook 靠 BRIDGE_PORT 找 bridge） */
export function bridgePortOf(bridgeUrl: string): string {
  try {
    const u = new URL(bridgeUrl);
    if (u.port) return u.port;
  } catch { /* 下面兜底 */ }
  return process.env.BRIDGE_PORT || "3847";
}

const AVAILABILITY_TTL_MS = 5 * 60_000;

export type CodexAdapter = ManagedRuntimeAdapter & {
  /** 测试 / e2e 用：当前缓存的 codex 路径 */
  readonly binPath: () => string | null;
};

export function createCodexAdapter(overrides: Partial<CodexAdapterDeps> = {}): CodexAdapter {
  let depsCache: CodexAdapterDeps | null = null;
  const deps = (): CodexAdapterDeps => (depsCache ??= { ...defaultCodexDeps(), ...overrides });

  let bin: string | null = null;
  let availCache: { at: number; result: { ok: true } | { ok: false; hint: string } } | null = null;
  /** beforeLaunch 拍的 pane 基线：复用窗口时，上一次启动留下的报错 / 对话框文字不能再算一次 */
  const paneBaselines = new Map<string, { occupied: number; dialog: number }>();

  async function ensureBin(): Promise<string> {
    if (bin) return bin;
    const found = await deps().resolveBin();
    if (!found) throw new Error("登录 shell 的 PATH 里找不到 codex（npm i -g @openai/codex，或用 CODEX_TUI_BIN 指定原生二进制）");
    bin = found;
    return bin;
  }

  function channelRules(): string {
    return channelInstructions(deps().repoRoot);
  }

  function cwdFor(spec: LaunchSpec): string {
    const cwd = spec.cwd || deps().sessionCwd(spec.sessionId);
    if (!cwd) throw new Error(`Codex 启动需要工作目录：会话 ${spec.sessionId.slice(0, 8)} 的 rollout 找不到 cwd`);
    return cwd;
  }

  const adapter: CodexAdapter = {
    id: "codex",
    label: "Codex",
    manageable: true,
    control: CODEX_CONTROL,
    inbound: "codex-queue",
    turnEnd: "codex-hooks",
    exitCommand: "/quit",
    noteTag: "codex",
    binPath: () => bin,

    // ── 会话来源 ──

    async scanSessions(search?: string): Promise<DiscoveredSession[]> {
      const root = codexSessionsRoot();
      if (!existsSync(root)) return [];
      const out: DiscoveredSession[] = [];
      for (const filePath of listCodexSessionFiles(root)) {
        const sessionId = codexSessionIdFromFilename(filePath.split("/").pop() || "");
        if (!sessionId) continue;
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;
        // cwd 在首行 session_meta 里，而那一行可能有好几 KB（塞着 base_instructions），
        // 必须读完整行再 parse —— 见 codex-session.readCodexMeta
        const meta = await readCodexMeta(filePath);
        if (!meta?.cwd) continue;
        if (search && !`${meta.cwd} ${sessionId}`.toLowerCase().includes(search.toLowerCase())) continue;
        out.push({
          sessionId,
          cwd: meta.cwd,
          slug: meta.cwd.split("/").filter(Boolean).pop() || "",
          modifiedAt: fileStat.mtime,
          lastUserMessage: await lastUserTextOf(filePath, fileStat.size, codexLineToClaudeShape),
          runtime: "codex",
        });
      }
      return out;
    },

    /** 文件名带 ISO 时间戳前缀又按日期分目录，光有 cwd+id 推不出路径 */
    sessionPath: () => null,
    findSessionById: (sessionId) => findCodexSessionPath(sessionId),
    /** rollout 按日期分目录、不按 cwd 分，没有「某目录下的会话文件」这个概念 */
    listSessionsForCwd: () => [],
    ownsPath: (path, home) => isCodexSessionPath(path, home),
    sessionIdFromPath: (path) => codexSessionIdFromFilename(basename(path)),
    /** 归档副本没有路径特征时靠首行：Codex 恒以 session_meta 开头 */
    sniffFirstLine: (rec) => rec?.type === "session_meta",
    translateLine: (line): AnyRecord | null => codexLineToClaudeShape(line),

    /**
     * 每文件一份翻译状态：按轮丢 code-mode exec（输出按 call_id 精确丢）、整轮丢 exec 引导。
     * 初始按「本轮已有 item 事件」算——读窗口常从回合中间开始，看不到那轮开头的 UserMessage
     * item；新版 rollout 全带 item 事件，这与无状态近似同口径；老版 rollout 在第一个
     * task_started 之后自然回到「没有 item → 保留 exec」。
     */
    newTranslator() {
      const state = newCodexTranslateState();
      state.turnHasItems = true;
      return (line: string) => codexLineToClaudeShape(line, state);
    },

    // ── 生命周期 ──

    isValidSessionId: (id) => UUID_RE.test(id),

    async available() {
      const now = deps().now();
      if (availCache && now - availCache.at < AVAILABILITY_TTL_MS) return availCache.result;
      let result: { ok: true } | { ok: false; hint: string };
      const found = await deps().resolveBin().catch(() => null);
      if (!found) {
        result = {
          ok: false,
          hint: "登录 shell 的 PATH 里找不到 codex。装上它（npm i -g @openai/codex）并登录一次（codex login），或用 CODEX_TUI_BIN 指定原生二进制路径",
        };
      } else if (!(await probeCodexQueue(deps().run, found).catch(() => false))) {
        result = {
          ok: false,
          hint: `${found} 没有 \`codex queue\` 子命令（版本太旧）：Claudestra 靠它往会话里投消息。升级：npm i -g @openai/codex@latest`,
        };
      } else {
        bin = found;
        result = { ok: true };
      }
      availCache = { at: now, result };
      return result;
    },

    /**
     * new：跑一轮 exec 引导拿 thread id。引导**不挂** claudestra MCP / hooks（挂了会抢注
     * 频道、多报一次 Stop）；职责与频道规则经 developer_instructions 在这一轮写进线程。
     * resume / fork：会话已存在，原样返回。
     */
    async prepareSession(spec: LaunchSpec) {
      codexPermissionFlags(spec.permissionMode); // 不支持的权限档位在这里就报错，不留半个会话
      if (spec.mode !== "new") return { sessionId: spec.sessionId };
      const cwd = spec.cwd;
      if (!cwd) throw new Error("Codex 新建会话需要工作目录（LaunchSpec.cwd）");
      const codexBin = await ensureBin();
      const argv = bootstrapArgs({
        codexBin,
        cwd,
        agentName: spec.agentName,
        purpose: spec.purpose,
        projectContext: spec.projectContext,
        model: spec.model,
        effort: spec.effort,
        permissionMode: spec.permissionMode,
        channelRules: channelRules(),
      });
      const r = await deps().execBootstrap(argv, cwd);
      const sid = parseBootstrapThreadId(r.out);
      if (!sid) {
        const tail = (r.err || r.out || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400);
        throw new Error(`Codex exec 引导没拿到 thread id（exit ${r.code}）：${tail || "无输出"}`);
      }
      return { sessionId: sid };
    },

    buildLaunchCommand(spec: LaunchSpec) {
      const codexBin = bin || process.env.CODEX_TUI_BIN?.trim();
      if (!codexBin) throw new Error("codex 路径尚未解析（应先经 available() / beforeLaunch）");
      return buildCodexCommand(
        {
          mode: spec.mode,
          sessionId: spec.sessionId,
          agentName: spec.agentName ?? "",
          channelId: spec.channelId,
          bridgeUrl: spec.bridgeUrl,
          bridgePort: bridgePortOf(spec.bridgeUrl),
          cwd: cwdFor(spec),
          codexBin,
          bunBin: deps().bunBin,
          claudestraHome: deps().repoRoot,
          purpose: spec.purpose,
          projectContext: spec.projectContext,
          model: spec.model,
          effort: spec.effort,
          permissionMode: spec.permissionMode,
        },
        channelRules(),
      );
    },

    /**
     * 清就绪标记（channel-server 一注册成功就写 "1"，清晚了会把真就绪抹掉）+ 解析 codex
     * 路径（buildLaunchCommand 是同步的）+ 给 pane 拍基线（复用窗口时旧文字不算数）。
     */
    async beforeLaunch(win: WindowOps) {
      const ok = await win.setOption(CODEX_READY_OPTION, "0");
      if (!ok) console.error(`⚠ 清不掉 ${win.name} 的 ${CODEX_READY_OPTION}（复用窗口时可能误判就绪）`);
      await ensureBin();
      const pane = await win.capture(200).catch(() => "");
      paneBaselines.set(win.target, {
        occupied: countMatches(pane, OCCUPIED_RE),
        dialog: countMatches(pane, BLOCKING_DIALOG_RE),
      });
    },

    async waitReady(win: WindowOps, budget): Promise<ReadyResult> {
      const base = paneBaselines.get(win.target) ?? { occupied: 0, dialog: 0 };
      try {
        for (let i = 0; i < budget.rounds; i++) {
          if ((await win.getOption(CODEX_READY_OPTION)) === "1") return { ready: true };
          const pane = await win.capture(200).catch(() => "");
          if (countMatches(pane, OCCUPIED_RE) > base.occupied) {
            return { ready: false, reason: "occupied", detail: matchedLine(pane, OCCUPIED_RE) };
          }
          if (countMatches(pane, BLOCKING_DIALOG_RE) > base.dialog) {
            return { ready: false, reason: "blocked-dialog", detail: matchedLine(pane, BLOCKING_DIALOG_RE) };
          }
          // 窗口回到 shell = codex 已退出（参数错、登录过期……），不必等满预算
          if (i > 4 && isAtShell(pane.split("\n").filter((l) => l.trim()).slice(-3).join("\n"))) {
            return { ready: false, reason: "exited", detail: pane.split("\n").filter((l) => l.trim()).slice(-4).join(" | ").slice(0, 300) };
          }
          await win.sleep(budget.pollMs);
        }
        return { ready: false, reason: "timeout" };
      } finally {
        paneBaselines.delete(win.target);
      }
    },

    // Codex 的 /quit 直接回 shell，没有 CC 那套收尾弹窗（等不到回 shell 由 gracefulExit 强杀兜底）

    /**
     * fork / 轮转后真实的线程 id：pane 的直接子进程（原生 codex）持有的
     * `~/.codex/thread-writer-locks/<sid>.lock`，排除源 id。锁在 TUI 起来约 1s 内出现。
     */
    async discoverSessionId(ctx: DiscoverContext) {
      const d = deps();
      const deadline = d.now() + (ctx.timeoutMs ?? 20_000);
      for (;;) {
        for (const pid of await d.childPids(ctx.windowName).catch(() => [] as number[])) {
          const held = (await d.heldThreadIds(pid).catch(() => [] as string[])).filter((s) => s !== ctx.exclude);
          if (held.length === 1) return { sessionId: held[0], via: "thread-writer-lock" };
        }
        if (d.now() >= deadline) return null;
        await Bun.sleep(500);
      }
    },

    registryFields: () => ({ runtime: "codex" }),
  };
  return adapter;
}

export const codexAdapter = createCodexAdapter();

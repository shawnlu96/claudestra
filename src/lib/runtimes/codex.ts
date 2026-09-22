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
 * 外部动作全经 CodexAdapterDeps 注入（codex-deps.ts），就绪判据在 codex-ready.ts。
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { channelInstructions } from "../channel-instructions.js";
import {
  bootstrapArgs,
  buildCodexCommand,
  codexPermissionFlags,
  parseBootstrapThreadId,
  probeCodexQueue,
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
import { bridgePortOf, defaultCodexDeps, type CodexAdapterDeps } from "./codex-deps.js";
import { codexExitPrelude, codexOnExitPane } from "./codex-exit.js";
import { CODEX_READY_OPTION, paneBaseline, waitCodexReady, type PaneBaseline } from "./codex-ready.js";
import { lastUserTextOf } from "./shared.js";
import type {
  AnyRecord,
  DiscoverContext,
  DiscoveredSession,
  LaunchSpec,
  ManagedRuntimeAdapter,
  RuntimeControl,
  SessionSourceAdapter,
  WindowOps,
} from "./types.js";

export { bridgePortOf, codexSessionCwdSync, defaultCodexDeps, type CodexAdapterDeps } from "./codex-deps.js";
export { BLOCKING_DIALOG_RE, CODEX_READY_OPTION, OCCUPIED_RE } from "./codex-ready.js";

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
  // 空闲时的 Esc 会挂上 backtrack、第二下打开回溯遮罩（codex-exit.ts）
  interruptOnlyWhenBusy: true,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVAILABILITY_TTL_MS = 5 * 60_000;

async function scanCodexSessions(search?: string): Promise<DiscoveredSession[]> {
  const root = codexSessionsRoot();
  if (!existsSync(root)) return [];
  const out: DiscoveredSession[] = [];
  for (const filePath of listCodexSessionFiles(root)) {
    const sessionId = codexSessionIdFromFilename(filePath.split("/").pop() || "");
    if (!sessionId) continue;
    const fileStat = await stat(filePath).catch(() => null); // 扫描期间被删 / 轮转：跳过这一个
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
}

/** 会话来源部分：只读，与生命周期状态无关 */
const codexSource: Omit<SessionSourceAdapter, "manageable"> = {
  id: "codex",
  label: "Codex",
  control: CODEX_CONTROL,
  scanSessions: scanCodexSessions,
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
};

type Availability = { ok: true } | { ok: false; hint: string };

/** 一个适配器实例的可变状态（codex 路径缓存、可用性缓存、pane 基线） */
interface CodexCtx {
  deps: CodexAdapterDeps;
  bin: string | null;
  avail: { at: number; result: Availability } | null;
  baselines: Map<string, PaneBaseline>;
}

async function ensureBin(ctx: CodexCtx): Promise<string> {
  if (ctx.bin) return ctx.bin;
  const found = await ctx.deps.resolveBin();
  if (!found) throw new Error("登录 shell 的 PATH 里找不到 codex（npm i -g @openai/codex，或用 CODEX_TUI_BIN 指定原生二进制）");
  ctx.bin = found;
  return found;
}

async function checkAvailable(ctx: CodexCtx): Promise<Availability> {
  const now = ctx.deps.now();
  if (ctx.avail && now - ctx.avail.at < AVAILABILITY_TTL_MS) return ctx.avail.result;
  let result: Availability;
  const found = await ctx.deps.resolveBin().catch(() => null); // 登录 shell 起不来：按「没找到」给提示
  if (!found) {
    result = {
      ok: false,
      hint: "登录 shell 的 PATH 里找不到 codex。装上它（npm i -g @openai/codex）并登录一次（codex login），或用 CODEX_TUI_BIN 指定原生二进制路径",
    };
  } else if (!(await probeCodexQueue(ctx.deps.run, found).catch(() => false))) { // 探测进程起不来 = 当作不支持
    result = {
      ok: false,
      hint: `${found} 没有 \`codex queue\` 子命令（版本太旧）：Claudestra 靠它往会话里投消息。升级：npm i -g @openai/codex@latest`,
    };
  } else {
    ctx.bin = found;
    result = { ok: true };
  }
  ctx.avail = { at: now, result };
  return result;
}

/**
 * new：跑一轮 exec 引导拿 thread id。引导**不挂** claudestra MCP / hooks（挂了会抢注
 * 频道、多报一次 Stop）；职责与频道规则经 developer_instructions 在这一轮写进线程。
 * resume / fork：会话已存在，原样返回。
 */
async function prepare(ctx: CodexCtx, spec: LaunchSpec): Promise<{ sessionId: string }> {
  codexPermissionFlags(spec.permissionMode); // 不支持的权限档位在这里就报错，不留半个会话
  if (spec.mode !== "new") return { sessionId: spec.sessionId };
  const cwd = spec.cwd;
  if (!cwd) throw new Error("Codex 新建会话需要工作目录（LaunchSpec.cwd）");
  const argv = bootstrapArgs({
    codexBin: await ensureBin(ctx),
    cwd,
    agentName: spec.agentName,
    purpose: spec.purpose,
    projectContext: spec.projectContext,
    model: spec.model,
    effort: spec.effort,
    permissionMode: spec.permissionMode,
    channelRules: channelInstructions(ctx.deps.repoRoot),
  });
  const r = await ctx.deps.execBootstrap(argv, cwd);
  const sid = parseBootstrapThreadId(r.out);
  if (sid) return { sessionId: sid };
  const tail = (r.err || r.out || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400);
  throw new Error(`Codex exec 引导没拿到 thread id（exit ${r.code}）：${tail || "无输出"}`);
}

function launchCommand(ctx: CodexCtx, spec: LaunchSpec): string {
  const codexBin = ctx.bin || process.env.CODEX_TUI_BIN?.trim();
  if (!codexBin) throw new Error("codex 路径尚未解析（应先经 available() / beforeLaunch）");
  const cwd = spec.cwd || ctx.deps.sessionCwd(spec.sessionId);
  if (!cwd) throw new Error(`Codex 启动需要工作目录：会话 ${spec.sessionId.slice(0, 8)} 的 rollout 找不到 cwd`);
  return buildCodexCommand(
    {
      mode: spec.mode,
      sessionId: spec.sessionId,
      agentName: spec.agentName ?? "",
      channelId: spec.channelId,
      bridgeUrl: spec.bridgeUrl,
      bridgePort: bridgePortOf(spec.bridgeUrl),
      cwd,
      codexBin,
      bunBin: ctx.deps.bunBin,
      claudestraHome: ctx.deps.repoRoot,
      purpose: spec.purpose,
      projectContext: spec.projectContext,
      model: spec.model,
      effort: spec.effort,
      permissionMode: spec.permissionMode,
    },
    channelInstructions(ctx.deps.repoRoot),
  );
}

/**
 * 清就绪标记（channel-server 一注册成功就写 "1"，清晚了会把真就绪抹掉）+ 解析 codex
 * 路径（buildLaunchCommand 是同步的）+ 给 pane 拍基线（复用窗口时旧文字不算数）。
 */
async function beforeLaunch(ctx: CodexCtx, win: WindowOps): Promise<void> {
  const ok = await win.setOption(CODEX_READY_OPTION, "0");
  if (!ok) console.error(`⚠ 清不掉 ${win.name} 的 ${CODEX_READY_OPTION}（复用窗口时可能误判就绪）`);
  await ensureBin(ctx);
  const pane = await win.capture(200).catch(() => ""); // 截不到屏就以空基线起步，最多多报一次旧文字
  ctx.baselines.set(win.target, paneBaseline(pane));
}

/**
 * fork / 轮转后真实的线程 id：pane 的直接子进程（原生 codex）持有的
 * `~/.codex/thread-writer-locks/<sid>.lock`，排除源 id。锁在 TUI 起来约 1s 内出现。
 */
async function discover(ctx: CodexCtx, d: DiscoverContext): Promise<{ sessionId: string; via: string } | null> {
  const deadline = ctx.deps.now() + (d.timeoutMs ?? 20_000);
  for (;;) {
    const pids = await ctx.deps.childPids(d.windowName).catch(() => [] as number[]); // 窗口刚起、查不到就下一轮
    for (const pid of pids) {
      const locks = await ctx.deps.heldThreadIds(pid).catch(() => [] as string[]); // lsof 失败按无锁，下一轮重查
      // 锁文件名来自文件系统，不是我们写的：不像线程 id 的一律不认，免得写进 registry
      const held = locks.filter((s) => s !== d.exclude && UUID_RE.test(s));
      if (held.length === 1) return { sessionId: held[0], via: "thread-writer-lock" };
    }
    if (ctx.deps.now() >= deadline) return null;
    await Bun.sleep(500);
  }
}

export type CodexAdapter = ManagedRuntimeAdapter & {
  /** 测试 / e2e 用：当前缓存的 codex 路径 */
  readonly binPath: () => string | null;
};

export function createCodexAdapter(overrides: Partial<CodexAdapterDeps> = {}): CodexAdapter {
  let ctxCache: CodexCtx | null = null;
  // 默认依赖惰性构造：模块加载时不碰 tmux / 登录 shell
  const ctx = (): CodexCtx =>
    (ctxCache ??= { deps: { ...defaultCodexDeps(), ...overrides }, bin: null, avail: null, baselines: new Map() });
  return {
    ...codexSource,
    manageable: true,
    control: CODEX_CONTROL,
    inbound: "codex-queue",
    turnEnd: "codex-hooks",
    exitCommand: "/quit",
    noteTag: "codex",
    binPath: () => ctx().bin,
    isValidSessionId: (id) => UUID_RE.test(id),
    available: () => checkAvailable(ctx()),
    prepareSession: (spec) => prepare(ctx(), spec),
    buildLaunchCommand: (spec) => launchCommand(ctx(), spec),
    beforeLaunch: (win) => beforeLaunch(ctx(), win),
    async waitReady(win, budget) {
      const c = ctx();
      try {
        return await waitCodexReady(win, budget, c.baselines.get(win.target) ?? { occupied: 0, dialog: 0 });
      } finally {
        c.baselines.delete(win.target);
      }
    },
    // 清场绝不连发 Esc（backtrack 手势，见 codex-exit.ts）；/quit 直接回 shell，没有 CC 那套收尾弹窗
    exitPrelude: codexExitPrelude,
    onExitPane: codexOnExitPane,
    discoverSessionId: (d) => discover(ctx(), d),
    registryFields: () => ({ runtime: "codex" }),
  };
}

export const codexAdapter = createCodexAdapter();

/**
 * Pi 适配器。
 *
 * 会话来源：文件名带时间戳前缀 ⇒ 路径推不出来，只能扫目录（见各方法注释）。
 * 生命周期：就绪判据是扩展写的 tmux 标记 @claudestra_ready，不认 pane 文案——
 * Pi 的 TUI 随版本变，这个标记是我们自己写的。
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { piAvailable, type PiEnvProfile } from "../pi-env.js";
import { buildPiCommand, type PiLaunchOptions } from "../pi-launch.js";
import { isAtShell, PI_READY_OPTION } from "../tmux-helper.js";
import {
  findPiSessionBySessionId,
  listPiSessionJsonls,
  piAgentDir,
  piLineToClaudeShape,
  piSessionIdFromFilename,
  piSessionPath,
} from "../pi-session.js";
import { lastUserTextOf } from "./shared.js";
import type {
  AnyRecord,
  DiscoveredSession,
  LaunchSpec,
  ManagedRuntimeAdapter,
  RuntimeControl,
  WindowOps,
} from "./types.js";

export const PI_CONTROL: RuntimeControl = {
  interruptKeys: ["C-c"],
  // 扩展能把回合中到达的消息 steer 进去；C-c 反而把干到一半的回合掐了
  preemptOnHumanMessage: false,
  // Pi 的 TUI 没有 CC 的 ❯ / 横幅，pane 判据恒判「忙」；忙闲只信扩展上报的回合结束
  idleSource: "hook",
  // Pi 的 --model 是启动期权威值，/model 在 Pi 里是另一套 slash 语义
  modelEnforcement: "launch-flag",
  // paneShowsCompacting 等 CC 文案在 Pi 窗口上会误命中
  paneHeuristics: false,
};

/** LaunchSpec → buildPiCommand 的选项。Pi 的 --session-id 是 open-or-create，三种 mode 同一条命令 */
export function piLaunchOptions(spec: LaunchSpec): PiLaunchOptions {
  return {
    channelId: spec.channelId,
    bridgeUrl: spec.bridgeUrl,
    sessionId: spec.sessionId,
    agentName: spec.agentName,
    purpose: spec.purpose,
    projectContext: spec.projectContext,
    model: spec.model,
    effort: spec.effort,
    piEnv: spec.extras?.piEnv as PiEnvProfile | undefined,
  };
}

export const piAdapter: ManagedRuntimeAdapter = {
  id: "pi",
  label: "Pi",
  manageable: true,
  control: PI_CONTROL,
  inbound: "pi-extension",
  turnEnd: "pi-extension",
  exitCommand: "/quit",
  noteTag: "pi",

  async scanSessions(search?: string): Promise<DiscoveredSession[]> {
    const root = join(piAgentDir(), "sessions");
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];
    for (const dir of await readdir(root).catch(() => [] as string[])) {
      if (!dir.startsWith("--")) continue; // 目录名是 cwd 的编码
      const dirPath = join(root, dir);
      for (const file of await readdir(dirPath).catch(() => [] as string[])) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = piSessionIdFromFilename(file);
        if (!sessionId) continue;
        const filePath = join(dirPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        // cwd 只能从 header 行读（目录编码把 `/` 换成 `-`，不可逆）
        let cwd = "";
        try {
          const head = await Bun.file(filePath).slice(0, 4096).text();
          for (const line of head.split("\n")) {
            if (!line.includes('"cwd"')) continue;
            const obj = JSON.parse(line);
            if (obj?.type === "session" && typeof obj.cwd === "string") { cwd = obj.cwd; break; }
          }
        } catch { /* non-critical */ }
        if (!cwd) continue;
        if (search && !`${cwd} ${sessionId}`.toLowerCase().includes(search.toLowerCase())) continue;

        out.push({
          sessionId,
          cwd,
          slug: cwd.split("/").filter(Boolean).pop() || "",
          modifiedAt: fileStat.mtime,
          lastUserMessage: await lastUserTextOf(filePath, fileStat.size, piLineToClaudeShape),
          runtime: "pi",
        });
      }
    }
    return out;
  },

  sessionPath: (cwd, sessionId) => piSessionPath(cwd, sessionId),
  findSessionById: (sessionId) => findPiSessionBySessionId(sessionId),
  listSessionsForCwd: (cwd) => listPiSessionJsonls(cwd),
  ownsPath: (path) => path.includes(`${piAgentDir()}/sessions/`),
  sessionIdFromPath: (path) => piSessionIdFromFilename(basename(path)),
  /** Pi 的首行恒为 `{type:"session", version:<number>}` */
  sniffFirstLine: (rec) => rec?.type === "session" && typeof rec?.version === "number",
  translateLine: (line): AnyRecord | null => piLineToClaudeShape(line),

  // ── 生命周期 ──

  /** 会话 id 是我们自造的（--session-id 收任意合法 id），不要求 UUID */
  isValidSessionId: (id) => id.length > 0,

  /** 没装 Pi 的机器上不该建出「看着建好了、其实起不来」的 agent */
  async available() {
    return (await piAvailable())
      ? { ok: true }
      : { ok: false, hint: "这台机器上没有找到 pi 可执行文件（可用 PI_BIN 指定路径，或省掉 --runtime 用默认的 Claude Code）" };
  },

  buildLaunchCommand: (spec) => buildPiCommand(piLaunchOptions(spec)),

  /**
   * 清零必须在发启动命令之前：扩展一注册成功就写 "1"，清晚了会把真就绪抹掉 →
   * 假「启动超时」→ create 把健康的 agent 清掉。复用窗口时旧标记也靠这里清。
   */
  async beforeLaunch(win: WindowOps) {
    const ok = await win.setOption(PI_READY_OPTION, "0");
    if (!ok) console.error(`⚠ 清不掉 ${win.name} 的 ${PI_READY_OPTION}（复用窗口时可能误判就绪）`);
  },

  async waitReady(win: WindowOps, budget) {
    for (let i = 0; i < budget.rounds; i++) {
      if ((await win.getOption(PI_READY_OPTION)) === "1") return { ready: true };
      // 窗口回到 shell = pi 进程已退出，不必等满预算
      if (i > 4 && isAtShell(await win.capture(3).catch(() => ""))) return { ready: false, reason: "exited" };
      await win.sleep(budget.pollMs);
    }
    return { ready: false, reason: "timeout" };
  },

  // 退出就是退出，没有 CC 那套收尾弹窗（等不到回 shell 由 gracefulExit 强杀兜底）

  registryFields(spec) {
    const piEnv = spec.extras?.piEnv;
    return { runtime: "pi", ...(piEnv ? { piEnv } : {}) };
  },
};

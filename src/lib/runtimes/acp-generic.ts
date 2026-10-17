/**
 * 只走 ACP 的新运行时用的通用 ACP 段：给会话来源 + 宿主描述 + 就绪闸，拼出 AcpRuntimeSpec（生命周期适配器按 ACP 共同约定：
 * 窗口里跑 src/acp-host.ts、就绪标记 @claudestra_ready、退出给宿主 SIGTERM、registry 记 transport=acp）。
 * Codex / Pi 有各自的历史包袱（引导轮、能力档、tmux 回退），仍用 codex-acp.ts / pi-acp.ts 的专用适配器。
 * 怎么用见 docs/runtimes/adding-a-runtime.md；tests/runtime-contract-fake.test.ts 用它注册假运行时走整条链。
 */
import { join } from "node:path";
import { acpLogDir } from "../log-paths.js";
import { REPO_ROOT } from "../repo-root.js";
import { spawnAdapter } from "../acp/adapter-proc.js";
import { AcpSession } from "../acp/session.js";
import { ACP_CONTROL, acpExitPrelude } from "./acp-control.js";
import { CODEX_READY_OPTION, waitCodexReady } from "./codex-ready.js";
import { acpHostCommand, rolePayload, waitReadyAndSettle, type writeLaunchPayload } from "./acp-launch-payload.js";
import { ACP_RUNTIME_ENV, type AcpRuntimeSpec } from "./contract.js";
import { resetReadyOption } from "./ready-option.js";
import type { LaunchSpec, ManagedRuntimeAdapter, SessionSourceAdapter } from "./types.js";

export interface GenericAcpDef extends Pick<AcpRuntimeSpec, "host" | "ready" | "agentProblem" | "catalogProbe"> {
  /** 历史 / 会话列表从哪读（只读来源即可，manageable 由这里补成 true） */
  source: SessionSourceAdapter;
  isValidSessionId(id: string): boolean;
  /** 启动命令里再加的环境变量（宿主 / 适配器读）；值为空的不出现 */
  launchEnv?(spec: LaunchSpec): [string, string | undefined][];
}

/** 宿主启动命令：环境变量前缀 + bun acp-host.ts（窗口的 cwd 就是会话的 cwd）。纯函数，单测逐字钉住 */
function genericAcpHostCommand(
  spec: LaunchSpec, def: GenericAcpDef, o: { bunBin: string; repoRoot: string; env?: Record<string, string | undefined>; writePayload?: typeof writeLaunchPayload },
): string {
  const env = o.env ?? process.env;
  const agent = spec.agentName || spec.settingsName;
  if (!agent) throw new Error("ACP 宿主需要 agent 名（LaunchSpec.agentName / settingsName）");
  if (!spec.sessionId) throw new Error("ACP 宿主需要会话 id");
  const who = { agentName: agent, purpose: spec.purpose, projectContext: spec.projectContext };
  const pairs: [string, string | undefined][] = [
    ["DISCORD_CHANNEL_ID", spec.channelId],
    ["BRIDGE_URL", spec.bridgeUrl],
    ["CLAUDESTRA_AGENT", agent],
    ["CLAUDESTRA_SESSION_ID", spec.sessionId],
    ["MCP_NAME", env.MCP_NAME || "claudestra"],
    [ACP_RUNTIME_ENV, def.host.id],
    ["CLAUDESTRA_ACP_MODEL", spec.model],
    ["CLAUDESTRA_ACP_EFFORT", spec.effort],
    ...(def.launchEnv?.(spec) ?? []),
  ];
  // 职责与频道规则进一次性文件、命令只带路径（acp-launch-payload.ts：命令太长会被 tty 截断）
  return acpHostCommand({
    pairs, payload: rolePayload(who, o.repoRoot, spec.mode), agent, writePayload: o.writePayload, callerCredFile: spec.callerCredFile, env, bunBin: o.bunBin, repoRoot: o.repoRoot,
  });
}

const OPEN_TIMEOUT_MS = 120_000;

/**
 * new / fork 先起一个短命适配器（不挂 claudestra MCP）把会话建出来，返回服务端给的 id；常驻宿主再按这个 id 接上。
 * 不能沿用 manager 随手生成的 UUID：严格的 ACP 服务端只认自己 session/new 出来的会话，load 一个没建过的 id 直接报不存在。
 */
async function openSession(spec: LaunchSpec, def: GenericAcpDef, spawn: typeof spawnAdapter): Promise<string> {
  if (!spec.cwd) throw new Error(`${def.host.label}（ACP）新建会话需要工作目录（LaunchSpec.cwd）`);
  // 和常驻宿主同一份有效启动环境（宿主拿到的是启动命令里的 launchEnv）：会话目录 / HOME 靠环境指定的运行时，建和载必须在同一个存储
  const env: Record<string, string | undefined> = { ...process.env, ...Object.fromEntries((def.launchEnv?.(spec) ?? []).filter(([, v]) => v)) };
  const agent = def.host.agentCommand(env, process.execPath, false);
  if ("error" in agent) throw new Error(agent.error);
  const envSpec = {
    base: env, bunBin: process.execPath, channelServer: join(REPO_ROOT, "src/channel-server.ts"),
    mcpName: env.MCP_NAME || "claudestra", logsDir: acpLogDir("bootstrap"),
  };
  const logs: string[] = [];
  const proc = spawn(agent.cmd, def.host.adapterEnv(envSpec), spec.cwd, (m) => logs.push(m), def.host.logLabel);
  const s = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: (m) => logs.push(m) }, def.host.mcpServers(envSpec));
  const timer = setTimeout(() => proc.stop(), OPEN_TIMEOUT_MS);
  try {
    await s.initialize({ fork: spec.mode === "fork" }); // 缺 fork 能力在这里就抛（lib/acp/protocol.ts）
    return spec.mode === "fork" ? await s.fork(spec.sessionId, spec.cwd) : await s.create(spec.cwd);
  } catch (e) {
    throw new Error(`${def.host.label}（ACP）没建出会话：${e instanceof Error ? e.message : e}${logs.length ? `（${logs.slice(-3).join(" | ").slice(0, 300)}）` : ""}`);
  } finally {
    clearTimeout(timer);
    proc.stop();
  }
}

/** deps.spawn 只给测试注入（内存线路的严格 ACP 服务端） */
export function genericAcpRuntime(def: GenericAcpDef, deps: { spawn?: typeof spawnAdapter } = {}): AcpRuntimeSpec {
  const managed: ManagedRuntimeAdapter = {
    ...def.source,
    manageable: true,
    control: ACP_CONTROL,
    inbound: "acp-host",
    turnEnd: "acp-host",
    exitCommand: "",
    noteTag: def.source.id,
    callerCred: "env",
    isValidSessionId: def.isValidSessionId,
    async available() {
      const r = await def.ready(false, {});
      return r.ok ? { ok: true } : { ok: false, hint: r.reason };
    },
    async prepareSession(spec) {
      return { sessionId: spec.mode === "resume" ? spec.sessionId : await openSession(spec, def, deps.spawn ?? spawnAdapter) };
    },
    buildLaunchCommand: (spec) => genericAcpHostCommand(spec, def, { bunBin: process.execPath, repoRoot: REPO_ROOT }), // manager 自己的 bun
    beforeLaunch: (win) => resetReadyOption(win, CODEX_READY_OPTION), // 清不掉就抛：不带着残留的 "1" 往下启动
    waitReady: (win, budget) => waitReadyAndSettle(win, () => waitCodexReady(win, budget, { occupied: 0, dialog: 0 })),
    exitPrelude: acpExitPrelude,
    registryFields: () => ({ runtime: def.source.id, transport: "acp" }),
  };
  return { managed, host: def.host, ready: def.ready, agentProblem: def.agentProblem, catalogProbe: def.catalogProbe };
}

/**
 * Codex 的 ACP 版适配器（transport=acp，T60）：会话来源部分和 tmux 版完全一样（rollout 照写，历史 / 归档 / 用量照读），
 * 生命周期换成「窗口里跑 ACP 宿主」（src/acp-host.ts）：
 * - new：和 tmux 下 exec 引导同一个坑——新线程在第一轮之前不落盘，所以这里起一个短命的适配器，session/new 后跑一轮
 *   `[claudestra:bootstrap]`（历史翻译整轮丢掉），职责与频道规则经 developer_instructions 在这一轮写进线程，拿到 thread id；
 * - resume / restart：宿主接上 registry 里的 thread id（有 session/resume 用它，不回放历史），首条入站附职责前言；
 * - fork：试点不支持，直接拒（先切回 tmux）；
 * - 就绪：宿主在 bridge 登记好、接上线程之后写 @claudestra_ready=1（与 channel-server / Pi 同一个标记）；
 * - 退出：C-c 给宿主（它收尾关掉适配器，app-server 跟着走），回到 shell。
 * 选用见 runtimes/index.ts managedFor(runtime, transport)。docs/runtimes/codex-acp.md；tests/codex-acp-adapter.test.ts。
 */
import { join } from "node:path";
import { channelInstructions } from "../channel-instructions.js";
import { shellEscape } from "../claude-launch.js";
import { BOOTSTRAP_PROMPT, codexContextPreamble, codexDeveloperInstructions, codexEffort, codexModel } from "../codex-launch.js";
import { encodePreambleEnv } from "../codex-thread.js";
import { pathOverrideAssignments, statePath } from "../paths.js";
import { isSandbox, SANDBOX_ROOT_ENV } from "../sandbox.js";
import { acpAgentCommand, adapterEnv, spawnAdapter } from "../acp/adapter-proc.js";
import { ACP_AGENT_ENV, sandboxAcpHome } from "../acp/stub.js";
import { AcpSession } from "../acp/session.js";
import { CODEX_ACP_CONTROL } from "./codex-control.js";
import { defaultCodexDeps, type CodexAdapterDeps } from "./codex-deps.js";
import { CODEX_READY_OPTION, waitCodexReady } from "./codex-ready.js";
import { codexSource, isValidCodexSessionId } from "./codex-source.js";
import type { LaunchSpec, ManagedRuntimeAdapter, WindowOps } from "./types.js";

const BOOTSTRAP_TIMEOUT_MS = 180_000;
const EXIT_POLL_ROUNDS = 20;
const mcpName = () => process.env.MCP_NAME || "claudestra";

/** 启动命令：环境变量前缀 + bun acp-host.ts（窗口的 cwd 就是会话的 cwd）。纯函数，单测逐字钉住 */
export function buildAcpHostCommand(spec: LaunchSpec, o: { bunBin: string; repoRoot: string; codexBin?: string; env?: Record<string, string | undefined> }): string {
  const agent = spec.agentName || spec.settingsName;
  if (!agent) throw new Error("ACP 宿主需要 agent 名（LaunchSpec.agentName / settingsName）");
  if (!spec.sessionId) throw new Error("ACP 宿主需要 thread id（new 先经 prepareSession 引导）");
  const env = o.env ?? process.env;
  const sandbox = isSandbox(env);
  const pairs: [string, string | undefined][] = [
    ["DISCORD_CHANNEL_ID", spec.channelId],
    ["BRIDGE_URL", spec.bridgeUrl],
    ["CLAUDESTRA_AGENT", agent],
    ["CLAUDESTRA_SESSION_ID", spec.sessionId],
    ["MCP_NAME", mcpName()],
    ["CLAUDESTRA_CODEX_BIN", o.codexBin],
    ["CLAUDESTRA_ACP_MODEL", codexModel(spec.model) ?? undefined],
    ["CLAUDESTRA_ACP_EFFORT", codexEffort(spec.effort) ?? undefined],
    // 重启 / 收编：developer_instructions 只在建线程那一轮生效，首条入站附前言（与 tmux 同一份文字）
    ["CLAUDESTRA_CODEX_PREAMBLE", spec.mode === "new" ? undefined : encodePreambleEnv(codexContextPreamble({ agentName: agent, purpose: spec.purpose, projectContext: spec.projectContext }))],
    // 沙箱外的手工覆盖（单测 / 排查）照带；沙箱里不带：适配器固定是本仓 stub，宿主这条链的 HOME 挪进沙箱根（lib/acp/stub.ts）
    [ACP_AGENT_ENV, sandbox ? undefined : env[ACP_AGENT_ENV]?.trim() || undefined],
    ...(sandbox ? Object.entries(sandboxAcpHome(env[SANDBOX_ROOT_ENV])) : []),
  ];
  const prefix = pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${shellEscape(v!)}`).join(" ");
  return `${prefix}${pathOverrideAssignments(shellEscape, env)} ${shellEscape(o.bunBin)} ${shellEscape(join(o.repoRoot, "src/acp-host.ts"))}`;
}

/** create 的引导：起一个短命的适配器，新建线程并跑一轮，返回 thread id（不挂 claudestra MCP，频道相关的环境变量全清掉） */
async function bootstrapThread(spec: LaunchSpec, deps: CodexAdapterDeps): Promise<string> {
  if (!spec.cwd) throw new Error("Codex（ACP）新建会话需要工作目录（LaunchSpec.cwd）");
  const agent = acpAgentCommand(process.env, deps.bunBin);
  if ("error" in agent) throw new Error(agent.error);
  const codexPath = agent.stub ? undefined : ((await deps.resolveBin()) ?? undefined);
  const developerInstructions = codexDeveloperInstructions({
    agentName: spec.agentName, purpose: spec.purpose, projectContext: spec.projectContext, channelRules: channelInstructions(deps.repoRoot),
  });
  const env = adapterEnv({
    base: process.env, bunBin: deps.bunBin, channelServer: join(deps.repoRoot, "src/channel-server.ts"), mcpName: mcpName(),
    codexPath, logsDir: statePath("logs", "acp", "bootstrap"), developerInstructions,
  });
  const logs: string[] = [];
  const proc = spawnAdapter(agent.cmd, env, spec.cwd, (m) => logs.push(m));
  const s = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: (m) => logs.push(m) });
  const timer = setTimeout(() => proc.stop(), BOOTSTRAP_TIMEOUT_MS);
  try {
    await s.initialize();
    const sid = await s.create(spec.cwd);
    for (const [id, v] of [["model", codexModel(spec.model)], ["reasoning_effort", codexEffort(spec.effort)]] as const) if (v) await s.setConfig(id, v);
    const r = await s.prompt(BOOTSTRAP_PROMPT);
    if (r.kind === "failed") throw new Error(`引导轮失败：${r.failure.message}`);
    return sid;
  } catch (e) {
    throw new Error(`Codex（ACP）引导没拿到 thread id：${e instanceof Error ? e.message : e}${logs.length ? `（${logs.slice(-3).join(" | ").slice(0, 300)}）` : ""}`);
  } finally {
    clearTimeout(timer);
    proc.stop();
  }
}

/** 退出：C-c 给宿主（它收尾关掉适配器），等窗口里没有子进程 = 回到 shell */
async function acpExitPrelude(win: WindowOps): Promise<"at-shell" | "continue"> {
  await win.sendKey("C-c");
  for (let i = 0; i < EXIT_POLL_ROUNDS; i++) {
    await win.sleep(250);
    if ((await win.childPids().catch(() => [1])).length === 0) return "at-shell"; // 查不到子进程按「还在」算，接着等
  }
  return "continue";
}

function createCodexAcpAdapter(overrides: Partial<CodexAdapterDeps> = {}): ManagedRuntimeAdapter {
  let depsCache: CodexAdapterDeps | null = null;
  const deps = () => (depsCache ??= { ...defaultCodexDeps(), ...overrides });
  let bin: string | null = null;
  return {
    ...codexSource,
    manageable: true,
    control: CODEX_ACP_CONTROL,
    acp: { control: CODEX_ACP_CONTROL },
    inbound: "acp-host",
    turnEnd: "acp-host",
    exitCommand: "",
    noteTag: "codex",
    isValidSessionId: isValidCodexSessionId,
    async available() {
      const agent = acpAgentCommand(process.env, deps().bunBin);
      if ("error" in agent) return { ok: false, hint: agent.error };
      if (agent.stub) return { ok: true };
      const found = await deps().resolveBin().catch(() => null); // 登录 shell 起不来按「没找到」给提示：这里只决定要不要早败
      return found ? { ok: true } : { ok: false, hint: "登录 shell 的 PATH 里找不到 codex（ACP 适配器用 CODEX_PATH 锁本机的 codex）" };
    },
    async prepareSession(spec) {
      if (spec.mode === "fork") throw new Error("ACP 试点不支持 fork：先切回 tmux（manager transport <agent> tmux）再 fork");
      return { sessionId: spec.mode === "new" ? await bootstrapThread(spec, deps()) : spec.sessionId };
    },
    buildLaunchCommand: (spec) => buildAcpHostCommand(spec, { bunBin: deps().bunBin, repoRoot: deps().repoRoot, codexBin: bin ?? undefined }),
    async beforeLaunch(win) {
      if (!(await win.setOption(CODEX_READY_OPTION, "0"))) console.error(`⚠ 清不掉 ${win.name} 的 ${CODEX_READY_OPTION}（复用窗口时可能误判就绪）`);
      bin = await deps().resolveBin().catch(() => null); // stub 用不上；真适配器起不来时宿主自己报 CODEX_PATH 的错
    },
    waitReady: (win, budget) => waitCodexReady(win, budget, { occupied: 0, dialog: 0 }),
    exitPrelude: acpExitPrelude,
    onExitPane: undefined,
    discoverSessionId: undefined,
    registryFields: () => ({ runtime: "codex", transport: "acp" }),
  };
}

export const codexAcpAdapter = createCodexAcpAdapter();

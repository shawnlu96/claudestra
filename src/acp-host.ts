/**
 * ACP 宿主入口（T60，transport=acp 的 Codex agent）：在 agent 的 tmux 窗口里代替 `codex` 运行，窗口只显示这里打的可读日志
 * （owner 在这里打字不起作用）。逻辑都在 lib/acp/host.ts，这里只读环境变量、接真实依赖、处理信号。启动命令由
 * lib/runtimes/codex-acp.ts 生成；手动排障：`tmux -S … attach` 看这个窗口，适配器的详细日志在 APP_SERVER_LOGS。
 */
import { join } from "node:path";
import { resolveBunPath } from "./lib/bun-path.js";
import { resolveBridgeUrl } from "./lib/bridge-url.js";
import { decodePreambleEnv } from "./lib/codex-thread.js";
import { noteAcpCodexRunning } from "./lib/codex-version.js";
import { acpAgentCommand, spawnAdapter } from "./lib/acp/adapter-proc.js";
import { BridgeLink } from "./lib/acp/bridge-link.js";
import { AcpHost } from "./lib/acp/host.js";
import { startToolProxy } from "./lib/acp/tool-proxy.js";
import { statePath } from "./lib/paths.js";
import { SRC_DIR } from "./lib/repo-root.js";
import { CODEX_READY_OPTION } from "./lib/runtimes/codex-ready.js";
import { tmuxRaw } from "./lib/tmux-helper.js";

const log = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) {
    console.error(`❌ acp-host 缺环境变量 ${k}（应由 manager 的启动命令给出，见 lib/runtimes/codex-acp.ts）`);
    process.exit(2);
  }
  return v;
};

const channelId = need("DISCORD_CHANNEL_ID");
const agentName = need("CLAUDESTRA_AGENT");
const sessionId = need("CLAUDESTRA_SESSION_ID");
const bridgeUrl = resolveBridgeUrl();
const bunBin = resolveBunPath();
const agent = acpAgentCommand(process.env, bunBin);
if ("error" in agent) {
  console.error(`❌ ${agent.error}`);
  process.exit(3);
}
const codexPath = process.env.CLAUDESTRA_CODEX_BIN?.trim() || undefined;
/** 每次起适配器前记一次（含退避重起）：app-server 跑的是那一刻磁盘上的 codex，网页「重启生效」提示读这条记录 */
const warned = new Set<string>();
const noteCodex = async () => void (await noteAcpCodexRunning({ agent: agentName, codexPath: agent.stub ? undefined : codexPath, log, warned }));

const host = new AcpHost(
  {
    channelId,
    agentName,
    sessionId,
    cwd: process.cwd(),
    mcpName: process.env.MCP_NAME || "claudestra",
    preamble: decodePreambleEnv(process.env.CLAUDESTRA_CODEX_PREAMBLE),
    model: process.env.CLAUDESTRA_ACP_MODEL?.trim() || undefined,
    effort: process.env.CLAUDESTRA_ACP_EFFORT?.trim() || undefined,
    agentCmd: agent.cmd,
    env: {
      base: process.env,
      bunBin,
      channelServer: join(SRC_DIR, "channel-server.ts"),
      mcpName: process.env.MCP_NAME || "claudestra",
      codexPath: agent.stub ? undefined : codexPath,
      logsDir: statePath("logs", "acp", agentName),
    },
  },
  {
    spawn: (cmd, env, cwd) => spawnAdapter(cmd, env, cwd, log),
    beforeSpawn: noteCodex,
    makeLink: (deps) => new BridgeLink({ ...deps, url: bridgeUrl }),
    startProxy: (deps) => startToolProxy(deps),
    postHook: async (body) => {
      const res = await fetch(`${bridgeUrl.replace(/^ws/, "http").replace(/\/+$/, "")}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok && (res.headers.get("content-type") || "").includes("application/json") ? ((await res.json()) as { block?: boolean; reason?: string }) : {};
    },
    markReady: async () => {
      const pane = process.env.TMUX_PANE;
      if (pane) await tmuxRaw(["set-option", "-w", "-t", pane, CODEX_READY_OPTION, "1"]);
      log("✅ 就绪（manager 在等的 @claudestra_ready 已写）");
    },
    log,
  },
);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    log(`收到 ${sig}，收尾退出`);
    host.stop();
    setTimeout(() => process.exit(0), 1_500);
  });
}

log(`ACP 宿主启动：${agentName} · 线程 ${sessionId.slice(0, 8)} · ${agent.stub ? `stub（${agent.cmd.join(" ")}）` : "codex-acp"} · bridge ${bridgeUrl}`);
host.start();

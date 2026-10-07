/**
 * ACP 宿主入口（transport=acp 的 Codex / Pi agent）：在 agent 的 tmux 窗口里代替运行时的 TUI，窗口只显示可读的会话
 * （lib/acp/transcript.ts；只看，owner 在这里打字不起作用），连接 / 生命周期日志只写 host.log。
 * 逻辑都在 lib/acp/host.ts，按运行时不同的几处在 lib/acp/host-runtime.ts，这里只读环境变量、接真实依赖、处理信号。
 * 启动命令由 lib/runtimes/codex-acp.ts / pi-acp.ts 生成；排障：连接日志看 host.log，会话看这个窗口（`tmux -S … attach`）。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveBunPath } from "./lib/bun-path.js";
import { resolveBridgeUrl } from "./lib/bridge-url.js";
import { decodePreambleEnv } from "./lib/codex-thread.js";
import { noteAcpCodexRunning } from "./lib/codex-version.js";
import { pickCodexAdapter } from "./lib/acp/codex-compat.js";
import { spawnAdapter } from "./lib/acp/adapter-proc.js";
import { BridgeLink } from "./lib/acp/bridge-link.js";
import { AcpHost } from "./lib/acp/host.js";
import { ACP_RUNTIME_ENV, acpRuntime } from "./lib/acp/host-runtime.js";
import { startToolProxy } from "./lib/acp/tool-proxy.js";
import { stampTranscript } from "./lib/acp/transcript.js";
import { acpLogDir, appendLogLine } from "./lib/log-paths.js";
import { redactSecrets } from "./lib/redact-secrets.js";
import { SRC_DIR } from "./lib/repo-root.js";
import { runManagerProcess } from "./lib/run-manager.js";
import { readRegistryAgents } from "./lib/registry.js";
import { CLEAN_ENV_FLAG, makeWorkerRoot } from "./lib/runtimes/clean-env.js";
import { CODEX_READY_OPTION } from "./lib/runtimes/codex-ready.js";
import { tmuxRaw } from "./lib/tmux-helper.js";
import { takeCallerCred } from "./lib/caller-cred.js";

// T85 启动凭据：环境里只有一次性文件的路径，在起任何子进程之前读进内存、删文件、删变量（适配器环境拷的是 process.env，
// lib/acp/adapter-proc.ts adapterEnv）。宿主自己在 bridge 登记时出示，bridge 按它认这个 agent 的身份。
const callerCred = takeCallerCred(process.env);

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) {
    console.error(`❌ acp-host 缺环境变量 ${k}（应由 manager 的启动命令给出，见 lib/runtimes/codex-acp.ts / pi-acp.ts）`);
    process.exit(2);
  }
  return v;
};

const channelId = need("DISCORD_CHANNEL_ID");
const agentName = need("CLAUDESTRA_AGENT");
const sessionId = need("CLAUDESTRA_SESSION_ID");
const logsDir = acpLogDir(agentName);
const hostLogFile = join(logsDir, "host.log");
// 连接日志只落盘：窗口留给会话，日志进窗口会把会话淹掉；落盘也不怕窗口被 kill（出借 worker 自停的原因曾因此丢掉）
const log = (msg: string) => {
  // 写不进盘就退回窗口，别丢；日志里有适配器 stderr 原文，进窗口前脱敏（窗口有终端授权就能看）
  if (!appendLogLine(hostLogFile, `${new Date().toISOString()} ${msg}`)) console.log(`[${new Date().toTimeString().slice(0, 8)}] ${redactSecrets(msg)}`);
};
const show = (item: string) => console.log(stampTranscript(item));
const bridgeUrl = resolveBridgeUrl();
const bunBin = resolveBunPath();
// 出借 worker：codex 本体（和它的 shell）用专属状态 / 运行目录，宿主自己留生产目录给看门狗（runtimes/clean-env.ts workerPrivateDirs）
const workerRoot = process.env[CLEAN_ENV_FLAG] === "1" ? makeWorkerRoot() : undefined;
if (workerRoot) process.on("exit", () => rmSync(workerRoot, { recursive: true, force: true }));
let runtime: ReturnType<typeof acpRuntime>;
try {
  runtime = acpRuntime(process.env[ACP_RUNTIME_ENV]?.trim());
} catch (e) {
  console.error(`❌ ${(e as Error).message}`);
  process.exit(2);
}
const agent = runtime.agentCommand(process.env, bunBin, process.env[CLEAN_ENV_FLAG] === "1");
if ("error" in agent) {
  console.error(`❌ ${agent.error}`);
  process.exit(3);
}
const codexPath = process.env.CLAUDESTRA_CODEX_BIN?.trim() || undefined;
// 选了自研：起之前按协议判本机 codex（和 readiness 同一判据），判不过就用上游；起来后接不上线程再退一次（codex-compat-switch.ts）
const picked = runtime.id === "codex" ? pickCodexAdapter(agent, codexPath, log) : null;
if (picked && "error" in picked) {
  log(`❌ ${picked.error}`);
  console.error(`❌ ${picked.error}`);
  process.exit(3);
}
const pick = picked;
/** 每次起适配器前记一次（含退避重起）：app-server 跑的是那一刻磁盘上的 codex，网页「重启生效」提示读这条记录 */
const warned = new Set<string>();
const noteCodex = async () =>
  void (await noteAcpCodexRunning({ agent: agentName, codexPath: agent.stub ? undefined : codexPath, log, warned, adapter: pick?.adapter, hostPid: process.pid,
    selfRefused: agent.adapter === "self" && pick?.adapter === "upstream" }));

const host = new AcpHost(
  {
    channelId,
    agentName,
    sessionId,
    cwd: process.cwd(),
    mcpName: process.env.MCP_NAME || "claudestra",
    preamble: decodePreambleEnv(process.env.CLAUDESTRA_CODEX_PREAMBLE),
    clearPreamble: decodePreambleEnv(process.env.CLAUDESTRA_ACP_CLEAR_PREAMBLE),
    model: process.env.CLAUDESTRA_ACP_MODEL?.trim() || undefined,
    effort: process.env.CLAUDESTRA_ACP_EFFORT?.trim() || undefined,
    agentCmd: pick?.cmd ?? agent.cmd,
    runtime,
    env: {
      base: process.env,
      bunBin,
      channelServer: join(SRC_DIR, "channel-server.ts"),
      mcpName: process.env.MCP_NAME || "claudestra",
      codexPath: agent.stub ? undefined : codexPath,
      logsDir,
      developerInstructions: process.env.CLAUDESTRA_ACP_DEVELOPER ? Buffer.from(process.env.CLAUDESTRA_ACP_DEVELOPER, "base64").toString("utf8") : undefined,
      clean: process.env[CLEAN_ENV_FLAG] === "1", // 出借 worker：适配器只拿白名单环境、不挂 claudestra MCP（lib/runtimes/clean-env.ts）
      workerRoot,
    },
  },
  {
    spawn: (cmd, env, cwd) => spawnAdapter(cmd, env, cwd, log, runtime.logLabel),
    beforeSpawn: runtime.id === "codex" ? noteCodex : undefined, // Pi 的适配器在仓库里，没有要对账的外部版本
    fallback: pick ? (why, kind) => pick.fallback(why, kind) : undefined,
    makeLink: (deps) => new BridgeLink({ ...deps, url: bridgeUrl, registerFrame: () => ({ ...deps.registerFrame(), ...(callerCred ? { callerCred } : {}) }) }),
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
    rotateSession: async (oldId, newId) => {
      const r = await runManagerProcess(["set-session", agentName, newId, "--expected", oldId], {
        bunPath: bunBin, managerPath: join(SRC_DIR, "manager.ts"), env: process.env, timeoutMs: 30_000,
      });
      if (r.ok) return { ok: true };
      // manager 可能已经提交 registry 才丢回包；确认持久状态后再决定是否接回旧线程。
      const current = (await readRegistryAgents()).find((a) => a.name === agentName)?.sessionId;
      return current === newId ? { ok: true } : { ok: false, error: r.error ?? "registry 轮转失败" };
    },
    log,
    show,
  },
);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    log(`收到 ${sig}，收尾退出`);
    host.stop();
    setTimeout(() => process.exit(0), 1_500);
  });
}

// 切换适配器（manager codex-adapter）：空闲才退出、manager 随后按新开关重起；在跑就不动，切换记成 deferred（manager/acp-adapter.ts）
process.on("SIGUSR2", () => {
  if (!host.retireIfIdle()) return void log("收到切换请求（SIGUSR2）：回合在跑，不退出");
  log("收到切换请求（SIGUSR2）：空闲，退出让 manager 按新开关重起");
  setTimeout(() => process.exit(0), 1_500);
});

// 出借 worker（干净环境）：scheduler 服务挂了也要按租约自停——宿主自己定时看 journal（lib/lend-watchdog.ts）
if (process.env[CLEAN_ENV_FLAG] === "1") {
  const { lendWatchdog, WATCHDOG_EVERY_MS } = await import("./lib/lend-watchdog.js");
  const stopReason = lendWatchdog(agentName, log);
  setInterval(() => {
    const why = stopReason();
    if (!why) return;
    log(`出借 worker 自停：${why}`);
    host.stop();
    setTimeout(() => process.exit(0), 1_500);
  }, WATCHDOG_EVERY_MS);
}

const adapterName = agent.stub ? `stub（${agent.cmd.join(" ")}）` : pick?.adapter === "self" ? "自研 Codex 适配器" : runtime.logLabel;
log(`ACP 宿主启动：${agentName} · 线程 ${sessionId.slice(0, 8)} · ${adapterName} · bridge ${bridgeUrl.replace(/\?.*$/, "")}`); // 查询串里可能带 control_token，不进日志
show(`ACP 会话 ${agentName} · 线程 ${sessionId.slice(0, 8)}（只看；连接日志在 ${hostLogFile}）`);
host.start();

/**
 * 自研 Codex ACP 适配器的进程入口：stdin/stdout 对宿主说 ACP，子进程跑 `$CODEX_PATH app-server`（独立进程组）。
 * 用法和 Pi 适配器一样：`bun main.ts`，环境约定同 codex-acp（CODEX_PATH、INITIAL_AGENT_MODE、CODEX_CONFIG）；stdout 只走协议，日志走 stderr。
 * 环境不合格不退出：initialize 回 -32603 带 data.fatal，宿主固定一张卡、不再重起（B38）。生产不接入（host-runtime.ts 不选它），
 * 只能靠 CLAUDESTRA_ACP_AGENT 手工覆盖起。被 import 时什么都不做，只有直接运行才接管 stdio。
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEND_WORKER_MARK } from "../../runtimes/clean-env.js";
import { createRpcPeer, RpcError, type RpcWire } from "../rpc.js";
import { stdioWire } from "../stdio-wire.js";
import { spawnAppServer } from "./app-server.js";
import { createReconciler } from "./delivery.js";
import { ProcTree, survivorText } from "./proc-tree.js";
import { CodexAcpServer } from "./server.js";
import { parseAdapterEnv } from "./session-config.js";
import { createShutdown } from "./shutdown.js";

export const CODEX_ACP_ADAPTER_MAIN = fileURLToPath(import.meta.url);
/** 进程树标记（进 app-server 的公共环境，所有后代都带）与控制标记（只定向写进 MCP server 自己的 env） */
const TREE_ENV = "CLAUDESTRA_ACP_TREE";
const CONTROL_ENV = "CLAUDESTRA_ACP_CONTROL";

/** agentInfo.version：本目录源码的短哈希（组合身份里的适配器指纹由 PR-D 另算） */
function sourceHash(): string {
  const dir = dirname(CODEX_ACP_ADAPTER_MAIN);
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) h.update(`${f}\0`).update(readFileSync(join(dir, f))).update("\0");
  return h.digest("hex").slice(0, 12);
}

function refuseToStart(log: (msg: string) => void, why: string): void {
  log(`Codex 适配器拒绝启动：${why}`);
  const acp = createRpcPeer(stdioWire(log), { log });
  acp.onRequest("initialize", () => {
    throw new RpcError(-32603, `Codex 适配器拒绝启动：${why}`, { fatal: true });
  });
  acp.onClosed(() => process.exit(0));
}

function run(): void {
  const log = (msg: string) => void process.stderr.write(`${msg}\n`);
  const parsed = parseAdapterEnv(process.env);
  if (!parsed.ok) return refuseToStart(log, parsed.why);
  const id = randomUUID();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  let app: ReturnType<typeof spawnAppServer>;
  try {
    app = spawnAppServer({ codexPath: parsed.cfg.codexPath, env: { ...env, [TREE_ENV]: id }, cwd: process.cwd(), log });
  } catch (e) {
    return refuseToStart(log, `起不来 ${parsed.cfg.codexPath} app-server（${e instanceof Error ? e.message : e}）`);
  }
  const tree = new ProcTree({ rootPid: app.proc.pid ?? -1, treeMark: `${TREE_ENV}=${id}`, controlMark: `${CONTROL_ENV}=${id}`, clean: env[LEND_WORKER_MARK] === "1", log });
  const stopWatch = tree.watch();
  let server: CodexAcpServer | null = null;
  const shutdown = createShutdown({
    stop: () => (stopWatch(), server?.stop()),
    closeAppStdin: () => app.proc.stop(),
    appExited: app.proc.exited,
    tree,
    writeResults: (cause, tail) => server?.turns.failAll(cause, tail),
    report: (left) => log(`收尾报告：仍存活的相关进程 ${left.map(survivorText).join("；")}`),
    flush: () => new Promise((r) => process.stdout.write("", () => r())),
    exit: (code) => process.exit(code),
    log,
  });
  const wire: RpcWire = { ...stdioWire(log), close: (why) => shutdown({ kind: "protocol", why: `ACP 线路作废（${why}）` }) };
  server = new CodexAcpServer(wire, {
    app, cfg: parsed.cfg, log, fatal: (c) => shutdown(c), controlMark: [CONTROL_ENV, id],
    reconcile: createReconciler(app, log), onCommand: () => void tree.scan(), version: sourceHash(),
  });
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, () => shutdown({ kind: "stop", why: `收到 ${sig}` }, { signal: true }));
}

if (import.meta.main) run();

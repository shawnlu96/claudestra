/**
 * Pi 的 ACP 适配器进程入口：stdin/stdout 说 ACP（给宿主），子进程跑 `pi --mode rpc`。
 * 用法：`bun main.ts [能力档等 pi 参数…]`，这些参数原样排在 rpc / 挂 MCP / 会话 id 之前（args.ts）；pi 可执行文件按 PI_BIN 找。
 * stdout 只留给协议，日志一律走 stderr（宿主按行转进自己的日志）。
 * 起它的一方从这里 import 路径（PI_ACP_ADAPTER_MAIN）；被 import 时什么都不做，只有直接运行才接管 stdio。
 */
import { fileURLToPath } from "node:url";
import { spawnAdapter } from "../adapter-proc.js";
import type { RpcWire } from "../rpc.js";
import { piBinName } from "../../pi-env.js";
import { piRpcArgs } from "./args.js";
import { piMcpClash } from "./mcp-clash.js";
import { piLinkOver } from "./pi-link.js";
import { PiAcpServer } from "./server.js";

export const PI_ACP_ADAPTER_MAIN = fileURLToPath(import.meta.url);

function run(baseArgs: string[]): void {
  const log = (msg: string) => void process.stderr.write(`${msg}\n`);
  const wire: RpcWire = {
    write: (line) => void process.stdout.write(line),
    onData: (cb) => void process.stdin.on("data", cb),
    onClose: (cb) => void process.stdin.on("end", () => cb("stdin 关闭")),
    close: (why) => {
      log(`ACP 线路作废（${why}），退出`);
      process.exit(1);
    },
  };
  const env = process.env as Record<string, string>;
  new PiAcpServer(wire, {
    openPi: (o) => piLinkOver(spawnAdapter([piBinName(), ...piRpcArgs(o.sessionId, baseArgs)], { ...env, ...o.env }, o.cwd, log, "pi"), log),
    newSessionId: () => Bun.randomUUIDv7(),
    mcpClash: (names, cwd) => (names.length ? piMcpClash(names, cwd) : null),
    log,
    exit: (code) => process.exit(code),
  });
}

if (import.meta.main) run(process.argv.slice(2));

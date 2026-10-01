/**
 * Pi 的 ACP 适配器进程入口：stdin/stdout 说 ACP（给宿主），子进程跑 `pi --mode rpc`。
 * 用法：`bun main.ts [能力档等 pi 参数…]`，这些参数原样排在 rpc / 挂 MCP / 会话 id 之前（args.ts）；pi 可执行文件按 PI_BIN 找。
 * stdout 只留给协议，日志一律走 stderr（宿主按行转进自己的日志）。PI_CODING_AGENT_DIR 按 Pi 的规则归一后再交给 pi（lib/pi-path.ts），
 * 撞名检查查的就是 pi 实际读的目录。
 * 起它的一方从这里 import 路径（PI_ACP_ADAPTER_MAIN）；被 import 时什么都不做，只有直接运行才接管 stdio。
 */
import { fileURLToPath } from "node:url";
import { spawnAdapter } from "../adapter-proc.js";
import type { RpcWire } from "../rpc.js";
import { piBinName } from "../../pi-env.js";
import { piAgentDirOf } from "../../pi-path.js";
import { sandboxPiAgentDirProblem } from "../../sandbox.js";
import { piRpcArgs, piToolLists } from "./args.js";
import { piMcpClash } from "./mcp-clash.js";
import { replyToolProblem } from "./reply-tool.js";
import { piLinkOver } from "./pi-link.js";
import { PiAcpServer } from "./server.js";

export const PI_ACP_ADAPTER_MAIN = fileURLToPath(import.meta.url);

type Env = Record<string, string | undefined>;

/**
 * 起 pi 前的闸（含 /clear 换会话）：沙箱里 Pi 目录及其全局文件的真实路径越出沙箱根（宿主起适配器前查过一次，这里每次起 pi 再查），
 * pi 配置里有同名 server，或 channel-server（MCP_NAME）的 reply 会被这组参数的工具白名单 / 黑名单筛掉。
 */
export function piMountProblem(names: string[], cwd: string, baseArgs: readonly string[], env: Env): string | null {
  const sandbox = sandboxPiAgentDirProblem(env);
  if (sandbox) return sandbox;
  const clash = piMcpClash(names, cwd, piAgentDirOf(env, cwd));
  if (clash) return clash;
  const channel = names.find((n) => n === (env.MCP_NAME || "claudestra"));
  if (!channel) return null;
  try {
    const { tools, excludeTools } = piToolLists(baseArgs);
    return replyToolProblem(channel, tools, excludeTools);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 交给 pi 的环境：设了 PI_CODING_AGENT_DIR 就换成归一后的绝对路径 */
export function piChildEnv(env: Env, extra: Record<string, string>, cwd: string): Record<string, string> {
  const out: Record<string, string> = { ...(env as Record<string, string>), ...extra };
  if (env.PI_CODING_AGENT_DIR) out.PI_CODING_AGENT_DIR = piAgentDirOf(env, cwd);
  return out;
}

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
  const env = process.env;
  new PiAcpServer(wire, {
    openPi: (o) => piLinkOver(spawnAdapter([piBinName(), ...piRpcArgs(o.sessionId, baseArgs)], piChildEnv(env, o.env, o.cwd), o.cwd, log, "pi"), log),
    newSessionId: () => Bun.randomUUIDv7(),
    mountProblem: (names, cwd) => piMountProblem(names, cwd, baseArgs, env),
    log,
    exit: (code) => process.exit(code),
  });
}

if (import.meta.main) run(process.argv.slice(2));

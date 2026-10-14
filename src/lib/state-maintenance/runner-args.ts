/**
 * 独立执行器入口(src/state-maintenance-runner.ts)的参数:只认固定子命令,runId 过 validRunId,note 只收绝对路径的维护根。
 */

import { validRunId } from "./paths.js";

export type RunnerArgs =
  | { cmd: "serve"; runId: string; recover: boolean }
  | { cmd: "exec" | "recover"; runId: string }
  | { cmd: "note" | "note-flush"; maintRoot: string }
  | { error: string };

export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const [cmd, arg, flag] = argv;
  if (cmd === "note" || cmd === "note-flush") return arg && arg.startsWith("/") ? { cmd, maintRoot: arg } : { error: `${cmd} 需要维护根` };
  if (cmd !== "serve" && cmd !== "exec" && cmd !== "recover") return { error: "用法:serve|exec|recover <runId> 或 note|note-flush <maintRoot>" };
  if (!arg || !validRunId(arg)) return { error: "runId 不合法" };
  if (cmd === "serve") return flag === undefined || flag === "--recover" ? { cmd, runId: arg, recover: flag === "--recover" } : { error: `不认识的参数 ${flag}` };
  return flag === undefined ? { cmd, runId: arg } : { error: `不认识的参数 ${flag}` };
}

/**
 * Pi 的 agent 目录按 Pi 自己的规则算（pi 0.99.2 config.js getAgentDir → utils/paths.js normalizePath）：PI_CODING_AGENT_DIR
 * 非空就用它，`~` / `~/…` 展开成家目录、`file://…` 转成路径，不 trim；没设回落 ~/.pi/agent。相对路径 Pi 按自己的 cwd
 * （= 会话 cwd）解析，所以给了 cwd 就按它转成绝对路径。撞名预检、适配器起 pi、pi 里的挂载扩展都走这一个函数，
 * 查的文件和 Pi 实际读的才是同一个。只依赖 node 内置模块：挂载扩展在 pi 进程里加载它。tests/pi-acp-agent-dir.test.ts。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

/** Pi normalizePath 的缺省选项版（只展开 ~ 和 file://；Windows 分支不移植） */
export function normalizePiPath(input: string, home: string = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return /^file:\/\//.test(input) ? fileURLToPath(input) : input;
}

export function piAgentDirOf(env: Env = process.env, cwd?: string): string {
  const raw = env.PI_CODING_AGENT_DIR;
  if (!raw) return join(homedir(), ".pi", "agent");
  const dir = normalizePiPath(raw);
  return cwd ? resolve(cwd, dir) : dir;
}

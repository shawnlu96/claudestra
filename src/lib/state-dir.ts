/**
 * 状态目录（`~/.claude-orchestrator` 或 `CLAUDESTRA_STATE_DIR`）。
 *
 * ⚠️ 这个文件**只许依赖 node: 内置模块**，而且**每次调用现算**、不要在这里缓存模块级常量。
 * 两个理由（都是踩出来的）：
 *   1. Pi 的扩展在 **Node/Jiti** 里加载（不是 Bun）⇒ 只要 import 任何 app 模块，就会把
 *      repo-root.ts 的 `import.meta.dir`（Bun 专有）带进来 ⇒ 加载期直接抛 ERR_INVALID_ARG_TYPE，
 *      扩展的生命周期 handler 都注册不上（PR #430 第 2 轮 P1 回归，审查用 Node v26 + Jiti 复现）。
 *   2. 测试会在运行中途改 `CLAUDESTRA_STATE_DIR` ⇒ 缓存过目录常量的模块会把快照写到旧目录
 *      （同轮 P2：组合运行 ENOENT）。
 * lib/paths.ts 的 STATE_DIR 复用这里，保持"定义处唯一"（tests/paths-guard.test.ts 白名单）。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** 某个 home 下的默认状态目录（不看 override）。给带 `home` 参数的纯函数用。 */
export function stateDirIn(home: string): string {
  return join(home, ".claude-orchestrator");
}

/** 当前进程该用的状态目录：`CLAUDESTRA_STATE_DIR` 优先，否则 `~/.claude-orchestrator`。每次调用现算。 */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  const v = (env.CLAUDESTRA_STATE_DIR || "").trim();
  return v || stateDirIn(homedir());
}

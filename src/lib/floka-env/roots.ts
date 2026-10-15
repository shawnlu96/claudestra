/**
 * 两套生产根：旧根（~/.claude-orchestrator、/tmp/claude-orchestrator）与改名后的新根（同级的 .floka、floka）。
 * 隔离闸不管改名档位，两套一起拒（lib/sandbox.ts、lib/test-guard.ts）。只依赖 node: 内置。
 */
import { dirname, join } from "node:path";

/** 状态新根在 home 下的目录名（与 lib/floka-migration/state/layout.ts 的 NEW_ROOT_NAME 一致） */
const FLOKA_STATE_ROOT_NAME = ".floka";
const FLOKA_RUNTIME_DIR_NAME = "floka";

/** 旧的默认运行目录 → [旧运行, 新运行] */
export function runtimeRoots(defaultRuntimeDir: string): string[] {
  return [defaultRuntimeDir, join(dirname(defaultRuntimeDir), FLOKA_RUNTIME_DIR_NAME)];
}

/** 由旧的默认状态 / 运行目录推出两套生产根：[旧状态, 新状态, 旧运行, 新运行] */
export function productionRoots(defaultStateDir: string, defaultRuntimeDir: string): string[] {
  return [defaultStateDir, join(dirname(defaultStateDir), FLOKA_STATE_ROOT_NAME), ...runtimeRoots(defaultRuntimeDir)];
}

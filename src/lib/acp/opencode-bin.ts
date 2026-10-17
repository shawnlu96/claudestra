/**
 * OpenCode CLI 的绝对路径（docs/runtimes/opencode-acp.md「安装」）：launchd 下的 PATH 没有 nvm 目录，裸调 `opencode` 必 ENOENT，
 * 所以按 resolveNpm() 的 bin 目录找；OPENCODE_BIN 可手工指定（单测 / 非 npm 安装）。找不到返回 null，调用方用 OPENCODE_INSTALL_HINT。
 * 宿主窗口不继承 manager 的 env：启动命令把这里解析出的路径以 OPENCODE_BIN 带过去（runtimes/opencode-acp.ts）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveNpm } from "../npm-path.js";
import { isSandbox, SANDBOX_ROOT_ENV } from "../sandbox.js";
import { sandboxAcpHome } from "./stub.js";

export const OPENCODE_BIN_ENV = "OPENCODE_BIN";
export const OPENCODE_INSTALL_HINT = "没装 OpenCode CLI：npm i -g opencode-ai（装完重开网页弹窗即可选）";

export function opencodeBin(env: Record<string, string | undefined> = process.env, npm = resolveNpm): string | null {
  const pinned = env[OPENCODE_BIN_ENV]?.trim();
  if (pinned) return existsSync(pinned) ? pinned : null;
  const dir = npm()?.binDir;
  const p = dir ? join(dir, "opencode") : "";
  return p && existsSync(p) ? p : null;
}

/**
 * 沙箱实例（docs/architecture/sandbox.md）里 OpenCode 的家目录、配置、库、缓存全挪进沙箱根（与 Codex 的 acp-home 同一处），
 * 不碰 owner 的 ~/.local/share/opencode；沙箱外返回 {}（照用 owner 的）。起 `opencode acp`、跑 export / models 都要叠上它。
 */
export function opencodeDirsEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  if (!isSandbox(env)) return {};
  const { HOME } = sandboxAcpHome(env[SANDBOX_ROOT_ENV]);
  return { HOME, XDG_CONFIG_HOME: join(HOME, ".config"), XDG_DATA_HOME: join(HOME, ".local/share"), XDG_STATE_HOME: join(HOME, ".local/state"), XDG_CACHE_HOME: join(HOME, ".cache") };
}

/**
 * 共享配置常量
 */

export const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
export const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "3847");
export const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .filter(Boolean);
export const TMP_DIR = "/tmp/claude-orchestrator";
export const TMUX_SOCK = `${TMP_DIR}/master.sock`;
export const MANAGER_PATH = `${import.meta.dir}/../manager.ts`;
export const BUN_PATH = `${process.env.HOME}/.bun/bin/bun`;
export const ENV_WITH_BUN = {
  ...process.env,
  PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
};

/**
 * setup-token 已下线：出借 Claude 直接用出借方本机登录（lend-claude-worker.ts）。旧版存过的 token 文件 / 环境变量一律不再读取，
 * 这里只报它们在哪，面板提示 owner 手动删；不自动删用户文件。
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";

export const claudeTokenPath = (env: Record<string, string | undefined> = process.env) =>
  join(env.CLAUDESTRA_STATE_DIR || STATE_DIR, "lend-credentials", "claude-token.json");

export interface LegacyClaudeToken { file: string | null; envVar: boolean }

/** 只看存在与否（lstat，不跟软链、不读内容）；envVar 只说环境里还配着 CLAUDE_CODE_OAUTH_TOKEN，不碰值 */
export function legacyClaudeToken(env: Record<string, string | undefined> = process.env): LegacyClaudeToken {
  const path = claudeTokenPath(env);
  let file: string | null = null;
  try { lstatSync(path); file = path; } catch { file = null; /* 不存在或读不到元数据：没有可提示删除的旧文件 */ }
  return { file, envVar: !!env.CLAUDE_CODE_OAUTH_TOKEN };
}

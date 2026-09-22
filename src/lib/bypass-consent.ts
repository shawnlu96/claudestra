/**
 * Claude Code 的 Bypass Permissions 首启确认。
 *
 * Claudestra 的 agent 全部以 --dangerously-skip-permissions 启动。CC 第一次这样启动时
 * 会弹确认框，默认高亮「No, exit」；用户在框里选过 Yes 之后，CC 往用户级 settings.json
 * 写 `skipDangerousModePermissionPrompt: true`，以后不再问。这个键就是「用户已同意」
 * 的唯一可靠记录——setup 征得同意后写它，takeover / 收编在动手前查它。
 * 自动化绝不替用户在框里选 Yes（见 tmux-helper 的 detectBypassConsentPrompt）。
 */
import { join } from "path";

export const BYPASS_CONSENT_KEY = "skipDangerousModePermissionPrompt";

/** CC 用户级 settings.json 的位置（尊重 CLAUDE_CONFIG_DIR，和 CC 自己一致） */
export function claudeUserSettingsPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || "~", ".claude"), "settings.json");
}

export function bypassConsentGiven(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && (settings as Record<string, unknown>)[BYPASS_CONSENT_KEY] === true;
}

/** 读不到 / 坏 JSON 一律当「没同意」——宁可多问一次，也不替用户认 */
export async function readBypassConsent(path = claudeUserSettingsPath()): Promise<boolean> {
  try {
    return bypassConsentGiven(JSON.parse(await Bun.file(path).text()));
  } catch {
    return false;
  }
}

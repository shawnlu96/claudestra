/**
 * `manager tmux-send-keys` 发键前的画面闸（T41a）：窗口停在要人决定的画面上就一个键都不发，除非调用方显式 --force。
 * 数字 / Enter 会替人选中高亮项（额度菜单里有花钱的选项、权限框等于替人批准），Esc / C-c 等于替人拒绝或取消，
 * 撞墙倒计时上随便敲一个字就取消 CC 排好的自动续跑——所以拦的是整个画面，不挑键。强发每次追加一行审计（send-keys-audit.jsonl）。
 * 单测 tests/send-key-guard.test.ts（真实画面 fixture）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAuqPane } from "./auq-pane.js";
import { LOG_DIR } from "./paths.js";
import type { RegistryAgent } from "./registry.js";
import { detectBypassConsentPrompt, detectRuntimePermissionPrompt, detectSessionIdlePrompt, trustPromptMoves } from "./tmux-helper.js";
import { wallWaitOf } from "./wall-screen.js";

export type GuardedScreen =
  | "limit_menu" | "wall_countdown" | "codex_menu" | "permission" | "ask_user_question" | "session_idle" | "trust_prompt" | "bypass_consent";

/** 画面 + 窗口运行时 → 命中的画面（纯函数）；认不出 / 普通画面 = null。额度与 Codex 菜单同 lib/wall-screen.ts 一套判定 */
export function guardedScreenOf(pane: string, runtime: string | undefined): GuardedScreen | null {
  const wall = wallWaitOf(pane, runtime);
  if (wall) return wall === "menu" ? "limit_menu" : wall === "countdown" ? "wall_countdown" : "codex_menu";
  if (detectRuntimePermissionPrompt(pane)) return "permission";
  if (parseAuqPane(pane)) return "ask_user_question";
  if (detectSessionIdlePrompt(pane)) return "session_idle";
  if (trustPromptMoves(pane) !== null) return "trust_prompt";
  if (detectBypassConsentPrompt(pane)) return "bypass_consent";
  return null;
}

const SCREEN_TEXT: Record<GuardedScreen, string> = {
  limit_menu: "额度菜单（里面有花钱的选项）",
  wall_countdown: "撞墙后的自动续跑倒计时（一打字就取消续跑）",
  codex_menu: "Codex 选择菜单",
  permission: "权限确认框",
  ask_user_question: "AskUserQuestion 提问框",
  session_idle: "会话闲置恢复选择框",
  trust_prompt: "目录信任框",
  bypass_consent: "Bypass Permissions 首启确认框",
};

export const guardedScreenRefusal = (screen: GuardedScreen): string =>
  `窗口停在${SCREEN_TEXT[screen]}上，没发任何键；确实要发请加 --force（会记审计日志）`;

const SEND_KEYS_AUDIT_LOG = join(LOG_DIR, "send-keys-audit.jsonl");

/** 谁在强发：Codex / Pi agent 带 CLAUDESTRA_AGENT；CC agent 的 Bash 继承了 DISCORD_CHANNEL_ID，按 registry 反查；都没有 = 手敲 / bridge */
export function sendKeysCaller(env: Record<string, string | undefined>, agents: readonly Pick<RegistryAgent, "name" | "channelId">[]): string {
  if (env.CLAUDESTRA_AGENT) return env.CLAUDESTRA_AGENT;
  const ch = env.DISCORD_CHANNEL_ID;
  if (!ch) return "cli";
  if (ch === env.CONTROL_CHANNEL_ID) return "master";
  return agents.find((a) => a.channelId === ch)?.name ?? `channel:${ch}`;
}

export interface SendKeysAudit {
  at: string;
  caller: string;
  ppid: number;
  window: string;
  keys: string[];
  /** --force 时画面命中了什么；null = 画面普通（仍记：强发本身就值得留档） */
  screen: GuardedScreen | null;
  /** owner 点过的按钮 / ask（--authorized）；null = 没有授权来源（手敲的 --force） */
  authorizedBy: string | null;
}

/** owner 在界面上点过才发键的路径（管理按钮等）调 manager 时用这个拼 argv：授权来源进审计，一眼能查到是哪个按钮 */
export const authorizedSendKeysArgs = (agent: string, ref: string, keys: string[]): string[] =>
  ["tmux-send-keys", agent, "--authorized", ref, ...keys];

/** 追加一行；写不进去要抛出去——强发的前提是留了档，调用方据此不发键 */
export function appendSendKeysAudit(entry: SendKeysAudit, path = SEND_KEYS_AUDIT_LOG): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

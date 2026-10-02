/**
 * `manager tmux-send-keys` 发键前的画面闸（T41a）：窗口停在要人决定的画面上就一个键都不发，除非调用方显式 --force。
 * 数字 / Enter 会替人选中高亮项（额度菜单里有花钱的选项、权限框等于替人批准），Esc / C-c 等于替人拒绝或取消，
 * 撞墙倒计时上随便敲一个字就取消 CC 排好的自动续跑——所以拦的是整个画面，不挑键。抓不到屏 / 空屏同样不发（认不出 ≠ 安全）。
 * owner 点过的按钮带「授权的画面」（--expect）和那一张框的指纹（--box）：画面是那种、而且还是那一张才发，换了就不发。
 * 切模型 / effort 确认框不能授权发键（没有调用方；按钮已停用，bridge/swmodel-button.ts）。
 * 强发、授权发每次追加一行审计（send-keys-audit.jsonl）；caller、authorizedBy 是调用方声明的，不是身份认证。
 * 单测 tests/send-key-guard.test.ts（真实画面 fixture）。
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAuqPane } from "./auq-pane.js";
import { LOG_DIR } from "./paths.js";
import type { RegistryAgent } from "./registry.js";
import {
  detectBypassConsentPrompt, detectRuntimePermissionPrompt, detectSessionIdlePrompt, detectSwitchConfirmPrompt,
} from "./tmux-helper.js";
import { looksLikeTrustPrompt } from "./trust-prompt.js";
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
  if (looksLikeTrustPrompt(pane)) return "trust_prompt"; // 半帧也拦：认不全 ≠ 安全
  if (detectBypassConsentPrompt(pane)) return "bypass_consent";
  return null;
}

/**
 * owner 能授权发键的画面：只有受保护的那几种。切模型 / effort 确认框（switch_confirm）不在内：
 * 点按钮到发键之间它可能关了又弹出一张内容相同的新框，指纹分不出来——这种框 owner 到终端里自己按
 */
export type AuthorizableScreen = GuardedScreen;
export const AUTHORIZABLE_SCREENS: readonly AuthorizableScreen[] = [
  "limit_menu", "wall_countdown", "codex_menu", "permission", "ask_user_question", "session_idle", "trust_prompt", "bypass_consent",
];
/** 发键前看到的画面：switch_confirm 程序自发不拦、授权发一律不发；unreadable = 抓屏失败 / 超时 / 空屏；null = 普通画面 */
export type SeenScreen = GuardedScreen | "switch_confirm" | "unreadable" | null;

export function seenScreenOf(pane: string, runtime: string | undefined): SeenScreen {
  if (!pane.trim()) return "unreadable";
  return guardedScreenOf(pane, runtime) ?? (detectSwitchConfirmPrompt(pane) ? "switch_confirm" : null);
}

/**
 * 那一张框的指纹：授权绑定到 owner 看到的那张，不是「同一类」——菜单换了选项，旧授权的数字就可能指向别的项。
 * 取最后 12 行非空行，连续空白压成一个空格（行与行之间也是一个空格），sha256 取前 12 位；抓屏两边都带 -J。
 * 空白只压不删：删光会让「Sonnet 5」和「Sonnet5」撞成同一张。❯ 停在哪一项也算在内（光标挪了，Enter 的意思就变了）
 */
export function screenFingerprint(pane: string): string {
  const lines = pane.split("\n").map((l) => l.trim()).filter(Boolean);
  return createHash("sha256").update(lines.slice(-12).join(" ").replace(/\s+/g, " ")).digest("hex").slice(0, 12);
}

const SCREEN_TEXT: Record<GuardedScreen | "switch_confirm", string> = {
  limit_menu: "额度菜单（里面有花钱的选项）",
  wall_countdown: "撞墙后的自动续跑倒计时（一打字就取消续跑）",
  codex_menu: "Codex 选择菜单",
  permission: "权限确认框",
  ask_user_question: "AskUserQuestion 提问框",
  session_idle: "会话闲置恢复选择框",
  trust_prompt: "目录信任框",
  bypass_consent: "Bypass Permissions 首启确认框",
  switch_confirm: "切模型 / effort 确认框",
};

/**
 * 这一个键能不能发（纯函数）：返回拒发原因，null = 发。抓不到画面一律不发（认不出 ≠ 安全）。expect = null 是程序自发：受保护画面不发；
 * expect 有值是 owner 授权过的：画面必须正是授权的那种——按钮点晚了、框关了回到输入框，Enter 会把草稿提交出去。
 * 切模型 / effort 确认框上授权发一律不发（哪怕调用方绕过参数解析硬塞 expect）。detail = 抓屏的报错
 */
export function sendKeyRefusal(seen: SeenScreen, expect: AuthorizableScreen | null, detail = ""): string | null {
  const force = "；确实要发请加 --force（会记审计日志）";
  if (seen === "unreadable") return `抓不到窗口画面（${detail || "空屏"}），认不出停在什么上，没发任何键${force}`;
  if (expect && seen === "switch_confirm") return `窗口停在${SCREEN_TEXT.switch_confirm}上：这种框只能 owner 到终端或网页终端里自己按，授权发键一律不发`;
  if (expect) return seen === expect ? null : `框已经变了：授权的是${SCREEN_TEXT[expect]}，窗口现在是${seen ? SCREEN_TEXT[seen] : "普通画面"}，没发任何键`;
  if (!seen || seen === "switch_confirm") return null;
  return `窗口停在${SCREEN_TEXT[seen]}上，没发任何键${force}`;
}

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
  /** 发第一个键前看到的画面；null = 画面普通（强发仍记：强发本身就值得留档） */
  screen: SeenScreen;
  /** owner 点过的按钮 / ask（--authorized）；null = 没有授权来源（手敲的 --force） */
  authorizedBy: string | null;
}

/**
 * owner 在界面上点过才发键的路径（管理按钮等）调 manager 时用这个拼 argv：授权来源进审计；expect = 按钮对应的那种框，
 * box = 发按钮时那一张框的 screenFingerprint：发键前重新抓屏，画面不是那种、或者指纹对不上（换了一张）就不发
 */
export const authorizedSendKeysArgs = (agent: string, ref: string, expect: AuthorizableScreen, box: string, keys: string[]): string[] =>
  ["tmux-send-keys", agent, "--authorized", ref, "--expect", expect, "--box", box, ...keys];

/** 追加一行；写不进去要抛出去——强发的前提是留了档，调用方据此不发键 */
export function appendSendKeysAudit(entry: SendKeysAudit, path = SEND_KEYS_AUDIT_LOG): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

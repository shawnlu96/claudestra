/**
 * `manager tmux-send-keys <agent> [--force] <keys...>`：大总管 / PM / 管理按钮往 agent 窗口发键。每个键发之前都抓一次屏过画面闸
 * （lib/send-key-guard.ts）：前一个键可能刚把弹窗弹出来（先 Enter 再「1」），只查开头一次挡不住。--force 跳过闸、先写审计再发。
 * 发键方式与改动前一致：特殊键名直发、其余走 -l 字面；Esc 走双击护栏；程序敲的字 / C-c 记下来，bridge 不当成 owner。
 */
import { readRegistryAgentsSync } from "../lib/registry.js";
import { runtimeOfWindow } from "../lib/wall-screen.js";
import {
  appendSendKeysAudit, guardedScreenOf, guardedScreenRefusal, sendKeysCaller, type GuardedScreen, type SendKeysAudit,
} from "../lib/send-key-guard.js";
import { noteProgramInput, tmuxRaw, tmuxSendEscape, windowTarget } from "../lib/tmux-helper.js";

export interface SendKeysDeps {
  capture(target: string): Promise<string>;
  runtimeOf(target: string): string | undefined;
  sendKey(target: string, key: string): Promise<void>;
  audit(entry: SendKeysAudit): void;
  caller(): string;
  now(): Date;
}

export type SendKeysResult =
  | { ok: true; keys: string[]; forced: boolean; screen: GuardedScreen | null }
  | { ok: false; error: string; screen: GuardedScreen; sent: string[] };

const SPECIAL_KEY_RE = /^(Enter|Escape|Esc|Left|Right|Up|Down|Tab|BTab|BSpace|C-[a-z]|M-[a-z]|Space)$/i;
const ESC_RE = /^(Escape|Esc)$/i;

export async function sendKeysChecked(tmuxName: string, keys: string[], force: boolean, deps: SendKeysDeps): Promise<SendKeysResult> {
  const target = windowTarget(tmuxName);
  const screenNow = async () => guardedScreenOf(await deps.capture(target), deps.runtimeOf(target));
  if (force) {
    const screen = await screenNow();
    // 审计写失败就不发：强发的前提是留了档（appendSendKeysAudit 会抛）
    deps.audit({ at: deps.now().toISOString(), caller: deps.caller(), ppid: process.ppid, window: tmuxName, keys, screen });
    for (const k of keys) await deps.sendKey(target, k);
    return { ok: true, keys, forced: true, screen };
  }
  const sent: string[] = [];
  for (const k of keys) {
    const screen = await screenNow();
    if (screen) return { ok: false, error: guardedScreenRefusal(screen), screen, sent };
    await deps.sendKey(target, k);
    sent.push(k);
  }
  return { ok: true, keys, forced: false, screen: null };
}

async function sendOneKey(target: string, k: string): Promise<void> {
  const special = SPECIAL_KEY_RE.test(k);
  if (!ESC_RE.test(k)) await noteProgramInput(target, special ? "" : k); // bridge 别把程序敲的字 / C-c 当成 owner
  // Esc 走双击护栏（跨进程也算），没发出去就报错
  await (ESC_RE.test(k) ? tmuxSendEscape(target, { strict: true }) : tmuxRaw(special ? ["send-keys", "-t", target, k] : ["send-keys", "-t", target, "-l", "--", k]));
  await Bun.sleep(50);
}

export const realSendKeysDeps = (): SendKeysDeps => ({
  capture: (target) => tmuxRaw(["capture-pane", "-t", target, "-p"]), // 抓不到返回空串 = 认不出画面、不拦（同 lib/wall-screen.ts）
  runtimeOf: runtimeOfWindow,
  sendKey: sendOneKey,
  audit: (e) => appendSendKeysAudit(e),
  caller: () => sendKeysCaller(process.env, readRegistryAgentsSync()),
  now: () => new Date(),
});

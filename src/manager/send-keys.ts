/**
 * `manager tmux-send-keys <agent> [--force] [--authorized <ref> --expect <画面>] <keys...>`：大总管 / PM / 管理按钮往 agent 窗口发键。
 * 每个键都过画面闸（lib/send-key-guard.ts），而且查在「拿到窗口锁、等完 Esc 节流」之后、紧挨着发：先查后等，等的那一两秒里弹出来的框挡不住。
 * 前一个键也可能刚把弹窗弹出来（先 Enter 再「1」），所以每个键都重查。抓屏失败 / 超时 / 空屏 = 不发。--force 跳过闸。
 * --authorized = owner 在界面上点过的按钮 / ask（ref 记进审计），--expect = 它授权的那种框：画面正是那种才发，别的画面（含普通输入框）都不发。
 * 强发、授权发都先写一行审计再发第一个键。发键方式与改动前一致：特殊键名直发、其余走 -l 字面；Esc 走双击护栏；程序敲的字 / C-c 记下来。
 */
import { readRegistryAgentsSync } from "../lib/registry.js";
import { runtimeOfWindow } from "../lib/wall-screen.js";
import {
  appendSendKeysAudit, AUTHORIZABLE_SCREENS, seenScreenOf, sendKeyRefusal, sendKeysCaller,
  type AuthorizableScreen, type SeenScreen, type SendKeysAudit,
} from "../lib/send-key-guard.js";
import { programInputNoter, tmuxRawStrict, tmuxSendEscape, windowTarget } from "../lib/tmux-helper.js";

export interface SendKeysDeps {
  /** 抓不到就抛 */
  capture(target: string): Promise<string>;
  runtimeOf(target: string): string | undefined;
  /** 拿到窗口锁、等完该等的之后调 gate，gate 过了立刻发这一个键、中间不再 await；gate 抛错 = 这个键不发 */
  sendKey(target: string, key: string, gate: () => Promise<void>): Promise<void>;
  audit(entry: SendKeysAudit): void;
  caller(): string;
  now(): Date;
}

export type SendKeysResult =
  | { ok: true; keys: string[]; forced: boolean; screen: SeenScreen }
  | { ok: false; error: string; screen: SeenScreen; sent: string[] };

const SPECIAL_KEY_RE = /^(Enter|Escape|Esc|Left|Right|Up|Down|Tab|BTab|BSpace|C-[a-z]|M-[a-z]|Space)$/i;
const ESC_RE = /^(Escape|Esc)$/i;

export interface SendKeysOpts {
  force: boolean;
  /** 谁授权的（按钮 id / ask id）；null = 程序自己发 */
  authorizedBy: string | null;
  /** 授权的是哪种框；和 authorizedBy 成对出现 */
  expect: AuthorizableScreen | null;
}

export const SEND_KEYS_USAGE = "usage: tmux-send-keys <agent> [--force] [--authorized <ref> --expect <screen>] <keys...>";

/**
 * argv（agent 之后）→ 选项 + 键；与 lib/send-key-guard.ts authorizedSendKeysArgs 拼的形状对应。
 * 选项只认键之前的：键里恰好有「--force」字样（要敲进去的文字）不会被当成强发。
 */
export function parseSendKeysArgs(args: string[]): (SendKeysOpts & { keys: string[] }) | { error: string } {
  const o: SendKeysOpts = { force: false, authorizedBy: null, expect: null };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--force") o.force = true;
    else if (a === "--authorized" || a === "--expect") {
      const v = args[++i];
      if (!v) return { error: `${a} 后面要跟值` };
      if (a === "--authorized") o.authorizedBy = v;
      else if (AUTHORIZABLE_SCREENS.includes(v as AuthorizableScreen)) o.expect = v as AuthorizableScreen;
      else return { error: `--expect 只认 ${AUTHORIZABLE_SCREENS.join(" / ")}` };
    } else break;
  }
  if (!o.authorizedBy !== !o.expect) return { error: "--authorized 和 --expect 要一起给：授权必须说明授权的是哪种框" };
  if (i >= args.length) return { error: SEND_KEYS_USAGE };
  return { ...o, keys: args.slice(i) };
}

class Refused extends Error {
  constructor(readonly screen: SeenScreen, message: string) {
    super(message);
  }
}

export async function sendKeysChecked(tmuxName: string, keys: string[], opts: SendKeysOpts, deps: SendKeysDeps): Promise<SendKeysResult> {
  const target = windowTarget(tmuxName);
  const look = async (): Promise<[SeenScreen, string]> => {
    try {
      return [seenScreenOf(await deps.capture(target), deps.runtimeOf(target)), ""];
    } catch (e) {
      return ["unreadable", (e as Error).message]; // 抓屏失败按「认不出」处理：闸拒发，--force 照发并记下 unreadable
    }
  };
  let first: SeenScreen | undefined;
  // 审计写失败就不发：强发 / 授权发的前提是留了档（appendSendKeysAudit 会抛，不是 Refused，原样抛出去）
  const audit = (screen: SeenScreen) =>
    deps.audit({ at: deps.now().toISOString(), caller: deps.caller(), ppid: process.ppid, window: tmuxName, keys, screen, authorizedBy: opts.authorizedBy });
  const sent: string[] = [];
  for (const k of keys) {
    try {
      await deps.sendKey(target, k, async () => {
        if (opts.force && first !== undefined) return; // 强发只看第一眼（记审计用），后面的键不再抓屏
        const [seen, detail] = await look();
        const refusal = opts.force ? null : sendKeyRefusal(seen, opts.expect, detail);
        if (refusal) throw new Refused(seen, refusal);
        if (first === undefined && (opts.force || opts.authorizedBy)) audit(seen);
        first ??= seen;
      });
    } catch (e) {
      if (e instanceof Refused) return { ok: false, error: e.message, screen: e.screen, sent };
      throw e;
    }
    sent.push(k);
  }
  return { ok: true, keys, forced: opts.force, screen: first ?? null };
}

async function sendOneKey(target: string, k: string, gate: () => Promise<void>): Promise<void> {
  if (ESC_RE.test(k)) {
    await tmuxSendEscape(target, { strict: true, gate }); // Esc 走双击护栏（跨进程也算）：锁、节流都等完才过 gate，没发出去就报错
  } else {
    const special = SPECIAL_KEY_RE.test(k);
    const note = await programInputNoter(target); // 要等的先等完
    await tmuxSendEscape.locked(target, async () => {
      await gate();
      note(special ? "" : k); // bridge 别把程序敲的字 / C-c 当成 owner
      await tmuxRawStrict(special ? ["send-keys", "-t", target, k] : ["send-keys", "-t", target, "-l", "--", k]);
    });
  }
  await Bun.sleep(50);
}

/** 解析 + 发，给 manager.ts 一行调用 */
export async function runSendKeysCommand(tmuxName: string, args: string[]): Promise<Record<string, unknown>> {
  const p = parseSendKeysArgs(args);
  if ("error" in p) return { ok: false, error: p.error };
  const { keys, ...opts } = p;
  return sendKeysChecked(tmuxName, keys, opts, realSendKeysDeps());
}

const realSendKeysDeps = (): SendKeysDeps => ({
  // 锁的过期是 5 秒（tmux-helper tmuxSendEscape）：抓屏超时要比它短，持锁期间不能被别人当死锁回收
  capture: (target) => tmuxRawStrict(["capture-pane", "-t", target, "-p"], { timeoutMs: 3_000 }),
  runtimeOf: runtimeOfWindow,
  sendKey: sendOneKey,
  audit: (e) => appendSendKeysAudit(e),
  caller: () => sendKeysCaller(process.env, readRegistryAgentsSync()),
  now: () => new Date(),
});

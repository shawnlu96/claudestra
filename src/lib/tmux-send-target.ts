import { TmuxCommandError } from "./tmux-failure.js";

/**
 * One plain injection addresses one pane. A name target is resolved again by every tmux command, so a window that takes the
 * name during the literal→Enter wait would receive the Enter. tmuxSendLine resolves the name once to a pane ID and uses it
 * for the copy-mode cancel, the menu capture, the literal, the Enter and the input record; a pane ID is never reused, so a
 * key for a vanished pane is refused by tmux instead of landing elsewhere. A window ID is no better than a name here: it
 * fixes the window, and each `send-keys -t @N` still picks whichever pane is active at that moment, so it is resolved to
 * its pane like any other window target. tests/tmux-audit-target.test.ts.
 */

/** The target resolved to no pane or to more than one, or the pinned pane went away before the line was complete. */
export class SendTargetLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendTargetLost";
  }
}

/** `exec` must throw on a non-zero exit or a timeout (tmuxRawStrict): an empty answer from a swallowing exec proves nothing. */
type Query = (args: string[]) => Promise<string>;

/** Only a pane ID is already the identity of one pane: kept as given. (The restore guard's window ID never comes through here.) */
const PANE = /^%\d+$/;

/** A lost target stops the send: the launch path (strict) hears about it, the other paths keep swallowing and log. */
function lost(target: string, why: string, strict: boolean): null {
  const message = `tmux 注入目标 ${target} ${why}，到此停止：不再发键、不改按名字找别的窗口`;
  if (strict) throw new SendTargetLost(message);
  console.error(`⚠ ${message}`);
  return null;
}

/** Only a tmux failure means "no such target"; a lost scheduler lease or a spawn error stays the caller's own error. */
async function ask(query: Query, args: string[]): Promise<string | null> {
  try { return await query(args); } catch (e) {
    if (e instanceof TmuxCommandError) return null;
    throw e;
  }
}

/**
 * Resolve `target` to the one pane this injection may touch; null (or a throw when strict) means nothing may be sent.
 * A window with several panes pins its active one, the pane a name target addressed before. tmux answers an ambiguous
 * `=name` with an error, so two windows of one name resolve to no pane.
 */
export async function pinSendTarget(target: string, query: Query, strict: boolean): Promise<string | null> {
  if (PANE.test(target)) return target;
  const out = await ask(query, ["list-panes", "-t", target, "-F", "#{pane_active}\t#{pane_id}"]);
  if (out === null) return lost(target, "不存在或不唯一", strict);
  const active = out.split("\n").map((line) => line.split("\t")).filter(([on, id]) => on === "1" && PANE.test(id ?? ""));
  return active.length === 1 ? active[0][1] : lost(target, `解析出 ${active.length} 个活动 pane`, strict);
}

/**
 * Before the Enter: is the pane we resolved still there? Gone means the line stops with no Enter (null / throw as above).
 * A caller-supplied pane ID is not probed: tmux refuses a key for a missing pane ID by itself.
 */
export async function pinStillThere(target: string, pin: string, query: Query, strict: boolean): Promise<true | null> {
  if (pin === target) return true;
  const panes = await ask(query, ["list-panes", "-t", pin, "-F", "#{pane_id}"]);
  return panes?.split("\n").includes(pin) ? true : lost(target, `的 pane ${pin} 在回车前消失`, strict);
}

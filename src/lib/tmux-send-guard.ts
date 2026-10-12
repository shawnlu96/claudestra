import { TmuxCommandError } from "./tmux-failure.js";

/**
 * Conditional key send: the tmux server evaluates the window binding and the pane's foreground command and runs
 * send-keys in the same command, so no await separates the last liveness / window answer from the key.
 * The registry is a file and cannot join this condition; callers still recheck it before each key.
 */

/**
 * Printed by the branch that sends nothing. A send counts as sent only when tmux exits 0 with no output, so `exec` must
 * report a non-zero exit or a timeout by throwing (tmuxRawStrict): every other result is unknown and counts as not sent.
 */
export const SEND_REFUSED = "claudestra-send-refused";

const SHELLS = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"];
/** `#{pane_current_command}` of an idle shell pane; a login shell may carry a leading dash. */
export const isShellCommand = (command: string): boolean => SHELLS.includes(command.replace(/^-/, ""));

const eq = (format: string, value: string) => `#{==:#{${format}},${value}}`;
const fold = (op: "&&" | "||", terms: string[]): string => terms.reduce((rest, term) => `#{${op}:${term},${rest}}`);

/**
 * A window name as a literal operand of `#{==:}`: `#`, `,` and `}` are the format's own separators. Agent names may be any
 * Unicode text (lib/registry.ts). A `#` run before `[` stays a style whatever the escape, and tmux prints `\` and control
 * characters in another form than it stores, so a name holding those cannot be compared and is refused.
 */
function literalName(name: string): string {
  if (!name || /#\[|[\\\x00-\x1f\x7f]/.test(name)) throw new Error("send guard cannot express this target");
  return name.replace(/[#,}]/g, (c) => `#${c}`);
}

/** tmux format that is 1 only while `name` is still bound to `windowId`, its pane is alive and, if asked, a shell is in front. */
export function sendCondition(windowId: string, name: string, shell: boolean): string {
  if (!/^@\d+$/.test(windowId)) throw new Error("send guard cannot express this target");
  const terms = [eq("window_id", windowId), eq("window_name", literalName(name)), eq("pane_dead", "0")];
  if (shell) terms.push(fold("||", SHELLS.flatMap((s) => [eq("pane_current_command", s), eq("pane_current_command", `-${s}`)])));
  return fold("&&", terms);
}

/**
 * One word of a tmux command string; single quotes keep `#{}`, `%`, `;`, `$` and `~` literal. A line break is refused: tmux
 * takes a `#` after it as a comment even inside quotes, drops the whole command and still exits 0 with no output.
 */
function word(arg: string): string {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(arg)) throw new Error("send guard cannot express this text");
  return /^[A-Za-z0-9@_.:=\/-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Wrap a `send-keys -t <windowId> …` argv so that it only runs while the condition holds. */
export function guardedSendArgs(windowId: string, name: string, shell: boolean, args: string[]): string[] {
  if (args[0] !== "send-keys" || args[1] !== "-t" || args[2] !== windowId) throw new Error("send guard needs send-keys pinned to its window ID");
  return ["if-shell", "-F", "-t", windowId, sendCondition(windowId, name, shell), args.map(word).join(" "), `display-message -p ${SEND_REFUSED}`];
}

export class SendRefused extends Error {}

/**
 * A strict exec failure that proves nothing was typed: tmux exited on its own with a reason (code 1-127, stderr), or the
 * client never started (spawn error). A kill, a signal, a silent non-zero exit or any other error leaves the send unknown.
 * Decided from structured fields only, never from the message text.
 */
function provenNotSent(e: unknown): boolean {
  if (e instanceof TmuxCommandError) return e.refusedByTmux;
  const syscall = (e as { syscall?: unknown } | null)?.syscall;
  return typeof syscall === "string" && /spawn/.test(syscall);
}

type Exec = (args: string[]) => Promise<string>;
export interface SendGuard {
  /**
   * Send through `exec` under the condition. An exec failure leaves the result unknown and latches a refusal, unless
   * `ownFailure` (the strict launch literal) and the failure proves nothing was sent (provenNotSent): that stays the
   * caller's launch error. No later key follows either.
   */
  run(exec: Exec, args: string[], ownFailure?: boolean): Promise<string>;
  /** Reason of the first refusal. Once set, no later key is sent even if the condition holds again. */
  refused(): string | null;
}

export function createSendGuard(windowId: string, name: string, shell: () => boolean): SendGuard {
  let refused: string | null = null;
  let failed: { error: unknown } | null = null;
  const lose = (reason: string): never => { refused ??= reason; throw new SendRefused(refused); };
  return {
    refused: () => refused,
    run: async (exec, args, ownFailure = false) => {
      if (refused) throw new SendRefused(refused);
      if (failed) throw failed.error;
      let guarded: string[];
      try { guarded = guardedSendArgs(windowId, name, shell(), args); } catch (e) { return lose(String(e)); }
      let out: string;
      try { out = await exec(guarded); } catch (e) {
        if (!ownFailure || !provenNotSent(e)) return lose(`send result unknown: ${String(e)}`);
        failed = { error: e };
        throw e;
      }
      if (out.trim() === SEND_REFUSED) return lose("window rebound, pane dead or no longer at a shell when the key was due");
      return out.trim() ? lose("send result unknown") : out;
    },
  };
}

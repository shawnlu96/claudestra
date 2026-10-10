/**
 * Conditional key send: the tmux server evaluates the window binding and the pane's foreground command and runs
 * send-keys in the same command, so no await separates the last liveness / window answer from the key.
 * The registry is a file and cannot join this condition; callers still recheck it before each key.
 */

/** Printed by the branch that sends nothing. Any other output is unknown and counts as not sent. */
export const SEND_REFUSED = "claudestra-send-refused";

const SHELLS = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"];
/** `#{pane_current_command}` of an idle shell pane; a login shell may carry a leading dash. */
export const isShellCommand = (command: string): boolean => SHELLS.includes(command.replace(/^-/, ""));

const eq = (format: string, value: string) => `#{==:#{${format}},${value}}`;
const fold = (op: "&&" | "||", terms: string[]): string => terms.reduce((rest, term) => `#{${op}:${term},${rest}}`);

/** tmux format that is 1 only while `name` is still bound to `windowId`, its pane is alive and, if asked, a shell is in front. */
export function sendCondition(windowId: string, name: string, shell: boolean): string {
  if (!/^@\d+$/.test(windowId) || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("send guard cannot express this target");
  const terms = [eq("window_id", windowId), eq("window_name", name), eq("pane_dead", "0")];
  if (shell) terms.push(fold("||", SHELLS.flatMap((s) => [eq("pane_current_command", s), eq("pane_current_command", `-${s}`)])));
  return fold("&&", terms);
}

/** One word of a tmux command string; single quotes keep `#{}`, `%`, `;`, `$` and `~` literal. */
const word = (arg: string) => /^[A-Za-z0-9@_.:=\/-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/** Wrap a `send-keys -t <windowId> …` argv so that it only runs while the condition holds. */
export function guardedSendArgs(windowId: string, name: string, shell: boolean, args: string[]): string[] {
  if (args[0] !== "send-keys" || args[1] !== "-t" || args[2] !== windowId) throw new Error("send guard needs send-keys pinned to its window ID");
  return ["if-shell", "-F", "-t", windowId, sendCondition(windowId, name, shell), args.map(word).join(" "), `display-message -p ${SEND_REFUSED}`];
}

export class SendRefused extends Error {}
type Exec = (args: string[]) => Promise<string>;
export interface SendGuard {
  /** Send through `exec` under the condition. `unknownOnError`: an exec failure also latches, for sends whose errors were swallowed. */
  run(exec: Exec, args: string[], unknownOnError?: boolean): Promise<string>;
  /** Reason of the first refusal. Once set, no later key is sent even if the condition holds again. */
  refused(): string | null;
}

export function createSendGuard(windowId: string, name: string, shell: () => boolean): SendGuard {
  let refused: string | null = null;
  const lose = (reason: string): never => { refused ??= reason; throw new SendRefused(refused); };
  return {
    refused: () => refused,
    run: async (exec, args, unknownOnError = false) => {
      if (refused) throw new SendRefused(refused);
      let guarded: string[];
      try { guarded = guardedSendArgs(windowId, name, shell(), args); } catch (e) { return lose(String(e)); }
      let out: string;
      try { out = await exec(guarded); } catch (e) { if (unknownOnError) return lose(`send result unknown: ${String(e)}`); throw e; }
      if (out.trim() === SEND_REFUSED) return lose("window rebound, pane dead or no longer at a shell when the key was due");
      return out.trim() ? lose("send result unknown") : out;
    },
  };
}

/** LSTLIVE1: the conditional key send. Unit checks of the condition / argv / latch, then the real tmuxSendLine against a private fake tmux. */
import { testChildEnv } from "./test-env.js";
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createSendGuard, guardedSendArgs, isShellCommand, sendCondition, SEND_REFUSED, SendRefused } from "../src/lib/tmux-send-guard.js";

test("send condition pins window ID, name and a live pane; the shell term is optional", () => {
  const bare = sendCondition("@7", "agent-x", false);
  expect(bare).toBe("#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{window_name},agent-x},#{==:#{window_id},@7}}}");
  const shell = sendCondition("@7", "agent-x", true);
  expect(shell).toContain(bare.slice("#{&&:".length, -1)); // The identity terms stay inside the shell-gated condition.
  for (const s of ["sh", "bash", "zsh", "fish", "-zsh"]) expect(shell).toContain(`#{==:#{pane_current_command},${s}}`);
  expect(shell).not.toContain("claude");
  for (const bad of [["1", "agent-x"], ["@1", "a,b"], ["@1", "a}b"], ["@1", "a#b"], ["@1", ""]]) expect(() => sendCondition(bad[0], bad[1], true)).toThrow();
});

test("shell names: idle shells only, login dash accepted", () => {
  for (const s of ["zsh", "-zsh", "bash", "sh", "fish"]) expect(isShellCommand(s)).toBe(true);
  for (const s of ["claude", "node", "bun", "codex", "", "zsh2", "--zsh"]) expect(isShellCommand(s)).toBe(false);
});

test("guarded argv: one if-shell with the send and a marker branch; text stays one literal word", () => {
  const args = guardedSendArgs("@1", "agent-x", true, ["send-keys", "-t", "@1", "-l", "--", `cd '/a b' && x "$HOME" #{pane_pid} %1; y ~`]);
  expect(args.slice(0, 4)).toEqual(["if-shell", "-F", "-t", "@1"]);
  expect(args[4]).toBe(sendCondition("@1", "agent-x", true));
  expect(args[5]).toBe(`send-keys -t @1 -l -- 'cd '\\''/a b'\\'' && x "$HOME" #{pane_pid} %1; y ~'`);
  expect(args[6]).toBe(`display-message -p ${SEND_REFUSED}`);
  expect(args).toHaveLength(7);
  expect(guardedSendArgs("@1", "agent-x", false, ["send-keys", "-t", "@1", "Enter"])[5]).toBe("send-keys -t @1 Enter");
  expect(guardedSendArgs("@1", "agent-x", true, ["send-keys", "-t", "@1", "-X", "cancel"])[5]).toBe("send-keys -t @1 -X cancel");
  for (const bad of [["send-keys", "-t", "@2", "Enter"], ["send-keys", "-t", "master:=agent-x", "Enter"], ["kill-window", "-t", "@1"]]) {
    expect(() => guardedSendArgs("@1", "agent-x", true, bad)).toThrow();
  }
});

test("a refusal latches: no later key reaches tmux even when the condition would hold again", async () => {
  const calls: string[][] = [];
  let answer = "";
  const exec = async (args: string[]) => { calls.push(args); return answer; };
  const guard = createSendGuard("@1", "agent-x", () => true);
  expect(await guard.run(exec, ["send-keys", "-t", "@1", "-l", "--", "go"])).toBe("");
  expect(guard.refused()).toBeNull();
  answer = `${SEND_REFUSED}\n`;
  await expect(guard.run(exec, ["send-keys", "-t", "@1", "Enter"])).rejects.toBeInstanceOf(SendRefused);
  expect(guard.refused()).toContain("no longer at a shell");
  answer = "";
  await expect(guard.run(exec, ["send-keys", "-t", "@1", "Enter"])).rejects.toBeInstanceOf(SendRefused);
  expect(calls).toHaveLength(2);
});

test("unknown results count as not sent; a strict failure stays the caller's error unless marked unknown", async () => {
  const noise = createSendGuard("@1", "agent-x", () => true);
  await expect(noise.run(async () => "something else", ["send-keys", "-t", "@1", "Enter"])).rejects.toBeInstanceOf(SendRefused);
  expect(noise.refused()).toBe("send result unknown");

  const boom = async () => { throw new Error("tmux exit 1"); };
  const strict = createSendGuard("@1", "agent-x", () => true);
  await expect(strict.run(boom, ["send-keys", "-t", "@1", "-l", "--", "go"])).rejects.toThrow("tmux exit 1");
  expect(strict.refused()).toBeNull(); // The launch command's strict failure is still an ordinary launch failure.
  await expect(strict.run(boom, ["send-keys", "-t", "@1", "Enter"], true)).rejects.toBeInstanceOf(SendRefused);
  expect(strict.refused()).toContain("send result unknown");

  const unpinned = createSendGuard("@1", "agent-x", () => true);
  let ran = 0;
  await expect(unpinned.run(async () => { ran++; return ""; }, ["send-keys", "-t", "@2", "Enter"])).rejects.toBeInstanceOf(SendRefused);
  expect(ran).toBe(0);
});

test("the shell term follows the caller: required before launch, dropped for its own launched agent", async () => {
  let launched = false;
  const seen: string[] = [];
  const guard = createSendGuard("@1", "agent-x", () => !launched);
  const exec = async (args: string[]) => { seen.push(args[4]); return ""; };
  await guard.run(exec, ["send-keys", "-t", "@1", "Enter"]);
  launched = true;
  await guard.run(exec, ["send-keys", "-t", "@1", "Enter"]);
  expect(seen).toEqual([sendCondition("@1", "agent-x", true), sendCondition("@1", "agent-x", false)]);
});

/** Real tmuxSendLine in a child with a private HOME / state / runtime and a fake tmux that logs each mutating argv. */
async function sendLine(mode: "plain" | "guarded" | "refuse-literal" | "refuse-enter" | "refuse-cancel") {
  const dir = mkdtempSync(join(tmpdir(), "send-guard-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), runtime = join(dir, "run"), log = join(dir, "argv"), literal = join(dir, "literal");
  for (const path of [bin, state, runtime]) mkdirSync(path);
  writeFileSync(log, "");
  const refuse = mode === "refuse-literal" || mode === "refuse-cancel" ? "true" : mode === "refuse-enter" ? `[ -f '${literal}' ]` : "false";
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *send-keys*)
    case "$*" in *if-shell*) if ${refuse}; then printf '${SEND_REFUSED}\\n'; exit 0; fi ;; esac
    for a in "$@"; do printf '%s\\037' "$a" >> '${log}'; done; printf '\\n' >> '${log}'
    case "$*" in *' -l '*) touch '${literal}' ;; esac ;;
  *list-panes*window_id*) printf '@1\\n' ;;
  *list-panes*) printf '${mode === "refuse-cancel" ? 1 : 0}\\n' ;;
  *capture-pane*) printf 'host repo %% \\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const guard = mode === "plain" ? "undefined" : `(await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib/tmux-send-guard.ts"))})).createSendGuard("@1", "agent-x", () => true)`;
  const script = `const { tmuxSendLine } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib/tmux-helper.ts"))});
const guard = ${guard};
try { await tmuxSendLine("@1", "run 'it' now", 0, true, undefined, guard); console.log("sent"); }
catch (e) { console.log("threw " + (guard?.refused() ?? "other: " + String(e))); }`;
  try {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      env: testChildEnv({ HOME: dir, TMPDIR: dir, PATH: `${bin}:/usr/bin:/bin`, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime }),
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const argv = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split("\x1f").slice(0, -1));
    return { out: out.trim(), err, argv, inputs: readdirSync(runtime).filter((file) => file.endsWith(".input")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("tmuxSendLine without a guard keeps its exact argv", async () => {
  const r = await sendLine("plain");
  expect(r.out).toBe("sent");
  expect(r.argv.map((a) => a.slice(4))).toEqual([["send-keys", "-t", "@1", "-l", "--", "run 'it' now"], ["send-keys", "-t", "@1", "Enter"]]);
  for (const a of r.argv) expect(a.slice(0, 3)).toEqual(["-f", "/dev/null", "-S"]);
  expect(r.inputs).toHaveLength(1);
}, 20_000);

test("tmuxSendLine with a guard sends literal and Enter through the condition, once each", async () => {
  const r = await sendLine("guarded");
  expect(r.out).toBe("sent");
  const condition = sendCondition("@1", "agent-x", true), no = `display-message -p ${SEND_REFUSED}`;
  expect(r.argv.map((a) => a.slice(4))).toEqual([
    ["if-shell", "-F", "-t", "@1", condition, `send-keys -t @1 -l -- 'run '\\''it'\\'' now'`, no],
    ["if-shell", "-F", "-t", "@1", condition, "send-keys -t @1 Enter", no],
  ]);
  expect(r.inputs).toHaveLength(1);
}, 20_000);

test("a refused cancel or literal sends nothing and records no input; a refused Enter leaves the one literal", async () => {
  for (const mode of ["refuse-cancel", "refuse-literal"] as const) {
    const r = await sendLine(mode);
    expect(r.out).toStartWith("threw window rebound");
    expect(r.argv).toEqual([]);
    expect(r.inputs).toHaveLength(0);
  }
  const r = await sendLine("refuse-enter");
  expect(r.out).toStartWith("threw window rebound");
  expect(r.argv).toHaveLength(1);
  expect(r.argv[0][9]).toContain(" -l ");
}, 40_000);

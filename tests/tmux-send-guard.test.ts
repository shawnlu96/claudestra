/** LSTLIVE1: the conditional key send. Unit checks of the condition / argv / latch, then the real tmuxSendLine against a private fake tmux. */
import { testChildEnv } from "./test-env.js";
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { formatTmuxFailure, TmuxCommandError } from "../src/lib/tmux-failure.js";
import { createSendGuard, guardedSendArgs, isShellCommand, sendCondition, SEND_REFUSED, SendRefused } from "../src/lib/tmux-send-guard.js";

test("send condition pins window ID, name and a live pane; the shell term is optional", () => {
  const bare = sendCondition("@7", "agent-x", false);
  expect(bare).toBe("#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{window_name},agent-x},#{==:#{window_id},@7}}}");
  const shell = sendCondition("@7", "agent-x", true);
  expect(shell).toContain(bare.slice("#{&&:".length, -1)); // The identity terms stay inside the shell-gated condition.
  for (const s of ["sh", "bash", "zsh", "fish", "-zsh"]) expect(shell).toContain(`#{==:#{pane_current_command},${s}}`);
  expect(shell).not.toContain("claude");
  for (const bad of [["1", "agent-x"], ["@1", ""], ["@1", "a#[b"], ["@1", "a\\b"], ["@1", "a\nb"]]) expect(() => sendCondition(bad[0], bad[1], true)).toThrow();
});

test("send condition takes every agent name the registry allows: Unicode as is, format separators escaped", () => {
  const nameTerm = (name: string) => sendCondition("@7", name, false).slice("#{&&:#{==:#{pane_dead},0},#{&&:".length, -"#{==:#{window_id},@7}}}".length);
  expect(nameTerm("agent-测试")).toBe("#{==:#{window_name},agent-测试},");
  expect(nameTerm("agent-é😀_x")).toBe("#{==:#{window_name},agent-é😀_x},");
  expect(nameTerm("a,b#c}d")).toBe("#{==:#{window_name},a#,b##c#}d},");
  expect(nameTerm("a#{pane_pid}")).toBe("#{==:#{window_name},a##{pane_pid#}},"); // Never a format of its own.
  expect(sendCondition("@7", "agent-测试", true)).toContain("#{==:#{pane_current_command},zsh}");
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
  // tmux drops a quoted command with a line break before `#` and still exits 0: such text is never handed over.
  expect(() => guardedSendArgs("@1", "agent-x", true, ["send-keys", "-t", "@1", "-l", "--", "a\n# b"])).toThrow();
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

test("unknown results count as not sent and latch; only the strict launch literal keeps its own failure, and no key follows it", async () => {
  const noise = createSendGuard("@1", "agent-x", () => true);
  await expect(noise.run(async () => "something else", ["send-keys", "-t", "@1", "Enter"])).rejects.toBeInstanceOf(SendRefused);
  expect(noise.refused()).toBe("send result unknown");

  let ran = 0;
  const boom = async () => { ran++; throw new Error("tmux exit 2"); };
  const ok = async () => { ran++; return ""; };
  for (const args of [["send-keys", "-t", "@1", "-X", "cancel"], ["send-keys", "-t", "@1", "-l", "--", "go"], ["send-keys", "-t", "@1", "Enter"]]) {
    const unknown = createSendGuard("@1", "agent-x", () => true);
    ran = 0;
    await expect(unknown.run(boom, args)).rejects.toBeInstanceOf(SendRefused);
    expect(unknown.refused()).toContain("send result unknown: Error: tmux exit 2");
    await expect(unknown.run(ok, ["send-keys", "-t", "@1", "Enter"])).rejects.toBeInstanceOf(SendRefused);
    expect(ran).toBe(1);
  }

  // The strict launch literal keeps its own failure only when tmux proved it typed nothing (exit 1-127 with stderr) or never started.
  const literal = ["send-keys", "-t", "@1", "-l", "--", "go"];
  const said = new TmuxCommandError(["send-keys"], 1, "command too long");
  const spawn = Object.assign(new Error("spawn failed"), { code: "ENOENT", syscall: "posix_spawn" });
  for (const known of [said, spawn]) {
    const strict = createSendGuard("@1", "agent-x", () => true);
    ran = 0;
    await expect(strict.run(async () => { ran++; throw known; }, literal, true)).rejects.toBe(known);
    expect(strict.refused()).toBeNull(); // An ordinary launch failure.
    await expect(strict.run(ok, ["send-keys", "-t", "@1", "Enter"])).rejects.toBe(known);
    expect(strict.refused()).toBeNull();
    expect(ran).toBe(1);
  }
  // Killed (timeout SIGKILL: Bun reports 137, a null code is also a signal), a silent non-zero exit, or any other error: unknown.
  for (const unsure of [new TmuxCommandError(["send-keys"], 137, ""), new TmuxCommandError(["send-keys"], null, ""),
    new TmuxCommandError(["send-keys"], 137, "partial"), new TmuxCommandError(["send-keys"], 2, ""), new Error("tmux exit 2")]) {
    const strict = createSendGuard("@1", "agent-x", () => true);
    ran = 0;
    await expect(strict.run(async () => { ran++; throw unsure; }, literal, true)).rejects.toBeInstanceOf(SendRefused);
    expect(strict.refused()).toBe(`send result unknown: ${String(unsure)}`);
    await expect(strict.run(ok, ["send-keys", "-t", "@1", "Enter"])).rejects.toBeInstanceOf(SendRefused);
    expect(ran).toBe(1);
  }

  const unpinned = createSendGuard("@1", "agent-x", () => true);
  ran = 0;
  await expect(unpinned.run(ok, ["send-keys", "-t", "@2", "Enter"])).rejects.toBeInstanceOf(SendRefused);
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
type Mode = "plain" | "guarded" | "refuse-literal" | "refuse-enter" | "refuse-cancel" | "fail-cancel" | "fail-literal" | "fail-enter" | "plain-fail-cancel" | "reject-literal" | "kill-literal";
async function sendLine(mode: Mode, strict = true) {
  const dir = mkdtempSync(join(tmpdir(), "send-guard-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), runtime = join(dir, "run"), log = join(dir, "argv"), literal = join(dir, "literal");
  for (const path of [bin, state, runtime]) mkdirSync(path);
  writeFileSync(log, "");
  const refuse = mode === "refuse-literal" || mode === "refuse-cancel" ? "true" : mode === "refuse-enter" ? `[ -f '${literal}' ]` : "false";
  // `fail-*`: that key's tmux command exits 2 with no output and types nothing, the result a swallowing exec cannot tell from a send.
  const fail = mode.endsWith("fail-cancel") ? "*' -X cancel'*" : mode === "fail-literal" ? "*' -l '*" : mode === "fail-enter" ? "*Enter*" : "";
  // `reject-literal`: tmux says why and exits 1 (nothing typed, provably). `kill-literal`: the client dies by SIGKILL with no
  // output, exactly what the 15 s timer leaves (exit 137), so whether tmux ran the key is unknown.
  const literalEnd = mode === "reject-literal" ? `printf 'command too long\\n' >&2; exit 1` : mode === "kill-literal" ? "kill -9 $$" : "";
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *send-keys*)
    ${fail ? `case "$*" in ${fail}) exit 2 ;; esac` : ""}
    ${literalEnd ? `case "$*" in *' -l '*) ${literalEnd} ;; esac` : ""}
    case "$*" in *if-shell*) if ${refuse}; then printf '${SEND_REFUSED}\\n'; exit 0; fi ;; esac
    for a in "$@"; do printf '%s\\037' "$a" >> '${log}'; done; printf '\\n' >> '${log}'
    case "$*" in *' -l '*) touch '${literal}' ;; esac ;;
  *list-panes*window_id*) printf '@1\\n' ;;
  *list-panes*pane_active*) printf '1\\t%%1\\n' ;;
  *list-panes*pane_id*) printf '%%1\\n' ;;
  *list-panes*) printf '${mode.endsWith("-cancel") ? 1 : 0}\\n' ;;
  *capture-pane*) printf 'host repo %% \\n' ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const guard = mode.startsWith("plain") ? "undefined" : `(await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib/tmux-send-guard.ts"))})).createSendGuard("@1", "agent-x", () => true)`;
  const script = `const { tmuxSendLine } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib/tmux-helper.ts"))});
const guard = ${guard};
try { await tmuxSendLine("@1", "run 'it' now", 0, ${strict}, undefined, guard); console.log("sent"); }
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
  expect(r.argv.map((a) => a.slice(4))).toEqual([["send-keys", "-t", "%1", "-l", "--", "run 'it' now"], ["send-keys", "-t", "%1", "Enter"]]);
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

test("a conditional key whose tmux command fails is unknown: nothing follows it, strict or not", async () => {
  for (const strict of [true, false]) {
    const cancel = await sendLine("fail-cancel", strict);
    expect(cancel.out).toStartWith("threw send result unknown");
    expect(cancel.argv).toEqual([]);
    expect(cancel.inputs).toHaveLength(0);
    const enter = await sendLine("fail-enter", strict);
    expect(enter.out).toStartWith("threw send result unknown");
    expect(enter.argv).toHaveLength(1);
  }
  const loose = await sendLine("fail-literal", false);
  expect(loose.out).toStartWith("threw send result unknown");
  expect(loose.argv).toEqual([]);
  expect(loose.inputs).toHaveLength(0);
  // The strict launch literal exiting 2 with no stderr: tmux gave no reason, so the send is unknown too (LSTLIVE1F).
  const launch = await sendLine("fail-literal", true);
  expect(launch.out).toStartWith("threw send result unknown: Error: tmux ");
  expect(launch.argv).toEqual([]);
  expect(launch.inputs).toHaveLength(0);
}, 60_000);

test("the strict launch literal: a stated tmux failure stays the launch error, a killed client is unknown; no Enter either way", async () => {
  const rejected = await sendLine("reject-literal", true);
  expect(rejected.out).toStartWith("threw other: Error: tmux ");
  expect(rejected.out).toEndWith("失败（exit 1）：command too long");
  expect(rejected.argv).toEqual([]);
  expect(rejected.inputs).toHaveLength(0);
  const killed = await sendLine("kill-literal", true);
  expect(killed.out).toStartWith("threw send result unknown: Error: tmux ");
  expect(killed.out).toEndWith("失败（exit 137）：（无 stderr 输出）");
  expect(killed.argv).toEqual([]);
  expect(killed.inputs).toHaveLength(0);
}, 40_000);

test("TmuxCommandError keeps formatTmuxFailure's exact message and carries the exit code and stderr", () => {
  const args = ["send-keys", "-t", "@1", "-l", "--", "x"];
  const timeout = new TmuxCommandError(args, null, "");
  expect(timeout.message).toBe("tmux send-keys -t @1 -l -- x 失败（exit null）：（超时被杀，无输出）");
  expect(timeout.message).toBe(formatTmuxFailure(args, null, ""));
  const silent = new TmuxCommandError(args, 2, "");
  expect(silent.message).toBe("tmux send-keys -t @1 -l -- x 失败（exit 2）：（无 stderr 输出）");
  const stated = new TmuxCommandError(args, 1, "command too long");
  expect(stated.message).toBe("tmux send-keys -t @1 -l -- x 失败（exit 1）：command too long");
  expect(String(stated)).toBe(`Error: ${stated.message}`);
  expect([stated.code, stated.stderr, stated.refusedByTmux]).toEqual([1, "command too long", true]);
  expect([timeout, silent, new TmuxCommandError(args, 137, ""), new TmuxCommandError(args, 137, "x")].map((e) => e.refusedByTmux))
    .toEqual([false, false, false, false]);
});

test("without a guard a failed cancel keeps the historical best-effort send", async () => {
  const r = await sendLine("plain-fail-cancel");
  expect(r.out.split("\n").at(-1)).toBe("sent");
  expect(r.argv.map((a) => a.slice(4))).toEqual([["send-keys", "-t", "%1", "-l", "--", "run 'it' now"], ["send-keys", "-t", "%1", "Enter"]]);
}, 20_000);

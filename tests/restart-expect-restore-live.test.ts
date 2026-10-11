/**
 * LSTLIVE1: the same session and window ID revive inside the second identity read of the last pre-key check.
 * Real manager CLI + canonical tmuxSendLine; tmux / ps / registry are private fakes. From the revival on, ps reports a real child.
 * `late-*` (review P1) swap the session or the window binding inside the final child probe, with ps truthfully empty.
 * `revive-final` revives inside the identity read after that probe: only the key's own tmux-side condition can refuse it,
 * so the fake evaluates that condition at the moment send-keys runs.
 * `key-unknown` (review P1): the armed phase's own conditional key exits 2 with no output and types nothing.
 * `model-unknown`: the launch succeeds, then the model literal does the same. `AGENT` may be a Unicode name.
 */
import { testChildEnv } from "./test-env.js";
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { restoreObservations } from "../src/manager/restart-expect-restore.js";
import { LauncherRestoreGate } from "../src/lib/launcher-restore-gate.js";
import { SEND_REFUSED } from "../src/lib/tmux-send-guard.js";

type Phase = "cancel" | "literal" | "enter";
type Kind = "revive" | "session" | "ps-unknown" | "window-gone" | "stable" | "late-session" | "late-window" | "revive-final" | "key-unknown" | "model-unknown";
const revives = (kind: Kind) => kind === "revive" || kind === "revive-final";
const MARK = "== injected ==", FAILED = "== key failed, nothing typed ==";

/**
 * `arm` is the first tmux call that only this phase's key preparation makes. The injection fires in the 2nd inventory read
 * after it, in the child probe's pane query after that read (`late-*`), or in the 3rd inventory read (`revive-final`).
 */
function fakeTmux(phase: Phase, kind: Kind, p: Record<string, string>, name: string): string {
  const arm = `[ -f '${p.armed}' ] || printf 0 > '${p.armed}'`;
  const inject = kind === "session" || kind === "late-session" ? `cp '${p.replacement}' '${p.registry}'`
    : kind === "late-window" ? `touch '${p.rebound}'` : kind === "stable" || kind.endsWith("-unknown") && kind !== "ps-unknown" ? ":" : `touch '${p.injected}'`;
  const failing = kind === "model-unknown" ? "*'/model '*" : kind !== "key-unknown" ? "" : phase === "cancel" ? "*' -X cancel'*" : phase === "literal" ? "*' -l '*" : "*Enter*";
  const fire = `touch '${p.fired}'; printf '%s\\n' '${MARK}' >> '${p.log}'; ${inject}`;
  const late = kind.startsWith("late-");
  return `#!/bin/sh
case "$*" in
  *list-windows*window_id*)
    if [ -f '${p.armed}' ] && [ ! -f '${p.fired}' ]; then
      n=$(cat '${p.armed}'); n=$((n + 1)); printf '%s' "$n" > '${p.armed}'
      if ${!late} && [ "$n" -eq ${kind === "revive-final" ? 3 : 2} ]; then ${fire}; fi
    fi
    if [ -f '${p.rebound}' ]; then printf 'agent-old\\t@1\\n${name}\\t@2\\n'; else printf '${name}\\t@1\\n'; fi ;;
  *list-windows*) printf '${name}\\n' ;;
  *capture-pane*)
    if [ -f '${p.ready}' ] || { [ -f '${p.injected}' ] && ${revives(kind)}; }; then printf '❯ \\nbypass permissions on\\n'
    else printf 'host repo %% \\n'; fi ;;
  *list-panes*pane_pid*)
    if [ -f '${p.injected}' ] && [ '${kind}' = window-gone ]; then exit 1; fi
    if ${late} && [ -f '${p.armed}' ] && [ ! -f '${p.fired}' ] && [ "$(cat '${p.armed}')" -ge 2 ]; then ${fire}; fi
    printf '12345\\n' ;;
  *list-panes*window_id*) ${phase === "literal" ? arm : ":"}; printf '@1\\n' ;;
  *list-panes*) ${phase === "cancel" ? `${arm}; printf '1\\n'` : `printf '0\\n'`} ;;
  *send-keys*)
    # The conditional send is decided here, when the key is due: a rebound window or a foreground agent sends nothing.
    case "$*" in *if-shell*)
      if [ -f '${p.rebound}' ] || { [ -f '${p.injected}' ] && ${revives(kind) || kind === "window-gone"}; }; then printf '${SEND_REFUSED}\\n'; exit 0; fi ;;
    esac
    ${failing ? `case "$*" in ${failing}) printf '%s\\n' '${FAILED}' >> '${p.log}'; exit 2 ;; esac` : ""}
    printf '%s\\n' "$*" >> '${p.log}'
    case "$*" in
      *' -l '*) ${phase === "enter" ? arm : ":"} ;;
      *Enter*) /bin/rm -f '${p.state}/run/caller-cred/'*.cred; touch '${p.ready}' ;;
    esac ;;
  *new-window*|*kill-window*) printf '%s\\n' "$*" >> '${p.log}' ;;
esac
`;
}

async function run(phase: Phase, kind: Kind, heldLock = false, name = "agent-test") {
  const dir = mkdtempSync(join(tmpdir(), "lstlive1-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), runtime = join(dir, "run");
  for (const path of [bin, state, runtime]) mkdirSync(path);
  const p = { log: join(dir, "keys"), armed: join(dir, "armed"), fired: join(dir, "fired"), injected: join(dir, "injected"), rebound: join(dir, "rebound"),
    ready: join(dir, "ready"), replacement: join(dir, "replacement.json"), registry: join(state, "registry.json"), state };
  writeFileSync(p.log, "");
  if (heldLock) { mkdirSync(join(state, "locks")); writeFileSync(join(state, `locks/restart-${name}.lock`), `${process.pid}\n${Date.now()}`); }
  writeFileSync(join(bin, "tmux"), fakeTmux(phase, kind, p, name));
  // The revived agent is a real child of the pane shell from the injection on; it is never reported absent again.
  writeFileSync(join(bin, "ps"), `#!/bin/sh
if [ -f '${p.injected}' ] && [ '${kind}' = ps-unknown ]; then exit 2; fi
if [ -f '${p.injected}' ] && ${revives(kind)}; then printf '12345\\n'; fi
exit 0
`);
  for (const tool of ["tmux", "ps"]) chmodSync(join(bin, tool), 0o755);
  const row = { sessionId: "s", channelId: "c", status: "active", cwd: dir, ...(kind === "model-unknown" ? { model: "claude-sonnet-5" } : {}) };
  writeFileSync(p.registry, JSON.stringify({ agents: { [name]: row } }));
  writeFileSync(p.replacement, JSON.stringify({ agents: { [name]: { ...row, sessionId: "new" } } }));
  const raw = (await restoreObservations({ [name]: row }, {
    registry: async () => ({ [name]: row }), windows: async () => ({ [name]: ["@1"] }), dead: async () => true, children: async () => false,
  }))[name];
  const path = join(dir, "gate.json");
  const gate = new LauncherRestoreGate({ path, alert: async () => true, log: () => {} });
  try {
    const [agent] = await gate.select([{ ...row, name, status: "dead" }]);
    const why = await gate.restart(agent, async () => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", process.env.LSTLIVE1_MANAGER_ENTRY
        ?? resolve(import.meta.dir, "../src/manager.ts"), "restart", "--restore-expect", raw, "--", agent.name], {
        env: testChildEnv({ HOME: dir, TMPDIR: dir, PATH: `${bin}:/usr/bin:/bin`, CLAUDESTRA_STATE_DIR: state,
          CLAUDESTRA_RUNTIME_DIR: runtime, BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9" }), stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 12_000);
      try {
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { ok: code === 0, out, err };
      } finally { clearTimeout(timer); }
    });
    const keys = readFileSync(p.log, "utf8").split("\n").filter(Boolean);
    const at = keys.indexOf(MARK);
    const locks = existsSync(join(state, "locks")) ? readdirSync(join(state, "locks")) : [];
    return { why, fired: existsSync(p.fired), before: at < 0 ? keys : keys.slice(0, at), after: at < 0 ? [] : keys.slice(at + 1),
      inputs: readdirSync(runtime).filter((file) => file.endsWith(".input")), locks,
      failures: JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures as number };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const literal = (line: string) => line.includes(" -l ") && line.includes("-t @1");

for (const phase of ["cancel", "literal", "enter"] as const) {
  for (const kind of ["revive", "session", "ps-unknown", "window-gone", "late-session", "late-window", "revive-final"] as const) {
    const where = kind.startsWith("late-") ? "final child probe" : kind === "revive-final" ? "final identity read" : "second identity read";
    test(`LSTLIVE1 ${kind} in the ${where} before ${phase}: no key after it, skipped, no budget`, async () => {
      const r = await run(phase, kind);
      expect(r.fired).toBe(true);
      expect(r.after).toEqual([]);
      // The literal sent before the Enter check was legitimate and is reported, not hidden: exactly one, never repeated.
      expect(r.before).toHaveLength(phase === "enter" ? 1 : 0);
      if (phase === "enter") expect(literal(r.before[0])).toBe(true);
      else expect(r.inputs).toHaveLength(0);
      expect(r.why).toStartWith("skipped:");
      expect(r.failures).toBe(0);
      expect(r.locks).toEqual([]);
    }, 20_000);
  }

  test(`LSTLIVE1 stable dead target with the ${phase} probe armed still launches exactly once`, async () => {
    const r = await run(phase, "stable");
    expect(r.fired).toBe(true);
    const keys = [...r.before, ...r.after];
    expect(keys.filter(literal)).toHaveLength(1);
    expect(keys.filter((line) => line.includes("Enter"))).toHaveLength(1);
    expect(keys.filter((line) => line.includes("-X cancel"))).toHaveLength(phase === "cancel" ? 1 : 0);
    expect(keys).toHaveLength(phase === "cancel" ? 3 : 2);
    expect(keys.every((line) => line.includes("-t @1"))).toBe(true);
    expect(r.why).toBeNull();
    expect(r.failures).toBe(0);
    expect(r.locks).toEqual([]);
  }, 20_000);
}

test("LSTLIVE1 another holder of the per-target restart lock: no key, lock left to its owner, not a success", async () => {
  const r = await run("enter", "stable", true);
  expect(r.fired).toBe(false);
  expect([...r.before, ...r.after]).toEqual([]);
  expect(r.why).not.toBeNull();
  expect(r.locks).toEqual(["restart-agent-test.lock"]);
}, 20_000);

// Review P1 unknown-send: a conditional key that tmux fails to run leaves no proof of a send, so nothing may follow it.
for (const phase of ["cancel", "literal", "enter"] as const) {
  test(`LSTLIVE1 the ${phase} key's own tmux command fails: no later key${phase === "literal" ? ", the historical launch failure" : ", skipped, no budget"}`, async () => {
    const r = await run(phase, "key-unknown");
    const keys = [...r.before, ...r.after];
    expect(keys.filter((line) => line === FAILED)).toHaveLength(1);
    expect(keys.at(-1)).toBe(FAILED);
    expect(keys.slice(0, -1).filter(literal)).toHaveLength(phase === "enter" ? 1 : 0);
    expect(keys).toHaveLength(phase === "enter" ? 2 : 1);
    // The strict launch literal's known failure keeps its launch-failure accounting (LSTGUARD1 launch-failure); cancel and Enter are unknown.
    if (phase === "literal") { expect(r.why).not.toBeNull(); expect(r.why).not.toStartWith("skipped:"); expect(r.failures).toBe(1); }
    else { expect(r.why).toStartWith("skipped:"); expect(r.why).toContain("send result unknown"); expect(r.failures).toBe(0); }
    expect(r.locks).toEqual([]);
  }, 20_000);
}

test("LSTLIVE1 the model literal's tmux command fails after a good launch: no model Enter, skipped, no budget", async () => {
  const r = await run("enter", "model-unknown");
  const keys = [...r.before, ...r.after].filter((line) => line !== MARK);
  expect(keys).toHaveLength(3);
  expect(literal(keys[0])).toBe(true);
  expect(keys[1]).toContain("Enter");
  expect(keys[2]).toBe(FAILED);
  expect(r.why).toStartWith("skipped:");
  expect(r.why).toContain("send result unknown");
  expect(r.failures).toBe(0);
  expect(r.locks).toEqual([]);
}, 20_000);

// Review P1 unicode-target: a stable dead agent with a registry-legal Unicode name still launches exactly once.
for (const name of ["agent-测试", "agent-é_x,1#2"]) {
  test(`LSTLIVE1 stable dead ${name} launches exactly once under the condition`, async () => {
    const r = await run("enter", "stable", false, name);
    const keys = [...r.before, ...r.after];
    expect(keys.filter(literal)).toHaveLength(1);
    expect(keys.filter((line) => line.includes("Enter"))).toHaveLength(1);
    expect(keys).toHaveLength(2);
    expect(keys.every((line) => line.includes("if-shell -F -t @1") && line.includes("#{==:#{window_name},"))).toBe(true);
    expect(r.why).toBeNull();
    expect(r.failures).toBe(0);
    expect(r.locks).toEqual([]);
  }, 20_000);
}

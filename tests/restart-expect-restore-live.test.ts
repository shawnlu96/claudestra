/**
 * LSTLIVE1: the same session and window ID revive inside the second identity read of the last pre-key check.
 * Real manager CLI + canonical tmuxSendLine; tmux / ps / registry are private fakes. From the revival on, ps reports a real child.
 */
import { testChildEnv } from "./test-env.js";
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { restoreObservations } from "../src/manager/restart-expect-restore.js";
import { LauncherRestoreGate } from "../src/lib/launcher-restore-gate.js";

type Phase = "cancel" | "literal" | "enter";
type Kind = "revive" | "session" | "ps-unknown" | "window-gone" | "stable";
const MARK = "== injected ==";

/** `arm` is the first tmux call that only this phase's key preparation makes; the injection fires in the 2nd inventory read after it. */
function fakeTmux(phase: Phase, kind: Kind, p: Record<string, string>): string {
  const arm = `[ -f '${p.armed}' ] || printf 0 > '${p.armed}'`;
  const inject = kind === "session" ? `cp '${p.replacement}' '${p.registry}'` : kind === "stable" ? ":" : `touch '${p.injected}'`;
  return `#!/bin/sh
case "$*" in
  *list-windows*window_id*)
    if [ -f '${p.armed}' ] && [ ! -f '${p.fired}' ]; then
      n=$(cat '${p.armed}'); n=$((n + 1)); printf '%s' "$n" > '${p.armed}'
      if [ "$n" -eq 2 ]; then touch '${p.fired}'; printf '%s\\n' '${MARK}' >> '${p.log}'; ${inject}; fi
    fi
    printf 'agent-test\\t@1\\n' ;;
  *list-windows*) printf 'agent-test\\n' ;;
  *capture-pane*)
    if [ -f '${p.ready}' ] || { [ -f '${p.injected}' ] && [ '${kind}' = revive ]; }; then printf '❯ \\nbypass permissions on\\n'
    else printf 'host repo %% \\n'; fi ;;
  *list-panes*pane_pid*)
    if [ -f '${p.injected}' ] && [ '${kind}' = window-gone ]; then exit 1; fi
    printf '12345\\n' ;;
  *list-panes*window_id*) ${phase === "literal" ? arm : ":"}; printf '@1\\n' ;;
  *list-panes*) ${phase === "cancel" ? `${arm}; printf '1\\n'` : `printf '0\\n'`} ;;
  *send-keys*)
    printf '%s\\n' "$*" >> '${p.log}'
    case "$*" in
      *' -l '*) ${phase === "enter" ? arm : ":"} ;;
      *Enter*) /bin/rm -f '${p.state}/run/caller-cred/'*.cred; touch '${p.ready}' ;;
    esac ;;
  *new-window*|*kill-window*) printf '%s\\n' "$*" >> '${p.log}' ;;
esac
`;
}

async function run(phase: Phase, kind: Kind, heldLock = false) {
  const dir = mkdtempSync(join(tmpdir(), "lstlive1-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), runtime = join(dir, "run");
  for (const path of [bin, state, runtime]) mkdirSync(path);
  const p = { log: join(dir, "keys"), armed: join(dir, "armed"), fired: join(dir, "fired"), injected: join(dir, "injected"),
    ready: join(dir, "ready"), replacement: join(dir, "replacement.json"), registry: join(state, "registry.json"), state };
  writeFileSync(p.log, "");
  if (heldLock) { mkdirSync(join(state, "locks")); writeFileSync(join(state, "locks/restart-agent-test.lock"), `${process.pid}\n${Date.now()}`); }
  writeFileSync(join(bin, "tmux"), fakeTmux(phase, kind, p));
  // The revived agent is a real child of the pane shell from the injection on; it is never reported absent again.
  writeFileSync(join(bin, "ps"), `#!/bin/sh
if [ -f '${p.injected}' ] && [ '${kind}' = ps-unknown ]; then exit 2; fi
if [ -f '${p.injected}' ] && [ '${kind}' = revive ]; then printf '12345\\n'; fi
exit 0
`);
  for (const tool of ["tmux", "ps"]) chmodSync(join(bin, tool), 0o755);
  const row = { sessionId: "s", channelId: "c", status: "active", cwd: dir };
  writeFileSync(p.registry, JSON.stringify({ agents: { "agent-test": row } }));
  writeFileSync(p.replacement, JSON.stringify({ agents: { "agent-test": { ...row, sessionId: "new" } } }));
  const raw = (await restoreObservations({ "agent-test": row }, {
    registry: async () => ({ "agent-test": row }), windows: async () => ({ "agent-test": ["@1"] }), dead: async () => true, children: async () => false,
  }))["agent-test"];
  const path = join(dir, "gate.json");
  const gate = new LauncherRestoreGate({ path, alert: async () => true, log: () => {} });
  try {
    const [agent] = await gate.select([{ ...row, name: "agent-test", status: "dead" }]);
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
  for (const kind of ["revive", "session", "ps-unknown", "window-gone"] as const) {
    test(`LSTLIVE1 ${kind} in the second identity read before ${phase}: no key after it, skipped, no budget`, async () => {
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

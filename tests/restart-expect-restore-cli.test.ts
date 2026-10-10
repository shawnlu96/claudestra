import { testChildEnv } from "./test-env.js";
import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { restoreObservations } from "../src/manager/restart-expect-restore.js";
import { LauncherRestoreGate } from "../src/lib/launcher-restore-gate.js";

function fakeTmux(mode: string, paths: Record<string, string>): string {
  const { count, replacement, state, drift, log, ready, modelEntered, modelLiteral, applied, prompt, settings } = paths;
  return `#!/bin/sh
case "$*" in
  *list-windows*window_id*)
    n=$(cat '${count}'); n=$((n + 1)); printf '%s' "$n" > '${count}'
    if [ -f '${drift}' ] && ${['model-before-window', 'model-between-window'].includes(mode) ? 'true' : 'false'}; then
      printf 'agent-test\\t@2\\n'; exit 0; fi
    if [ '${mode}' = missing-id ]; then printf 'master\\t@0\\n'; exit 0; fi
    if [ "$n" -ge 5 ]; then
      ${mode === 'late-session' ? `cp '${replacement}' '${join(state, 'registry.json')}'` : ':'}
      ${mode === 'late-window' ? `printf 'agent-test\\t@2\\n'; exit 0` : ':'}
    fi
    printf 'agent-test\\t@1\\n' ;;

  *list-windows*) printf '${mode === 'missing-id' ? 'master' : 'agent-test'}\\n' ;;
  *capture-pane*)
    if [ -f '${ready}' ] && ${mode.startsWith('model-') ? 'true' : 'false'}; then
      case "$*" in
        *-120*)
          ${mode === 'model-before-session' ? `cp '${replacement}' '${join(state, 'registry.json')}'` : mode === 'model-before-window' ? `touch '${drift}'` : ':'}
          ${mode === 'model-capture-fail' ? `printf '{"model":"foreign-new"}' > '${settings}'; exit 2` : ':'}
          if [ -f '${modelEntered}' ]; then
            if [ -f '${applied}' ]; then
              printf '❯ /model claude-sonnet-5\\n  ⎿  Set model to Sonnet 5\\n\\n────────────\\n❯ \\n────────────\\nbypass permissions on\\n';
            else cat '${prompt}'; fi; exit 0; fi ;;
      esac
      printf '❯ \\nbypass permissions on\\n'; exit 0
    fi
    n=$(cat '${count}')
    if [ '${mode}' = recovered ] || { [ '${mode}' = late-recovery ] && [ "$n" -ge 5 ]; } ||
      { [ -f '${drift}' ] && ${['cancel-recovery', 'literal-recovery'].includes(mode) ? 'true' : 'false'}; }; then
      printf 'Agent is working\\n'
    else printf 'host repo %% \\n'; fi ;;
  *list-panes*pane_pid*)
    printf '12345\\n' ;;
  *list-panes*window_id*)
    ${mode.startsWith('literal-') ? (mode === 'literal-session' ? `cp '${replacement}' '${join(state, 'registry.json')}'` : `touch '${drift}'`) : ':'}
    printf '@1\\n' ;;
  *list-panes*)
    ${mode.startsWith('cancel-') ? (mode === 'cancel-session' ? `cp '${replacement}' '${join(state, 'registry.json')}'` : `touch '${drift}'`) : ':'}
    printf '${mode.startsWith('cancel-') ? '1' : '0'}\\n' ;;
  *new-window*) printf '%s\\n' "$*" >> '${log}'; exit 0 ;;
  *send-keys*' -l '*)
    printf '%s\\n' "$*" >> '${log}'
    case "$*" in *'/model '*) touch '${modelLiteral}' ;; esac
    ${mode.startsWith('enter-') ? (mode === 'enter-session' ? `cp '${replacement}' '${join(state, 'registry.json')}'` : `touch '${drift}'`) : ':'}
    exit ${mode.startsWith('enter-') || mode.startsWith('model-') ? '0' : '1'} ;;
  *send-keys*)
    printf '%s\\n' "$*" >> '${log}'
    if ${mode.startsWith('model-') ? 'true' : 'false'}; then
      case "$*" in
        *Up*) ${mode === 'model-between-session' ? `cp '${replacement}' '${join(state, 'registry.json')}'` : mode === 'model-between-window' ? `touch '${drift}'` : ':'} ;;
        *Enter*) if [ ! -f '${ready}' ]; then /bin/rm -f '${state}/run/caller-cred/'*.cred; touch '${ready}';
          elif [ ! -f '${modelEntered}' ]; then touch '${modelEntered}'; else touch '${applied}'; fi ;;
      esac
      exit 0
    fi
    exit 1 ;;
  *kill-window*) printf '%s\\n' "$*" >> '${log}'; exit 1 ;;

esac
`;
}

for (const mode of ["recovered", "late-window", "late-session", "late-recovery", "missing-id", "launch-failure", "cancel-session", "cancel-recovery", "cancel-unknown",
  "literal-session", "literal-recovery", "literal-unknown", "enter-session", "enter-recovery", "enter-unknown", "lock-unknown",
  "model-before-session", "model-before-window", "model-between-session", "model-between-window", "model-capture-fail", "model-valid"] as const) {
test(`LSTGUARD1 real manager ${mode}: safe mutations and correct gate accounting`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lstguard1-cli-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), run = join(dir, "run");
  for (const path of [bin, state, run]) mkdirSync(path);
  const log = join(dir, "mutations");
  writeFileSync(log, "");
  const count = join(dir, "count");
  const replacement = join(dir, "replacement.json");
  writeFileSync(count, "0");
  const drift = join(dir, "drift");
  const ready = join(dir, "ready"), modelEntered = join(dir, "model-entered"), modelLiteral = join(dir, "model-literal"), applied = join(dir, "applied");
  const prompt = join(dir, "model-prompt"), settings = join(dir, ".claude/settings.json");
  writeFileSync(prompt, readFileSync(resolve(import.meta.dir, "fixtures/switch-confirm/cc2.1.280-switch-model.txt"), "utf8")
    .replace("❯ 1. Yes, switch to Sonnet 5", "  1. Yes, switch to Sonnet 5").replace("  2. No, go back", "❯ 2. No, go back"));
  if (mode === "model-capture-fail") { mkdirSync(join(dir, ".claude")); writeFileSync(settings, '{"model":"old-default"}'); }
  writeFileSync(join(bin, "tmux"), fakeTmux(mode, { count, replacement, state, drift, log, ready, modelEntered, modelLiteral, applied, prompt, settings }));
  chmodSync(join(bin, "tmux"), 0o755);
  writeFileSync(join(bin, "ps"), `#!/bin/sh
if [ '${mode}' = lock-unknown ] || { [ -f '${drift}' ] && ${mode.endsWith("unknown") ? "true" : "false"}; }; then exit 2; fi
if [ -f '${drift}' ] && [ '${mode}' = enter-recovery ]; then printf '12345\\n'; fi
exit 0
`);
  chmodSync(join(bin, "ps"), 0o755);
  const row = { sessionId: "s", channelId: "c", status: "active", cwd: dir, ...(mode.startsWith("model-") ? { model: "claude-sonnet-5" } : {}) };
  writeFileSync(join(state, "registry.json"), JSON.stringify({ agents: { "agent-test": row } }));
  writeFileSync(replacement, JSON.stringify({ agents: { "agent-test": { ...row, sessionId: "new" } } }));
  const raw = (await restoreObservations({ "agent-test": row }, {
    registry: async () => ({ "agent-test": row }), windows: async () => ({ "agent-test": mode === "missing-id" ? [] : ["@1"] }), dead: async () => true, children: async () => false,
  }))["agent-test"];
  const path = join(dir, "gate.json");
  const gate = new LauncherRestoreGate({ path, alert: async () => true, log: () => {} });
  try {
    const [agent] = await gate.select([{ ...row, name: "agent-test", status: "dead" }]);
    const why = await gate.restart(agent, async () => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", process.env.LSTGUARD1_MANAGER_ENTRY
        ?? resolve(import.meta.dir, "../src/manager.ts"), "restart", "--restore-expect", raw, "--", agent.name], {
        env: testChildEnv({ HOME: dir, TMPDIR: dir, PATH: `${bin}:/usr/bin:/bin`, CLAUDESTRA_STATE_DIR: state,
          CLAUDESTRA_RUNTIME_DIR: run, BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9" }), stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 8000);
      try {
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { ok: code === 0, out, err };
      } finally { clearTimeout(timer); }
    });
    const mutations = readFileSync(log, "utf8");
    if (mode.startsWith("model-")) {
      const lines = mutations.split("\n").filter(Boolean);
      const count = mode === "model-valid" ? 6 : mode.startsWith("model-between-") ? 5 : 2;
      expect(lines).toHaveLength(count);
      expect(lines.every((line) => line.includes("-t @1"))).toBe(true);
      expect(mutations).not.toContain("new-window");
      if (mode === "model-capture-fail") expect(JSON.parse(readFileSync(settings, "utf8")).model).toBe("foreign-new");
    } else if (mode === "missing-id") {
      expect(mutations.split("\n").filter(Boolean)).toHaveLength(1);
      expect(mutations).toContain("new-window");
    } else if (mode === "launch-failure" || mode.startsWith("enter-")) {
      expect(mutations.split("\n").filter((line) => line.includes(" -l "))).toHaveLength(1);
      expect(mutations).toContain("-t @1");
      expect(mutations).not.toContain("new-window");
      expect(mutations.split("\n").filter(Boolean)).toHaveLength(1);
    } else expect(mutations).toBe("");
    if (mode.startsWith("cancel-") || mode.startsWith("literal-")) {
      expect(readdirSync(run).filter((file) => file.endsWith(".input"))).toHaveLength(0);
    }
    if (mode === "model-valid") expect(why).toBeNull();
    else if (mode === "launch-failure") expect(why).not.toStartWith("skipped:");
    else expect(why).toStartWith("skipped:");
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(mode === "launch-failure" ? 1 : 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

}

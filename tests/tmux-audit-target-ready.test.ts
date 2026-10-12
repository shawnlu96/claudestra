/**
 * TMUXPIN1: setWindowOption reports what tmux really did, and a ready marker that could not be reset aborts the launch.
 * The real setWindowOption / adapters run in a child against a fake tmux whose window option starts at a stale "1".
 */
import { testChildEnv } from "./test-env.js";
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { resetReadyOption } from "../src/lib/runtimes/ready-option.js";
import type { WindowOps } from "../src/lib/runtimes/types.js";

/** `exit1`: tmux states a reason and exits 1. `silent2`: exits 2 with no output. `hang`: never answers (the timer kills it). */
type Mode = "ok" | "exit1" | "silent2" | "hang";
type Runtime = "pi" | "codex" | "codex-acp";
const OPTION = "@claudestra_ready";
const src = (path: string) => JSON.stringify(resolve(import.meta.dir, "../src", path));

function fakeTmux(dir: string, mode: Mode): string {
  const set = mode === "ok" ? `printf '%s' "$value" > "$d/option"` : mode === "exit1" ? `printf 'no such window: @1\\n' >&2; exit 1`
    : mode === "silent2" ? "exit 2" : "exec sleep 30";
  return `#!/bin/sh
d='${dir}'
shift 4
for value in "$@"; do :; done
case "$1" in
  set-option) printf '%s\\n' "$*" >> "$d/sets"; ${set} ;;
  show-options) cat "$d/option" ;;
  capture-pane) printf 'starting\\n' ;;
esac
`;
}

/** Runs `body` (an async function body that returns a JSON value) in a child wired to the fake tmux. Only `hang` shortens the 15 s tmux timer. */
async function inChild(mode: Mode, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "audit-ready-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), runtime = join(dir, "run");
  for (const path of [bin, state, runtime]) mkdirSync(path);
  writeFileSync(join(dir, "option"), "1");
  writeFileSync(join(bin, "tmux"), fakeTmux(dir, mode));
  chmodSync(join(bin, "tmux"), 0o755);
  const script = `const optionFile = ${JSON.stringify(join(dir, "option"))};
const { setWindowOption } = await import(${src("lib/tmux-helper.ts")});
const { tmuxWindowOps } = await import(${src("lib/runtimes/window-ops.ts")});
const win = { ...tmuxWindowOps("agent-x", "@1"), sleep: async () => {}, setOption: (k, v) => setWindowOption("@1", k, v, ${mode === "hang" ? 400 : "undefined"}) };
console.log("RESULT " + JSON.stringify(await (async () => { ${body} })()));`;
  try {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      env: testChildEnv({ HOME: dir, TMPDIR: dir, PATH: `${bin}:/usr/bin:/bin`, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime }),
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`child printed no result: ${err.slice(-800)}`);
    return { result: JSON.parse(line.slice(7)), err };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ADAPTER: Record<Runtime, string> = {
  pi: `(await import(${src("lib/runtimes/pi.ts")})).piAdapter`,
  codex: `(await import(${src("lib/runtimes/codex.ts")})).createCodexAdapter({ resolveBin: async () => "/x/codex", run: async () => ({ ok: true, out: "codex-cli 1.0.0", err: "" }) })`,
  "codex-acp": `(await import(${src("lib/runtimes/codex-acp.ts")})).createCodexAcpAdapter({ resolveBin: async () => "/x/codex" })`,
};

/** The launch flow of manager.ts launchInWindow: beforeLaunch, then (the session's client may write "1"), then waitReady. */
const launch = (runtime: Runtime, mode: Mode, clientWrites: boolean) => inChild(mode, `const adapter = ${ADAPTER[runtime]};
try { await adapter.beforeLaunch(win); } catch (e) { return { aborted: String(e.message) }; }
${clientWrites ? `(await import("fs")).writeFileSync(optionFile, "1");` : ""}
return { ready: (await adapter.waitReady(win, { rounds: 3, pollMs: 1 })).ready };`);

test("[验收线 2] setWindowOption: a non-zero exit or a timeout is not a success and is logged", async () => {
  for (const mode of ["exit1", "silent2", "hang"] as const) {
    const r = await inChild(mode, `return { ok: await setWindowOption("@1", "${OPTION}", "0", 400), now: await win.getOption("${OPTION}") };`);
    expect(r.result).toEqual({ ok: false, now: "1" });
    expect(r.err).toContain(`tmux set-option ${OPTION} on @1 失败`);
  }
  const ok = await inChild("ok", `return { ok: await setWindowOption("@1", "${OPTION}", "0"), now: await win.getOption("${OPTION}") };`);
  expect(ok.result).toEqual({ ok: true, now: "0" });
  expect(ok.err).not.toContain("失败");
}, 60_000);

for (const runtime of ["pi", "codex", "codex-acp"] as const) {
  test(`[验收线 2] ${runtime}: a reset that failed aborts the launch, the stale 1 never confirms it`, async () => {
    for (const mode of ["exit1", "hang"] as const) {
      const r = await launch(runtime, mode, false);
      expect(r.result.ready).toBeUndefined();
      expect(r.result.aborted).toContain(`清不掉 agent-x 的 ${OPTION}`);
    }
  }, 60_000);

  test(`[验收线 2] ${runtime}: a real reset then waits for a new 1`, async () => {
    expect((await launch(runtime, "ok", false)).result).toEqual({ ready: false }); // the stale 1 is gone
    expect((await launch(runtime, "ok", true)).result).toEqual({ ready: true });
  }, 60_000);
}

test("resetReadyOption writes 0 once and throws only when the write reports failure", async () => {
  const calls: string[] = [];
  const win = (ok: boolean) => ({ name: "agent-y", setOption: async (k: string, v: string) => (calls.push(`${k}=${v}`), ok) }) as unknown as WindowOps;
  await resetReadyOption(win(true), OPTION);
  await expect(resetReadyOption(win(false), OPTION)).rejects.toThrow("中止本次启动");
  expect(calls).toEqual([`${OPTION}=0`, `${OPTION}=0`]);
});

/**
 * T68h r1 P1-1 / P1-2: a child of the scheduler service (manager create) that loses the lease *after* its last check but
 * before its effect lands sends nothing. The real bridge client and the real tmux helpers run in a child process with the
 * lease in its env; the lease is lost while the child is inside an await (the WebSocket handshake, a tmux query, the gap
 * between the literal and Enter). Frames go to a stub bridge on a free port; tmux is a PATH stand-in that only logs argv.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { acquireLock, lockOwnedBy } from "../src/lib/file-lock.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { encodeLease, SCHEDULER_LEASE_ENV } from "../src/lib/scheduler-lease-env.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

async function world() {
  const root = mkdtempSync(join(tmpdir(), "t68h-effects-")); roots.push(root);
  for (const d of ["home", "state", "run", "bin"]) mkdirSync(join(root, d));
  const pid = join(root, "state", "scheduler.pid"), maint = join(root, "state", "scheduler-maintenance.lock");
  const a = (await acquireLock(pid, 0))!, b = (await acquireLock(maint, 0))!;
  const lease = encodeLease({ singleton: { path: pid, token: a.token }, maintenance: { path: maint, token: b.token } });
  const stops: Record<string, () => void> = {
    "SIGTERM (scheduler.pid released)": () => a.release(),
    "scheduler.pid taken over": () => writeFileSync(join(pid, "owner"), "another-scheduler"),
    "maintenance lease taken over": () => writeFileSync(join(maint, "owner"), "update-took-over"),
  };
  const release = () => { for (const [l, p] of [[a, pid], [b, maint]] as const) if (lockOwnedBy(p, l.token)) l.release(); }; // a stopped one is not ours
  return { root, lease, stops, release };
}

const STOPS = ["SIGTERM (scheduler.pid released)", "scheduler.pid taken over", "maintenance lease taken over"];

/** Runs `code` (after the lease is adopted) in a fresh bun under env -i; resolves with its last stdout line as JSON. */
function child(root: string, lease: string, code: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { HOME: join(root, "home"), PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, TMPDIR: root,
    CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run"), [SCHEDULER_LEASE_ENV]: lease, ...extra };
  const script = `import { adoptSchedulerLease } from "${REPO_ROOT}/src/lib/scheduler-lease-env.ts";
adoptSchedulerLease();
try { const r = await (async () => { ${code} })(); console.log(JSON.stringify({ ok: true, r })); }
catch (e) { console.log(JSON.stringify({ ok: false, name: e.constructor.name, error: e.message })); }`;
  const p = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", "-e", script],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  return (async () => {
    const out = await new Response(p.stdout).text();
    await p.exited;
    return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { ok: boolean; name?: string; error?: string };
  })();
}

describe("P1-1: a bridge frame is not sent once the lease is lost during the WebSocket handshake", () => {
  /** A stub bridge that loses the lease (`stop`) as the client connects, then holds the handshake 350ms before completing it. */
  async function handshake(stop: string | null, call: string) {
    const w = await world();
    const frames: { type: string }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req, s) {
      if (stop) w.stops[stop]();
      await Bun.sleep(350); // the client is connected and waiting in the handshake: no frame can have been sent yet
      return s.upgrade(req) ? undefined : new Response("stub");
    }, websocket: { message(ws, msg) {
      const f = JSON.parse(String(msg)); frames.push(f); ws.send(JSON.stringify({ requestId: f.requestId, result: { channelId: "c1" } }));
    } } });
    try {
      const r = await child(w.root, w.lease, `const c = await import("${REPO_ROOT}/src/lib/bridge-client.ts"); return c.${call};`,
        { BRIDGE_URL: `ws://127.0.0.1:${server.port}` });
      return { r, frames };
    } finally { server.stop(true); w.release(); }
  }
  const create = `bridgeRequest({ type: "create_channel", name: "probe" })`;

  for (const stop of STOPS) {
    test(`${stop}: bridgeRequest rejects with SchedulerLeaseLost and the stub receives no create_channel`, async () => {
      const { r, frames } = await handshake(stop, create);
      expect(frames).toEqual([]);
      expect(r).toMatchObject({ ok: false, name: "SchedulerLeaseLost" });
    }, 20_000);
  }

  test("bridgeSend (orders) refuses the same way: sent=false, no frame", async () => {
    const { r, frames } = await handshake("scheduler.pid taken over", `bridgeSend({ type: "route_to_agent", targetName: "x" })`);
    expect(r).toMatchObject({ ok: true, r: { ok: false, sent: false } });
    expect(frames).toEqual([]);
  }, 20_000);

  test("positive control: nothing stops, the same request sends its frame", async () => {
    const { r, frames } = await handshake(null, create);
    expect(r).toMatchObject({ ok: true, r: { channelId: "c1" } });
    expect(frames.map((f) => f.type)).toEqual(["create_channel"]);
  }, 20_000);
});

describe("P1-2: tmux keys are not sent once the lease is lost inside a compound send", () => {
  /** tmux stand-in: logs argv, answers the queries tmuxSendLine makes, and is slow enough for the lease to go mid-flight. */
  function fakeTmux(root: string): string {
    const log = join(root, "tmux.log"), bin = join(root, "bin", "tmux");
    writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *pane_in_mode*) sleep 0.3; echo 0 ;;
  *window_id*) sleep 0.3; echo @1 ;;
  *capture-pane*) sleep 0.2 ;;
esac
`);
    chmodSync(bin, 0o755);
    return log;
  }
  const lines = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const keysIn = (log: string) => lines(log).filter((l) => l.includes("send-keys"));

  async function run(method: "sendLine" | "sendLiteral", stopWhen: ((log: string) => boolean) | null, stop: string) {
    const w = await world();
    const log = fakeTmux(w.root);
    const pending = child(w.root, w.lease, `const { tmuxWindowOps } = await import("${REPO_ROOT}/src/lib/runtimes/window-ops.ts");
      return tmuxWindowOps("agent-probe", "@1").${method}("printf PROBE");`);
    if (stopWhen) {
      for (const end = Date.now() + 10_000; Date.now() < end && !stopWhen(log); await Bun.sleep(5));
      w.stops[stop]();
    }
    const r = await pending;
    w.release();
    return { r, keys: keysIn(log) };
  }

  for (const stop of STOPS) {
    test(`${stop} while sendLine is still querying tmux: no literal, no Enter`, async () => {
      const { r, keys } = await run("sendLine", (log) => lines(log).length > 0, stop);
      expect(keys).toEqual([]);
      expect(r).toMatchObject({ ok: false, name: "SchedulerLeaseLost" });
    }, 20_000);
  }

  test("lease lost after the literal, before Enter: the literal stays in the box, Enter is not pressed", async () => {
    const { r, keys } = await run("sendLine", (log) => keysIn(log).some((l) => l.includes(" -l ")), "scheduler.pid taken over");
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain("printf PROBE");
    expect(r).toMatchObject({ ok: false, name: "SchedulerLeaseLost" });
  }, 20_000);

  test("sendLiteral: lease lost while it looks up the window, the text is not typed", async () => {
    const { r, keys } = await run("sendLiteral", (log) => lines(log).length > 0, "maintenance lease taken over");
    expect(keys).toEqual([]);
    expect(r).toMatchObject({ ok: false, name: "SchedulerLeaseLost" });
  }, 20_000);

  test("positive control: nothing stops, sendLine types the literal and presses Enter", async () => {
    const { r, keys } = await run("sendLine", null, "");
    expect(r).toMatchObject({ ok: true });
    expect(keys.length).toBe(2);
    expect(keys[1]).toMatch(/Enter$/);
  }, 20_000);
});

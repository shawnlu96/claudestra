/**
 * Shared harness for the real scheduler daemon tests: a private state dir (ledger, registry, projects, scheduler.json), a
 * stub bridge on a free port so an order can only ever reach the stub, and `src/scheduler.ts` started under `env -i`.
 * Used by tests/scheduler-service-lease.test.ts and tests/scheduler-child-lease.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
interface Frame { type: string; targetName?: string; requestId?: string }
export interface Svc {
  root: string; state: string; lockPath: string; frames: Frame[];
  onDispatch: (f: Frame) => Promise<void> | void;
  /** Runs before each WebSocket upgrade completes: the client has connected, no frame can have been sent yet. */
  onUpgrade: () => Promise<void> | void;
  child: ReturnType<typeof Bun.spawn> | null; server: Server<unknown>; stderr: Promise<string> | null;
}

const live: Svc[] = [];
export const dispatched = (s: Svc) => s.frames.filter((f) => f.type === "route_to_agent");

/** ghost: the cards' executor is not in the registry, so the first thing the scheduler sends is the PM notice. */
export function setup(cards: string[], opts: { ghost?: boolean; autoDispatch?: boolean } = {}): Svc {
  const root = mkdtempSync(join(tmpdir(), "t68f-lease-")), state = join(root, "state"), work = join(root, "work");
  for (const d of [state, work, join(root, "home"), join(root, "run"), join(root, "tmp"), join(root, "master")]) mkdirSync(d, { recursive: true });
  const agents = opts.ghost ? {} : Object.fromEntries(cards.map((id, i) => [`agent-task-${i}`, { runtime: "claude-code", sessionId: `s-${i}`, cwd: work,
    channelId: `ch-${i}`, status: "active", projectId: "p", purpose: "", created: "", notes: "" }]));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [work], createdAt: "" }] }));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents }));
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: true, pollMs: 1000, ...(opts.autoDispatch === false ? {} : { autoDispatch: true }),
    projects: { p: { maxActiveWorkers: cards.length, requiredChecks: ["check"], repoDir: work } } }));
  const ledger = join(state, "ledger.sqlite"), db = openLedger(ledger);
  let now = Date.now();
  const at = (actor: string) => ({ actor, now: (now += 10) });
  cards.forEach((id, i) => {
    createTask(db, at("owner"), { project: "p", id, title: id, kind: "code", agent: opts.ghost ? "agent-ghost" : `agent-task-${i}`,
      extra: { fileGlobs: [`f${i}.md`] } });
    setWorkflow(db, at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "退回人工" });
  });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  closeLedger(ledger);
  const svc: Svc = { root, state, lockPath: join(state, "scheduler-maintenance.lock"), frames: [], onDispatch: () => {}, onUpgrade: () => {}, child: null, stderr: null,
    server: Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req, s) {
      await svc.onUpgrade();
      return s.upgrade(req, { data: null }) ? undefined : new Response("stub");
    }, websocket: {
      async message(ws, msg) {
        const frame = JSON.parse(String(msg)) as Frame;
        svc.frames.push(frame);
        if (frame.type === "route_to_agent") await svc.onDispatch(frame);
        ws.send(JSON.stringify({ requestId: frame.requestId, result: { ok: true, targetChannelId: "ch" } }));
      },
    } }) };
  live.push(svc);
  return svc;
}

export function start(s: Svc): void {
  const port = String(s.server.port);
  const env: Record<string, string> = { HOME: join(s.root, "home"), PATH: process.env.PATH ?? "", TMPDIR: join(s.root, "tmp"), CLAUDESTRA_SANDBOX: "1",
    CLAUDESTRA_SANDBOX_ROOT: s.root, CLAUDESTRA_STATE_DIR: s.state, CLAUDESTRA_RUNTIME_DIR: join(s.root, "run"), MASTER_DIR: join(s.root, "master"),
    BRIDGE_PORT: port, BRIDGE_URL: `ws://127.0.0.1:${port}`, BRIDGE_BIND: "127.0.0.1" };
  s.child = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", join(REPO_ROOT, "src/scheduler.ts")],
    { cwd: s.root, stdout: "ignore", stderr: "pipe" });
  s.stderr = new Response(s.child.stderr as ReadableStream).text();
}

export async function until(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (cond()) return true;
  return cond();
}

export function intents(s: Svc): { taskId: string; action: string; status: string }[] {
  const db = openLedger(join(s.state, "ledger.sqlite"));
  try { return db.query("SELECT taskId, action, status FROM scheduler_intents ORDER BY eventSeq").all() as { taskId: string; action: string; status: string }[]; }
  finally { closeLedger(join(s.state, "ledger.sqlite")); }
}

/** Kill every daemon this file started, stop its stub bridge, drop its state dir; register with afterEach. */
export async function cleanupDaemons(): Promise<void> {
  for (const s of live.splice(0)) {
    s.child?.kill("SIGKILL");
    await s.child?.exited;
    s.server.stop(true);
    rmSync(s.root, { recursive: true, force: true });
  }
}

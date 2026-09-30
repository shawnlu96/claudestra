/**
 * T68f r3 P1 (T68f-r3-adv.md): the real scheduler daemon runs merge + observe + auto under the one maintenance lease that
 * update also takes. Each case starts `src/scheduler.ts` in a private state dir with a stub bridge on a free port, so a
 * dispatch can only ever reach the stub; the ledger is the daemon's own, written through the real ledger CLI.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { acquireLock } from "../src/lib/file-lock.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";

interface Frame { type: string; targetName?: string; requestId?: string }
interface Svc {
  root: string; state: string; lockPath: string; frames: Frame[];
  onDispatch: (f: Frame) => Promise<void> | void;
  child: ReturnType<typeof Bun.spawn> | null; server: Server<unknown>; stderr: Promise<string> | null;
}

const live: Svc[] = [];
const dispatched = (s: Svc) => s.frames.filter((f) => f.type === "route_to_agent");

function setup(cards: string[]): Svc {
  const root = mkdtempSync(join(tmpdir(), "t68f-lease-")), state = join(root, "state"), work = join(root, "work");
  for (const d of [state, work, join(root, "home"), join(root, "run"), join(root, "tmp"), join(root, "master")]) mkdirSync(d, { recursive: true });
  const agents = Object.fromEntries(cards.map((id, i) => [`agent-task-${i}`, { runtime: "claude-code", sessionId: `s-${i}`, cwd: work,
    channelId: `ch-${i}`, status: "active", projectId: "p", purpose: "", created: "", notes: "" }]));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [work], createdAt: "" }] }));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents }));
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: true, pollMs: 1000,
    projects: { p: { maxActiveWorkers: cards.length, requiredChecks: ["check"], repoDir: work } } }));
  const ledger = join(state, "ledger.sqlite"), db = openLedger(ledger);
  let now = Date.now();
  const at = (actor: string) => ({ actor, now: (now += 10) });
  cards.forEach((id, i) => {
    createTask(db, at("owner"), { project: "p", id, title: id, kind: "code", agent: `agent-task-${i}`, extra: { fileGlobs: [`f${i}.md`] } });
    setWorkflow(db, at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "退回人工" });
  });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  closeLedger(ledger);
  const svc: Svc = { root, state, lockPath: join(state, "scheduler-maintenance.lock"), frames: [], onDispatch: () => {}, child: null, stderr: null,
    server: Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => (s.upgrade(req, { data: null }) ? undefined : new Response("stub")), websocket: {
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

function start(s: Svc): void {
  const port = String(s.server.port);
  const env: Record<string, string> = { HOME: join(s.root, "home"), PATH: process.env.PATH ?? "", TMPDIR: join(s.root, "tmp"), CLAUDESTRA_SANDBOX: "1",
    CLAUDESTRA_SANDBOX_ROOT: s.root, CLAUDESTRA_STATE_DIR: s.state, CLAUDESTRA_RUNTIME_DIR: join(s.root, "run"), MASTER_DIR: join(s.root, "master"),
    BRIDGE_PORT: port, BRIDGE_URL: `ws://127.0.0.1:${port}`, BRIDGE_BIND: "127.0.0.1" };
  s.child = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", join(REPO_ROOT, "src/scheduler.ts")],
    { cwd: s.root, stdout: "ignore", stderr: "pipe" });
  s.stderr = new Response(s.child.stderr as ReadableStream).text();
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (cond()) return true;
  return cond();
}

function intents(s: Svc): { taskId: string; action: string; status: string }[] {
  const db = openLedger(join(s.state, "ledger.sqlite"));
  try { return db.query("SELECT taskId, action, status FROM scheduler_intents ORDER BY eventSeq").all() as { taskId: string; action: string; status: string }[]; }
  finally { closeLedger(join(s.state, "ledger.sqlite")); }
}

afterEach(async () => {
  for (const s of live.splice(0)) {
    s.child?.kill("SIGKILL");
    await s.child?.exited;
    s.server.stop(true);
    rmSync(s.root, { recursive: true, force: true });
  }
});

describe("the scheduler daemon's whole pass lives under the maintenance lease", () => {
  test("while update holds the lease an auto card gets no session, no plan and no order; once released it is driven", async () => {
    const s = setup(["T1"]);
    const update = await acquireLock(s.lockPath, 0);
    expect(update).not.toBeNull();
    start(s);
    await Bun.sleep(3500);
    expect(update!.held()).toBe(true);
    expect(s.frames).toEqual([]);
    expect(intents(s)).toEqual([]);
    update!.release();
    expect(await until(() => dispatched(s).length > 0, 20_000)).toBe(true);
    expect(dispatched(s)[0]).toMatchObject({ targetName: "agent-task-0" });
  }, 40_000);

  test("losing the lease mid-submit ends the pass: the next card is not dispatched and the daemon stops", async () => {
    const s = setup(["T1", "T2"]);
    s.onDispatch = async () => {
      writeFileSync(join(s.lockPath, "owner"), "update-took-over");
      await Bun.sleep(300);
    };
    start(s);
    expect(await until(() => dispatched(s).length > 0, 20_000)).toBe(true);
    expect(await until(() => s.child!.exitCode !== null, 10_000)).toBe(true);
    expect(dispatched(s)).toHaveLength(1);
    const first = dispatched(s)[0].targetName === "agent-task-0" ? "T1" : "T2";
    expect(intents(s).filter((i) => i.taskId !== first && i.action === "dispatch")).toEqual([]);
  }, 40_000);

  test("a stop signal mid-submit ends the pass the same way", async () => {
    const s = setup(["T1", "T2"]);
    s.onDispatch = async () => {
      s.child!.kill("SIGTERM");
      await Bun.sleep(300);
    };
    start(s);
    expect(await until(() => dispatched(s).length > 0, 20_000)).toBe(true);
    expect(await until(() => s.child!.exitCode !== null, 10_000)).toBe(true);
    expect(dispatched(s)).toHaveLength(1);
    const first = dispatched(s)[0].targetName === "agent-task-0" ? "T1" : "T2";
    expect(intents(s).filter((i) => i.taskId !== first && i.action === "dispatch")).toEqual([]);
    expect(await s.stderr).toBe("");
  }, 40_000);
});

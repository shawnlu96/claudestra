/** Shared fixture for the T68f auto-mode tests: a temp ledger, the real ledger CLI in-process, E1 adapters over mock ports. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { boundRef, schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { ledgerResult } from "../src/lib/scheduler-work-order.js";
import { createAcpWorker, type AcpTurnState } from "../src/lib/worker-acp.js";
import { createChannelWorker } from "../src/lib/worker-message.js";
import type { AdapterDeps, LiveState, SendResult } from "../src/lib/worker-ports.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { CallerWitness } from "../src/lib/caller-witness.js";
import type { Registry } from "../src/manager/core.js";

export const H1 = "1".repeat(40), H2 = "2".repeat(40);
export const DIGEST = "d".repeat(64);
export const P1 = { findingId: "race-1", family: "concurrency", severity: "P1" as const, probe: "two ticks claim the same intent" };
export const P2 = { findingId: "name-1", family: "naming", severity: "P2" as const, probe: "rename helper" };

/** Each agent's own runtime session, as its shell environment would report it. */
const SESSIONS: Record<string, string> = { "agent-task-one": "s-one", "agent-rv-t1": "s-rv", pm: "s-pm" };

export interface Sent { agent: string; sessionId: string; text: string; key: string; route: "channel" | "acp" }

function shots(dir: string): string[] {
  const out = [join(dir, "before.png"), join(dir, "after.png")];
  for (const p of out) writeFileSync(p, "png");
  return out;
}

export function autoFixture(opts: { template?: "code" | "ui"; reviewerRuntime?: string } = {}) {
  const template = opts.template ?? "code";
  const dir = mkdtempSync(join(tmpdir(), "t68f-auto-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {
    "agent-task-one": { runtime: "claude-code", sessionId: "s-one", cwd: dir, channelId: "ch-one" },
    "agent-rv-t1": { runtime: opts.reviewerRuntime ?? "codex", transport: "acp", sessionId: "s-rv", cwd: join(dir, "rv-t1") },
    pm: { runtime: "claude-code", sessionId: "s-pm", role: "pm" },
  } }));
  let now = 1000;
  const at = (actor: string) => ({ actor, now: (now += 10) });
  createTask(db, at("owner"), { project: "p", id: "T1", title: "auto", kind: "code", agent: "agent-task-one",
    extra: { fileGlobs: ["src/lib/x.ts"], ...(template === "ui" ? { screenshotsDigest: DIGEST, screenshots: shots(dir) } : {}) } });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  setWorkflow(db, at("owner"), { taskId: "T1", taskRev: 1, template, templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  const deps = (actor: string): LedgerDeps => ({
    db, actor, registryPath, projectIds: ["p"], now: () => (now += 10), autoProjects: () => ["p"], callerSession: SESSIONS[actor],
    gitHead: () => reviewerAt ?? getTask(db, "T1")?.headSHA ?? null, gitDirty: () => reviewerDirty,
    ...(witness ? { callerWitness: async () => witness! } : {}),
    loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {},
  });
  const cli = (actor: string, ...args: string[]) => runLedger(args, deps(actor));
  const cliWith = (over: Partial<LedgerDeps>, actor: string, ...args: string[]) => runLedger(args, { ...deps(actor), ...over });

  const sent: Sent[] = [];
  const live: Record<string, LiveState> = {};
  const acpState: { lastFailure?: AcpTurnState["lastFailure"] } = {};
  const notices: string[] = [];
  const ensured: { role: string; family: string }[] = [];
  let sendMode: "ok" | "refuse" | "lost" = "ok";
  const pins: string[] = [];
  let pinRefusal: string | null = null;
  let reviewerAt: string | null = null;
  let reviewerDirty: string | null = null;
  let witness: CallerWitness | null = null;
  const send = (route: Sent["route"]) => async (agent: string, sessionId: string, text: string, key: string): Promise<SendResult> => {
    if (sendMode === "refuse") return { ok: false, delivered: false, reason: "bridge 拒收" };
    sent.push({ agent, sessionId, text, key, route });
    return sendMode === "lost" ? { ok: false, delivered: "unknown", reason: "答复丢了" } : { ok: true, messageId: `m${sent.length}` };
  };
  const adapterDeps: AdapterDeps = {
    sessions: { bound: (t, role) => boundRef(db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
    ledger: { result: (ref, probe) => ledgerResult(db, ref, probe) },
  };
  const status = async (agent: string) => live[agent] ?? "idle";
  const tickDeps: AutoTickDeps = {
    manager: async (...args) => runLedger(args.slice(1), deps("scheduler")),
    worker: (ref: SessionRef) => ref.family === "codex"
      ? createAcpWorker({ ...adapterDeps, port: { prompt: send("acp"), turnState: async (a) => ({ live: await status(a), ...acpState }), cancel: async () => ({ ok: true, evidence: "c" }) } })
      : createChannelWorker({ ...adapterDeps, port: { send: send("channel"), status, interrupt: async () => ({ ok: true, evidence: "i" }) } }),
    ensure: async (task, role, family) => {
      ensured.push({ role, family });
      const agent = role === "author" ? task.agent as string : "agent-rv-t1";
      const row = JSON.parse(readFileSync(registryPath, "utf8")).agents[agent];
      return { kind: "ready", created: role === "reviewer", ref: { taskId: task.id, role, agent, sessionId: row.sessionId, family,
        transport: row.transport === "acp" ? "acp" : "tmux" } };
    },
    reviewDirty: async () => reviewerDirty,
    pinReview: async (_task, _ref, head) => { pins.push(head ?? ""); return pinRefusal ? { manual: pinRefusal } : { dir: join(dir, "rv-t1") }; },
    notifyPm: async (_task, text) => { notices.push(text); },
    now: () => now,
  };
  const tick = async () => {
    const r = await schedulerAutoTick(db, { p: { maxActiveWorkers: 2 } }, tickDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const task = () => getTask(db, "T1")!;
  const intents = () => db.query("SELECT id, node, action, status, recipient FROM scheduler_intents ORDER BY eventSeq").all() as
    { id: string; node: string; action: string; status: string; recipient: string | null }[];
  const findingsFile = (rows: object[]) => { const p = join(dir, `f${now}.json`); writeFileSync(p, JSON.stringify(rows)); return p; };
  const review = (verdict: "pass" | "changes", head: string, rows: object[], extra: string[] = [], actor = "agent-rv-t1") =>
    cli(actor, "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", verdict, "--p0", "0",
      "--p1", String(rows.filter((f) => (f as { severity: string }).severity === "P1").length),
      "--p2", String(rows.filter((f) => (f as { severity: string }).severity === "P2").length),
      "--head", head, "--session", "s-rv", "--family", "codex", "--findings", findingsFile(rows), "--path", `reviews/T1-r${task().round}/report.md`, ...extra);
  const advance = (ms: number) => { now += ms; };
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, dir, at, cli, cliWith, tick, task, intents, review, sent, live, acpState, notices, ensured, advance, close, tickDeps, registryPath,
    setSend: (m: typeof sendMode) => { sendMode = m; }, pins, refusePin: (why: string | null) => { pinRefusal = why; },
    reviewerCheckoutAt: (h: string | null) => { reviewerAt = h; }, dirtyReviewer: (d: string | null) => { reviewerDirty = d; },
    witnessAs: (w: CallerWitness | null) => { witness = w; } };
}

/** Drive the card from spec to the start of build: author session, restate order, worker restates, PM releases it. */
export async function toBuild(f: ReturnType<typeof autoFixture>) {
  await f.tick(); // ensure author session
  await f.tick(); // restate order
  await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
  await f.cli("pm", "restate-approve", "T1");
  await f.tick(); // restate → build
}

/**
 * A fix swap re-reads its permission before every destructive effect: whatever PM does while an inventory or a manager child is
 * awaited (manual takeover, a new session, a moved head / spec, a shared binding) must leave the new object untouched.
 * Synthetic ledger, temp dirs and the in-memory lifecycle facade only.
 */
import { expect, test } from "bun:test";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup } from "../src/lib/ledger-store.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";

type Fixture = Awaited<ReturnType<typeof repeatedFix>>;
type Probe = ReturnType<typeof convergenceProbe>;
const OLD = "agent-task-one";

/** Fires `fn` once, inside the named await of the named step: after the port read its answer, before the caller gets it. */
function hooked(f: Fixture) {
  const p = convergenceProbe(f), intent = p.plan();
  let step = 0, armed: { at: string; fn: () => Promise<unknown> | unknown } | null = null;
  const seen = new Map<string, number>();
  const fire = async (port: string) => {
    const n = (seen.get(`${step}:${port}`) ?? 0) + 1; seen.set(`${step}:${port}`, n);
    if (armed?.at !== `${step}:${port}:${n}`) return;
    const { fn } = armed; armed = null; await fn();
  };
  const { agents, manager, readReport } = p.deps;
  p.deps.agents = async () => { const rows = await agents(); await fire("inventory"); return rows; };
  p.deps.readReport = async (path) => { const text = await readReport!(path); await fire("report"); return text; };
  p.deps.manager = async (...args) => { const out = await manager(...args); await fire(String(args[0])); return out; };
  const run = async () => { step++; return fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps); };
  return { p, intent, run, arm: (at: string, fn: () => Promise<unknown> | unknown) => { armed = { at, fn }; }, unfired: () => armed !== null };
}

const authors = (f: Fixture) => f.db.query("SELECT agent, sessionId, state FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author' ORDER BY rowid")
  .all() as { agent: string; sessionId: string; state: string }[];
const receipts = (f: Fixture, id: string) => ["author", "archive", "kill", "creating", "replacement"].filter((e) => getEventByDedup(f.db, `scheduler:${id}:${e}`));
/** The fixture registry leaves `status` out for a running agent; only "stopped" means it was killed. */
const running = (p: Probe, name: string, sessionId: string) => {
  const row = p.raw().agents[name];
  expect([row.sessionId, row.status ?? "active"]).toEqual([sessionId, "active"]);
};
/** PM's hand binding: the card's one author row now names another session (the table keeps one row per card and role). */
const rebind = (f: Fixture, agent: string) =>
  f.db.run("UPDATE scheduler_sessions SET agent = ?, sessionId = 's-manual', updatedAt = updatedAt + 1 WHERE taskId = 'T1' AND role = 'author'", [agent]);
const destructive = (effects: string[]) => effects.filter((e) => /^(archive|kill|create):/.test(e));
const toManual = async (f: Fixture) => expect(await f.cli("owner", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev",
  String(getWorkflow(f.db, "T1")!.rev), "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude",
  "--fallback", "人工修复", "--reason", "PM 接管，人工修复")).toMatchObject({ ok: true });

test("[验收线 1] a formal manual takeover inside the second step's inventory await stops the swap: no kill, no create", async () => {
  const f = await repeatedFix();
  try {
    const h = hooked(f);
    expect(await h.run()).toMatchObject({ step: "waiting", detail: "旧作者已归档，下轮确认停止" });
    expect(getIntent(f.db, h.intent.id)?.status).toBe("submitted");
    h.arm("2:inventory:1", () => toManual(f));
    const out = await h.run();
    expect(h.unfired()).toBe(false);
    expect(h.p.effects).toEqual([`archive:${OLD}`]);
    running(h.p, OLD, "s-one");
    expect(out).toMatchObject({ ok: true, step: "waiting", halted: "takeover", detail: expect.stringContaining("PM 已接管") });
    expect(authors(f)).toEqual([{ agent: OLD, sessionId: "s-one", state: "active" }]);
    expect(receipts(f, h.intent.id)).toEqual(["author", "archive"]); // the finished archive stays as history, and nothing follows from it
    expect(Object.keys(h.p.raw().agents).filter((n) => n.startsWith("agent-cv-"))).toEqual([]);
    // submitted is not standing permission: the next pass is refused at admission and still touches nothing
    await expect(h.run()).rejects.toThrow("收敛意图的规格或 head 已过期");
    expect(h.p.effects).toEqual([`archive:${OLD}`]);
  } finally { f.close(); }
});

interface Drift { name: string; inject(f: Fixture, p: Probe): Promise<unknown> | unknown; intact(f: Fixture, p: Probe): void }
const oldBound = (f: Fixture) => expect(authors(f)).toEqual([{ agent: OLD, sessionId: "s-one", state: "active" }]);
const DRIFTS: Drift[] = [
  { name: "manual takeover", inject: (f) => toManual(f), intact: oldBound },
  { name: "new live session under the old name", inject: (_f, p) => p.edit((r) => { r.agents[OLD].sessionId = "s-fresh"; delete r.agents[OLD].status; }),
    intact: (f, p) => { oldBound(f); running(p, OLD, "s-fresh"); } },
  { name: "new author binding",
    inject: (f, p) => {
      p.edit((r) => { r.agents["agent-manual"] = { cwd: f.dir, sessionId: "s-manual", status: "active", runtime: "claude-code", transport: "tmux" }; });
      rebind(f, "agent-manual");
    },
    intact: (f, p) => {
      expect(authors(f)).toEqual([{ agent: "agent-manual", sessionId: "s-manual", state: "active" }]);
      running(p, "agent-manual", "s-manual");
    } },
  { name: "moved head", inject: (f) => f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["9".repeat(40)]), intact: oldBound },
  { name: "moved spec", inject: (f) => f.db.run("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'"), intact: oldBound },
  { name: "shared binding", intact: oldBound,
    inject: (f) => f.db.run(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES ('T2', 'p', 'other', 'code', 'build', '${OLD}', 0, 0)`) },
];
/** Every await ahead of archive (step 1) and of kill (step 2), plus the two manager children themselves. */
const POINTS = ["1:report:1", "1:inventory:1", "1:archive:1", "2:inventory:1", "2:inventory:2", "2:kill:1"];

for (const at of POINTS) for (const drift of DRIFTS) {
  test(`[验收线 2] ${drift.name} injected at ${at} adds no destructive effect and no receipt`, async () => {
    const f = await repeatedFix();
    try {
      const h = hooked(f), id = h.intent.id;
      let mark = -1, journal: string[] = [];
      h.arm(at, async () => { await drift.inject(f, h.p); mark = h.p.effects.length; journal = receipts(f, id); });
      for (let step = 1; step <= 3; step++) {
        // a pass after the drift may be refused at admission (a throw) or wait; either way it must not act
        const out = await h.run().catch((e: Error) => ({ step: "refused", detail: e.message }));
        if (mark < 0) continue;
        expect(out.step === "waiting" || out.step === "refused").toBe(true);
      }
      expect(mark).toBeGreaterThanOrEqual(0);
      expect(destructive(h.p.effects.slice(mark))).toEqual([]);
      expect(receipts(f, id)).toEqual(journal);
      expect(getIntent(f.db, id)?.status).not.toBe("done");
      drift.intact(f, h.p);
    } finally { f.close(); }
  });
}

test("[验收线 2] with no drift the swap archives, kills and creates exactly once each", async () => {
  const f = await repeatedFix();
  try {
    const h = hooked(f);
    expect(await h.run()).toMatchObject({ step: "waiting" });
    expect(await h.run()).toMatchObject({ step: "session" });
    expect(await h.run()).toMatchObject({ step: "session" });
    const created = `agent-cv-t1-fix-${h.intent.eventSeq}`;
    expect(destructive(h.p.effects)).toEqual([`archive:${OLD}`, `kill:${OLD}`, `create:${created}`]);
    expect(receipts(f, h.intent.id)).toEqual(["author", "archive", "kill", "creating", "replacement"]);
    expect(authors(f)).toEqual([{ agent: OLD, sessionId: "s-one", state: "retired" }, { agent: created, sessionId: `session:${created}`, state: "active" }]);
    expect(getIntent(f.db, h.intent.id)?.status).toBe("done");
  } finally { f.close(); }
});

test("[验收线 2] the final stop port is handed the pinned session identity, not only a name", async () => {
  const f = await repeatedFix();
  try {
    const h = hooked(f), stops: unknown[] = [];
    h.p.deps.stop = async (old) => { stops.push(old); return h.p.deps.manager("kill", old.agent); };
    await h.run();
    expect(await h.run()).toMatchObject({ step: "session" });
    expect(stops).toEqual([{ agent: OLD, sessionId: "s-one" }]);
    expect(destructive(h.p.effects).filter((e) => e.startsWith("kill:"))).toEqual([`kill:${OLD}`]);
  } finally { f.close(); }
});

test("[验收线 2] a lost scheduler lease still refuses, at each stage, before the next effect", async () => {
  for (const at of ["1:inventory:1", "2:inventory:2"]) {
    const f = await repeatedFix();
    try {
      const h = hooked(f);
      let lost = false;
      h.p.deps.active = () => { if (lost) throw new SchedulerLeaseLost("调度租约已丢"); };
      h.arm(at, () => { lost = true; });
      const before = at.startsWith("2") ? [`archive:${OLD}`] : [];
      if (at.startsWith("2")) await h.run();
      await expect(h.run()).rejects.toBeInstanceOf(SchedulerLeaseLost);
      expect(destructive(h.p.effects)).toEqual(before);
      running(h.p, OLD, "s-one");
      oldBound(f);
    } finally { f.close(); }
  }
});

test("[验收线 2] an archive taken for the old session never licenses stopping an author bound since", async () => {
  const f = await repeatedFix();
  try {
    const h = hooked(f);
    expect(await h.run()).toMatchObject({ step: "waiting" });
    // between passes: the old name now runs a session PM bound by hand; card, workflow and intent are otherwise as pinned
    h.p.edit((r) => { r.agents[OLD].sessionId = "s-manual"; });
    rebind(f, OLD);
    for (let pass = 0; pass < 3; pass++) expect(await h.run()).toMatchObject({ step: "waiting", halted: "binding" });
    expect(h.p.effects).toEqual([`archive:${OLD}`]);
    running(h.p, OLD, "s-manual");
    expect(authors(f).at(-1)).toEqual({ agent: OLD, sessionId: "s-manual", state: "active" });
  } finally { f.close(); }
});

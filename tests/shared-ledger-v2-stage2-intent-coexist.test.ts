import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { withSchedulerV2LedgerCmds } from "../src/lib/scheduler-v2-ledger-cmds.js";
import { configureSchedulerV2Pass, schedulerV2Route, type SchedulerV2Switch } from "../src/lib/scheduler-v2-pass.js";
import { configureSchedulerV2Intents, withSchedulerV2Intents } from "../src/lib/scheduler-v2-intent.js";
import type { TickPace } from "../src/lib/scheduler-yield.js";
import { ledgercmdFixture } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

afterEach(() => configureSchedulerV2Pass(null));
const centerExecution = { centerId: "center", teamId: "team", projectId: "center-project", centerFeatureId: "center-feature", epoch: 1 };
type Authority = "none" | "planning" | "execution";

/**
 * §7.2 over a real schedulerAutoTick: the route is S2D's real schedulerV2Route (switch via its port), S2I wraps the fixture's
 * ports, wrapManager is the real S2Q against the recording center. `pass` = the production pass's skipTask from the same route.
 */
async function run(opts: { authority: Authority; sw: SchedulerV2Switch | null; s2i: boolean; migrating?: boolean; pass?: boolean; ticks?: number }) {
  const s = ledgercmdFixture(), db = s.f.db;
  if (opts.authority !== "none") {
    const mode = opts.authority === "execution" ? { authorityMode: "execution", sharedPlanning: true, centerExecution }
      : { authorityMode: "planning", sharedPlanning: true };
    writeFileSync(join(s.f.dir, "shared-ledger-modes.json"), JSON.stringify({ features: { "feature-one": {
      ...mode, ...(opts.migrating ? { migrating: { batchId: "batch", kind: "execute" } } : {}) } } }));
  }
  const sw = opts.sw;
  configureSchedulerV2Pass(sw === null ? null : { mode: () => sw, wrapManager: (m) => m });
  const route = (id: string) => schedulerV2Route(id, db);
  s.port.route = route;
  const center = intentCenter(s.port.clientFor("p")!);
  let realCalls = 0;
  configureSchedulerV2Intents(opts.s2i ? { route,
    wrapManager: (m) => withSchedulerV2LedgerCmds(async (...args) => { realCalls++; return m(...args); }, s.port),
    fence: () => s.port.fence("feature-one"), claimFence: () => null,
    central: (taskId, intentId) => center.bound(taskId, intentId, null, "dispatch") } : null);
  const deps = withSchedulerV2Intents(s.f.tickDeps);
  const pace: TickPace | undefined = opts.pass ? { yieldNow: () => false, cursor: {}, skipTask: (id) => route(id) === "skip" } : undefined;
  const before = events(db), steps: string[] = [];
  for (let i = 0; i < (opts.ticks ?? 2); i++) {
    const r = await schedulerAutoTick(db, { p: { maxActiveWorkers: 2 } }, deps, pace);
    steps.push(...r.cards.map((c) => c.step), ...r.failed.map((f) => `failed:${f.error}`));
  }
  configureSchedulerV2Intents(null);
  return { s, before, after: events(db), steps, requests: s.requests.length + center.calls.length, realCalls,
    sent: s.f.sent.map((x) => [x.agent, x.route, x.key]), ensured: s.f.ensured, route: route("T1"), deps };
}
/** Local ledger events without wall-clock fields: two runs of the same synthetic ledger must match field for field. */
function events(db: Database) {
  return (db.query("SELECT actor, project, target, kind, text, data FROM events ORDER BY seq").all() as Record<string, string>[])
    .map((e) => ({ ...e, data: JSON.parse(e.data, (k, v) => ["createdAt", "updatedAt", "ts", "at"].includes(k) ? 0 : v) }));
}
const quiet = () => [spyOn(console, "info").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];

describe("S2I coexistence (§7.2)", () => {
  test("1. off: non-execution runs the original path, execution is skipped; zero center requests either way", async () => {
    const logs = quiet();
    try {
      const local = await run({ authority: "planning", sw: "off", s2i: true });
      expect(local.route).toBe("local");
      expect(local.steps).toEqual(["session", "sent"]);
      expect(local.requests).toBe(0);
      for (const pass of [true, false]) {
        const held = await run({ authority: "execution", sw: "off", s2i: true, pass });
        expect(held.route).toBe("skip");
        expect({ requests: held.requests, sent: held.sent, ensured: held.ensured }).toEqual({ requests: 0, sent: [], ensured: [] });
        expect(held.after).toEqual(held.before);
      }
    } finally { for (const l of logs) l.mockRestore(); }
  });

  for (const sw of ["observe", "on"] as const) {
    test(`2/3. ${sw} + non-execution card: events, sends and sessions equal the off run field for field`, async () => {
      const logs = quiet();
      try {
        const runs = [await run({ authority: "none", sw: null, s2i: false, ticks: 3 }), await run({ authority: "planning", sw: "off", s2i: true, ticks: 3 }),
          await run({ authority: "planning", sw, s2i: true, ticks: 3 }), await run({ authority: "none", sw, s2i: true, ticks: 3 })];
        for (const r of runs) {
          expect(r.after).toEqual(runs[0]!.after);
          expect({ sent: r.sent, ensured: r.ensured, steps: r.steps, requests: r.requests }).toEqual({ sent: runs[0]!.sent,
            ensured: runs[0]!.ensured, steps: runs[0]!.steps, requests: 0 });
        }
      } finally { for (const l of logs) l.mockRestore(); }
    });
  }

  test("2. observe + execution card: skipped like off, zero center writes", async () => {
    const logs = quiet();
    try {
      const r = await run({ authority: "execution", sw: "observe", s2i: true, pass: true });
      expect(r.route).toBe("skip");
      expect({ requests: r.requests, sent: r.sent, ensured: r.ensured, events: r.after }).toEqual({ requests: 0, sent: [], ensured: [], events: r.before });
    } finally { for (const l of logs) l.mockRestore(); }
  });

  test("4. on + execution + S2I port null: deps untouched, the pass route holds the card, zero local writes", async () => {
    const logs = quiet();
    try {
      const r = await run({ authority: "execution", sw: null, s2i: false, pass: true });
      expect(r.deps).toBe(r.s.f.tickDeps);
      expect(r.route).toBe("skip");
      expect(logs[0]).toHaveBeenCalledWith("[scheduler-v2 unavailable] T1: skip");
      expect({ requests: r.requests, sent: r.sent, ensured: r.ensured, events: r.after }).toEqual({ requests: 0, sent: [], ensured: [], events: r.before });
    } finally { for (const l of logs) l.mockRestore(); }
  });

  for (const authority of ["planning", "execution"] as const) {
    test(`5. migrating ${authority} + on: zero center writes and zero side effects, with or without the pass gate`, async () => {
      const logs = quiet();
      try {
        for (const pass of [true, false]) {
          const r = await run({ authority, sw: "on", s2i: true, migrating: true, pass });
          expect(r.route).toBe("skip");
          expect({ requests: r.requests, sent: r.sent, ensured: r.ensured, events: r.after }).toEqual({ requests: 0, sent: [], ensured: [], events: r.before });
        }
      } finally { for (const l of logs) l.mockRestore(); }
    });
  }
});

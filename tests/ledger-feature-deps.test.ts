import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger, listEvents } from "../src/lib/ledger-store.js";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { changeFeatureDep } from "../src/lib/ledger-feature-deps-write.js";
import { FEATURE_DEPS_SCHEMA } from "../src/lib/ledger-feature-schema.js";
import { featureDeps } from "../src/lib/ledger-feature-deps.js";
import { setFeatureDeps } from "../src/lib/ledger-feature-deps-tool.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
let db: Database;
const ctx = { actor: "agent-pm", now: 1000 };
let ids: string[];
beforeEach(() => {
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: [ctx.actor] });
  ids = ["a", "b", "c"].map((slug) => createFeature(db, ctx, { project: "p", slug, title: slug }).row.id);
});
afterEach(() => closeLedger(":memory:"));
test("migration repeats on populated database; duplicate leaves one origin event", () => {
  FEATURE_DEPS_SCHEMA(db); FEATURE_DEPS_SCHEMA(db);
  expect(changeFeatureDep(db, ctx, ids[0], ids[1])).toMatchObject({ ok: true, duplicate: false });
  FEATURE_DEPS_SCHEMA(db); FEATURE_DEPS_SCHEMA(db);
  expect(changeFeatureDep(db, ctx, ids[0], ids[1])).toMatchObject({ duplicate: true });
  expect(featureDeps(db, "p", ids[1])).toHaveLength(1);
  const events = listEvents(db, { project: "p" }).filter((e) => e.data.op === "dep-add");
  expect(events).toHaveLength(1); expect(events[0].origin).toBe("ab12");
  changeFeatureDep(db, ctx, ids[0], ids[1], true);
  expect(featureDeps(db)).toHaveLength(0);
  expect(() => changeFeatureDep(db, ctx, ids[0], ids[1], true)).toThrow("没有 feature 依赖");
});
test("cycles name the path, cross-project and unprivileged writes rejected", () => {
  changeFeatureDep(db, ctx, ids[0], ids[1]); changeFeatureDep(db, ctx, ids[1], ids[2]);
  expect(() => changeFeatureDep(db, ctx, ids[2], ids[0])).toThrow(`${ids[2]} → ${ids[0]} → ${ids[1]} → ${ids[2]}`);
  expect(() => changeFeatureDep(db, ctx, ids[0], ids[0])).toThrow("成环");
  const foreign = createFeature(db, { actor: "owner" }, { project: "q", slug: "d", title: "d" }).row.id;
  expect(() => changeFeatureDep(db, ctx, ids[0], foreign)).toThrow("同一个项目");
  expect(() => changeFeatureDep(db, { actor: "agent-exec" }, ids[0], ids[2])).toThrow("只有");
  expect(() => changeFeatureDep(db, ctx, ids[0], ids[2], false, "x".repeat(61))).toThrow("≤60");
});
test("MCP batches via CLI with verified channel; PM succeeds and executor writes nothing", async () => {
  changeFeatureDep(db, ctx, ids[0], ids[2]);
  const calls: string[][] = [];
  const deps = { db: () => db, manager: async (args: string[], channel: string) => {
    expect(channel).toBe("pm-channel"); calls.push(args);
    return runLedger(args.slice(1), { db, actor: ctx.actor, actorProject: "p", projectIds: ["p"], now: () => 1000,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
  } };
  const call = { agent: ctx.actor, channelId: "pm-channel", family: "codex", sessionId: null };
  const args = { remove: [{ from: ids[0], to: ids[2] }], add: [{ from: ids[0], to: ids[1] }, { from: ids[1], to: ids[2], note: "前置" }] };
  expect(await setFeatureDeps(deps, { ...call, agent: "agent-exec" }, args)).toMatchObject({ ok: false, code: "forbidden" });
  expect(calls).toHaveLength(0);
  expect(await setFeatureDeps(deps, call, args)).toMatchObject({ ok: true });
  expect(calls).toHaveLength(3); expect(featureDeps(db)).toHaveLength(2);
  expect(listEvents(db, { project: "p" }).filter((e) => ["dep-add", "dep-rm"].includes(e.data.op as string))).toHaveLength(4);
  const listed = await runLedger(["feature-deps", "a"], { db, actor: ctx.actor, actorProject: "p", projectIds: ["p"], now: () => 1000,
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
  expect(listed).toMatchObject({ ok: true, deps: [{ from: ids[0], to: ids[1] }] });
});

test("feature-deps reads require PM / master / owner for project and feature forms", async () => {
  changeFeatureDep(db, ctx, ids[0], ids[1]);
  for (const actor of ["agent-exec", ctx.actor, "master", "owner"]) {
    for (const suffix of [[], ["a"]]) {
      const result = await runLedger(["feature-deps", ...suffix], { db, actor, actorProject: "p", projectIds: ["p"], now: () => 1000,
        loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
      expect(result).toMatchObject(actor === "agent-exec" ? { ok: false, code: "forbidden" } : { ok: true, deps: [{ from: ids[0], to: ids[1] }] });
    }
  }
});

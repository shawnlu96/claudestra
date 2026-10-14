import { expect, test } from "bun:test";
import { parseAsk, parseAuthorizationBind, V2_MIGRATION_FEATURE_IDS_MAX } from "../src/lib/shared-ledger-contract-v2-asks";
import { parseCommand, parseDTO } from "../src/lib/shared-ledger-contract-v2";
import {
  V2_ASK_KIND_FIXTURES, V2_COMMAND_FIXTURES, V2_DTO_FIXTURES, V2_MIGRATION_ASK_FIXTURE,
} from "../src/lib/shared-ledger-contract-v2-fixtures";

const ask = () => structuredClone(V2_MIGRATION_ASK_FIXTURE.valid) as any;
const withBind = (patch: Record<string, unknown>) => { const a = ask(); a.bind = { ...a.bind, ...patch }; return a; };
const ids = (count: number) => ["feature", ...Array.from({ length: count - 1 }, (_, i) => `feature-${i}`)];

test("[验收线 1] migration authorize ask covers a multi-feature batch", () => {
  const a = ask();
  expect(a.bind.actions).toEqual(["migration"]);
  expect(a.bind.featureIds).toEqual(["feature", "feature-two"]);
  expect(a.featureId).toBe("feature");
  expect(parseAsk(a)).toEqual(a);
  expect(parseAuthorizationBind(a.bind)).toEqual(a.bind);
  expect(parseDTO("ask", a)).toEqual(a);
  expect(() => parseAsk(V2_MIGRATION_ASK_FIXTURE.invalid)).toThrow("invalid_field");
});

test("[验收线 1] migration bind without featureIds covers bind.featureId only", () => {
  const a = ask(); delete a.bind.featureIds;
  const parsed = parseAsk(a);
  expect(parsed).toEqual(a);
  expect(Object.hasOwn(parsed.bind!, "featureIds")).toBe(false);
  const single = withBind({ featureIds: ["feature"] });
  expect(parseAsk(single)).toEqual(single);
});

test("[验收线 1] featureIds accepts the cap and keeps order", () => {
  const a = withBind({ featureIds: ids(V2_MIGRATION_FEATURE_IDS_MAX).reverse() });
  expect(V2_MIGRATION_FEATURE_IDS_MAX).toBe(64);
  expect(parseAsk(a)).toEqual(a);
});

test("[验收线 2] migration never mixes with another action", () => {
  for (const actions of [["migration", "merge"], ["home.change", "migration"], ["migration", "migration"]]) {
    expect(() => parseAsk(withBind({ actions }))).toThrow("invalid_field");
    const bare = withBind({ actions }); delete bare.bind.featureIds;
    expect(() => parseAsk(bare)).toThrow("invalid_field");
  }
});

test("[验收线 2] only a migration bind may carry featureIds", () => {
  for (const actions of [["merge"], ["home.change"], ["scope.change", "task.cancel"]]) {
    expect(() => parseAsk(withBind({ actions }))).toThrow("invalid_field");
    expect(() => parseAsk(withBind({ actions, featureIds: ["feature"] }))).toThrow("invalid_field");
  }
});

test("[验收线 2] featureIds must be non-empty, distinct, include bind.featureId and stay within the cap", () => {
  const invalid: unknown[] = [
    [], ["feature", "feature"], ["feature", "feature-two", "feature-two"], ["feature-two"], ["feature-two", "feature-three"],
    ids(V2_MIGRATION_FEATURE_IDS_MAX + 1), null, "feature", ["feature", ""], ["feature", 1],
  ];
  for (const featureIds of invalid) {
    expect(() => parseAsk(withBind({ featureIds }))).toThrow("invalid_field");
    expect(() => parseAuthorizationBind({ ...ask().bind, featureIds })).toThrow("invalid_field");
  }
});

test("[验收线 2] parseAsk keeps its feature/task/expiry binding for migration asks", () => {
  expect(() => parseAsk({ ...ask(), featureId: "feature-two" })).toThrow("invalid_field");
  expect(() => parseAsk({ ...ask(), taskId: "task-two" })).toThrow("invalid_field");
  expect(() => parseAsk({ ...ask(), expiresAt: ask().expiresAt - 1 })).toThrow("invalid_field");
  expect(() => parseAsk({ ...ask(), bind: null })).toThrow("invalid_field");
  expect(() => parseAsk({ ...ask(), kind: "decide" })).toThrow("invalid_field");
});

test("[验收线 3] non-migration binds and asks parse exactly as before", () => {
  const legacy = ["scope.change", "home.change", "task.cancel", "merge", "deploy", "release", "artifact.share", "workflow.auto"];
  const bind = structuredClone(V2_DTO_FIXTURES.authorizationBind.valid) as any;
  expect(JSON.stringify(parseAuthorizationBind(bind))).toBe(JSON.stringify(bind));
  expect(JSON.stringify(parseAsk(V2_DTO_FIXTURES.ask.valid))).toBe(JSON.stringify(V2_DTO_FIXTURES.ask.valid));
  for (const action of legacy) {
    const one = { ...bind, actions: [action] };
    expect(JSON.stringify(parseAuthorizationBind(one))).toBe(JSON.stringify(one));
  }
  const all = { ...bind, actions: legacy };
  expect(JSON.stringify(parseAuthorizationBind(all))).toBe(JSON.stringify(all));
  expect(() => parseAuthorizationBind({ ...bind, actions: [...legacy, "migration"] })).toThrow("invalid_field");
  for (const actions of [[], ["merge", "merge"], ["unknown"]]) {
    expect(() => parseAuthorizationBind({ ...bind, actions })).toThrow("invalid_field");
  }
  for (const fixture of V2_ASK_KIND_FIXTURES) {
    expect(JSON.stringify(parseAsk(fixture.valid))).toBe(JSON.stringify(fixture.valid));
    expect(() => parseAsk(fixture.invalid)).toThrow("invalid_field");
  }
  expect(() => parseDTO("authorizationBind", V2_DTO_FIXTURES.authorizationBind.invalid)).toThrow("invalid_field");
  expect(() => parseDTO("ask", V2_DTO_FIXTURES.ask.invalid)).toThrow("invalid_field");
});

test("[验收线 3] ask.create and authorization.check commands carry the same bind rules", () => {
  const create = structuredClone(V2_COMMAND_FIXTURES.find(f => f.type === "ask.create")!.valid) as any;
  expect(parseCommand(create)).toEqual(create);
  const migration = structuredClone(create);
  migration.payload.bind = ask().bind;
  expect(parseCommand(migration)).toEqual(migration);
  migration.payload.bind = { ...ask().bind, actions: ["migration", "merge"] };
  expect(() => parseCommand(migration)).toThrow("invalid_field");
  const check = structuredClone(V2_COMMAND_FIXTURES.find(f => f.type === "authorization.check")!.valid) as any;
  expect(parseCommand(check)).toEqual(check);
});

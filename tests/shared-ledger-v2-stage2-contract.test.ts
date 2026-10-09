import { describe, expect, test } from "bun:test";
import {
  V2_COMMAND_NAMES, V2ContractError, capabilities, parseCapabilities, parseIntent, parseResource, parseWorkflow,
} from "../src/lib/shared-ledger-contract-v2";
import {
  V2_ROUTES, V2_ROUTE_NAMES, matchV2Route, parseFeatureView, parseLendView, parseMigrationLookup, parsePathId,
  parseRevertLookup, parseRevertRequest, parseRevertResult,
  v2ProjectRoot, type V2RouteName,
} from "../src/lib/shared-ledger-contract-v2-routes";
import {
  V2_FEATURE_VIEW_FIXTURE, V2_FEATURE_VIEW_INVALID, V2_REVERT_REQUEST_FIXTURE, V2_REVERT_REQUEST_INVALID,
  V2_REVERT_RESULT_FIXTURE, V2_REVERT_RESULT_INVALID, V2_ROUTE_BAD_IDS, V2_ROUTE_FIXTURES,
} from "../src/lib/shared-ledger-contract-v2-routes-fixtures";

const rejects = (fn: () => unknown) => {
  try { fn(); throw Error("accepted invalid input"); }
  catch (e) { expect(e).toBeInstanceOf(V2ContractError); expect((e as V2ContractError).code).toBe("invalid_field"); }
};
const routes = V2_ROUTES as unknown as Record<V2RouteName, {
  method: string; path(p: unknown): string; parseRequest(v: unknown, p: unknown): unknown; parseResponse(v: unknown, p: unknown): unknown;
}>;
const ROOT = "/v2/teams/team/projects/project";

describe("S2K V2_ROUTES", () => {
  test("covers exactly the nine stage-2 routes with fixed methods", () => {
    expect(Object.fromEntries(V2_ROUTE_NAMES.map(n => [n, routes[n].method]))).toEqual({
      commands: "POST", receipts: "GET", asks: "GET", features: "GET", lend: "GET",
      migrations: "POST", migration: "GET", reverts: "POST", revert: "GET",
    });
    expect(Object.keys(V2_ROUTE_FIXTURES).sort()).toEqual([...V2_ROUTE_NAMES].sort());
    expect(Object.isFrozen(V2_ROUTES)).toBe(true);
  });
  for (const name of Object.keys(V2_ROUTE_FIXTURES) as V2RouteName[]) {
    const fx = V2_ROUTE_FIXTURES[name], r = routes[name];
    test(`${name}: path under project root, legal samples pass, illegal samples reject`, () => {
      expect(r.path(fx.params)).toBe(fx.path);
      expect(fx.path.startsWith(`${ROOT}/`)).toBe(true);
      expect(matchV2Route(r.method, fx.path)).toEqual({ name, params: fx.params });
      expect(r.parseRequest(structuredClone(fx.request.valid), fx.params)).toEqual(fx.request.valid as never);
      expect(r.parseResponse(structuredClone(fx.response.valid), fx.params)).toEqual(fx.response.valid as never);
      expect(Object.keys(fx.request.invalid).length + Object.keys(fx.response.invalid).length).toBeGreaterThan(1);
      for (const [label, bad] of Object.entries(fx.request.invalid)) {
        try { rejects(() => r.parseRequest(bad, fx.params)); } catch (e) { throw Error(`${name} request ${label}: ${e}`); }
      }
      for (const [label, bad] of Object.entries(fx.response.invalid)) {
        try { rejects(() => r.parseResponse(bad, fx.params)); } catch (e) { throw Error(`${name} response ${label}: ${e}`); }
      }
    });
    test(`${name}: path builder rejects ids with "/" or ".."`, () => {
      for (const key of Object.keys(fx.params).filter(k => k !== "commandDigest")) {
        for (const bad of V2_ROUTE_BAD_IDS) rejects(() => r.path({ ...fx.params, [key]: bad }));
      }
      rejects(() => r.path({ ...fx.params, extra: "x" }));
      rejects(() => r.parseResponse(fx.response.valid, { ...fx.params, teamId: "../team" }));
    });
  }
  test("path ids and project root", () => {
    for (const bad of V2_ROUTE_BAD_IDS) rejects(() => parsePathId(bad));
    for (const bad of [1, null, undefined, "a".repeat(129)]) rejects(() => parsePathId(bad));
    expect(parsePathId("task:1.v2")).toBe("task:1.v2");
    expect(v2ProjectRoot("team", "project")).toBe(ROOT);
    rejects(() => v2ProjectRoot("team/x", "project"));
    rejects(() => v2ProjectRoot("team", ".."));
  });
  test("receipts query omits a null operationId and the matcher round-trips it", () => {
    const params = { ...V2_ROUTE_FIXTURES.receipts.params, operationId: null };
    const path = V2_ROUTES.receipts.path(params as never);
    expect(path).toBe(`${ROOT}/receipts/request?commandDigest=${"a".repeat(64)}`);
    expect(matchV2Route("GET", path)).toEqual({ name: "receipts", params });
    rejects(() => V2_ROUTES.receipts.path({ ...params, commandDigest: "short" } as never));
  });
  test("matcher refuses wrong method, extra segments, foreign roots and traversal", () => {
    for (const [method, url] of [
      ["GET", `${ROOT}/commands`], ["POST", `${ROOT}/asks/ask`], ["GET", `${ROOT}/asks/ask/extra`],
      ["GET", `${ROOT}/asks/..`], ["GET", `${ROOT}/asks/a..b`], ["GET", "/v2/teams/team/commands"],
      ["GET", `/v1/teams/team/projects/project/asks/ask`], ["GET", `${ROOT}/receipts/request`],
      ["GET", `${ROOT}/receipts/request?commandDigest=${"a".repeat(64)}&actor=x`], ["GET", `${ROOT}/asks/ask?x=1`],
      ["GET", `${ROOT}/asks/%2e%2e`], ["GET", `${ROOT}/unknown/x`],
    ]) expect(matchV2Route(method, url)).toBeNull();
  });
  test("GET routes accept no body; POST bodies must match the path scope", () => {
    for (const name of V2_ROUTE_NAMES.filter(n => routes[n].method === "GET")) {
      rejects(() => routes[name].parseRequest({}, V2_ROUTE_FIXTURES[name].params));
    }
    const other = { teamId: "team", projectId: "project-other" };
    for (const name of ["commands", "migrations", "reverts"] as const) {
      rejects(() => routes[name].parseRequest(V2_ROUTE_FIXTURES[name].request.valid, other));
    }
  });
});

describe("S2K standalone view / lookup parsers", () => {
  test("lend view and batch lookups parse without path params", () => {
    const lend = V2_ROUTE_FIXTURES.lend.response.valid;
    expect(parseLendView(structuredClone(lend))).toEqual(lend as never);
    expect(parseLendView({ ...structuredClone(lend as object), lease: null }).lease).toBeNull();
    const fx = V2_ROUTE_FIXTURES.lend.response.invalid as Record<string, Record<string, any>>;
    for (const label of ["leaseOtherEpoch", "leaseOtherGeneration", "leaseOtherBoot", "leaseOtherExecutor", "orderOtherFeature", "orderOtherHome"]) {
      rejects(() => parseLendView(structuredClone(fx[label])));
      expect(parseLendView({ ...structuredClone(fx[label]), lease: null, task: structuredClone((lend as any).task) }).lease).toBeNull();
    }
    const migration = V2_ROUTE_FIXTURES.migration.response.valid;
    expect(parseMigrationLookup(structuredClone(migration))).toEqual(migration as never);
    const committed = { teamId: "team", projectId: "project", batchId: "revert-batch", status: "committed", result: V2_REVERT_RESULT_FIXTURE };
    expect(parseRevertLookup(structuredClone(committed)).result?.nextEpoch).toBe(2);
    rejects(() => parseRevertLookup({ ...committed, result: null }));
    rejects(() => parseMigrationLookup({ ...(migration as object), status: "pending" }));
  });
});

describe("S2K parseFeatureView", () => {
  test("has exactly the frozen field set", () => {
    expect(Object.keys(parseFeatureView(structuredClone(V2_FEATURE_VIEW_FIXTURE))).sort()).toEqual([
      "teamId", "projectId", "serverSeq", "serviceGeneration", "feature", "dag", "tasks", "dependencies", "steps",
      "workflows", "intents", "resources", "pendingAsks", "capabilities",
    ].sort());
  });
  test("reuses X0 workflow / intent / resource parsers", () => {
    const v = structuredClone(V2_FEATURE_VIEW_FIXTURE);
    expect(parseFeatureView(v).workflows).toEqual(v.workflows.map(parseWorkflow) as never);
    expect(parseFeatureView(v).intents).toEqual(v.intents.map(parseIntent) as never);
    expect(parseFeatureView(v).resources).toEqual(v.resources.map(parseResource) as never);
    for (const [key, field] of [["workflows", "mode"], ["intents", "status"], ["resources", "state"]] as const) {
      const bad = structuredClone(V2_FEATURE_VIEW_FIXTURE) as Record<string, any>;
      bad[key][0][field] = "not-a-value";
      rejects(() => parseFeatureView(bad));
    }
  });
  test("a feature without a DAG has dag null", () => {
    const v = structuredClone(V2_FEATURE_VIEW_FIXTURE) as Record<string, any>;
    v.feature.currentVersion = 0; v.dag = null;
    expect(parseFeatureView(v).dag).toBeNull();
    v.dag = structuredClone(V2_FEATURE_VIEW_FIXTURE.dag);
    rejects(() => parseFeatureView(v));
  });
  for (const [label, bad] of Object.entries(V2_FEATURE_VIEW_INVALID)) {
    test(`rejects ${label}`, () => rejects(() => parseFeatureView(bad)));
  }
  test("resource rejections come from cross-row invariants: each row still parses alone", () => {
    for (const label of ["unknownWithoutLock", "unknownLockHeld", "resourceFenceMismatch", "resourceOtherBoot", "resourceNotDeclared", "resourceOverlap"]) {
      const bad = V2_FEATURE_VIEW_INVALID[label] as Record<string, any>;
      for (const i of bad.intents) parseIntent(structuredClone(i));
      for (const r of bad.resources) parseResource(structuredClone(r));
    }
  });
  test("an unknown intent keeps every declared resource as an unknown lock", () => {
    const v = structuredClone(V2_FEATURE_VIEW_FIXTURE) as Record<string, any>;
    v.intents[0].status = "unknown"; v.resources[0].state = "unknown";
    expect(parseFeatureView(v).resources[0].state).toBe("unknown");
    v.intents[0].resources = []; v.resources = [];
    expect(parseFeatureView(v).intents[0].status).toBe("unknown");
  });
});

describe("S2K revert request / result", () => {
  test("legal request requires all four evidence flags true", () => {
    expect(parseRevertRequest(structuredClone(V2_REVERT_REQUEST_FIXTURE))).toEqual(V2_REVERT_REQUEST_FIXTURE as never);
    expect(Object.keys(V2_REVERT_REQUEST_FIXTURE.evidence).sort()).toEqual(["dispatchPaused", "leasesReleased", "lendSettled", "unknownReconciled"]);
    for (const key of Object.keys(V2_REVERT_REQUEST_FIXTURE.evidence)) {
      const bad = structuredClone(V2_REVERT_REQUEST_FIXTURE) as Record<string, any>;
      bad.evidence[key] = false;
      rejects(() => parseRevertRequest(bad));
    }
    for (const key of ["batchId", "featureIds", "expectedEpoch", "authorizationAskId", "evidence"]) {
      const bad = structuredClone(V2_REVERT_REQUEST_FIXTURE) as Record<string, unknown>;
      delete bad[key];
      rejects(() => parseRevertRequest(bad));
    }
  });
  for (const [label, bad] of Object.entries(V2_REVERT_REQUEST_INVALID)) {
    test(`request rejects ${label}`, () => rejects(() => parseRevertRequest(bad)));
  }
  test("legal result carries nextEpoch and a final planning feature view", () => {
    const r = parseRevertResult(structuredClone(V2_REVERT_RESULT_FIXTURE));
    expect(r.nextEpoch).toBe(2);
    expect(r.views[0].feature.authorityMode).toBe("planning");
    expect(parseFeatureView(structuredClone(V2_REVERT_RESULT_FIXTURE.views[0]))).toEqual(r.views[0]);
  });
  for (const [label, bad] of Object.entries(V2_REVERT_RESULT_INVALID)) {
    test(`result rejects ${label}`, () => rejects(() => parseRevertResult(bad)));
  }
});

describe("S2K leaves the frozen command set untouched", () => {
  test("V2_COMMAND_NAMES snapshot", () => {
    expect([...V2_COMMAND_NAMES]).toEqual([
      "feature.new", "feature.set", "dag.init", "item.new", "item.set", "task.new", "task.set", "task.spec", "task.assign",
      "task.stage", "task.deliver", "task.review", "dep.set", "dep.remove", "step.assign", "workflow.set", "ask.create",
      "ask.answer", "ask.cancel", "ask.expire", "authorization.check", "artifact.put", "lease.acquire", "lease.renew",
      "lease.release", "intent.create", "intent.check", "intent.cancel", "operation.result", "operation.reconcile",
      "lend.create", "lend.claim", "lend.renew", "lend.result", "lend.cancel", "dag.propose", "dag.decide", "dag.bind",
      "dag.rewrite", "home.change", "migration.commit",
    ]);
    expect(Object.isFrozen(V2_COMMAND_NAMES)).toBe(true);
  });
  test("parseCapabilities snapshot: exactly the command keys, all required, no extras", () => {
    const all = capabilities(["task.set"]);
    expect(Object.keys(parseCapabilities(all))).toEqual([...V2_COMMAND_NAMES]);
    expect(parseCapabilities(all)["task.set"]).toEqual({ enabled: true, code: null, reason: "" });
    expect(parseCapabilities(all)["lend.create"]).toEqual({ enabled: false, code: "execution_not_shared", reason: "执行能力尚未开放" });
    const missing = structuredClone(all) as Record<string, unknown>; delete missing["migration.commit"];
    rejects(() => parseCapabilities(missing));
    rejects(() => parseCapabilities({ ...all, "revert.commit": { enabled: false, code: "execution_not_shared", reason: "x" } }));
  });
});

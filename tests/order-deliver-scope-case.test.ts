import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_SCOPE_RULE } from "../src/lib/ask-scope-auto.js";
import { describeDeliveredScope } from "../src/lib/ask-scope-auto-display.js";
import { useAskScopeCasePort } from "../src/lib/ask-scope-case-policy.js";
import { answerAsk, openAskFull } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask } from "../src/lib/ledger-write.js";
import { ensureDeliverScope, scopeInputs } from "../src/lib/order-deliver-scope.js";
import type { ScopeDiff } from "../src/lib/order-deliver-scope-git.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const H = "a".repeat(40), B = "b".repeat(40), source = "src/lib/card-feature.ts";
const risky = "src/lib/Ledger-Checks-x.ts", safe = "src/lib/Host.ts";
const registry = "src/lib/Recovery-Keys.ts", service = "src/lib/shared-ledger-gate-cli-services.ts";
const checked = (path: string, kind = "wire", granted = true) => ({ path, kind, granted, added: 2, deleted: 0 });
let db: Database, dir: string, dbPath: string, caseMode: RecoveryMode, autoMode: RecoveryMode;
const policy: RecoveryPolicyPort = (project, key) => ({
  mode: key === "askScopeAuto" ? autoMode : key === "askScopeCaseFold" && project === "claude-orchestrator" ? caseMode : "off",
  manualAfterMs: null, source: "config",
});
const task = () => getTask(db, "T1")!;
const notes = () => listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope");
const review = () => scopeInputs(db, task(), H, policy).join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scope-case-display-")); dbPath = join(dir, "ledger.db"); db = openLedger(dbPath);
  caseMode = "off"; autoMode = "on";
  useAskScopeCasePort({ policy, observe: () => { throw new Error("rendering must not write observations"); } });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "scope case", kind: "code", extra: { fileGlobs: [source] } });
});
afterEach(() => { useAskScopeCasePort(); closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

function legacy(caseFold?: RecoveryMode, paths = [checked(risky), checked(registry), checked(safe), checked(service, "services")], spliced = false) {
  const data = { op: "deliver_scope", head: H, base: B, specRev: task().specRev,
    askScopeAuto: { rule: ASK_SCOPE_RULE, files: paths, ...(caseFold === undefined ? {} : { caseFold }) } };
  const body = ["规格外文件（相对 PR base）：", ...paths.map((f) => `${JSON.stringify(f.path)}：+2 / -0（2 行）；与 T2 共改，冲突两边保留`)].join("\n");
  const text = spliced ? "规格外文件：无（相对 PR base）" : describeDeliveredScope(body, data);
  appendEvent(db, { actor: "scheduler", dedupKey: `deliver-scope:T1:${task().specRev}:${H}` },
    { project: "p", target: "T1", kind: "note", text, data });
  return { data, body, text, baseline: describeDeliveredScope(text, data, "on") };
}

for (const recorded of [undefined, "off", "observe"] as const) {
  test(`[验收线 1] same head rechecks legacy ${recorded ?? "missing"} evidence after folding tightens`, async () => {
    const old = legacy(recorded), events = listEvents(db, { target: "T1" });
    expect(review()).toBe(old.baseline);
    caseMode = "on";
    let reads = 0;
    await ensureDeliverScope(db, task(), H, async () => { reads++; throw new Error("same head must not fetch"); }, Date.now(), policy);
    expect(reads).toBe(0);
    const [outside, approved] = review().split("已自动核准：");
    for (const path of [risky, registry]) {
      expect(outside).toContain(`${JSON.stringify(path)}：+2 / -0（2 行）；与 T2 共改，冲突两边保留；折叠口径收紧后需人工核`);
      expect(approved).not.toContain(path);
    }
    for (const path of [safe, service]) expect(approved).toContain(path);
    expect(listEvents(db, { target: "T1" })).toEqual(events);
    expect(notes()[0]!.text).toBe(old.text);
  });
}

test("[验收线 1] old events with spliced files restore ordinary rows without an empty approval section", () => {
  const { data } = legacy(undefined, [checked(risky)], true);
  caseMode = "on";
  expect(review()).toBe(`规格外文件（相对 PR base）：\n${JSON.stringify(risky)}：+2 / -0（2 行）；折叠口径收紧后需人工核`);
  expect(notes()[0]!.data).toEqual(data);
});

test("[验收线 1] registry variants are rechecked for every granted kind", () => {
  legacy(undefined, [checked(registry, "keys")]); caseMode = "on";
  expect(review()).not.toContain("已自动核准");
  expect(review()).toContain(`${JSON.stringify(registry)}：+2 / -0（2 行）；与 T2 共改，冲突两边保留；折叠口径收紧后需人工核`);
});

test("[验收线 2] off restores identical text, observe and disabled auto scope keep baseline behavior", () => {
  const old = legacy();
  const baseline = review();
  expect(baseline).toBe(["规格外文件（相对 PR base）：", "已自动核准：",
    ...[risky, registry, safe].map((path) => `${JSON.stringify(path)}：+2 / -0（2 行）；与 T2 共改，冲突两边保留；小接线`),
    `${JSON.stringify(service)}：+2 / -0（2 行）；与 T2 共改，冲突两边保留；登记项`,
  ].join("\n"));
  caseMode = "on"; expect(review()).not.toBe(baseline);
  caseMode = "off"; expect(review()).toBe(baseline);
  caseMode = "observe"; expect(review()).toBe(baseline);
  caseMode = "on";
  for (const state of ["off", "observe"] as const) {
    autoMode = state;
    expect(review()).toBe(describeDeliveredScope(old.text, old.data, state));
    expect(review()).toBe(old.body);
  }
});

test("[验收线 3] evidence recorded with folding on is not rechecked at render time", () => {
  const old = legacy("on");
  caseMode = "on";
  let checks = 0;
  useAskScopeCasePort({ policy: (...args) => { checks++; return policy(...args); }, observe: () => { throw new Error("unexpected observation"); } });
  expect(review()).toBe(old.baseline);
  expect(review().split("已自动核准：")[1]).toContain(risky);
  expect(checks).toBe(0);
});

function candidate(path: string) {
  const grants = [{ path, kind: "wire", source, check: "wire" }];
  const { ask } = openAskFull(db, { project: "p", taskId: "T1", source: "system", kind: "decide", title: "wire",
    extra: { askScopeAuto: true, scopeGrants: grants } });
  answerAsk(db, ask.id, { choices: [], labels: [], text: "provisional", principal: "system:ask-scope-auto", via: "terminal", at: Date.now(), final: true });
  appendEvent(db, { actor: "system:ask-scope-auto" }, { project: "p", target: "T1", kind: "note", text: "grant",
    data: { op: "ask_scope_auto", rule: ASK_SCOPE_RULE, specRev: task().specRev, askId: ask.id, grants } });
}

function diff(path: string): ScopeDiff {
  const base = "export function host(ctx: unknown) {\n  return ctx;\n}\n";
  const next = 'import { feature } from "./card-feature.js";\nexport function host(ctx: unknown) {\n  feature(ctx);\n  return ctx;\n}\n';
  return { base: B, filesComplete: true, files: [{ path, added: 2, deleted: 0 }, { path: source, added: 1, deleted: 0 }], objects: {
    mergeBase: async () => B, prHead: async () => H, list: async (commit) => commit === B ? [path] : [path, source],
    show: async (commit, file) => file === source ? "export function feature(ctx: unknown) { return ctx; }\n" : commit === B ? base : next,
  } };
}

for (const mode of ["off", "observe", "on"] as const) {
  test(`[验收线 3] new delivery records caseFold=${mode} with exact diff evidence`, async () => {
    candidate(safe); caseMode = mode;
    await ensureDeliverScope(db, task(), H, async () => diff(safe), Date.now(), policy);
    expect(notes()[0]!.data.askScopeAuto).toMatchObject({ caseFold: mode, files: [{ path: safe, granted: true }] });
  });
}

test("[验收线 1] a real off grant is downgraded for review on the same head", async () => {
  candidate(risky);
  await ensureDeliverScope(db, task(), H, async () => diff(risky), Date.now(), policy);
  expect(notes()[0]!.data.askScopeAuto).toMatchObject({ caseFold: "off", files: [{ path: risky, granted: true }] });
  const baseline = review(), events = listEvents(db, { target: "T1" });
  caseMode = "on";
  expect(review()).not.toContain("已自动核准");
  expect(review()).toContain(`${JSON.stringify(risky)}：+2 / -0（2 行）；折叠口径收紧后需人工核`);
  expect(listEvents(db, { target: "T1" })).toEqual(events);
  caseMode = "off"; expect(review()).toBe(baseline);
});

test("[验收线 3] a policy change during Git reads cannot stamp a grant with the earlier folding mode", async () => {
  candidate(risky); caseMode = "on";
  const d = diff(risky);
  d.objects!.show = async (commit, path) => {
    caseMode = "off";
    return diff(risky).objects!.show(commit, path);
  };
  await ensureDeliverScope(db, task(), H, async () => d, Date.now(), policy);
  expect(notes()[0]!.data.askScopeAuto).toMatchObject({ caseFold: "on", files: [{ granted: false, reason: "核对期间折叠口径已变化" }] });
});

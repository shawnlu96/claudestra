import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { answerAsk, closeAsk, getAsk, listAsks, openAsk, patchAsk, type Ask } from "../src/lib/ledger-asks.js";
import { SharedLedgerProjectAuditor, type ProjectAuditPorts } from "../src/bridge/shared-ledger-project-audit.js";
import { auditSharedLedgerProjects, auditRows, auditVersion, type ProjectAudit, type ProjectAuditState } from "../src/lib/shared-ledger-project-audit.js";
import { sharedLedgerGateProxy } from "../src/lib/shared-ledger-gate-proxy.js";
import { initSharedLedgerProjectAudit } from "../src/bridge/shared-ledger-project-audit-runtime.js";
import { publishAsk, setAsksForTest } from "../src/bridge/asks.js";

const roots: string[] = [];
afterEach(() => {
  setAsksForTest(undefined);
  for (const dir of roots.splice(0)) { closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); }
});
const target = { centerId: "center", teamId: "team", projectId: "claude-orchestrator", name: "Claudestra" };
const binding = { centerId: target.centerId, teamId: target.teamId, projectId: target.projectId, localProjectId: "claude-orchestrator" };
const local = { id: "claudestra", name: "Claudestra", personal: false };
const initial = (): ProjectAuditState => ({ bindings: [{ ...binding }], credentials: [{ ...target }], projects: [{ ...local }] });

/** Synthetic replacement port, NOT frozen N2 or production writer coverage. N6W must rerun with the actual writer. */
function world(state = initial()) {
  const dir = mkdtempSync(join(tmpdir(), "sl-project-audit-")); roots.push(dir);
  const db = openLedger(join(dir, "ledger.sqlite")), file = join(dir, "shared-ledger-bindings.json");
  const credentialFile = join(dir, "shared-ledger-credentials.json");
  writeFileSync(file, JSON.stringify(state.bindings), { mode: 0o600 });
  writeFileSync(credentialFile, JSON.stringify({ credentials: [{ ...target, localSubject: "owner:self", kind: "person",
    baseUrl: "https://fixture.invalid/", personId: "fixture-person", instanceId: "fixture-instance", bearer: "synthetic-only",
    projects: [{ projectId: target.projectId, actions: ["read"] }] }] }), { mode: 0o600 });
  let now = Date.now(), replacements = 0, creations = 0;
  const messages: string[] = [];
  const ports: ProjectAuditPorts = {
    now: () => now, read: async () => structuredClone({ ...state, bindings: JSON.parse(readFileSync(file, "utf8")) }),
    asks: () => listAsks(db), openAsk: input => openAsk(db, input),
    closeAsk: (id, status) => { closeAsk(db, id, status, "new audit snapshot or expiration", now); },
    claim: id => db.transaction(() => {
      const a = getAsk(db, id);
      if (!a || a.state !== "answered" || a.extra.projectAuditSettled) return false;
      patchAsk(db, id, { extra: { projectAuditSettled: true } });
      return true;
    }).immediate(),
    inform: async text => { messages.push(text); },
    createLocalProject: async ref => {
      creations++;
      let id = ref.projectId, n = 2;
      while (state.projects.some(p => p.id === id)) id = `${ref.projectId}-${n++}`;
      state.projects.push({ id, name: ref.name, personal: false });
      return id;
    },
    replaceSharedLedgerBindings: async input => {
      const rows = JSON.parse(readFileSync(file, "utf8"));
      if (auditVersion(auditRows(rows, target)) !== auditVersion(input.expected)) throw new Error("fixture_cas");
      replacements++;
      writeFileSync(`${file}.bak-${replacements}`, readFileSync(file), { mode: 0o600 });
      writeFileSync(file, JSON.stringify([...rows.filter((b: typeof binding) =>
        b.centerId !== input.next.centerId || b.teamId !== input.next.teamId || b.projectId !== input.next.projectId), input.next]));
    },
  };
  const auditor = new SharedLedgerProjectAuditor(ports);
  const current = () => ports.asks().find(a => a.state === "open")!;
  const answer = (button?: string, owner = true, a = current()): Ask => answerAsk(db, a.id, {
    choices: [`[button:${button ?? (a.extra.projectAudit as ProjectAudit).selected}]`], labels: ["fixture"], text: "",
    principal: "owner:self", via: "web_card", at: now, ...(owner ? { owner: true as const } : { external: true }),
  });
  return { state, dir, file, credentialFile, ports, auditor, db, current, answer, messages,
    counts: () => ({ replacements, creations }), advance: () => { now += 25 * 3600_000; },
    mutate: (rows: unknown) => writeFileSync(file, JSON.stringify(rows)),
  };
}

test("read-only classifier covers normal, dangling, duplicate, personal and credentials without bindings", () => {
  for (const status of ["normal", "dangling", "duplicate", "personal", "unbound"] as const) {
    const state = initial();
    if (status === "normal" || status === "personal") state.bindings[0]!.localProjectId = local.id;
    if (status === "personal") state.projects[0]!.personal = true;
    if (status === "duplicate") state.bindings.push({ ...binding, localProjectId: local.id });
    if (status === "unbound") state.bindings = [];
    const before = structuredClone(state);
    expect(auditSharedLedgerProjects(state)[0]!.status).toBe(status);
    expect(state).toEqual(before);
  }
});

test("normal owner member has no binding audit or owner bootstrap card", async () => {
  const state = initial(); state.bindings[0]!.localProjectId = local.id;
  const w = world(state), before = readFileSync(w.file);
  await w.auditor.run();
  expect(w.ports.asks()).toHaveLength(0);
  expect(w.counts()).toEqual({ replacements: 0, creations: 0 });
  expect(readFileSync(w.file)).toEqual(before);
});

for (const peer of ["A", "B"]) test(`peer ${peer}: recommended Claudestra, owner approval, fixture backup and real proxy local identity`, async () => {
  const w = world(), before = readFileSync(w.file), credential = readFileSync(w.credentialFile);
  await Promise.all([w.auditor.run(), w.auditor.run(), new SharedLedgerProjectAuditor(w.ports).run()]);
  expect(w.ports.asks()).toHaveLength(1);
  const audit = w.current().extra.projectAudit as ProjectAudit;
  expect(audit.choices.find(c => c.button === audit.selected)).toMatchObject({ localProjectId: local.id });
  expect(readFileSync(w.file)).toEqual(before);
  const answered = w.answer();
  await Promise.all([w.auditor.onAnswered(answered), w.auditor.onAnswered(answered), new SharedLedgerProjectAuditor(w.ports).onAnswered(answered)]);
  expect(w.counts().replacements).toBe(1);
  expect(JSON.parse(readFileSync(w.file, "utf8"))).toEqual([{ ...binding, localProjectId: local.id }]);
  expect(readFileSync(`${w.file}.bak-1`)).toEqual(before);
  expect(statSync(`${w.file}.bak-1`).mode & 0o777).toBe(0o600);
  expect(readFileSync(w.credentialFile)).toEqual(credential);
  const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "" };
  const response = await sharedLedgerGateProxy(new Request("https://fixture.invalid/shared-ledger/context"),
    "/shared-ledger/context", principal, async () => Response.json({ ok: true }), { stateDir: w.dir });
  expect(response!.status).toBe(200);
  expect((await response!.json() as { identities: unknown[] }).identities).toMatchObject([{ localProjectId: local.id, project: target.projectId }]);
});

test("duplicate, personal and unbound states converge through the replacement port only", async () => {
  for (const mode of ["duplicate", "personal", "unbound"]) {
    const state = initial();
    if (mode === "duplicate") state.bindings.push({ ...binding, localProjectId: "other-missing" });
    if (mode === "personal") state.projects.push({ id: binding.localProjectId, name: "Private", personal: true });
    if (mode === "unbound") state.bindings = [];
    const w = world(state), credentials = readFileSync(w.credentialFile);
    await w.auditor.run();
    expect((w.current().extra.projectAudit as ProjectAudit).choices).not.toContainEqual(expect.objectContaining({ localProjectId: binding.localProjectId }));
    await w.auditor.onAnswered(w.answer());
    expect((await w.ports.read()).bindings).toEqual([{ ...binding, localProjectId: local.id }]);
    expect(readFileSync(w.credentialFile)).toEqual(credentials);
  }
});

test("ignore and expiration do not write; restart reoffers once with a new persistent dedup key", async () => {
  for (const mode of ["ignore", "expire"]) {
    const w = world(), before = readFileSync(w.file);
    await w.auditor.run();
    const oldKey = w.current().dedupKey;
    if (mode === "ignore") await w.auditor.onAnswered(w.answer("sl_audit_skip"));
    else w.advance();
    await w.auditor.run();
    expect(w.ports.asks()).toHaveLength(1);
    const restarted = new SharedLedgerProjectAuditor(w.ports);
    await Promise.all([restarted.run(), restarted.run(), new SharedLedgerProjectAuditor(w.ports).run()]);
    expect(w.ports.asks()).toHaveLength(2);
    expect(w.ports.asks().filter(a => a.state === "open")).toHaveLength(1);
    if (mode === "expire") expect(w.ports.asks().find(a => a.dedupKey === oldKey)!.state).toBe("expired");
    expect(w.ports.asks().some(a => a.dedupKey !== oldKey)).toBe(true);
    expect(readFileSync(w.file)).toEqual(before);
    expect(w.counts().replacements).toBe(0);
  }
});

test("changed expected rows reject without any write and open a new snapshot card", async () => {
  const w = world(); await w.auditor.run();
  const a = w.answer();
  w.mutate([{ ...binding, localProjectId: "changed-by-other-owner" }]);
  const before = readFileSync(w.file);
  await w.auditor.onAnswered(a);
  expect(readFileSync(w.file)).toEqual(before);
  expect(w.counts()).toEqual({ replacements: 0, creations: 0 });
  expect(w.current().id).not.toBe(a.id);
  expect((w.current().extra.projectAudit as ProjectAudit).expected[0]!.localProjectId).toBe("changed-by-other-owner");
});

test("guest, multiple selections, expiry and modified snapshot/hash never call replacement", async () => {
  for (const mode of ["guest", "multiple", "expiry", "snapshot", "hash"]) {
    const w = world(); await w.auditor.run();
    const a = w.answer(undefined, mode !== "guest"), before = readFileSync(w.file);
    if (mode === "multiple") a.answer!.choices.push("[button:sl_audit_skip]");
    if (mode === "expiry") w.advance();
    if (mode === "snapshot") (a.extra.projectAudit as ProjectAudit).target.name = "Changed";
    if (mode === "hash") a.bind!.paramsHash = "0".repeat(64);
    await w.auditor.onAnswered(a);
    expect(w.counts()).toEqual({ replacements: 0, creations: 0 });
    expect(readFileSync(w.file)).toEqual(before);
  }
});

test("name matching is case insensitive, ambiguous matches choose create, all eligible choices retained", () => {
  const state = initial(); state.projects[0]!.name = "CLAUDESTRA";
  let audit = auditSharedLedgerProjects(state)[0]!;
  expect(audit.selected).toBe("sl_audit_0");
  state.projects.push({ id: "also", name: "Claudestra", personal: false });
  for (let i = 0; i < 8; i++) state.projects.push({ id: `p${i}`, name: `P ${i}`, personal: false });
  state.projects.push({ id: "personal", name: "Claudestra", personal: true });
  state.bindings.push({ ...binding, projectId: "other", localProjectId: "p0" });
  audit = auditSharedLedgerProjects(state)[0]!;
  expect(audit.selected).toBe("sl_audit_create");
  expect(audit.choices).toHaveLength(10);
  expect(audit.choices.some(c => c.kind === "existing" && ["p0", "personal"].includes(c.localProjectId))).toBe(false);
});

test("new local project is created only after owner approval and no-name-match defaults to create", async () => {
  const state = initial(); state.projects = [];
  const w = world(state); await w.auditor.run();
  expect(w.counts().creations).toBe(0);
  expect((w.current().extra.projectAudit as ProjectAudit).selected).toBe("sl_audit_create");
  await w.auditor.onAnswered(w.answer());
  expect(w.counts()).toEqual({ replacements: 1, creations: 1 });
  expect((await w.ports.read()).bindings).toEqual([binding]);
});

test("credential loss and target becoming personal after opening both fail closed", async () => {
  for (const mode of ["credential", "personal", "deleted", "occupied"]) {
    const w = world(); await w.auditor.run();
    const a = w.answer();
    if (mode === "credential") w.state.credentials = [];
    if (mode === "personal") w.state.projects[0]!.personal = true;
    if (mode === "deleted") w.state.projects = [];
    if (mode === "occupied") w.mutate([binding, { ...binding, projectId: "other", localProjectId: local.id }]);
    const before = readFileSync(w.file);
    await w.auditor.onAnswered(a);
    expect(readFileSync(w.file)).toEqual(before);
    expect(w.counts().replacements).toBe(0);
  }
});

test("writer race and failed readback never report success; error text is not reflected", async () => {
  for (const mode of ["race", "readback"]) {
    const w = world(); await w.auditor.run();
    w.ports.replaceSharedLedgerBindings = async () => { if (mode === "race") throw new Error("synthetic-secret-must-not-echo"); };
    await w.auditor.onAnswered(w.answer());
    expect(w.messages.join(" ")).not.toContain("synthetic-secret");
    expect(w.messages.join(" ")).not.toContain("已绑定");
    expect(w.current()).toBeDefined();
  }
});

test("bridge composition runs startup audit, consumes actual ask notifications and rechecks after join", async () => {
  const w = world();
  setAsksForTest({ path: join(w.dir, "ledger.sqlite") });
  w.ports.projectChoices = () => ({ choices: [
    { kind: "existing", button: "n4_existing", localProjectId: local.id, name: local.name },
  ], selected: "n4_existing" });
  const runtime = await initSharedLedgerProjectAudit(w.ports);
  try {
    expect(w.ports.asks()).toHaveLength(1);
    expect((w.current().extra.projectAudit as ProjectAudit).selected).toBe("n4_existing");
    publishAsk(w.answer());
    await runtime.afterJoin(); // Serialized behind the answer listener; no sleeps or network needed.
    expect(w.counts().replacements).toBe(1);
    expect((await w.ports.read()).bindings).toEqual([{ ...binding, localProjectId: local.id }]);
    w.mutate([{ ...binding, localProjectId: "another-missing-project" }]);
    await runtime.afterJoin();
    expect(w.current()).toBeDefined();
    expect(w.ports.asks()).toHaveLength(2);
  } finally { runtime.stop(); }
});

test("exact expected row snapshot including duplicates reaches N2; unrelated identities are preserved", async () => {
  const state = initial();
  const unrelated = { ...binding, centerId: "different-center", localProjectId: "different-local" };
  state.bindings.push({ ...binding, localProjectId: "missing-two" }, unrelated);
  const w = world(state), replace = w.ports.replaceSharedLedgerBindings;
  await w.auditor.run();
  const a = w.ports.asks().find(a => (a.extra.projectAudit as ProjectAudit).target.centerId === target.centerId)!;
  let seen: unknown;
  w.ports.replaceSharedLedgerBindings = async input => { seen = input.expected; await replace(input); };
  await w.auditor.onAnswered(w.answer("sl_audit_0", true, a));
  expect(seen).toEqual(state.bindings.slice(0, 2));
  expect((await w.ports.read()).bindings).toEqual([unrelated, { ...binding, localProjectId: local.id }]);
});

test("status and credential changes invalidate an open card even when expected binding rows are unchanged", async () => {
  for (const mode of ["personal", "credential", "choices"]) {
    const w = world(); await w.auditor.run();
    const old = w.current(), before = readFileSync(w.file);
    if (mode === "personal") w.state.projects.push({ id: binding.localProjectId, name: "Private", personal: true });
    if (mode === "credential") w.state.credentials = [];
    if (mode === "choices") w.ports.projectChoices = () => ({
      choices: [{ kind: "create", button: "n4_create", name: target.name }], selected: "n4_create",
    });
    await w.auditor.run();
    const fresh = w.current();
    expect(fresh.id).not.toBe(old.id);
    expect(getAsk(w.db, old.id)!.state).toBe("cancelled");
    expect((fresh.extra.projectAudit as ProjectAudit).version).toBe((old.extra.projectAudit as ProjectAudit).version);
    expect(w.ports.asks().filter(a => a.state === "open")).toHaveLength(1);
    expect(readFileSync(w.file)).toEqual(before);
    expect(w.counts()).toEqual({ replacements: 0, creations: 0 });
  }
});

test("withdrawn unbound credential closes its card without touching binding or credential bytes", async () => {
  const state = initial(); state.bindings = [];
  const w = world(state); await w.auditor.run();
  const old = w.current(), bindings = readFileSync(w.file), credentials = readFileSync(w.credentialFile);
  w.state.credentials = [];
  await w.auditor.run();
  expect(getAsk(w.db, old.id)!.state).toBe("cancelled");
  expect(w.ports.asks().filter(a => a.state === "open")).toHaveLength(0);
  expect(readFileSync(w.file)).toEqual(bindings);
  expect(readFileSync(w.credentialFile)).toEqual(credentials);
});

test("persisted open card expired while offline is closed and reoffered exactly once on restart", async () => {
  const w = world(); await w.auditor.run();
  const old = w.current(), before = readFileSync(w.file);
  w.advance();
  const restarted = new SharedLedgerProjectAuditor(w.ports);
  await Promise.all([restarted.run(), restarted.run(), new SharedLedgerProjectAuditor(w.ports).run()]);
  expect(getAsk(w.db, old.id)!.state).toBe("expired");
  expect(w.ports.asks()).toHaveLength(2);
  expect(w.ports.asks().filter(a => a.state === "open")).toHaveLength(1);
  expect(w.current().dedupKey).not.toBe(old.dedupKey);
  expect(readFileSync(w.file)).toEqual(before);
});

test("a resolved anomaly returning during the same controller lifetime receives a fresh card", async () => {
  const w = world(); await w.auditor.run();
  const old = w.current();
  w.state.projects.push({ id: binding.localProjectId, name: "Valid local project", personal: false });
  await w.auditor.run();
  expect(w.ports.asks().filter(a => a.state === "open")).toHaveLength(0);
  w.state.projects.pop();
  await w.auditor.run();
  expect(w.current().id).not.toBe(old.id);
  expect(w.ports.asks().filter(a => a.state === "open")).toHaveLength(1);
  expect(w.counts()).toEqual({ replacements: 0, creations: 0 });
});

test("N4 selection model drift before confirmation rejects both existing and create choices", async () => {
  for (const mode of ["existing", "create"]) {
    const state = initial(); if (mode === "create") state.projects = [];
    const w = world(state); await w.auditor.run();
    const answered = w.answer(), before = readFileSync(w.file);
    w.ports.projectChoices = () => ({ choices: [{ kind: "create", button: "new_n4_button", name: target.name }], selected: "new_n4_button" });
    await w.auditor.onAnswered(answered);
    expect(w.counts()).toEqual({ replacements: 0, creations: 0 });
    expect(readFileSync(w.file)).toEqual(before);
    expect(w.messages.join(" ")).not.toContain("已绑定");
    expect((w.current().extra.projectAudit as ProjectAudit).selected).toBe("new_n4_button");
  }
});

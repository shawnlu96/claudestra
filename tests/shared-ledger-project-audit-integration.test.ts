import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { testChildEnv } from "./test-env.ts";
import { closeLedger } from "../src/lib/ledger-store.js";
import { answerAsk, getAsk, listAsks, MASTER_PROJECT, openAsk, type Ask } from "../src/lib/ledger-asks.js";
import { writeProjects, type ProjectDef } from "../src/lib/projects.js";
import { readSharedLedgerBindings, replaceSharedLedgerBindings, SHARED_LEDGER_BINDING_GENERATION } from "../src/lib/shared-ledger-gate-bindings.js";
import { writeSharedLedgerCredential, type SharedLedgerLocalCredential } from "../src/lib/shared-ledger-mode.js";
import { sharedLedgerGateProxy } from "../src/lib/shared-ledger-gate-proxy.js";
import type { ProjectAudit } from "../src/lib/shared-ledger-project-audit.js";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { askDb, onAsk, setAsksForTest } from "../src/bridge/asks.js";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import {
  onJoinOfferAnswered, receiveJoinOffer, setSharedProjectAuditHook, sweepJoinOfferMaintenance, type JoinOfferDeps,
} from "../src/bridge/shared-ledger-join-offer.js";
import type { SharedLedgerRebindDeps } from "../src/bridge/shared-ledger-rebind.js";
import {
  installSharedLedgerProjectAudit, sharedLedgerProjectAuditHook, sharedLedgerProjectAuditPorts, type SharedLedgerProjectAuditWiringPorts,
} from "../src/bridge/shared-ledger-project-audit-wiring.js";

const AUDIT = "共享项目核对", LEGACY = "共享台账需要绑定本机项目", LEGACY_CREATOR = "system:shared-ledger-rebind";
const OWNER = { id: "owner:self", role: "owner" as const, agents: ["*"], manage: true, createdAt: "", credential: "fixture" };
const shared = { teamId: "team", projectId: "claude-orchestrator" };
const credential = (centerId: string): SharedLedgerLocalCredential => ({ localSubject: "owner:self", kind: "person", centerId, ...shared,
  baseUrl: "https://center.invalid/", personId: "person", instanceId: "instance", bearer: "fixture-bearer",
  projects: [{ projectId: shared.projectId, actions: ["read"] }] });
const project = (id: string, name: string, personal = false): ProjectDef => ({ id, name, dirs: [], createdAt: "", ...(personal ? { personal } : {}) });

const roots: string[] = [], stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  setSharedProjectAuditHook(undefined);
  setAsksForTest(undefined);
  for (const dir of roots.splice(0)) { closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); }
});
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

/** Peer A/B today: local claudestra exists, the binding still names the missing claude-orchestrator, owner:self person read credential. */
async function seed(dir: string, centerId = "center-a", o: { bound?: boolean; credential?: boolean; projects?: ProjectDef[] } = {}) {
  await writeProjects({ projects: o.projects ?? [project("claudestra", "Claudestra")] }, join(dir, "projects.json"));
  if (o.bound !== false) writeFileSync(join(dir, "shared-ledger-bindings.json"),
    JSON.stringify([{ centerId, ...shared, localProjectId: "claude-orchestrator" }]), { mode: 0o600 });
  writeFileSync(join(dir, SHARED_LEDGER_BINDING_GENERATION), JSON.stringify({ generation: "initial" }), { mode: 0o600 });
  if (o.credential !== false) await writeSharedLedgerCredential(credential(centerId), dir);
}
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map(f => [f, readFileSync(join(dir, f)).toString("base64")]));

/** In-process world: real N2/N4 ports over a temp state dir, real ask ledger, inform through the live join-offer deliver path. */
async function world(o: Parameters<typeof seed>[2] = {}) {
  const dir = tmp("sl-audit-int-"), messages: string[] = [];
  await seed(dir, "center-a", o);
  setAsksForTest({ path: join(dir, "ledger.sqlite"), ownerChats: [], deps: { clients: new Map(), controlChannelId: "fixture",
    deliver: async env => { messages.push(env.content); return { ok: true } as never; }, hold: () => {} } });
  let reads = 0;
  const real = sharedLedgerProjectAuditPorts(dir);
  const ports: SharedLedgerProjectAuditWiringPorts = { ...real, read: () => { reads++; return real.read(); } };
  const hook = sharedLedgerProjectAuditHook(ports); stops.push(hook.stop);
  setSharedProjectAuditHook(hook);
  const legacy = { calls: 0 };
  const rebind = { bindings: () => { legacy.calls++; return []; } } as unknown as SharedLedgerRebindDeps;
  const join_: JoinOfferDeps = { stateDir: () => dir, now: Date.now, peers: async () => [], projects: async () => [],
    openAsk: () => { throw new Error("no join cards"); }, getAsk: () => null, closeAsk: () => {}, join: async () => { throw new Error("no join"); },
    inform: async () => {}, sendReceipt: async () => 500, writeNote: async () => {} };
  const tick = () => sweepJoinOfferMaintenance(join_, rebind);
  const cards = () => listAsks(askDb());
  const open = () => cards().filter(a => a.state === "open" && a.title === AUDIT);
  const pick = async (button: string, a = open()[0]!) => {
    expect((await answerFromCard(a.project, a.id, { choices: [`[button:${button}]`] }, OWNER)).status).toBe(202);
    await hook(); // Serialized behind the answer listener.
  };
  const file = (name: string) => readFileSync(join(dir, name));
  return { dir, messages, ports, hook, tick, cards, open, pick, file, legacy, reads: () => reads };
}

/** `env -i` style child: initAskWiring order, offline fetch, temp HOME/TMPDIR/state. */
async function boot(dir: string, mode: "confirm" | "idle") {
  const script = `
    import { initAskWiring, answerFromCard } from "./src/bridge/ask-entry.ts";
    import { asksDeps, askReadDb } from "./src/bridge/asks.ts";
    import { sweepJoinOfferMaintenance } from "./src/bridge/shared-ledger-join-offer.ts";
    import { listAsks } from "./src/lib/ledger-asks.ts";
    let fetches = 0; globalThis.fetch = async () => { fetches++; throw new Error("offline"); };
    const messages = [], cards = () => { const db = askReadDb(); return db ? listAsks(db) : []; };
    const returned = initAskWiring({ clients: new Map(), controlChannelId: "fixture", hold: () => {}, discord: null,
      deliver: async env => { messages.push(env.content); return { ok: true }; } });
    const wired = !!asksDeps();
    for (let i = 0; i < 100 && !cards().length; i++) await Bun.sleep(10);
    await Bun.sleep(150);
    const startup = cards().map(a => ({ title: a.title, state: a.state }));
    let status = null;
    if (${JSON.stringify(mode)} === "confirm") {
      const a = cards().find(a => a.title === ${JSON.stringify(AUDIT)});
      status = a ? (await answerFromCard(a.project, a.id, { choices: ["[button:sl_audit_local_claudestra]"] }, ${JSON.stringify(OWNER)})).status : null;
      for (let i = 0; i < 200 && !messages.some(m => m.includes("已绑定")); i++) await Bun.sleep(10);
    } else { await sweepJoinOfferMaintenance(); await sweepJoinOfferMaintenance(); }
    console.log("RESULT " + JSON.stringify({ returned: returned === undefined, wired, startup, status, fetches,
      informed: messages.filter(m => m.startsWith("共享项目")) }));
  `;
  const home = tmp("sl-audit-home-"), t = tmp("sl-audit-tmp-");
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: join(import.meta.dir, ".."),
    env: testChildEnv({ HOME: home, TMPDIR: t, CLAUDESTRA_STATE_DIR: dir, DISCORD_CHANNEL_ID: "" }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = stdout.split("\n").find(l => l.startsWith("RESULT "));
  return { exit, stderr, logs: stdout.split("\n").filter(l => l && !l.startsWith("RESULT ")), result: line ? JSON.parse(line.slice(7)) : null };
}

for (const [peer, centerId] of [["A", "center-a"], ["B", "center-b"]]) {
  test(`peer ${peer}: startup opens exactly one audit card (no legacy card); owner answerFromCard rebinds through real N2`, async () => {
    const dir = tmp("sl-audit-peer-");
    await seed(dir, centerId);
    const bindings = readFileSync(join(dir, "shared-ledger-bindings.json")), credentials = readFileSync(join(dir, "shared-ledger-credentials.json"));
    const generation = readFileSync(join(dir, SHARED_LEDGER_BINDING_GENERATION));
    const r = await boot(dir, "confirm");
    expect({ exit: r.exit, stderr: r.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(r.result.startup).toEqual([{ title: AUDIT, state: "open" }]);
    expect(r.result.startup.filter((c: { title: string }) => c.title === LEGACY)).toHaveLength(0);
    expect({ returned: r.result.returned, wired: r.result.wired, status: r.result.status, fetches: r.result.fetches })
      .toEqual({ returned: true, wired: true, status: 202, fetches: 0 });
    expect(r.result.informed).toEqual([`共享项目 ${shared.projectId} 已绑定，可在本机项目下查看「团队 · 全部 feature」。`]);
    expect(readSharedLedgerBindings(dir)).toEqual([{ centerId, ...shared, localProjectId: "claudestra" }]);
    const baks = readdirSync(dir).filter(f => f.startsWith("shared-ledger-bindings.json.bak-"));
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(dir, baks[0]!))).toEqual(bindings);
    expect(statSync(join(dir, baks[0]!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, SHARED_LEDGER_BINDING_GENERATION))).not.toEqual(generation);
    expect(readFileSync(join(dir, "shared-ledger-credentials.json"))).toEqual(credentials);
    const context = await sharedLedgerGateProxy(new Request("https://bridge.invalid/shared-ledger/context"), "/shared-ledger/context",
      OWNER, async () => Response.json({ ok: true }), { stateDir: dir });
    expect(context!.status).toBe(200);
    expect((await context!.json() as { identities: unknown[] }).identities).toMatchObject([{ localProjectId: "claudestra", project: shared.projectId }]);
  });
}

test("no binding and no credential: startup plus two maintenance ticks leave state bytes untouched, no card, no log, no fetch", async () => {
  const dir = tmp("sl-audit-none-");
  await seed(dir, "center-a", { bound: false, credential: false });
  const before = snapshot(dir);
  const r = await boot(dir, "idle");
  expect({ exit: r.exit, stderr: r.stderr, logs: r.logs }).toEqual({ exit: 0, stderr: "", logs: [] });
  expect(r.result).toMatchObject({ returned: true, wired: true, startup: [], fetches: 0, informed: [] });
  expect(snapshot(dir)).toEqual(before);
});

test("init failure logs only fixed text and the rest of initAskWiring still runs", async () => {
  const dir = tmp("sl-audit-broken-");
  await seed(dir);
  chmodSync(join(dir, "shared-ledger-bindings.json"), 0o644); // N2 reader rejects non-0600 bindings.
  const r = await boot(dir, "idle");
  expect(r.exit).toBe(0);
  expect(r.result).toMatchObject({ returned: true, wired: true, startup: [], fetches: 0 });
  expect(r.stderr.split("\n").filter(Boolean).every(l => l === "共享项目核对启动失败，下一分钟重试。" || l === "⚠️ [join-offer] 扫描失败")).toBe(true);
  expect(r.stderr).toContain("共享项目核对启动失败，下一分钟重试。");
  expect(r.stderr).not.toContain(dir);
});

function legacyCard(dedupKey: string): Ask {
  return openAsk(askDb(), { source: "system", createdBy: LEGACY_CREATOR, project: MASTER_PROJECT, kind: "authorize", title: LEGACY,
    options: [{ type: "buttons", buttons: [{ id: "sl_rebind_0", label: "改绑到 Claudestra" }] }], allowText: false, blocking: false,
    expiresAt: Date.now() + 3600_000, dedupKey, extra: { sharedLedgerRebind: { key: dedupKey } } } as never);
}

test("installed audit replaces legacy maintenance: 0 legacy sweeps, answered legacy card untouched, open legacy card closed once", async () => {
  const w = await world();
  const stale = legacyCard("legacy-open"), answered = legacyCard("legacy-answered");
  const done = answerAsk(askDb(), answered.id, { choices: ["[button:sl_rebind_0]"], labels: ["x"], text: "", principal: "owner:self",
    via: "web_card", at: Date.now(), owner: true });
  const cancels: string[] = [];
  stops.push(onAsk(a => { if (a.id === stale.id && a.state === "cancelled") cancels.push(a.id); }));
  const bindings = w.file("shared-ledger-bindings.json");
  await w.tick(); await w.tick();
  await onJoinOfferAnswered(done);
  expect(w.legacy.calls).toBe(0);
  expect(cancels).toEqual([stale.id]);
  expect(getAsk(askDb(), stale.id)!.state).toBe("cancelled");
  expect(getAsk(askDb(), answered.id)!.extra.rebindSettled).toBeUndefined();
  expect(w.messages.some(m => m.includes("改绑"))).toBe(false);
  expect(w.file("shared-ledger-bindings.json")).toEqual(bindings);
  expect(w.open()).toHaveLength(1);
});

test("init error keeps the hook installed and the legacy sweep never runs; the next tick retries", async () => {
  const w = await world(), read = w.ports.read;
  let fail = true;
  w.ports.read = async () => { if (fail) throw new Error("synthetic /private/path"); return read(); };
  const errors: string[] = [], spy = spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  try { await w.tick(); } finally { spy.mockRestore(); }
  expect(errors).toEqual(["共享项目核对启动失败，下一分钟重试。"]);
  expect(w.open()).toHaveLength(0);
  fail = false;
  await w.tick();
  expect(w.legacy.calls).toBe(0);
  expect(w.open()).toHaveLength(1);
});

test("install is synchronous and does no reads before the first tick", () => {
  let reads = 0;
  const ports = { ...sharedLedgerProjectAuditPorts(tmp("sl-audit-sync-")), read: async () => { reads++; return { bindings: [], credentials: [], projects: [] }; } };
  expect(installSharedLedgerProjectAudit(ports)).toBeUndefined();
  expect(reads).toBe(0);
});

test("N2 backup write failure: bindings and generation unchanged, no residue, fixed notice, card reopened", async () => {
  const w = await world();
  await w.tick();
  const old = w.open()[0]!;
  const before = snapshot(w.dir);
  const real = fs.writeFileSync;
  const spy = spyOn(fs, "writeFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(p).includes(".bak-")) throw new Error("synthetic backup failure");
    return (real as (...a: unknown[]) => void)(p, ...rest);
  }) as typeof fs.writeFileSync);
  try { await w.pick("sl_audit_local_claudestra", old); } finally { spy.mockRestore(); }
  const after = snapshot(w.dir);
  for (const f of ["shared-ledger-bindings.json", SHARED_LEDGER_BINDING_GENERATION, "projects.json", "shared-ledger-credentials.json"]) expect(after[f]).toBe(before[f]!);
  expect(Object.keys(after).filter(f => !f.startsWith("ledger.sqlite"))).toEqual(Object.keys(before).filter(f => !f.startsWith("ledger.sqlite")));
  expect(w.messages.filter(m => m.startsWith("共享项目"))).toEqual(["共享项目未确认改绑：状态可能已变化，请查看最新核对卡。"]);
  expect(w.open()).toHaveLength(1);
  expect(w.open()[0]!.id).not.toBe(old.id);
});

test("N2 backup failing after a partial write (ENOSPC): the unfinished .bak-* is removed, nothing else changes", async () => {
  const w = await world();
  await w.tick();
  const old = w.open()[0]!;
  writeFileSync(join(w.dir, "shared-ledger-bindings.json.bak-1-earlier"), "earlier backup", { mode: 0o600 }); // Pre-existing: kept.
  const before = snapshot(w.dir);
  const real = fs.writeFileSync;
  const spy = spyOn(fs, "writeFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (!String(p).includes(".bak-")) return (real as (...a: unknown[]) => void)(p, ...rest);
    real(p, "partial backup", { flag: "wx", mode: 0o600 });
    throw Object.assign(new Error("synthetic ENOSPC"), { code: "ENOSPC" });
  }) as typeof fs.writeFileSync);
  try { await w.pick("sl_audit_local_claudestra", old); } finally { spy.mockRestore(); }
  const after = snapshot(w.dir), files = (s: Record<string, string>) => Object.keys(s).filter(f => !f.startsWith("ledger.sqlite"));
  expect(files(after)).toEqual(files(before));
  for (const f of files(before)) expect(after[f]).toBe(before[f]!);
  expect(w.messages.filter(m => m.startsWith("共享项目"))).toEqual(["共享项目未确认改绑：状态可能已变化，请查看最新核对卡。"]);
  expect(w.open()).toHaveLength(1);
  expect(w.open()[0]!.id).not.toBe(old.id);
});

test("CAS: another real N2 write after the card opened rejects confirmation with zero writes and a fresh card", async () => {
  const w = await world({ projects: [project("claudestra", "Claudestra"), project("other", "Other")] });
  await w.tick();
  const old = w.open()[0]!, expected = readSharedLedgerBindings(w.dir);
  await replaceSharedLedgerBindings({ expected, next: { ...expected[0]!, localProjectId: "other" } }, w.dir);
  await writeProjects({ projects: [project("claudestra", "Claudestra")] }, join(w.dir, "projects.json")); // "other" then disappears: still dangling.
  const before = snapshot(w.dir);
  await w.pick("sl_audit_local_claudestra", old);
  const after = snapshot(w.dir);
  for (const f of Object.keys(before).filter(f => !f.startsWith("ledger.sqlite"))) expect(after[f]).toBe(before[f]!);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  expect(w.messages.filter(m => m.startsWith("共享项目"))).toEqual(["共享项目未确认改绑：状态可能已变化，请查看最新核对卡。"]);
  expect(w.open()).toHaveLength(1);
  expect(w.open()[0]!.id).not.toBe(old.id);
  expect((w.open()[0]!.extra.projectAudit as ProjectAudit).expected[0]!.localProjectId).toBe("other");
});

test("CAS: drift before confirmation reopens a card; drifted preflight never creates the project", async () => {
  const w = await world({ projects: [project("other", "Other")] });
  await w.tick();
  const old = w.open()[0]!, expected = readSharedLedgerBindings(w.dir);
  expect((old.extra.projectAudit as ProjectAudit).selected).toBe("sl_audit_create");
  // Another owner action re-points the row to a still-missing project: the issue remains, but under new rows.
  writeFileSync(join(w.dir, "shared-ledger-bindings.json"), JSON.stringify([{ ...expected[0]!, localProjectId: "still-missing" }]), { mode: 0o600 });
  const projects = w.file("projects.json");
  await w.pick("sl_audit_create", old);
  expect(w.file("projects.json")).toEqual(projects);
  expect(w.messages.some(m => m.includes("已绑定"))).toBe(false);
  expect(w.open()).toHaveLength(1);
  expect((w.open()[0]!.extra.projectAudit as ProjectAudit).expected[0]!.localProjectId).toBe("still-missing");
});

test("CAS: a writer winning after preflight leaves bindings unwritten, keeps the empty unbound project and never reports success", async () => {
  const w = await world({ projects: [project("other", "Other")] });
  const create = w.ports.createLocalProject; // Ports are captured at controller init, so wrap before the first tick.
  w.ports.createLocalProject = async target => {
    const id = await create(target), expected = readSharedLedgerBindings(w.dir);
    await replaceSharedLedgerBindings({ expected, next: { ...expected[0]!, localProjectId: "other" } }, w.dir);
    return id;
  };
  await w.tick();
  await w.pick("sl_audit_create");
  expect(readSharedLedgerBindings(w.dir)).toEqual([{ centerId: "center-a", ...shared, localProjectId: "other" }]);
  const created = JSON.parse(w.file("projects.json").toString()).projects.find((p: ProjectDef) => p.id === shared.projectId);
  expect(created).toMatchObject({ id: shared.projectId, name: shared.projectId, dirs: [] });
  expect(readSharedLedgerBindings(w.dir).some(b => b.localProjectId === shared.projectId)).toBe(false);
  expect(w.messages.some(m => m.includes("已绑定"))).toBe(false);
  expect(readdirSync(w.dir).filter(f => f.includes(".bak-"))).toHaveLength(1); // Only the winning writer's backup.
});

test("personal projects never become candidates and their projects.json entries stay byte-identical", async () => {
  const personal = project("private", shared.projectId, true);
  const w = await world({ projects: [project("claudestra", "Claudestra"), personal] });
  await w.tick();
  const audit = w.open()[0]!.extra.projectAudit as ProjectAudit;
  expect(audit.choices.map(c => c.button)).toEqual(["sl_audit_create", "sl_audit_local_claudestra"]);
  const entry = () => JSON.stringify(JSON.parse(w.file("projects.json").toString()).projects.find((p: ProjectDef) => p.id === "private"));
  const before = entry();
  await w.pick("sl_audit_local_claudestra");
  expect(entry()).toBe(before);
  expect(readSharedLedgerBindings(w.dir)).toEqual([{ centerId: "center-a", ...shared, localProjectId: "claudestra" }]);
});

test("no binding and no credential returns empty without reading projects.json", async () => {
  const dir = tmp("sl-audit-empty-");
  writeFileSync(join(dir, "projects.json"), "{corrupt");
  expect(await sharedLedgerProjectAuditPorts(dir).read()).toEqual({ bindings: [], credentials: [], projects: [] });
});

const centerId = "center-" + "c".repeat(32);
const code = `sljoin1.${centerId}.${"a".repeat(32)}.${"M".repeat(43)}`;
const offered = { teamId: "team", projectId: "project-b", name: "Project B" };
test("join hook: onJoinOfferAnswered reaching settle(joined) triggers exactly one audit scan", async () => {
  const w = await world();
  await w.tick();
  for (const initialized of [true, false]) {
    if (!initialized) { w.hook.stop(); }
    const p = { name: `peer-${randomBytes(4).toString("hex")}`, baseUrl: "https://peer.invalid", outToken: "synthetic-token", addedAt: "" };
    const asks: Ask[] = [];
    const d: JoinOfferDeps = { stateDir: () => w.dir, now: Date.now, peers: async () => [p], projects: async () => [], bindings: () => [],
      openAsk: input => { const a = { ...input, id: `join_${asks.length}`, state: "open", answer: null, extra: input.extra ?? {} } as Ask; asks.push(a); return a; },
      getAsk: id => asks.find(a => a.id === id) ?? null, closeAsk: () => {}, join: async () => { throw new Error("legacy join must not run"); },
      joinProject: async () => ({ centerId, teamId: "team", personId: "alice", projectId: "project-b", localProjectId: "local-b", kind: "person",
        expiresAt: Date.now() + 60000, identities: 1 }),
      inform: async () => {}, sendReceipt: async () => 200, writeNote: async () => {} };
    const invite = { ...createV2ProjectsFixtures().invite, centerId, teamId: offered.teamId, projectId: offered.projectId, personId: "alice", instanceId: null, codeId: "a".repeat(32), code,
      expiresAt: Date.now() + 60000 };
    expect((await receiveJoinOffer(p, { v: 1, offerId: randomBytes(16).toString("hex"), url: "https://center.invalid/", code,
      project: offered, projectInvite: invite }, d)).status).toBe(202);
    const before = w.reads();
    await onJoinOfferAnswered({ ...asks[0]!, state: "answered", answer: { choices: ["[select:shared_project_local:create]", "[button:sl_join_accept]"],
      labels: [], text: "", principal: "owner:self", owner: true, via: "web_card", at: Date.now() } }, d);
    expect(w.reads() - before).toBe(1);
  }
});

test("restart: an answered audit card is consumed exactly once across concurrent fresh controllers", async () => {
  const w = await world();
  await w.tick();
  const a = w.open()[0]!;
  answerAsk(askDb(), a.id, { choices: ["[button:sl_audit_local_claudestra]"], labels: ["x"], text: "", principal: "owner:self",
    via: "web_card", at: Date.now(), owner: true });
  w.hook.stop();
  const restarted = [sharedLedgerProjectAuditHook(w.ports), sharedLedgerProjectAuditHook(w.ports)];
  stops.push(...restarted.map(h => h.stop));
  await Promise.all(restarted.map(h => h()));
  await Promise.all(restarted.map(h => h()));
  expect(readdirSync(w.dir).filter(f => f.includes(".bak-"))).toHaveLength(1);
  expect(w.messages.filter(m => m.includes("已绑定"))).toHaveLength(1);
  expect(readSharedLedgerBindings(w.dir)).toEqual([{ centerId: "center-a", ...shared, localProjectId: "claudestra" }]);
});

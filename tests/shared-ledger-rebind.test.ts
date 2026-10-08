import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/lib/ledger-store.js";
import { answerAsk, closeAsk, getAsk, listAsks, openAsk, patchAsk, type Ask } from "../src/lib/ledger-asks.js";
import { readSharedLedgerBindings, setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { rebindSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings-rebind.js";
import { writeSharedLedgerCredential, type SharedLedgerLocalCredential } from "../src/lib/shared-ledger-mode.js";
import { writeProjects } from "../src/lib/projects.js";
import { sharedLedgerGateProxy } from "../src/lib/shared-ledger-gate-proxy.js";
import { joinOfferLiveDeps, sweepJoinOfferMaintenance } from "../src/bridge/shared-ledger-join-offer.js";
import { onSharedLedgerRebindAnswered, sweepSharedLedgerRebinds, type SharedLedgerRebindDeps } from "../src/bridge/shared-ledger-rebind.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const shared = { centerId: "center", teamId: "team", projectId: "shared" };
const credential: SharedLedgerLocalCredential = { localSubject: "owner:self", kind: "person", ...shared,
  baseUrl: "https://center.example/", personId: "person", instanceId: "instance", bearer: "fixture-bearer",
  projects: [{ projectId: "shared", actions: ["read"] }] };

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "sl-rebind-")); roots.push(dir);
  const asks: Ask[] = [], messages: string[] = [];
  const projects = [{ id: "local", name: "Local", lastActivityAt: 10 }];
  let now = Date.now();
  await writeProjects({ projects: ["local", "free", "elsewhere"].map(id => ({ id, name: id, dirs: [], createdAt: "" })) }, join(dir, "projects.json"));
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([{ ...shared, localProjectId: "missing" }]), { mode: 0o600 });
  await writeSharedLedgerCredential(credential, dir);
  const d: SharedLedgerRebindDeps = {
    now: () => now, bindings: () => readSharedLedgerBindings(dir), projects: async () => projects,
    asks: () => asks, openAsk: input => {
      const ask = { ...input, id: `ask_${asks.length}`, state: "open", answer: null, fromAgent: null, extra: input.extra ?? {} } as Ask;
      asks.push(ask); return ask;
    },
    claim: a => { if (a.extra.rebindSettled) return false; a.extra.rebindSettled = true; return true; },
    rebind: (previous, id) => rebindSharedLedgerBinding(previous, id, dir), inform: async text => { messages.push(text); },
  };
  const answer = (button = "sl_rebind_0", owner = true) => {
    const a = asks.at(-1)!; a.state = "answered";
    a.answer = { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner:self", via: "web_card", at: now,
      ...(owner ? { owner: true as const } : { external: true }) };
    return a;
  };
  return { dir, d, asks, messages, projects, answer, advance: () => { now += 25 * 3600_000; } };
}

test("missing local project: one durable card, rebind preserves credentials and exposes exactly one proxy identity", async () => {
  const w = await world(), file = join(w.dir, "shared-ledger-credentials.json"), before = readFileSync(file);
  await Promise.all([sweepSharedLedgerRebinds(w.d), sweepSharedLedgerRebinds(w.d)]);
  expect(w.asks).toHaveLength(1);
  const a = w.answer();
  await Promise.all([onSharedLedgerRebindAnswered(a, w.d), onSharedLedgerRebindAnswered(a, w.d)]);
  await sweepSharedLedgerRebinds(w.d);
  expect(w.asks).toHaveLength(1);
  expect(w.messages).toHaveLength(1);
  expect(readSharedLedgerBindings(w.dir)).toEqual([{ ...shared, localProjectId: "local" }]);
  expect(readFileSync(file)).toEqual(before);
  const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "" };
  const context = await sharedLedgerGateProxy(new Request("https://bridge.example/shared-ledger/context"), "/shared-ledger/context", principal,
    async () => Response.json({ ok: true }), { stateDir: w.dir });
  expect(context!.status).toBe(200);
  expect((await context!.json() as { identities: unknown[] }).identities).toMatchObject([{ project: "shared", localProjectId: "local" }]);
  for (const wanted of [null, "shared"]) {
    const response = await sharedLedgerGateProxy(new Request("https://bridge.example/shared-ledger/features",
      { headers: wanted ? { "x-shared-ledger-project": wanted } : {} }), "/shared-ledger/features", principal,
      async () => Response.json({ ok: true }), { stateDir: w.dir, key: () => ({ publicKey: "fixture", privateKey: {} as never }) });
    expect(response!.status).toBe(200);
  }
});

test("pins conflict refuses rebind, explains why and leaves bindings and credentials unchanged", async () => {
  const w = await world();
  await sweepSharedLedgerRebinds(w.d);
  await setSharedLedgerBinding({ centerId: "other", teamId: "other", projectId: "other", localProjectId: "local" }, w.dir);
  const before = readFileSync(join(w.dir, "shared-ledger-bindings.json"));
  await onSharedLedgerRebindAnswered(w.answer(), w.d);
  expect(readFileSync(join(w.dir, "shared-ledger-bindings.json"))).toEqual(before);
  expect(w.messages[0]).toContain("pins");
  await sweepSharedLedgerRebinds(w.d);
  expect(w.asks).toHaveLength(1);
  expect(w.messages).toHaveLength(1);
});

test("non-owner, expired or altered authorization never writes", async () => {
  for (const mode of ["guest", "expired", "tampered", "deleted", "stale"]) {
    const w = await world();
    await sweepSharedLedgerRebinds(w.d);
    const a = w.answer("sl_rebind_0", mode !== "guest");
    if (mode === "expired") w.advance();
    if (mode === "tampered") a.bind!.paramsHash = "0".repeat(64);
    if (mode === "deleted") w.projects.splice(0);
    if (mode === "stale") writeFileSync(join(w.dir, "shared-ledger-bindings.json"),
      JSON.stringify([{ ...shared, localProjectId: "elsewhere" }]), { mode: 0o600 });
    const before = readFileSync(join(w.dir, "shared-ledger-bindings.json"));
    await onSharedLedgerRebindAnswered(a, w.d);
    expect(readFileSync(join(w.dir, "shared-ledger-bindings.json"))).toEqual(before);
    expect(w.messages[0]).toContain("未执行");
  }
});

test("decline stays dismissed; unanswered expiration can create a fresh card; valid bindings do not ask", async () => {
  const w = await world();
  await sweepSharedLedgerRebinds(w.d);
  w.advance();
  await sweepSharedLedgerRebinds(w.d);
  expect(w.asks).toHaveLength(2);
  await onSharedLedgerRebindAnswered(w.answer("sl_rebind_skip"), w.d);
  await sweepSharedLedgerRebinds(w.d);
  expect(w.asks).toHaveLength(2);
  expect(w.messages).toEqual([]);
  await rebindSharedLedgerBinding({ ...shared, localProjectId: "missing" }, "local", w.dir);
  await sweepSharedLedgerRebinds(w.d);
  expect(w.asks).toHaveLength(2);
});

test("persistent ask ledger prevents duplicate cards and repeated execution across fresh dependency instances", async () => {
  const w = await world(), db = openLedger(join(w.dir, "ledger.sqlite"));
  const restart = (): SharedLedgerRebindDeps => ({ ...w.d,
    asks: () => listAsks(db), openAsk: input => openAsk(db, input, w.d.now()),
    claim: a => {
      const current = getAsk(db, a.id);
      if (!current || current.extra.rebindSettled) return false;
      patchAsk(db, a.id, { extra: { rebindSettled: true } }); return true;
    },
  });
  try {
    await sweepSharedLedgerRebinds(restart());
    await sweepSharedLedgerRebinds(restart());
    expect(listAsks(db)).toHaveLength(1);
    const a = listAsks(db)[0]!;
    answerAsk(db, a.id, { choices: ["[button:sl_rebind_0]"], labels: ["Local"], text: "", principal: "owner:self",
      owner: true, via: "web_card", at: w.d.now() });
    await sweepSharedLedgerRebinds(restart()); // Simulates restart after answer, before the answer hook ran.
    await sweepSharedLedgerRebinds(restart());
    await onSharedLedgerRebindAnswered(getAsk(db, a.id)!, restart());
    expect(getAsk(db, a.id)!.extra.rebindSettled).toBe(true);
    expect(w.messages).toHaveLength(1);
    expect(readSharedLedgerBindings(w.dir)[0]!.localProjectId).toBe("local");
  } finally { db.close(); }
});

test("center URL pin conflicts also refuse rebind without touching credentials", async () => {
  const w = await world();
  await writeSharedLedgerCredential({ ...credential, localSubject: "owner:other", baseUrl: "https://different.example/" }, w.dir);
  const before = readFileSync(join(w.dir, "shared-ledger-credentials.json"));
  await sweepSharedLedgerRebinds(w.d);
  await onSharedLedgerRebindAnswered(w.answer(), w.d);
  expect(w.messages[0]).toContain("pins");
  expect(readSharedLedgerBindings(w.dir)[0]!.localProjectId).toBe("missing");
  expect(readFileSync(join(w.dir, "shared-ledger-credentials.json"))).toEqual(before);
});

test("bridge startup sweep and real owner card answer run the live rebind path in isolated state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-rebind-live-")); roots.push(dir);
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync, writeFileSync } from "node:fs";
    import { writeProjects } from "./src/lib/projects.ts";
    import { setSharedLedgerBinding, readSharedLedgerBindings } from "./src/lib/shared-ledger-gate-bindings.ts";
    import { writeSharedLedgerCredential } from "./src/lib/shared-ledger-mode.ts";
    import { listAsks } from "./src/lib/ledger-asks.ts";
    import { askDb, setAsksForTest } from "./src/bridge/asks.ts";
    import { initJoinOffers } from "./src/bridge/shared-ledger-join-offer.ts";
    import { answerFromCard } from "./src/bridge/ask-entry.ts";
    const dir = process.env.CLAUDESTRA_STATE_DIR, messages = [];
    await writeProjects({ projects: [{ id: "local", name: "Local", dirs: [], createdAt: "" }] });
    writeFileSync(dir + "/shared-ledger-bindings.json",
      JSON.stringify([{ centerId: "center", teamId: "team", projectId: "shared", localProjectId: "missing" }]), { mode: 0o600 });
    await writeSharedLedgerCredential(${JSON.stringify(credential)});
    const before = readFileSync(dir + "/shared-ledger-credentials.json");
    setAsksForTest({ path: dir + "/cards.sqlite", ownerChats: [], deps: { clients: new Map(), controlChannelId: "fixture",
      deliver: async env => { messages.push(env.content); return { ok: true }; }, hold: () => {} } });
    initJoinOffers();
    for (let i = 0; i < 100 && !listAsks(askDb()).length; i++) await Bun.sleep(10);
    const a = listAsks(askDb())[0]; assert.ok(a); assert.equal(a.createdBy, "system:shared-ledger-rebind");
    const res = await answerFromCard(a.project, a.id, { choices: ["[button:sl_rebind_0]"] },
      { id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "", credential: "fixture" });
    assert.equal(res.status, 202);
    for (let i = 0; i < 100 && !messages.length; i++) await Bun.sleep(10);
    assert.equal(readSharedLedgerBindings()[0].localProjectId, "local");
    assert.equal(messages.length, 1); assert.ok(messages[0].includes("全部 feature"));
    assert.deepEqual(readFileSync(dir + "/shared-ledger-credentials.json"), before);
    assert.equal(listAsks(askDb()).length, 1);
    console.log("live-rebind-passed");
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(), env: { ...process.env, CLAUDESTRA_STATE_DIR: dir, DISCORD_CHANNEL_ID: "" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("live-rebind-passed");
});


test("owner-dismissed rebind card stays dismissed across sweeps and restart", async () => {
  const w = await world(), db = openLedger(join(w.dir, "dismiss.sqlite"));
  const d = { ...w.d, asks: () => listAsks(db), openAsk: (input: Parameters<typeof w.d.openAsk>[0]) => openAsk(db, input, w.d.now()) };
  try {
    await sweepSharedLedgerRebinds(d);
    const a = listAsks(db)[0]!;
    closeAsk(db, a.id, "cancelled", "owner dismissed", w.d.now(), { dismissed: true, hidden: true });
    await sweepSharedLedgerRebinds({ ...d });
    await sweepSharedLedgerRebinds({ ...d });
    w.advance();
    await sweepSharedLedgerRebinds({ ...d });
    expect(listAsks(db)).toHaveLength(1);
    expect(listAsks(db)[0]!.state).toBe("cancelled");
    expect(w.messages).toEqual([]);
    expect(readSharedLedgerBindings(w.dir)[0]!.localProjectId).toBe("missing");
  } finally { db.close(); }
});


test("no bindings avoids project/session IO and a failed join sweep does not block rebind maintenance", async () => {
  const w = await world();
  const none = { ...w.d, bindings: () => [], projects: async () => { throw new Error("unexpected session IO"); } };
  await sweepSharedLedgerRebinds(none);
  expect(w.asks).toHaveLength(0);
  const errors: string[] = [], spy = spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
  try {
    await sweepJoinOfferMaintenance({ ...joinOfferLiveDeps, stateDir: () => { throw new Error("private pending data"); } }, w.d);
    expect(w.asks).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("private pending data");
  } finally { spy.mockRestore(); }
});

test("rebind offers free projects instead of choices already pinned to other shared projects", async () => {
  const w = await world();
  w.projects.push({ id: "free", name: "Free", lastActivityAt: 0 });
  await setSharedLedgerBinding({ centerId: "other", teamId: "team", projectId: "other", localProjectId: "local" }, w.dir);
  await sweepSharedLedgerRebinds(w.d);
  expect((w.asks[0]!.options[0] as { buttons: { label: string }[] }).buttons.map(b => b.label)).toEqual(["改绑到 Free", "暂不改绑"]);
  await onSharedLedgerRebindAnswered(w.answer(), w.d);
  expect(readSharedLedgerBindings(w.dir).find(b => b.centerId === "center")!.localProjectId).toBe("free");
});

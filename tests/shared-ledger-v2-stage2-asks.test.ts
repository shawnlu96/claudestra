import { afterEach, expect, test, setSystemTime, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsk, parseFeature, parseReceipt, V2_COMMAND_NAMES, V2ContractError, v2ObjectDigest,
  type V2Ask, type V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { SharedLedgerExecClient, type ExecTransport } from "../src/lib/shared-ledger-exec-client.js";
import { SharedLedgerExecGate, type ExecIdentity } from "../src/lib/shared-ledger-exec-gate.js";
import { setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import { deliverReplyWithAsk } from "../src/bridge/ask-reply.js";
import { answerFromCard, answerFromChat, answerFromDiscord } from "../src/bridge/ask-entry.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import { dismissFromCard } from "../src/bridge/ask-dismiss.js";
import { sweepExpired } from "../src/bridge/ask-expire.js";
import { initSharedAskWiring } from "../src/bridge/shared-ledger-v2-asks-wiring.js";
import { configureSharedAsks, type SharedAsksPort, type ExecFeatureRef, type SharedAskCommandContext } from "../src/bridge/shared-ledger-v2-asks.js";
import { sharedAskMapping } from "../src/bridge/shared-ledger-v2-asks-mapping.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getAsk, listAsks, openAsk, answerAsk, patchAsk, type Ask } from "../src/lib/ledger-asks.js";
import { READ_CMDS } from "../src/manager/ledger-read-cmds.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { owner, ownerWithMaster } from "./asks-test-kit.js";
import type { Envelope } from "../src/bridge/router.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { closeLedger, openLedger, listEvents } from "../src/lib/ledger-store.js";

const dirs: string[] = [];
afterEach(() => {
  configureSharedAsks(null);
  setAsksForTest(undefined);
  for (const dir of dirs.splice(0)) {
    closeLedger(join(dir, "ledger.sqlite"));
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fakeCenter() {
  const dir = mkdtempSync(join(tmpdir(), "stage2-asks-"));
  dirs.push(dir);
  await writeSharedLedgerMode("feature", { authorityMode: "execution", sharedPlanning: true }, dir);
  const identity: ExecIdentity = { centerId: "center", teamId: "team", projectId: "project", projectRole: "owner",
    registeredPersonId: "person", registeredInstanceId: "local", actor: {
      kind: "person", personId: "person", instanceId: "local", serviceId: null, representedPersonId: null,
      orderId: null, projects: ["project"], actions: [...V2_COMMAND_NAMES],
    } };
  const feature = parseFeature({ ...V2_DTO_FIXTURES.feature.valid as object, authorityMode: "execution" });
  const asks = new Map<string, V2Ask>();
  const calls: V2Command[] = [];
  const actors: ExecIdentity["actor"][] = [];
  const receipts = new Map<string, unknown>();
  const state = { offline: false, transportCalls: 0, seq: 0, now: Date.now() };
  const online = () => { state.transportCalls++; if (state.offline) throw Error("offline"); };
  const transport: ExecTransport = {
    async receipt(q) { online(); return receipts.get(q.requestId) ?? null; },
    async ask(q) {
      online();
      const a = asks.get(q.askId);
      if (!a) throw new V2ContractError("not_found");
      return structuredClone(a);
    },
    async submit(c, actor) {
      online(); actors.push(actor); calls.push(c); state.seq++;
      let entityId = "authorization";
      let rev = 1;
      if (c.type === "ask.create") {
        entityId = `central-ask-${state.seq}`;
        asks.set(entityId, parseAsk({ ...c.payload, teamId: c.teamId, projectId: c.projectId, id: entityId,
          source: "business", state: "open", rev, createdBy: "person", createdAt: state.now,
          answeredBy: null, answeredAt: null, answer: null, decision: null, auditEventSeq: state.seq }));
      } else if (c.type === "ask.answer" || c.type === "ask.cancel") {
        entityId = c.payload.askId;
        const a = asks.get(entityId);
        if (!a) throw new V2ContractError("not_found");
        if (a.rev !== c.payload.expectedRev || a.state !== "open") throw new V2ContractError("conflict");
        if (v2ObjectDigest(a.bind) !== c.payload.bindDigest) throw new V2ContractError("authorization_mismatch");
        rev = a.rev + 1;
        asks.set(entityId, parseAsk({ ...a, rev, auditEventSeq: state.seq,
          ...(c.type === "ask.answer" ? { state: "answered", answer: c.payload.answer, decision: c.payload.decision,
            answeredBy: "person", answeredAt: state.now + 1 } : { state: "cancelled" }) }));
      } else if (c.type === "authorization.check") {
        const a = asks.get(c.payload.askId);
        if (!a || a.state !== "answered" || a.decision !== "approved" || a.expiresAt <= state.now
          || v2ObjectDigest(a.bind) !== v2ObjectDigest(c.payload.bind)) throw new V2ContractError("authorization_mismatch");
      } else throw Error(`unexpected command ${c.type}`);
      const r = parseReceipt({ ...V2_DTO_FIXTURES.receipt.valid as object, requestId: c.requestId,
        command: c.type, commandDigest: v2ObjectDigest(c), serverSeq: state.seq, committedAt: state.now,
        result: { entityId, rev, specRev: null, version: null, epoch: c.epoch, operationId: null } });
      receipts.set(c.requestId, r);
      return r;
    },
  };
  const client = new SharedLedgerExecClient(new SharedLedgerExecGate({ modeDirectory: dir, identity: () => identity,
    context: () => ({ feature, fence: V2_FIXTURE_FENCE, orderId: null }) }), transport);
  return { dir, client, state, calls, asks, actors };
}

test("synthetic transport assigns center ask ids and rejects a second answer", async () => {
  const h = await fakeCenter();
  const ask = parseAsk(V2_DTO_FIXTURES.ask.valid);
  const { kind, blocking, title, context, options, allowText, bind, featureId, taskId } = ask;
  const create = await h.client.createAsk({ type: "ask.create", requestId: "create", teamId: "team", projectId: "project", ...V2_FIXTURE_FENCE,
    payload: { kind, blocking, title, context, options, allowText, bind: { ...bind!, expiresAt: h.state.now + 100000 },
      featureId, taskId, expiresAt: h.state.now + 100000 } });
  const central = h.asks.get(create.result.entityId)!;
  const answer = { type: "ask.answer" as const, teamId: "team", projectId: "project", ...V2_FIXTURE_FENCE,
    payload: { askId: central.id, expectedRev: 1, bindDigest: v2ObjectDigest(central.bind),
      answer: { kind: "option" as const, optionId: "approve" }, decision: "approved" as const } };
  await h.client.answerAsk({ ...answer, requestId: "answer-one" });
  await expect(h.client.answerAsk({ ...answer, requestId: "answer-two" })).rejects.toThrow("conflict");
  expect(h.calls.filter((c) => c.type === "ask.create")).toHaveLength(1);
});

const components = [{ type: "buttons", buttons: [{ id: "go", label: "Approve" }, { id: "no", label: "Reject" }] }];
async function bridge(mode: "off" | "observe" | "on" = "on", execution = true) {
  const h = await fakeCenter();
  const path = join(h.dir, "ledger.sqlite");
  const db = openLedger(path);
  createTask(db, { actor: "owner", now: h.state.now }, { project: "project", id: "localtask", title: "Synthetic task", kind: "code", agent: "x" });
  const notices: Envelope[] = [];
  const deliveries: Envelope[] = [];
  const deps: AsksDeps = { controlChannelId: "999", clients: new Map([["111", { ws: {} as never }]]),
    deliver: async (envelope) => { notices.push(envelope); return { envelope, outcome: { kind: "sent" } }; },
    hold: (envelope) => { notices.push(envelope); } };
  setAsksForTest({ path, deps, registry: [{ name: "agent-x", channelId: "111", projectId: "project", status: "active" } as RegistryAgent] });
  initSharedAskWiring();
  const routing = { mode, execution, route: execution ? "central" : "local" };
  const bind = parseAsk(V2_DTO_FIXTURES.ask.valid).bind!;
  const featureRef: ExecFeatureRef = { localFeatureId: "feature", centerFeatureId: "feature", projectId: "project", epoch: 1 };
  const context: SharedAskCommandContext = { ...V2_FIXTURE_FENCE, teamId: "team", projectId: "project", taskId: "task" };
  const ports: SharedAsksPort = {
    mode: () => routing.mode, clientFor: () => h.client,
    featureOfTask: () => routing.execution ? featureRef : null,
    route: () => routing.route as "central" | "local" | "skip",
    commandContext: (_p, _f, _principal, localTaskId) => ({ ...context, taskId: `center-${localTaskId}` }),
    authorizationBind: (a) => ({ ...bind, taskId: `center-${a.taskId}`, expiresAt: h.state.now + 100000 }),
  };
  configureSharedAsks(ports);
  async function reply(authorize = false, taskId = "localtask") {
    const env: Envelope = { from: { kind: "local", channelId: "111", ws: {} as never },
      to: { kind: "user", userId: "", channelId: "123" }, intent: "response", content: "Approve?",
      meta: { messageId: `reply-${crypto.randomUUID()}`, threadId: `thread-${crypto.randomUUID()}`,
        ts: new Date(h.state.now).toISOString(), triggerKind: "agent_tool", components } };
    const raw = authorize ? { kind: "authorize", bind: { action: "merge", params: { taskId }, approve: ["go"] } } : undefined;
    return deliverReplyWithAsk(env, "123", "111", async (envelope) => {
      deliveries.push(envelope);
      return { envelope, outcome: { kind: "sent", discordMessageIds: [`discord-${envelope.meta.messageId}`] } };
    }, raw);
  }
  const current = () => getAsk(db, deliveries.at(-1)!.meta.askId!)!;
  async function check(id: string, hash: string) {
    const cli = new LedgerCli({ db, actor: "agent-x", actorProject: "project", projectIds: ["project"], now: () => h.state.now,
      loadRegistry: async () => ({ agents: {}, socket: "/tmp/synthetic.sock" }), saveRegistry: async () => {} }, { pos: ["ask-check", id], flags: { hash }, bools: new Set() });
    return READ_CMDS["ask-check"]!.run(cli);
  }
  return { ...h, db, routing, ports, deps, notices, deliveries, reply, current, check };
}

test("execution reply creates exactly one center ask and three entries share its id/CAS", async () => {
  const h = await bridge();
  expect((await h.reply()).outcome.kind).toBe("sent");
  const a = h.current();
  const mapping = sharedAskMapping(a)!;
  expect(h.calls.map((c) => c.type)).toEqual(["ask.create"]);
  const chat = await answerFromChat({ agent: "agent-x", text: "[button:go]", principal: owner(), askId: a.id });
  expect(chat?.status).toBe(202);
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(409);
  const whispers: string[] = [];
  expect(await answerFromDiscord({ messageId: a.discordMessageIds[0], user: { id: "u", username: "U" }, channelId: "123",
    origContent: "Approve?", edit: async () => {}, whisper: async (s) => { whispers.push(s); } }, "[button:go]")).toBe(true);
  expect(whispers).toHaveLength(1);
  expect(h.calls.filter((c) => c.type === "ask.answer").map((c) => c.payload.askId)).toEqual(Array(3).fill(mapping.centerAskId));
  expect(getAsk(h.db, a.id)?.answer).toBeNull();
  expect(getAsk(h.db, a.id)?.outboxMessageId).toBe(h.notices.at(-1)?.meta.messageId);
  expect(listEvents(h.db).filter((e) => e.kind === "decision")).toHaveLength(0);
});

test("command context resolves each local card separately for creation, reads and authorization", async () => {
  const h = await bridge();
  createTask(h.db, { actor: "owner" }, { project: "project", id: "second", title: "Second", kind: "code" });
  const seen: (string | undefined)[] = [];
  const bind = parseAsk(V2_DTO_FIXTURES.ask.valid).bind!;
  configureSharedAsks({ ...h.ports,
    commandContext: (_p, _f, _principal, taskId) => {
      seen.push(taskId);
      return { ...V2_FIXTURE_FENCE, teamId: "team", projectId: "project", taskId: `center-${taskId}` };
    },
    authorizationBind: (a) => ({ ...bind, taskId: `center-${a.taskId}`, expiresAt: h.state.now + 100000 }),
  });
  for (const taskId of ["localtask", "second"]) {
    expect((await h.reply(true, taskId)).outcome.kind).toBe("sent");
    const a = listAsks(h.db).find((a) => a.taskId === taskId)!;
    expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(202);
    expect((await h.check(a.id, a.bind!.paramsHash)).ok).toBe(true);
  }
  expect(h.calls.filter((c) => c.type === "ask.create").map((c) => c.payload.taskId)).toEqual(["center-localtask", "center-second"]);
  expect(h.calls.filter((c) => c.type === "authorization.check").map((c) => c.payload.taskId)).toEqual(["center-localtask", "center-second"]);
  expect(seen).toContain("localtask");
  expect(seen).toContain("second");
  expect(seen).not.toContain(undefined);
});

test("one unavailable mapping cannot hide permission or AUQ rows in the list", async () => {
  const h = await bridge();
  await h.reply();
  const a = h.current();
  const locals = ["permission", "auq"].map((source) => openAsk(h.db, {
    project: "project", source: source as "permission" | "auq", kind: "decide", title: source,
  }));
  async function read() {
    const r = await handleAsksApi(new Request("http://fake/asks"), "/ledger/project/asks", owner());
    expect(r?.status).toBe(200);
    return ((await r!.json()) as { asks: Ask[] }).asks;
  }
  const baseline = await read();
  for (const condition of ["offline", "off", "observe", "local", "null"] as const) {
    h.state.offline = condition === "offline";
    h.routing.mode = condition === "off" || condition === "observe" ? condition : "on";
    h.routing.route = condition === "local" ? "local" : "central";
    configureSharedAsks(condition === "null" ? null : h.ports);
    const before = h.state.transportCalls;
    const rows = await read();
    expect(rows.find((x) => x.id === a.id)?.extra.displayStale).toBe(true);
    for (const local of locals) expect(rows.find((x) => x.id === local.id)).toEqual(baseline.find((x) => x.id === local.id));
    if (condition !== "offline") expect(h.state.transportCalls).toBe(before);
  }
  h.state.offline = false;
  configureSharedAsks(h.ports);
  expect((await read()).find((x) => x.id === a.id)?.extra.displayStale).toBeUndefined();
});

test("card actor forgery is ignored; the authenticated center actor stays person/local", async () => {
  const h = await bridge();
  await h.reply();
  const a = h.current();
  const response = await answerFromCard("project", a.id, { choices: ["[button:go]"], actor: "attacker", role: "owner" } as never, owner());
  expect(response.status).toBe(202);
  expect(h.calls.at(-1)).not.toHaveProperty("actor");
  expect(h.actors.at(-1)).toMatchObject({ personId: "person", instanceId: "local", kind: "person" });
  expect(h.asks.get(sharedAskMapping(a)!.centerAskId)?.answeredBy).toBe("person");
});

test("offline answer and ask-check leave the mapping unchanged; check is fresh and online", async () => {
  const h = await bridge();
  await h.reply(true);
  const a = h.current();
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(202);
  const authorization = spyOn(h.client, "checkAuthorization");
  expect((await h.check(a.id, a.bind!.paramsHash)).ok).toBe(true);
  expect((await h.check(a.id, a.bind!.paramsHash)).ok).toBe(true);
  const checks = h.calls.filter((c) => c.type === "authorization.check");
  expect(checks).toHaveLength(2);
  expect(checks[0]!.requestId).not.toBe(checks[1]!.requestId);
  const before = getAsk(h.db, a.id);
  const events = listEvents(h.db);
  h.state.offline = true;
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(503);
  expect((await h.check(a.id, a.bind!.paramsHash)).ok).toBe(false);
  expect(authorization).toHaveBeenCalledTimes(3);
  expect(new Set(authorization.mock.calls.map(([c]) => c.requestId)).size).toBe(3);
  authorization.mockRestore();
  expect(getAsk(h.db, a.id)).toEqual(before);
  expect(listEvents(h.db)).toEqual(events);
  expect(h.state.transportCalls).toBeGreaterThan(0);
});

test("cancel sends ask.cancel; expiry only caches center terminal state without local expiry decisions", async () => {
  const h = await bridge();
  await h.reply();
  const a = h.current();
  const center = h.asks.get(sharedAskMapping(a)!.centerAskId)!;
  await sweepExpired(a.expiresAt + 1);
  expect(getAsk(h.db, a.id)?.state).toBe("open");
  expect(h.calls.map((c) => c.type)).toEqual(["ask.create"]);
  h.asks.set(center.id, parseAsk({ ...center, state: "expired", rev: 2 }));
  await sweepExpired(a.expiresAt + 2);
  expect(getAsk(h.db, a.id)?.state).toBe("expired");
  const reads = h.state.transportCalls;
  for (let i = 0; i < 3; i++) await sweepExpired(a.expiresAt + 3 + i);
  expect(h.state.transportCalls).toBe(reads);
  expect(listEvents(h.db).filter((e) => e.kind === "ask_expire")).toHaveLength(0);
  await h.reply();
  const other = h.current();
  expect((await dismissFromCard("project", other.id, owner())).status).toBe(200);
  expect(h.calls.at(-1)?.type).toBe("ask.cancel");
  expect(getAsk(h.db, other.id)?.answer).toBeNull();
  expect(getAsk(h.db, other.id)?.state).toBe("cancelled");
});

for (const execution of [false, true]) {
  for (const mode of ["off", "observe"] as const) {
    test(`${mode}, execution=${execution}: original reply/answer, zero center transport`, async () => {
      const h = await bridge(mode, execution);
      await h.reply();
      const a = h.current();
      expect(sharedAskMapping(a)).toBeNull();
      expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(202);
      expect(getAsk(h.db, a.id)?.state).toBe("answered");
      expect(h.state.transportCalls).toBe(0);
    });
  }
}

test("on/non-execution uses the original local path", async () => {
  const h = await bridge("on", false);
  await h.reply();
  expect(sharedAskMapping(h.current())).toBeNull();
  expect(h.state.transportCalls).toBe(0);
});

for (const execution of [false, true]) {
  test(`migrating planning/execution=${execution}: no local or center writes`, async () => {
    const h = await bridge("on", execution);
    h.routing.route = "skip";
    const before = listEvents(h.db);
    expect((await h.reply()).outcome).toMatchObject({ kind: "dropped", reason: "migration_blocked" });
    expect(listAsks(h.db)).toHaveLength(0);
    expect(listEvents(h.db)).toEqual(before);
    expect(h.state.transportCalls).toBe(0);
  });
}

test("on/execution without client fails closed before creating a local ask", async () => {
  const h = await bridge();
  configureSharedAsks({ ...h.ports, clientFor: () => null });
  const before = listEvents(h.db);
  expect((await h.reply()).outcome).toMatchObject({ kind: "dropped", reason: "unavailable" });
  expect(h.deliveries).toHaveLength(1);
  expect(h.deliveries[0]?.content).toBe("Approve?");
  expect(h.deliveries[0]?.meta.components).toBeUndefined();
  expect(h.deliveries[0]?.meta.askId).toBeUndefined();
  expect(listEvents(h.db)).toEqual(before);
  expect(listAsks(h.db)).toHaveLength(0);
  expect(h.state.transportCalls).toBe(0);
});

for (const missing of ["route", "commandContext", "authorizationBind"] as const) {
  test(`missing optional ${missing} keeps stage one and makes zero center calls`, async () => {
    const h = await bridge();
    configureSharedAsks({ ...h.ports, [missing]: undefined });
    await h.reply();
    expect(sharedAskMapping(h.current())).toBeNull();
    expect(h.state.transportCalls).toBe(0);
  });
}

test("an old local approved execution ask cannot authorize while the center is unavailable", async () => {
  const h = await bridge();
  h.db.query("UPDATE tasks SET extra = ? WHERE id = 'localtask'").run(JSON.stringify({ sharedFeatureId: "feature" }));
  const a = openAsk(h.db, { project: "project", source: "reply", kind: "authorize", fromAgent: "agent-x", taskId: "localtask",
    title: "Legacy approval", bind: { action: "merge", params: { taskId: "localtask" }, paramsHash: "oldhash", approve: ["go"] } });
  answerAsk(h.db, a.id, { choices: ["[button:go]"], labels: ["Approve"], text: "", principal: "owner:self", owner: true,
    via: "web_card", at: Date.now() });
  configureSharedAsks(null);
  const before = getAsk(h.db, a.id);
  expect((await h.check(a.id, "oldhash")).ok).toBe(false);
  expect(getAsk(h.db, a.id)).toEqual(before);
  expect(h.state.transportCalls).toBe(0);
});

test("same synthetic ledger: off/observe events and delivery effects are equal; observe logs its decision", async () => {
  const h = await bridge("off");
  setSystemTime(h.state.now);
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  const logs: unknown[][] = [];
  const log = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
  async function run(mode: "off" | "observe" | "on") {
    h.routing.mode = mode;
    h.notices.length = 0;
    h.db.exec("SAVEPOINT compare_mode");
    try {
      await h.reply();
      const a = h.current();
      await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner());
      return { events: listEvents(h.db), asks: listAsks(h.db), effects: h.notices.map((e) => ({ to: e.to.kind, content: e.content, intent: e.intent })) };
    } finally { h.db.exec("ROLLBACK TO compare_mode; RELEASE compare_mode"); }
  }
  try {
    expect(await run("observe")).toEqual(await run("off"));
    expect(logs.flat().join(" ")).toContain("would use the center");
    h.routing.execution = false; h.routing.route = "local";
    expect(await run("on")).toEqual(await run("off"));
    expect(h.state.transportCalls).toBe(0);
  } finally { log.mockRestore(); uuid.mockRestore(); random.mockRestore(); setSystemTime(); }
});

test("missing optional methods or switch-off cannot turn an existing center mapping into local approval", async () => {
  const h = await bridge();
  await h.reply();
  const a = h.current();
  const before = listEvents(h.db);
  configureSharedAsks({ ...h.ports, commandContext: undefined });
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(503);
  configureSharedAsks(h.ports);
  h.routing.mode = "off";
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(503);
  expect(getAsk(h.db, a.id)?.answer).toBeNull();
  expect(listEvents(h.db)).toEqual(before);
  expect(h.calls.map((c) => c.type)).toEqual(["ask.create"]);
});

test("execution human business ask API creates/reads through the center, while assigned asks stay local", async () => {
  const h = await bridge();
  const req = (body: object) => new Request("http://fake/asks", { method: "POST", body: JSON.stringify(body) });
  const opened = await handleAsksApi(req({ title: "Choose", taskId: "localtask", options: components,
    actor: "attacker", role: "owner" }), "/ledger/project/asks", owner());
  expect(opened?.status).toBe(201);
  const a = ((await opened!.json()) as { ask: Ask }).ask;
  expect(sharedAskMapping(a)).not.toBeNull();
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(202);
  const read = await handleAsksApi(new Request("http://fake/asks"), `/asks/${a.id}`, owner());
  expect(((await read!.json()) as { ask: Ask }).ask.state).toBe("answered");
  expect(getAsk(h.db, a.id)?.answer).toBeNull();
  const calls = h.state.transportCalls;
  const assigned = await handleAsksApi(req({ title: "Assigned", taskId: "localtask", kind: "assigned", assignee: "agent-x" }),
    "/ledger/project/asks", owner());
  expect(assigned?.status).toBe(201);
  expect(h.state.transportCalls).toBe(calls);
});

test("a successfully delivered replacement cancels the old center ask", async () => {
  const h = await bridge();
  await h.reply(true);
  const first = h.current();
  await h.reply(true);
  const old = h.asks.get(sharedAskMapping(first)!.centerAskId)!;
  expect(old.state).toBe("cancelled");
  expect(h.calls.map((c) => c.type)).toEqual(["ask.create", "ask.create", "ask.cancel"]);
  expect(getAsk(h.db, first.id)?.answer).toBeNull();
  expect((await answerFromCard("project", first.id, { choices: ["[button:go]"] }, owner())).status).toBe(409);
});

for (const mode of ["off", "observe"] as const) {
  test(`injected migrating route freezes ${mode} business asks before local side effects`, async () => {
    const h = await bridge(mode, false);
    h.routing.route = "skip";
    const events = listEvents(h.db);
    expect((await h.reply()).outcome.kind).toBe("dropped");
    expect(listEvents(h.db)).toEqual(events);
    expect(h.state.transportCalls).toBe(0);
    expect(listAsks(h.db)).toHaveLength(0);
  });
}

test("real CLI ask-check exits nonzero for a mapped ask without center wiring", async () => {
  const h = await bridge();
  await h.reply(true);
  const a = h.current();
  writeFileSync(join(h.dir, "projects.json"), JSON.stringify({ projects: [{ id: "project", name: "project", dirs: [h.dir], createdAt: "2026-10-09" }] }));
  writeFileSync(join(h.dir, "registry.json"), JSON.stringify({ socket: join(h.dir, "fake.sock"), agents: {
    "agent-x": { name: "agent-x", channelId: "111", projectId: "project", status: "active", cwd: h.dir },
  } }));
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "../src/manager.ts"),
    "ledger", "ask-check", a.id, "--hash", a.bind!.paramsHash], {
    // The isolated child assumes the synthetic local agent identity.
    env: { ...process.env, CLAUDESTRA_LEND_WORKER: undefined, CLAUDESTRA_STATE_DIR: h.dir,
      CLAUDESTRA_RUNTIME_DIR: join(h.dir, "runtime"), DISCORD_CHANNEL_ID: "111" },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(err).not.toContain("SyntaxError");
  expect(JSON.parse(out.trim().split("\n").at(-1)!)).toMatchObject({ ok: false, approved: false, code: "unavailable" });
  expect(getAsk(h.db, a.id)?.answer).toBeNull();
});

test("concurrent human creation with the same dedup key sends only one center create", async () => {
  const h = await bridge();
  const create = () => handleAsksApi(new Request("http://fake/asks", { method: "POST", body: JSON.stringify({
    title: "Choose", taskId: "localtask", options: components, dedupKey: "unique-decision",
  }) }), "/ledger/project/asks", owner());
  const [first, second] = await Promise.all([create(), create()]);
  const a = (await first!.json()) as { ask: Ask };
  const b = (await second!.json()) as { ask: Ask };
  expect(a.ask.id).toBe(b.ask.id);
  expect(h.calls.filter((c) => c.type === "ask.create")).toHaveLength(1);
  const again = await create();
  expect(again?.status).toBe(200);
  expect(((await again!.json()) as { existed: boolean }).existed).toBe(true);
});

test("a center replacement closes an older local ask; rollback holds a replacement of a live mapping", async () => {
  const h = await bridge("off");
  await h.reply(true);
  const local = h.current();
  h.routing.mode = "on";
  await h.reply(true);
  const mapped = h.current();
  expect(sharedAskMapping(mapped)).not.toBeNull();
  expect(getAsk(h.db, local.id)?.state).toBe("cancelled");
  for (const condition of ["off", "observe", "local", "null"] as const) {
    h.routing.mode = condition === "off" || condition === "observe" ? condition : "on";
    h.routing.route = condition === "local" ? "local" : "central";
    configureSharedAsks(condition === "null" ? null : h.ports);
    const events = listEvents(h.db);
    const rows = listAsks(h.db);
    const requests = h.state.transportCalls;
    expect((await h.reply(true)).outcome).toMatchObject({ kind: "dropped", reason: "unavailable" });
    expect(listAsks(h.db)).toEqual(rows);
    expect(listEvents(h.db)).toEqual(events);
    expect(h.state.transportCalls).toBe(requests);
    expect(h.asks.get(sharedAskMapping(mapped)!.centerAskId)?.state).toBe("open");
  }
});

test("answered mappings stop expiry polling; switch-off produces no polling or error log", async () => {
  const h = await bridge();
  await h.reply();
  const a = h.current();
  await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner());
  await sweepExpired(a.expiresAt + 1);
  expect(getAsk(h.db, a.id)?.state).toBe("answered");
  expect(getAsk(h.db, a.id)?.answer).toBeNull();
  const requests = h.state.transportCalls;
  for (let i = 0; i < 3; i++) await sweepExpired(a.expiresAt + 2 + i);
  expect(h.state.transportCalls).toBe(requests);
  await h.reply();
  const other = h.current();
  h.routing.mode = "off";
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const before = h.state.transportCalls;
    for (let i = 0; i < 3; i++) await sweepExpired(other.expiresAt + 1 + i);
    expect(h.state.transportCalls).toBe(before);
    expect(errors).not.toHaveBeenCalled();
  } finally { errors.mockRestore(); }
  expect(listEvents(h.db).filter((e) => e.kind === "decision" || e.kind === "ask_expire")).toHaveLength(0);
});

test("a dedup key inherited from planning keeps the original 200 response and makes no center request", async () => {
  const h = await bridge("off");
  const create = () => handleAsksApi(new Request("http://fake/asks", { method: "POST", body: JSON.stringify({
    title: "Decision", taskId: "localtask", dedupKey: "planning-key", options: components,
  }) }), "/ledger/project/asks", owner());
  const first = ((await (await create())!.json()) as { ask: Ask }).ask;
  h.routing.mode = "on";
  const again = await create();
  expect(again?.status).toBe(200);
  expect(await again!.json()).toMatchObject({ existed: true, ask: { id: first.id } });
  expect(h.state.transportCalls).toBe(0);
  expect((await answerFromCard("project", first.id, { choices: ["[button:go]"] }, owner())).status).toBe(503);
});

test("observe logs once per create or answer and a mapped read logs once", async () => {
  const h = await bridge("observe");
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    await h.reply();
    expect(log).toHaveBeenCalledTimes(1);
    const a = h.current();
    await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner());
    expect(log).toHaveBeenCalledTimes(2);
    h.routing.mode = "on";
    await h.reply();
    h.routing.mode = "observe";
    const mapped = h.current();
    await answerFromCard("project", mapped.id, { choices: ["[button:go]"] }, owner());
    expect(log).toHaveBeenCalledTimes(3);
  } finally { log.mockRestore(); }
});

test("MCP business asks opened outside this hook are held, never approved locally in execution", async () => {
  const h = await bridge();
  const a = openAsk(h.db, { project: "project", taskId: "localtask", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide",
    title: "MCP question", options: components, extra: { via: "mcp_ask" } });
  const events = listEvents(h.db);
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(503);
  expect(getAsk(h.db, a.id)).toEqual(a);
  expect(listEvents(h.db)).toEqual(events);
  expect(h.state.transportCalls).toBe(0);
});

test("shared answer keeps its outbox and redirect display mapping", async () => {
  const h = await bridge();
  await h.reply();
  const a = h.current();
  patchAsk(h.db, a.id, { extra: { parentChannelId: "222" } });
  setAsksForTest({ path: join(h.dir, "ledger.sqlite"), deps: h.deps, registry: [] });
  h.deps.clients.delete("111");
  expect((await answerFromCard("project", a.id, { choices: ["[button:go]"] }, ownerWithMaster())).status).toBe(202);
  expect(getAsk(h.db, a.id)?.extra.redirectedTo).toBe("master");
  expect(getAsk(h.db, a.id)?.outboxMessageId).toBe(h.notices.at(-1)?.meta.messageId);
  expect(getAsk(h.db, a.id)?.answer).toBeNull();
});

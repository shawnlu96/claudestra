import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsk, parseFeature, parseReceipt, V2_COMMAND_NAMES, V2ContractError, v2ObjectDigest,
  type V2Ask, type V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { SharedLedgerExecClient, type ExecTransport } from "../src/lib/shared-ledger-exec-client.js";
import { SharedLedgerExecGate, type ExecIdentity } from "../src/lib/shared-ledger-exec-gate.js";
import { setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import { deliverReplyWithAsk } from "../src/bridge/ask-reply.js";
import { initSharedAskWiring } from "../src/bridge/shared-ledger-v2-asks-wiring.js";
import { configureSharedAsks, type SharedAsksPort, type ExecFeatureRef, type SharedAskCommandContext } from "../src/bridge/shared-ledger-v2-asks.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getAsk } from "../src/lib/ledger-asks.js";
import { READ_CMDS } from "../src/manager/ledger-read-cmds.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import type { Envelope } from "../src/bridge/router.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";

const dirs: string[] = [];
afterEach(() => {
  configureSharedAsks(null);
  setAsksForTest(undefined);
  for (const dir of dirs.splice(0)) {
    closeLedger(join(dir, "ledger.sqlite"));
    rmSync(dir, { recursive: true, force: true });
  }
});

export async function fakeCenter() {
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

export const components = [{ type: "buttons", buttons: [{ id: "go", label: "Approve" }, { id: "no", label: "Reject" }] }];
export async function bridge(mode: "off" | "observe" | "on" = "on", execution = true) {
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

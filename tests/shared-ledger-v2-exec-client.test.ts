import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAsk, parseCommand, parseFeature, parseReceipt, V2_COMMAND_NAMES, V2_COMMAND_POLICY,
  V2ContractError, v2ObjectDigest, type V2Command, type V2CommandName, type V2Receipt,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_COMMAND_FIXTURES, V2_DTO_FIXTURES, V2_FIXTURE_FENCE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { execOperationId, SharedLedgerExecClient, type ExecTransport } from "../src/lib/shared-ledger-exec-client.js";
import { SharedLedgerExecGate, type ExecIdentity } from "../src/lib/shared-ledger-exec-gate.js";
import { SharedLedgerExecLocal } from "../src/lib/shared-ledger-exec-local.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function command<K extends V2CommandName>(type: K): Extract<V2Command, { type: K }> {
  return structuredClone(V2_COMMAND_FIXTURES.find(f => f.type === type)!.valid) as Extract<V2Command, { type: K }>;
}
function receipt(c: V2Command): V2Receipt {
  return parseReceipt({ ...V2_DTO_FIXTURES.receipt.valid as object, requestId: c.requestId, command: c.type,
    commandDigest: v2ObjectDigest(c), result: { entityId: "entity", rev: 2, specRev: 1, version: null,
      epoch: c.epoch, operationId: execOperationId(c) } });
}
async function harness(mode: "source" | "planning" | "execution" = "execution") {
  const dir = mkdtempSync(join(tmpdir(), "v2-exec-")); dirs.push(dir);
  const feature = parseFeature({ ...V2_DTO_FIXTURES.feature.valid as object, authorityMode: mode });
  const identity: ExecIdentity = { centerId: "center", teamId: "team", projectId: "project", projectRole: "owner",
    registeredPersonId: "person", registeredInstanceId: "local", actor: {
      kind: "person", personId: "person", instanceId: "local", serviceId: null,
      representedPersonId: null, orderId: null, projects: ["project"], actions: [...V2_COMMAND_NAMES],
    } };
  await writeSharedLedgerMode("feature", { authorityMode: mode, sharedPlanning: mode !== "source" }, dir);
  const state = { offline: false, drop: false, now: 2000, reads: 0, submits: 0, orderId: "order" as string | null };
  const log: string[] = [];
  const committed = new Map<string, V2Receipt>();
  const submitted: { command: V2Command; actor: ExecIdentity["actor"] }[] = [];
  const transport: ExecTransport = {
    async receipt(q) {
      log.push(`receipt:${q.operationId ?? q.requestId}`); state.reads++;
      if (state.offline) throw Error("offline");
      return committed.get(q.requestId) ?? null;
    },
    async submit(c, actor) {
      log.push(`submit:${c.type}`); state.submits++; submitted.push({ command: c, actor });
      if (state.offline) throw Error("offline");
      const r = receipt(c); committed.set(c.requestId, r);
      if (state.drop) { state.drop = false; throw Error("lost response"); }
      return r;
    },
    async ask() { log.push("ask"); if (state.offline) throw Error("offline"); return structuredClone(V2_DTO_FIXTURES.ask.valid); },
  };
  const gate = new SharedLedgerExecGate({ modeDirectory: dir, identity: () => identity,
    context: () => ({ feature, fence: V2_FIXTURE_FENCE, orderId: state.orderId }) });
  const client = new SharedLedgerExecClient(gate, transport, () => state.now);
  return { dir, feature, identity, state, log, committed, submitted, transport, gate, client };
}
function service(h: Awaited<ReturnType<typeof harness>>) {
  Object.assign(h.identity.actor, { kind: "service", serviceId: "service", representedPersonId: "person", orderId: "order" });
}

for (const mode of ["source", "planning", "execution"] as const) {
  test(`${mode} follows the frozen policy for every command`, async () => {
    const h = await harness(mode);
    for (const { valid } of V2_COMMAND_FIXTURES) {
      const blocked = mode === "source" || (mode === "planning" && V2_COMMAND_POLICY[valid.type].executionOnly);
      if (blocked) await expect(h.client.command(valid)).rejects.toThrow("execution_not_shared");
      else expect((await h.client.command(valid)).command).toBe(valid.type);
    }
    expect(h.state.submits).toBe(mode === "source" ? 0 : V2_COMMAND_FIXTURES.filter(f =>
      mode === "execution" || !V2_COMMAND_POLICY[f.type].executionOnly).length);
  });
}
for (const field of ["actor", "role", "personId", "instanceId"] as const) {
  test(`rejects caller-supplied ${field} before transport`, async () => {
    const h = await harness();
    await expect(h.client.command({ ...command("task.stage"), [field]: "owner" } as V2Command)).rejects.toThrow("invalid_field");
    expect(h.log).toEqual([]);
  });
}
for (const mismatch of ["person", "instance", "team", "project", "action", "owner", "home"] as const) {
  test(`identity scope rejects ${mismatch}`, async () => {
    const h = await harness();
    let c: V2Command = command("task.stage");
    if (mismatch === "person") h.identity.registeredPersonId = "other";
    if (mismatch === "instance") h.identity.registeredInstanceId = "peer-a";
    if (mismatch === "team") h.identity.teamId = "other";
    if (mismatch === "project") h.identity.actor.projects = ["other"];
    if (mismatch === "action") h.identity.actor.actions = ["task.set"];
    if (mismatch === "owner") { h.identity.projectRole = "member"; c = command("ask.answer"); }
    if (mismatch === "home") h.feature.homeInstanceId = "peer-a";
    await expect(h.client.command(c)).rejects.toBeInstanceOf(V2ContractError);
    expect(h.log).toEqual([]);
  });
}
test("service carries represented identity/order separately and cannot approve as owner", async () => {
  const h = await harness(); service(h);
  const c = command("task.deliver"); c.payload.orderId = "order"; c.payload.leaseGen = 1;
  await h.client.command(c);
  expect(h.submitted[0]!.actor).toMatchObject({ kind: "service", representedPersonId: "person", orderId: "order" });
  expect(h.submitted[0]!.command).not.toHaveProperty("actor");
  await expect(h.client.answerAsk(command("ask.answer"))).rejects.toThrow("forbidden");
  h.identity.actor.actions = ["task.deliver"];
  await expect(h.client.command(command("task.stage"))).rejects.toThrow("forbidden");
});
for (const wrong of ["registration", "project", "order", "body-order", "represented", "executor"] as const) {
  test(`service scope rejects ${wrong}`, async () => {
    const h = await harness(); service(h);
    const c = command("lend.result"); c.payload.result.executorInstanceId = "local";
    c.payload.result.worker = { kind: "agent", instanceId: "local", agentId: "worker" };
    if (wrong === "registration") h.identity.registeredInstanceId = "peer-a";
    if (wrong === "project") h.identity.actor.projects = ["other"];
    if (wrong === "order") h.state.orderId = "other";
    if (wrong === "body-order") c.payload.result.orderId = "other";
    if (wrong === "represented") h.identity.actor.representedPersonId = null;
    if (wrong === "executor") {
      c.payload.result.executorInstanceId = "peer-b"; c.payload.result.worker.instanceId = "peer-b";
    }
    const code = wrong === "represented" ? "invalid_field" : wrong === "registration" ? "unauthenticated" : "forbidden";
    await expect(h.client.command(c)).rejects.toThrow(code);
    expect(h.log).toEqual([]);
  });
}
test("all six business ask operations use the center", async () => {
  const h = await harness();
  await h.client.createAsk(command("ask.create"));
  expect((await h.client.queryAsk({ teamId: "team", projectId: "project", askId: "ask" })).source).toBe("business");
  await h.client.answerAsk(command("ask.answer"));
  await h.client.cancelAsk(command("ask.cancel"));
  await h.client.expireAsk(command("ask.expire"));
  await h.client.checkAuthorization(command("authorization.check"));
  expect(h.state.submits).toBe(5);
  expect(h.log).toContain("ask");
  expect(h.submitted.map(x => x.command.type)).toEqual(["ask.create", "ask.answer", "ask.cancel", "ask.expire", "authorization.check"]);
});
test("typed ask facade also rejects wrong method at runtime and runtime permission kinds", async () => {
  const h = await harness();
  expect(() => h.client.createAsk(command("ask.answer") as never)).toThrow("invalid_field");
  const c = command("ask.create"); (c.payload as { kind: string }).kind = "permission";
  await expect(h.client.createAsk(c)).rejects.toThrow("invalid_field");
  expect(h.log).toEqual([]);
});
test("persisted gate is rechecked after receipt lookup and survives restart", async () => {
  const h = await harness();
  h.transport.receipt = async () => {
    await writeSharedLedgerMode("feature", { authorityMode: "planning", sharedPlanning: true }, h.dir);
    return null;
  };
  await expect(h.client.command(command("task.stage"))).rejects.toThrow("execution_not_shared");
  const restarted = new SharedLedgerExecClient(h.gate, h.transport);
  await expect(restarted.command(command("task.stage"))).rejects.toThrow("execution_not_shared");
  expect(h.state.submits).toBe(0);
});
test("missing or corrupt durable mode never falls back to execution", async () => {
  const h = await harness();
  writeFileSync(join(h.dir, "shared-ledger-modes.json"), "{}");
  await expect(h.client.command(command("task.stage"))).rejects.toThrow("state invalid");
  rmSync(join(h.dir, "shared-ledger-modes.json"));
  await expect(h.client.command(command("task.stage"))).rejects.toThrow("execution_not_shared");
  expect(h.log).toEqual([]);
});
test("identity revocation during receipt lookup prevents send and receipt replay", async () => {
  const h = await harness();
  h.transport.receipt = async () => { h.identity.actor.projects = []; return receipt(command("task.stage")); };
  await expect(h.client.command(command("task.stage"))).rejects.toThrow("forbidden");
  expect(h.state.submits).toBe(0);
});
for (const type of ["intent.create", "operation.result", "lend.result", "ask.answer"] as const) {
  test(`lost ${type} response is reconciled before explicit retry, including restart`, async () => {
    const h = await harness(); h.state.drop = true;
    const c = command(type);
    await expect(h.client.command(c)).rejects.toThrow("unavailable");
    expect(h.state.submits).toBe(1);
    const restarted = new SharedLedgerExecClient(h.gate, h.transport);
    expect(await restarted.command(c)).toEqual(receipt(c));
    expect(h.state.submits).toBe(1);
    expect(h.log.at(-1)).toBe(`receipt:${execOperationId(c) ?? c.requestId}`);
  });
}
test("receipt outage and unknown operation stop before a blind send", async () => {
  const h = await harness(); h.state.offline = true;
  await expect(h.client.command(command("intent.create"))).rejects.toThrow("unavailable");
  expect(h.state.submits).toBe(0);
  h.transport.receipt = async () => { throw new V2ContractError("unknown_operation"); };
  await expect(h.client.command(command("intent.create"))).rejects.toThrow("unknown_operation");
  expect(h.state.submits).toBe(0);
});
test("a historical authorization check never becomes a fresh permission", async () => {
  const h = await harness();
  await h.client.checkAuthorization(command("authorization.check"));
  await expect(h.client.checkAuthorization(command("authorization.check"))).rejects.toThrow("replayed");
  const fresh = command("authorization.check"); fresh.requestId = "fresh-check";
  await h.client.checkAuthorization(fresh);
  expect(h.state.submits).toBe(2);
});
for (const wrong of ["digest", "scope", "actor", "generation", "epoch", "operation", "request"] as const) {
  test(`mismatched ${wrong} receipt cannot confirm or trigger another send`, async () => {
    const h = await harness(); const c = command("intent.create"); const r = receipt(c);
    if (wrong === "digest") r.commandDigest = "0".repeat(64);
    if (wrong === "scope") r.projectId = "other";
    if (wrong === "actor") r.personId = "other";
    if (wrong === "generation") r.serviceGeneration++;
    if (wrong === "epoch") r.result.epoch++;
    if (wrong === "operation") r.result.operationId = "other";
    if (wrong === "request") r.requestId = "other";
    h.committed.set(c.requestId, r);
    await expect(h.client.command(c)).rejects.toBeInstanceOf(V2ContractError);
    expect(h.state.submits).toBe(0);
  });
}
test("same request id with changed content is refused after a lost reply", async () => {
  const h = await harness(); h.state.drop = true;
  const c = command("task.deliver");
  await expect(h.client.command(c)).rejects.toThrow("unavailable");
  c.payload.summary = "different result";
  await expect(h.client.command(c)).rejects.toThrow("dedup_mismatch");
  expect(h.state.submits).toBe(1);
});
test("offline ask cache remains display only, with last successful time; approvals still need center", async () => {
  const h = await harness();
  const query = { teamId: "team", projectId: "project", askId: "ask" };
  await h.client.queryAsk(query);
  h.state.offline = true; h.state.now = 9000;
  await expect(h.client.queryAsk(query)).rejects.toThrow("unavailable");
  await expect(h.client.answerAsk(command("ask.answer"))).rejects.toThrow("unavailable");
  await expect(h.client.checkAuthorization(command("authorization.check"))).rejects.toThrow("unavailable");
  expect(h.client.cachedAsk(query)).toMatchObject({ displayOnly: true, authoritative: false, stale: true, lastSuccessAt: 2000 });
  expect(h.client.status()).toEqual({ available: false, lastSuccessAt: 2000 });
  expect(h.state.submits).toBe(0);
});
test("rejected membership clears cached asks; wrong-project responses are rejected", async () => {
  const h = await harness(); const query = { teamId: "team", projectId: "project", askId: "ask" };
  await h.client.queryAsk(query);
  h.transport.ask = async () => { throw new V2ContractError("not_member"); };
  await expect(h.client.queryAsk(query)).rejects.toThrow("not_member");
  expect(h.client.cachedAsk(query)).toBeNull();
  h.transport.ask = async () => ({ ...V2_DTO_FIXTURES.ask.valid as object, projectId: "other" });
  await expect(h.client.queryAsk(query)).rejects.toThrow("forbidden");
});
test("service ask query requires scoped ask capability", async () => {
  const h = await harness(); service(h); h.identity.actor.actions = ["task.deliver"];
  await expect(h.client.queryAsk({ teamId: "team", projectId: "project", askId: "ask" })).rejects.toThrow("forbidden");
  expect(h.log).toEqual([]);
});
test("drafts and pending results survive restart without approval or automatic submit", async () => {
  const h = await harness(); const local = new SharedLedgerExecLocal(h.dir, h.identity, "project", () => 2500);
  expect(await local.saveResult(command("operation.result"))).toEqual({ state: "pending_submission", authoritative: false });
  await local.saveDraft("draft", "Unsubmitted proposal"); await local.noteSuccess(2000);
  const restarted = new SharedLedgerExecLocal(h.dir, h.identity, "project");
  expect(restarted.view()).toMatchObject({ authoritative: false, displayOnly: true, lastSuccessAt: 2000,
    results: [{ state: "pending_submission", savedAt: 2500 }], drafts: [{ content: "Unsubmitted proposal" }] });
  expect(h.log).toEqual([]);
  const file = readdirSync(h.dir).find(f => f.startsWith("exec-local-"))!;
  expect(statSync(join(h.dir, file)).mode & 0o777).toBe(0o600);
  const saved = readFileSync(join(h.dir, file), "utf8");
  expect(saved).not.toContain('"approved"');
  await expect(local.saveResult(command("ask.answer") as never)).rejects.toThrow("forbidden");
  await expect(local.saveResult(command("intent.create") as never)).rejects.toThrow("forbidden");
});
test("outbox retains all result kinds, deduplicates and rejects overwrite, wrong scope and bad state", async () => {
  const h = await harness(); const local = new SharedLedgerExecLocal(h.dir, h.identity, "project");
  for (const type of ["task.deliver", "task.review", "operation.result", "lend.result"] as const) await local.saveResult(command(type));
  await local.saveResult(command("task.deliver")); expect(local.view().results).toHaveLength(4);
  const changed = command("task.deliver"); changed.payload.summary = "changed";
  await expect(local.saveResult(changed)).rejects.toThrow("dedup_mismatch");
  const cross = command("task.deliver"); cross.projectId = "other";
  await expect(local.saveResult(cross)).rejects.toThrow("forbidden");
  const file = join(h.dir, readdirSync(h.dir).find(f => f.startsWith("exec-local-"))!);
  writeFileSync(file, "broken");
  await expect(local.saveDraft("draft", "text")).rejects.toThrow("unavailable");
  expect(readFileSync(file, "utf8")).toBe("broken");
});
test("outbox scopes saved results by identity and service order", async () => {
  const h = await harness(); const local = new SharedLedgerExecLocal(h.dir, h.identity, "project");
  await local.saveResult(command("task.deliver"));
  service(h);
  const worker = new SharedLedgerExecLocal(h.dir, h.identity, "project");
  expect(worker.view().results).toEqual([]);
  await expect(worker.saveResult(command("task.deliver"))).rejects.toThrow("forbidden");
  const c = command("task.deliver"); c.payload.orderId = "order"; c.payload.leaseGen = 1;
  await worker.saveResult(c);
  expect(worker.view().results).toHaveLength(1);
});
test("a cached approved ask is never consulted for authorization", async () => {
  const h = await harness();
  h.transport.ask = async () => parseAsk({ ...V2_DTO_FIXTURES.ask.valid as object,
    state: "answered", answeredBy: "person", answeredAt: 2000, decision: "approved", answer: { kind: "option", optionId: "approve" } });
  await h.client.queryAsk({ teamId: "team", projectId: "project", askId: "ask" });
  h.state.offline = true;
  await expect(h.client.checkAuthorization(command("authorization.check"))).rejects.toThrow("unavailable");
  expect(h.state.submits).toBe(0);
});

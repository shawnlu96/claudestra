/** S2F8 · composition-root command routing: the gate reads the local mode through the recorded local ↔ center feature binding,
 * and ask / dep / nested-task commands find their feature. Synthetic center behind an injected connector; nothing leaves the process. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilities, fail, parseCommand, v2ObjectDigest, V2ContractError, type V2Command,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_COMMAND_FIXTURES, V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { centerReplicaLocalId } from "../src/lib/shared-ledger-center-replica.js";
import { execOperationId } from "../src/lib/shared-ledger-exec-client.js";
import type { Stage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import { OWNER_PRINCIPAL, Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { commandTaskId, localFeatureOfCenter } from "../src/lib/shared-ledger-v2-wiring-routing.js";

type Obj = Record<string, any>;
const P = "s2f8-local", CENTER = { centerId: "center", ...V2_FIXTURE_SCOPE };
const A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", B = "ffeeddcc-bbaa-4998-8776-655443322110";
const LOCAL_A = centerReplicaLocalId(A)!, LOCAL_B = centerReplicaLocalId(B)!;
const dto = (k: keyof typeof V2_DTO_FIXTURES): Obj => structuredClone(V2_DTO_FIXTURES[k].valid) as Obj;
const payload = (type: string): Obj => structuredClone(V2_COMMAND_FIXTURES.find((c) => c.type === type)!.valid.payload) as Obj;
const openAsk = (id: string, featureId: string): Obj => ({ ...dto("ask"), id, featureId, taskId: null, kind: "decide", bind: null });
const view = (featureId: string, taskIds: string[], askIds: string[]): Obj => ({
  ...V2_FIXTURE_SCOPE, serverSeq: 3, serviceGeneration: 1,
  feature: { ...dto("feature"), id: featureId, authorityMode: "execution", currentVersion: 0 }, dag: null,
  tasks: taskIds.map((id) => ({ ...dto("task"), id, featureId, itemId: null })), dependencies: [], steps: [], workflows: [],
  intents: [], resources: [], pendingAsks: askIds.map((id) => openAsk(id, featureId)), capabilities: capabilities(),
});
const execution = (centerFeatureId: string) => ({ authorityMode: "execution", sharedPlanning: true,
  centerExecution: { ...CENTER, centerFeatureId, epoch: 1 } });

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A synthetic center: feature A holds `task` / `task-two` and ask `ask`; feature B holds `task-b` and `ask-b`. */
function world(modes: Obj) {
  const dir = mkdtempSync(join(tmpdir(), "s2f8-routing-"));
  dirs.push(dir);
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: modes }), { mode: 0o600 });
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([{ ...CENTER, localProjectId: P }]), { mode: 0o600 });
  const calls = { receipt: 0, submit: 0, ask: 0, snapshot: 0 }, submitted: string[] = [];
  const views = new Map<string, Obj>([[A, view(A, ["task", "task-two"], ["ask"])], [B, view(B, ["task-b"], ["ask-b"])]]);
  const asks = new Map<string, Obj>([["ask", openAsk("ask", A)], ["ask-b", openAsk("ask-b", B)]]);
  const transport = {
    scope: V2_FIXTURE_SCOPE,
    exec: {
      receipt: async () => { calls.receipt++; return null; },
      submit: async (command: V2Command, actor: { personId: string; instanceId: string }) => {
        calls.submit++; submitted.push(command.type);
        return { ...V2_FIXTURE_SCOPE, schemaVersion: 2, serviceGeneration: 1, requestId: command.requestId, personId: actor.personId,
          instanceId: actor.instanceId, commandDigest: v2ObjectDigest(command), command: command.type, serverSeq: 9, committedAt: 2000,
          result: { entityId: "entity", rev: 2, specRev: null, version: null, epoch: 1, operationId: execOperationId(command) } };
      },
      ask: async () => fail("unavailable"),
    },
    snapshot: async (id: string) => { calls.snapshot++; return structuredClone(views.get(id)) ?? fail("not_found"); },
    ask: async (id: string) => { calls.ask++; return structuredClone(asks.get(id)) ?? fail("not_found"); },
  } as unknown as Stage2Transport;
  const wiring = new Stage2Wiring({ dir, connect: () => ({ transport, personId: "person", instanceId: "local" }) });
  let n = 0;
  const command = (type: string, patch: Obj = {}) =>
    parseCommand({ ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, requestId: `request-${++n}`, type, payload: { ...payload(type), ...patch } });
  const send = (type: string, patch: Obj = {}) => wiring.clientFor(OWNER_PRINCIPAL, P)!.command(command(type, patch));
  return { dir, wiring, calls, submitted, views, send };
}
async function codeOf(run: Promise<unknown>): Promise<string> {
  try { await run; return "ok"; } catch (e) {
    if (e instanceof V2ContractError) return e.code;
    throw e;
  }
}

describe("local mode is read through the recorded local ↔ center feature binding", () => {
  test("[验收线 1] an n7 replica in execution mode: task.set queries the receipt and submits", async () => {
    const w = world({ [LOCAL_A]: execution(A) });
    expect(LOCAL_A).toBe("n7-0a1b2c3d4e");
    await w.wiring.snapshot(P, LOCAL_A);
    const receipt = await w.send("task.set");
    expect(receipt.command).toBe("task.set");
    expect(w.calls).toMatchObject({ receipt: 1, submit: 1 });
  });

  test("[验收线 2] local id equal to the center id still passes", async () => {
    const w = world({ [A]: execution(A) });
    await w.wiring.snapshot(P, A);
    expect(await codeOf(w.send("task.set"))).toBe("ok");
    expect(w.calls).toMatchObject({ receipt: 1, submit: 1 });
  });

  test("[验收线 2] no binding for the center feature is refused with no request", async () => {
    const unrelated = world({ [LOCAL_B]: execution(B) });
    expect(await codeOf(unrelated.send("feature.set", { featureId: A }))).toBe("execution_not_shared");
    // A record that merely sits under the center id but is bound to another center feature is not a binding for it.
    const elsewhere = world({ [A]: execution(B) });
    expect(await codeOf(elsewhere.send("feature.set", { featureId: A }))).toBe("execution_not_shared");
    // Bound in another center scope.
    const otherCenter = world({ [LOCAL_A]: { ...execution(A), centerExecution: { ...CENTER, centerId: "center-two", centerFeatureId: A, epoch: 1 } } });
    expect(await codeOf(otherCenter.send("feature.set", { featureId: A }))).toBe("execution_not_shared");
    // Two local records claiming one center feature: no single answer, so none.
    const twice = world({ [LOCAL_A]: execution(A), "n7-copy": execution(A) });
    expect(await codeOf(twice.send("feature.set", { featureId: A }))).toBe("execution_not_shared");
    for (const w of [unrelated, elsewhere, otherCenter, twice]) expect(w.calls).toMatchObject({ receipt: 0, submit: 0 });
  });

  test("[验收线 2] the gate's rule is unchanged: a bound planning record does not admit an execution command", async () => {
    const w = world({ [LOCAL_A]: { authorityMode: "planning", sharedPlanning: true, centerPlanned: { ...CENTER, centerFeatureId: A } } });
    expect(await codeOf(w.send("feature.set", { featureId: A }))).toBe("execution_not_shared");
    expect(localFeatureOfCenter(w.dir, CENTER, A)).toBe(LOCAL_A);
    expect(w.calls).toMatchObject({ receipt: 0, submit: 0 });
  });

  test("a corrupt or missing mode file maps nothing", () => {
    const w = world({ [LOCAL_A]: execution(A) });
    writeFileSync(join(w.dir, "shared-ledger-modes.json"), "{not json");
    expect(localFeatureOfCenter(w.dir, CENTER, A)).toBeNull();
    rmSync(join(w.dir, "shared-ledger-modes.json"));
    expect(localFeatureOfCenter(w.dir, CENTER, A)).toBeNull();
  });
});

describe("ask and dep commands find their feature", () => {
  test("[验收线 3] a cached center ask routes ask.answer / ask.cancel / ask.expire with no extra ask read", async () => {
    const w = world({ [LOCAL_A]: execution(A) });
    await w.wiring.snapshot(P, LOCAL_A); // caches the view and its pending asks
    expect(w.wiring.cachedAsk("ask")?.featureId).toBe(A);
    for (const type of ["ask.answer", "ask.cancel", "ask.expire"]) expect(await codeOf(w.send(type))).toBe("ok");
    expect(w.submitted).toEqual(["ask.answer", "ask.cancel", "ask.expire"]);
    expect(w.calls).toMatchObject({ receipt: 3, submit: 3, ask: 0, snapshot: 1 });
  });

  test("[验收线 3] an uncached ask costs one center read, then its feature's view", async () => {
    const w = world({ [LOCAL_A]: execution(A) });
    expect(await codeOf(w.send("ask.cancel"))).toBe("ok");
    expect(w.calls).toMatchObject({ receipt: 1, submit: 1, ask: 1, snapshot: 1 });
    expect(await codeOf(w.send("ask.expire"))).toBe("ok");
    expect(w.calls).toMatchObject({ receipt: 2, submit: 2, ask: 1, snapshot: 1 });
    // An ask the center does not know: the center's answer is passed on, nothing is submitted.
    expect(await codeOf(w.send("ask.cancel", { askId: "ask-gone" }))).toBe("not_found");
    expect(w.calls).toMatchObject({ receipt: 2, submit: 2 });
  });

  test("[验收线 3] an ask of an unbound feature is refused", async () => {
    const w = world({ [LOCAL_A]: execution(A) });
    expect(await codeOf(w.send("ask.cancel", { askId: "ask-b" }))).toBe("execution_not_shared");
    expect(w.calls).toMatchObject({ receipt: 0, submit: 0 });
  });

  test("[验收线 3] dep.set / dep.remove route by the feature both cards belong to", async () => {
    const w = world({ [LOCAL_A]: execution(A) });
    await w.wiring.snapshot(P, LOCAL_A);
    expect(await codeOf(w.send("dep.set"))).toBe("ok");
    expect(await codeOf(w.send("dep.remove"))).toBe("ok");
    expect(w.submitted).toEqual(["dep.set", "dep.remove"]);
    expect(w.calls).toMatchObject({ receipt: 2, submit: 2 });
  });

  test("[验收线 3] a dep across two features is refused with no request", async () => {
    const w = world({ [LOCAL_A]: execution(A), [LOCAL_B]: execution(B) });
    await w.wiring.snapshot(P, LOCAL_A);
    await w.wiring.snapshot(P, LOCAL_B);
    expect(await codeOf(w.send("dep.set", { toTask: "task-b" }))).toBe("forbidden");
    expect(await codeOf(w.send("dep.remove", { fromTask: "task-b" }))).toBe("forbidden");
    expect(w.calls).toMatchObject({ receipt: 0, submit: 0 });
  });

  test("a dep card the cached view predates is found by one re-read; an unknown card stays unavailable", async () => {
    const w = world({ [LOCAL_A]: execution(A) });
    w.views.set(A, view(A, ["task"], []));
    await w.wiring.snapshot(P, LOCAL_A);
    w.views.set(A, view(A, ["task", "task-two"], []));
    expect(await codeOf(w.send("dep.set"))).toBe("ok");
    expect(w.calls).toMatchObject({ snapshot: 2, submit: 1 });
    expect(await codeOf(w.send("dep.set", { toTask: "task-nowhere" }))).toBe("unavailable");
    expect(await codeOf(w.send("dep.set", { fromTask: "task-x", toTask: "task-y" }))).toBe("unavailable");
    expect(w.calls).toMatchObject({ receipt: 1, submit: 1 });
  });

  test("nested task ids (operation.result / lend.claim / lend.result) are recognised", async () => {
    const w = world({ [LOCAL_A]: execution(A) });
    await w.wiring.snapshot(P, LOCAL_A);
    for (const type of ["operation.result", "lend.claim", "lend.result"]) {
      const p = payload(type);
      expect(commandTaskId(p)).toBe("task");
      expect(await codeOf(w.send(type))).toBe("ok");
    }
    expect(commandTaskId({ result: { taskId: 1 } })).toBeNull();
    expect(w.calls).toMatchObject({ receipt: 3, submit: 3 });
  });
});

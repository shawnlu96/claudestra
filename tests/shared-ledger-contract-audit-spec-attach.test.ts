import { describe, expect, test } from "bun:test";
import {
  parseCommand, V2_COMMAND_NAMES, V2_COMMAND_POLICY, V2_COMMAND_SCHEMAS,
} from "../src/lib/shared-ledger-contract-v2-commands";

const envelope = {
  teamId: "team", projectId: "project", requestId: "attach-request",
  serviceGeneration: 1, epoch: 1, bootId: "boot",
};
const payload = {
  taskId: "task", expectedRev: 4, expectedSpecRev: 2,
  artifactId: "approved-spec-copy", authorizationAskId: "share-approval",
};
const attach = () => ({ ...envelope, type: "task.spec.attach" as const, payload: { ...payload } });
const spec = {
  summary: "Original specification", originalDigest: "a".repeat(64), sharedDigest: null,
  artifactId: null, visibility: "home_only" as const, repositoryPath: null, commit: null,
};

describe("[验收线 1] task.spec.attach static contract", () => {
  test("same-generation attachment parses through the public command table", () => {
    const command = attach();
    expect(parseCommand(command)).toEqual(command);
    expect(V2_COMMAND_NAMES.filter(name => String(name) === command.type)).toHaveLength(1);
    const schema = (V2_COMMAND_SCHEMAS as Record<string, (v: unknown) => unknown>)[command.type]!;
    expect(schema(command)).toEqual(command);
    expect(Object.keys(parseCommand(command).payload).sort()).toEqual(Object.keys(payload).sort());
  });

  test("scope, request and fencing fields remain required and strictly typed", () => {
    for (const key of Object.keys(envelope)) {
      const missing: Record<string, unknown> = attach();
      delete missing[key];
      expect(() => parseCommand(missing)).toThrow("invalid_field");
    }
    for (const key of ["serviceGeneration", "epoch"]) {
      for (const value of [0, -1, 1.5, "1", null]) {
        expect(() => parseCommand({ ...attach(), [key]: value })).toThrow("invalid_field");
      }
    }
  });

  test("task CAS, specification CAS and approval cannot be omitted or bypassed", () => {
    for (const key of Object.keys(payload)) {
      const missing: Record<string, unknown> = { ...payload };
      delete missing[key];
      expect(() => parseCommand({ ...attach(), payload: missing })).toThrow("invalid_field");
    }
    for (const key of ["expectedRev", "expectedSpecRev"]) {
      for (const value of [null, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => parseCommand({ ...attach(), payload: { ...payload, [key]: value } })).toThrow("invalid_field");
      }
    }
  });

  test("artifact, task and approval identities use canonical ledger IDs", () => {
    for (const key of ["artifactId", "taskId", "authorizationAskId"]) {
      for (const value of [null, "", "../artifact", "/tmp/spec", "artifact copy", "id\u0000", "x".repeat(129), {}, 1]) {
        expect(() => parseCommand({ ...attach(), payload: { ...payload, [key]: value } })).toThrow("invalid_field");
      }
    }
  });

  test("owner and artifact.share approval are explicit execution policy", () => {
    const policy = (V2_COMMAND_POLICY as Record<string, unknown>)["task.spec.attach"];
    expect(policy).toEqual({ actor: "owner", executionOnly: true, authorizationAction: "artifact.share" });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(V2_COMMAND_POLICY["task.spec"]).toEqual({ actor: "member", executionOnly: true });
  });

  test("body cannot supply verified identity or an authorization policy", () => {
    for (const key of ["actor", "role", "personId", "instanceId", "owner", "authorizationAction"]) {
      expect(() => parseCommand({ ...attach(), [key]: "owner" })).toThrow("invalid_field");
      expect(() => parseCommand({ ...attach(), payload: { ...payload, [key]: "owner" } })).toThrow("invalid_field");
    }
  });
});

describe("[验收线 2] attachment cannot replace the specification or execution state", () => {
  test("only artifact and approval references can be attached", () => {
    const extraFields = {
      nextSpecRev: 3, spec, patch: { spec }, summary: "Changed specification",
      originalDigest: "b".repeat(64), sharedDigest: "c".repeat(64), content: "Changed body",
      head: "d".repeat(40), stage: "done", round: 9, expectedWorkflowRev: 1,
      visibility: "approved_copy", repositoryPath: "spec.md", commit: "d".repeat(40),
      artifact: { artifactId: payload.artifactId }, approval: { decision: "approved" },
    };
    for (const [key, value] of Object.entries(extraFields)) {
      expect(() => parseCommand({ ...attach(), payload: { ...payload, [key]: value } })).toThrow("invalid_field");
    }
  });

  test("task.spec still requires exactly one specification revision increment", () => {
    const command = {
      ...envelope, type: "task.spec" as const,
      payload: { taskId: "task", expectedRev: 4, expectedSpecRev: 2, nextSpecRev: 3, spec, reason: "New specification" },
    };
    expect(parseCommand(command)).toEqual(command);
    for (const nextSpecRev of [undefined, null, 0, 1, 2, 4, "3"]) {
      expect(() => parseCommand({ ...command, payload: { ...command.payload, nextSpecRev } })).toThrow("invalid_field");
    }
    for (const key of ["artifactId", "authorizationAskId"]) {
      expect(() => parseCommand({ ...command, payload: { ...command.payload, [key]: payload.artifactId } })).toThrow("invalid_field");
    }
  });
});

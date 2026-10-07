import { describe, expect, test } from "bun:test";
import { acpTurnGate } from "../src/lib/acp-turn-gate.js";
import { diagnoseUpdateHostCompat, type UpdateHostCompatInput, type UpdateHostEvidence } from "../src/lib/update-host-compat.js";

const identity = { agent: "fixture-agent", sessionId: "fixture-session", hostGeneration: "fixture-generation" };
const scope = { identity, observedAt: 100, validUntil: 200 };

function fixture(supported = false): UpdateHostCompatInput {
  return {
    identity: { ...identity }, now: 150,
    evidence: [
      { ...scope, kind: "capability", source: "host-declaration", value: supported ? "supported" : "unsupported" },
      { ...scope, kind: "turn", source: supported ? "turn-query" : "verified-session-state", value: "idle" },
      { ...scope, kind: "session", value: "preserved" },
      { ...scope, kind: "orders", value: "none" },
    ],
  };
}

function changed(kind: UpdateHostEvidence["kind"], patch: Record<string, unknown>, input = fixture()): UpdateHostCompatInput {
  return { ...input, evidence: input.evidence.map((e) => e.kind === kind ? { ...e, ...patch } as UpdateHostEvidence : e) };
}

function missing(kind: UpdateHostEvidence["kind"]): UpdateHostCompatInput {
  const input = fixture();
  return { ...input, evidence: input.evidence.filter((e) => e.kind !== kind) };
}

function blocked(input: unknown, reason: string): void {
  const result = diagnoseUpdateHostCompat(input as UpdateHostCompatInput);
  expect(result).toMatchObject({ status: "blocked", reason, gate: "unchanged", executable: false, recovery: null });
}

describe("host compatibility diagnosis (no controller integration)", () => {
  test("explicit old capability plus independent idle, preservation and no orders only suggests owner recovery", () => {
    expect(diagnoseUpdateHostCompat(fixture())).toEqual({
      mode: "observe", status: "recovery-plan", compatibility: "unsupported", reason: "legacy-recovery-needs-owner",
      advice: "request-owner-controlled-restart", gate: "unchanged", executable: false,
      recovery: { action: "controlled-host-restart", requires: ["owner-approval", "existing-control-path", "revalidate-evidence"] },
    });
    const rejection = changed("capability", { source: "structured-rejection" });
    expect(diagnoseUpdateHostCompat(rejection)).toEqual(diagnoseUpdateHostCompat(fixture()));
  });

  test("supported protocol still defers upgrade permission to the existing gate", () => {
    expect(diagnoseUpdateHostCompat(fixture(true))).toMatchObject({
      status: "compatible", compatibility: "supported", reason: "compatible-idle", advice: "use-existing-gate",
      gate: "unchanged", executable: false, recovery: null,
    });
  });

  test.each(["on", "observe"] as const)("%s mode remains a pure recommendation", (mode) => {
    const input = { ...fixture(), mode };
    const before = JSON.stringify(input);
    const result = diagnoseUpdateHostCompat(input);
    expect(result.mode).toBe(mode);
    expect(result.executable).toBe(false);
    expect(result.gate).toBe("unchanged");
    expect(diagnoseUpdateHostCompat(input)).toEqual(result);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("off ignores evidence without granting permission", () => {
    expect(diagnoseUpdateHostCompat({ ...fixture(), mode: "off" })).toEqual({
      mode: "off", status: "disabled", compatibility: "unknown", reason: "disabled", advice: "none",
      gate: "unchanged", executable: false, recovery: null,
    });
  });

  test.each([false, true])("busy/unknown/active are never recovery candidates (supported=%s)", (supported) => {
    const input = fixture(supported);
    blocked(changed("turn", { value: "busy" }, input), "busy");
    blocked(changed("turn", { value: "unknown" }, input), "turn-unknown");
    blocked(changed("orders", { value: "active" }, input), "active-orders");
    blocked(changed("orders", { value: "unknown" }, input), "orders-unknown");
    blocked(changed("session", { value: "unpreserved" }, input), "session-unpreserved");
    blocked(changed("session", { value: "unknown" }, input), "session-unpreserved");
  });

  test.each([
    ["capability", "capability-unknown"], ["turn", "turn-unknown"],
    ["session", "session-unpreserved"], ["orders", "orders-unknown"],
  ] as const)("missing %s blocks", (kind, reason) => blocked(missing(kind), reason));

  test("no explicit old-protocol fact means unknown, regardless of error/version/description", () => {
    const input = { ...missing("capability"), error: "unsupported turn", version: "595a4a2a", description: "legacy idle host" };
    blocked(input, "capability-unknown");
    expect(diagnoseUpdateHostCompat(input).compatibility).toBe("unknown");
    blocked(changed("capability", { value: "unknown" }), "capability-unknown");
    blocked(changed("capability", { source: "error-string" }), "invalid-input");
    blocked(changed("capability", { source: "structured-rejection", value: "supported" }), "invalid-input");
  });

  test("unsupported by itself is not safe", () => {
    const input = fixture();
    blocked({ ...input, evidence: [input.evidence[0]] }, "turn-unknown");
  });

  test.each(["agent", "sessionId", "hostGeneration"] as const)("a changed %s invalidates every kind of evidence", (key) => {
    for (const { kind } of fixture().evidence) {
      const result = changed(kind, { identity: { ...identity, [key]: "different" } });
      blocked(result, "identity-mismatch");
      expect(diagnoseUpdateHostCompat(result).compatibility).toBe("unknown");
    }
  });

  test.each([
    { validUntil: 150 }, { validUntil: 149 }, { observedAt: 151 }, { validUntil: 100 },
  ])("stale/future/inverted evidence %j is blocked", (patch) => {
    for (const { kind } of fixture().evidence) blocked(changed(kind, patch), "stale-evidence");
  });

  test("freshness comes from caller validity, without an embedded age threshold", () => {
    expect(diagnoseUpdateHostCompat({ ...fixture(), now: 100 }).status).toBe("recovery-plan");
    const input = fixture();
    const evidence = input.evidence.map((e) => ({ ...e, observedAt: 0, validUntil: 1_000_001 }));
    expect(diagnoseUpdateHostCompat({ ...input, now: 1_000_000, evidence }).status).toBe("recovery-plan");
  });

  test("read failure cannot be explained away as old protocol or successful idle", () => {
    const input = fixture();
    blocked({ ...input, evidence: [...input.evidence, { ...scope, kind: "read", value: "failed" }] }, "read-failed");
  });

  test("duplicate facts are idempotent; conflicting facts never pick the last or first", () => {
    const input = fixture();
    expect(diagnoseUpdateHostCompat({ ...input, evidence: [...input.evidence, ...input.evidence] })).toEqual(diagnoseUpdateHostCompat(input));
    for (const [kind, value] of [["capability", "supported"], ["turn", "busy"], ["session", "unpreserved"], ["orders", "active"]] as const) {
      const other = changed(kind, { value }).evidence.find((e) => e.kind === kind)!;
      for (const evidence of [[...input.evidence, other], [other, ...input.evidence]]) blocked({ ...input, evidence }, "conflicting-evidence");
    }
    blocked(changed("turn", { source: "turn-query" }), "conflicting-evidence");
    blocked({ ...input, evidence: [...input.evidence, { ...input.evidence[0]!, validUntil: 149 }] }, "stale-evidence");
  });

  test("runtime validation fails closed with bounded collections/identifiers", () => {
    for (const input of [null, undefined, [], 1, "idle", {}, { ...fixture(), mode: "invalid" }, { ...fixture(), mode: null }, { ...fixture(), evidence: null }]) {
      blocked(input, "invalid-input");
    }
    for (const now of [NaN, Infinity, -1, 1.5, "150", Number.MAX_SAFE_INTEGER + 1]) blocked({ ...fixture(), now }, "invalid-input");
    for (const value of ["", " ", "x".repeat(257), null, 3]) {
      for (const key of ["agent", "sessionId", "hostGeneration"]) blocked({ ...fixture(), identity: { ...identity, [key]: value } }, "invalid-input");
    }
    for (const patch of [{ kind: "invalid" }, { observedAt: NaN }, { validUntil: Infinity }, { value: true }, { source: null }, { identity: null }]) {
      blocked(changed("capability", patch), "invalid-input");
    }
    blocked({ ...fixture(), evidence: Array(4) }, "invalid-input");
    blocked({ ...fixture(), evidence: Array(33).fill(fixture().evidence[0]) }, "invalid-input");
  });

  test("output never echoes identities, argv, machine paths, or raw failure text", () => {
    const secret = "/private/fixture/credential --token=fixture-secret";
    const input = fixture();
    const privateIdentity = { agent: secret, sessionId: secret, hostGeneration: secret };
    const privateInput = { ...input, identity: privateIdentity, argv: secret, error: secret,
      evidence: input.evidence.map((e) => ({ ...e, identity: privateIdentity, error: secret })) };
    expect(diagnoseUpdateHostCompat(privateInput)).toEqual(diagnoseUpdateHostCompat(input));
    expect(JSON.stringify(diagnoseUpdateHostCompat(privateInput))).not.toContain(secret);
    const failure = { ...privateInput, evidence: [...privateInput.evidence, { ...scope, identity: privateIdentity, kind: "read", value: "failed", error: secret }] };
    blocked(failure, "read-failed");
    expect(JSON.stringify(diagnoseUpdateHostCompat(failure as UpdateHostCompatInput))).not.toContain(secret);
  });

  test("diagnostic recovery does not alter the legacy gate's fail-closed behavior", async () => {
    const gate = acpTurnGate({ query: async () => ({ turns: { old: "unknown", modern: "idle", busy: "busy" } }),
      notify: async () => { throw new Error("no notifications expected without update key"); }, log: () => undefined });
    diagnoseUpdateHostCompat(fixture());
    expect(await gate(["old", "modern", "busy"])).toEqual(["old", "busy"]);
  });
});

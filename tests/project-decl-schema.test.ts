import { describe, expect, test } from "bun:test";
import { parseProjectDeclaration, parseProjectJson, remoteIdentity } from "../src/lib/project-decl-schema.js";
import { fixture } from "./project-decl-fixtures.test.js";

describe("closed version 1 schema", () => {
  test("safe references round-trip, environment values and authority are rejected at every depth", () => {
    const { declaration: d } = fixture();
    expect(parseProjectDeclaration(d).declaration).toEqual(d);
    for (const env of [{ CI: "value" }, { CI: { value: "not-a-reference" } }, { "BAD-NAME": { from: "CI" } }, { CI: { from: "BAD-NAME" } }]) {
      const raw = structuredClone(d) as any; raw.validation.author[0].env = env;
      expect(parseProjectDeclaration(raw).declaration).toBeNull();
    }
    for (const field of ["authorization", "ownerApproved", "permissions", "policy", "allow"]) {
      const raw = structuredClone(d) as any; raw.verification.probes[0][field] = true;
      expect(parseProjectDeclaration(raw).declaration).toBeNull();
    }
  });
  test("invalid argv, cwd, timeout, versions and provenance fail with structured diagnostics", () => {
    const { declaration: d } = fixture();
    const commands = [{ argv: [] }, { argv: [""] }, { argv: ["bad\nargument"] }, { cwd: "/outside" }, { cwd: "a/../b" },
      { cwd: "a\\b" }, { timeoutSec: 0 }, { timeoutSec: 86401 }, { timeoutSec: 0.5 },
      { provenance: { status: "verified" } }, { provenance: { status: "verified", verifiedHead: "x", verifiedAt: "never" } }];
    for (const change of commands) {
      const raw = structuredClone(d); Object.assign(raw.validation.author[0], change);
      expect(parseProjectDeclaration(raw).declaration).toBeNull();
    }
    expect(parseProjectDeclaration({ ...d, version: 99 }).diagnostics[0].reasonCode).toBe("UNKNOWN_VERSION");
    expect(parseProjectDeclaration({ ...d, version: undefined }).declaration).toBeNull();
  });
  test("ambiguous duplicate ids, basis and capability path separators are rejected", () => {
    const { declaration: d } = fixture();
    const duplicate = structuredClone(d); duplicate.validation.author.push(duplicate.validation.author[0]);
    expect(parseProjectDeclaration(duplicate).declaration).toBeNull();
    const basis = structuredClone(d); basis.basis.push(basis.basis[0]); expect(parseProjectDeclaration(basis).declaration).toBeNull();
    const collision = structuredClone(d); collision.tests.rules[0].id = "suite.classifier";
    expect(parseProjectDeclaration(collision).declaration).toBeNull();
  });
  test("duplicate JSON keys, including escaped names, cannot select policy by parser order", () => {
    expect(() => parseProjectJson('{"version":2,"version":1}')).toThrow("AMBIGUOUS_JSON");
    expect(() => parseProjectJson('{"ci":{"provider":"none","provider":"github"}}')).toThrow("AMBIGUOUS_JSON");
    expect(() => parseProjectJson('{"version":1,"ver\\u0073ion":1}')).toThrow("AMBIGUOUS_JSON");
    expect(parseProjectJson('{"a":[{"x":"quoted\\\"value"}],"b":{"x":true}}')).toEqual({ a: [{ x: 'quoted"value' }], b: { x: true } });
  });
  test("remote identities support other Git hosts without credentials or URL ambiguity", () => {
    const d = fixture().declaration; d.ci.provider = "gitlab";
    expect(parseProjectDeclaration(d).declaration?.ci.provider).toBe("gitlab");
    expect(remoteIdentity("https://github.com/fixtures/python.git")).toBe("fixtures/python");
    expect(remoteIdentity("git@github.com:fixtures/python.git")).toBe("fixtures/python");
    expect(remoteIdentity("https://code.example/team/service.git")).toBe("code.example/team/service");
    expect(remoteIdentity("git@code.example:team/service.git")).toBe("code.example/team/service");
    expect(remoteIdentity("https://user@code.example/team/service.git")).toBeNull();
    expect(remoteIdentity("https://code.example/team/service.git?x=y")).toBeNull();
  });
});

import { expect, test } from "bun:test";
import { scrubSharedLedger, SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.js";
import { parseSharedLedgerCommand } from "../src/lib/shared-ledger-contract-validation.js";
import { fakeCommand } from "./shared-ledger-client.test.js";
const context = { identity: { username: "fake-user", hostname: "fake-host" }, knownSecrets: ["obviously-fake-secret"] };
test("sensitive originals and undeclared fields refuse without echoing values", () => {
  for (const value of ["sk-FAKEFAKEFAKEFAKEFAKE", "203.0.113.42", "fake@example.invalid", "+1 555 010 1234",
    "/Users/fake-user/project", "/srv/fake-project", "C:\\fake-user\\project", "obviously-fake-secret", "fake-host", "s k - FAKEFAKEFAKEFAKEFAKE"]) {
    try { scrubSharedLedger({ ...fakeCommand, description: value }, parseSharedLedgerCommand, context); throw new Error("should reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(SharedLedgerScrubError);
      expect((error as Error).message).toContain("$.description");
      expect((error as Error).message).not.toContain(value);
    }
  }
  for (const field of ["sessionId", "tmux", "acp", "registry", "chat", "env", "privateKey", "token", "cookie", "notificationRoute",
    "docsDir", "scheduler_sessions", "lendJournal", "extra", "obviously-fake-secret"]) {
    try { scrubSharedLedger({ ...fakeCommand, [field]: "fake private value" }, parseSharedLedgerCommand, context); }
    catch (error) { expect((error as Error).message).toBe("upload blocked at $.<undeclared>"); continue; }
    throw new Error("should reject");
  }
  expect(scrubSharedLedger(fakeCommand, parseSharedLedgerCommand, context)).toEqual(fakeCommand);
});

test("short identity names use case-insensitive word boundaries", () => {
  const identity = { identity: { username: "he", hostname: "fake-host" } };
  expect(scrubSharedLedger({ ...fakeCommand, title: "The plan" }, parseSharedLedgerCommand, identity)).toMatchObject({ title: "The plan" });
  for (const description of ["owner he", "owner HE", "HE", "<fake-HOST>", "/Users/he/private"]) {
    expect(() => scrubSharedLedger({ ...fakeCommand, description }, parseSharedLedgerCommand, identity)).toThrow("$.description");
  }
});

test("relative repository globs remain valid and empty identities fail closed", () => {
  const command = { type: "dag.init" as const, projectId: "fake-project", featureId: "fake-feature", requestId: "fake-init", expectedRev: 1,
    baseVersion: 0, reason: "The plan", nodes: [{ key: "A", oneLine: "Build", deps: [], estimate: "S", fileGlobs: ["src/**/file.ts", "**/test.ts"] }] };
  expect(scrubSharedLedger(command, parseSharedLedgerCommand, context)).toEqual(command);
  expect(() => scrubSharedLedger(fakeCommand, parseSharedLedgerCommand, { identity: { username: "", hostname: "" } })).toThrow("<identity>");
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECOVERY_KEYS } from "../src/lib/recovery-policy.js";
import { teamBodyMode } from "../src/lib/team-body-switch.js";

const dir = mkdtempSync(join(tmpdir(), "team-body-switch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const policy = (content: unknown): string => {
  const path = join(dir, `recovery-policy-${n++}.json`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};

describe("teamBodyMode", () => {
  test("teamBody is a recovery key", () => {
    expect(RECOVERY_KEYS).toContain("teamBody");
  });
  test("not configured reads observe: no file, no project entry, no key", () => {
    expect(teamBodyMode("proj-1", join(dir, "missing.json"))).toBe("observe");
    expect(teamBodyMode("proj-1", policy({ projects: {} }))).toBe("observe");
    expect(teamBodyMode("proj-1", policy({ projects: { other: { keys: { teamBody: "on" } } } }))).toBe("observe");
    expect(teamBodyMode("proj-1", policy({ projects: { "proj-1": { keys: { audit: "on" } } } }))).toBe("observe");
  });
  test("configured on / off / observe is returned as written", () => {
    for (const mode of ["on", "off", "observe"] as const) {
      expect(teamBodyMode("proj-1", policy({ projects: { "proj-1": { keys: { teamBody: mode } } } }))).toBe(mode);
    }
  });
  test("the key wins over the project's mode, which is the fallback", () => {
    expect(teamBodyMode("proj-1", policy({ projects: { "proj-1": { mode: "on", keys: { teamBody: "off" } } } }))).toBe("off");
    expect(teamBodyMode("proj-1", policy({ projects: { "proj-1": { mode: "off", keys: { teamBody: "on" } } } }))).toBe("on");
    expect(teamBodyMode("proj-1", policy({ projects: { "proj-1": { mode: "on" } } }))).toBe("on");
  });
  test("an unreadable or invalid policy file reads off", () => {
    expect(teamBodyMode("proj-1", policy("{ not json"))).toBe("off");
    expect(teamBodyMode("proj-1", policy({ projects: { "proj-1": { keys: { teamBody: "yes" } } } }))).toBe("off");
  });
});

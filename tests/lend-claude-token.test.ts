import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, statSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeTokenPath, claudeTokenStatus, readClaudeLendToken, saveClaudeToken } from "../src/lib/lend-claude-token.js";
import { claudeLendSlots } from "../src/lib/lend-claude-worker-capacity.js";
import type { LendEntry } from "../src/lib/lend-config.js";
const root = mkdtempSync("/tmp/c3t-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("file-first hot reload, clear suppresses legacy env, private modes and status", async () => {
  const env = { CLAUDESTRA_STATE_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "fake-legacy" };
  const path = claudeTokenPath(env);
  const entry = { families: { claude: 3 } } as LendEntry;
  expect(readClaudeLendToken(env)).toBe("fake-legacy");
  expect(claudeLendSlots(entry, env)).toBe(3);
  const status = await saveClaudeToken("fake-secret-cl3", path);
  expect(readClaudeLendToken(env)).toBe("fake-secret-cl3");
  expect(claudeLendSlots(entry, env)).toBe(3);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  expect(status).toEqual(claudeTokenStatus(path));
  expect(JSON.stringify(status)).not.toContain("fake-secret-cl3");
  await saveClaudeToken(null, path);
  const logs: string[] = [];
  expect(claudeLendSlots(entry, env, (s) => logs.push(s))).toBe(0);
  expect(JSON.stringify(logs)).not.toContain("fake-secret-cl3");
  expect(readFileSync(path, "utf8")).not.toContain("fake-secret-cl3");
});

test("unreadable, malformed and symlink credentials fail closed instead of legacy fallback", async () => {
  const { chmodSync, mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
  const env = { CLAUDESTRA_STATE_DIR: join(root, "unsafe"), CLAUDE_CODE_OAUTH_TOKEN: "fake-legacy" };
  const path = claudeTokenPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "fake-invalid-json", { mode: 0o600 });
  expect(readClaudeLendToken(env)).toBeUndefined();
  await saveClaudeToken("fake-private", path);
  chmodSync(path, 0o644);
  expect(readClaudeLendToken(env)).toBeUndefined();
  rmSync(path);
  const target = join(root, "target");
  writeFileSync(target, JSON.stringify({ token: "fake-target", savedAt: "2026" }), { mode: 0o600 });
  symlinkSync(target, path);
  expect(readClaudeLendToken(env)).toBeUndefined();
  await saveClaudeToken("fake-new", path);
  expect(readFileSync(target, "utf8")).toContain("fake-target");
  expect(readClaudeLendToken(env)).toBe("fake-new");
});

test("saved token stays out of worker command, argv and launch configuration", async () => {
  const { buildLendClaudeCommand, removeClaudeWorkerConfig } = await import("../src/lib/lend-claude-worker.js");
  const { readdirSync } = await import("node:fs");
  const env = { CLAUDESTRA_STATE_DIR: join(root, "worker-state"), CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), PATH: "/usr/bin:/bin" };
  const secret = "fake-file-worker-secret";
  await saveClaudeToken(secret, claudeTokenPath(env));
  const workerRoot = join(root, "worker-config");
  const name = "agent-lend-cl3-test";
  try {
    const command = buildLendClaudeCommand({ mode: "new", cwd: root, agentName: name, callerCredFile: join(root, "fake-cred"),
      sessionId: "fake-session", channelId: "fake-channel", bridgeUrl: "ws://fixture.invalid:24983" }, { base: env, root: workerRoot, bin: "/fake/claude", authRoot: join(root, "auth") });
    expect(command).not.toContain(secret);
    const dir = join(workerRoot, name, readdirSync(join(workerRoot, name))[0]);
    const plan = readFileSync(join(dir, "launch.json"), "utf8");
    expect(plan).not.toContain(secret);
    expect(JSON.parse(plan).argv.join(" ")).not.toContain(secret);
  } finally { removeClaudeWorkerConfig(name, workerRoot); }
});

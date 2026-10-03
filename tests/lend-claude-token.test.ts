/** setup-token 下线后的旧数据：存过的 token 文件、调度服务环境里的 CLAUDE_CODE_OAUTH_TOKEN 都不会让 worker 改用 token 启动，也不影响位数。 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTokenPath } from "../src/lib/lend-claude-token.js";
import { claudeLendSlots, noteClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { buildLendClaudeCommand, removeClaudeWorkerConfig, type ClaudeWorkerPlan } from "../src/lib/lend-claude-worker.js";
import type { LendEntry } from "../src/lib/lend-config.js";

afterEach(() => noteClaudeReadiness(null));

test("旧 token 文件和环境变量都在：启动计划照样用出借方 HOME，不带 token；位数只看本机登录", () => {
  const root = mkdtempSync(join(tmpdir(), "cl4-old-"));
  const name = "agent-lend-cl4old";
  const secret = "fake-legacy-cl4";
  try {
    const env = { CLAUDESTRA_STATE_DIR: root, HOME: join(root, "owner"), PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: `${secret}-env` };
    mkdirSync(join(root, "lend-credentials"), { mode: 0o700 });
    writeFileSync(claudeTokenPath(env), JSON.stringify({ token: secret, savedAt: new Date(0).toISOString() }), { mode: 0o600 });
    const workers = join(root, "workers");
    const command = buildLendClaudeCommand({ mode: "new", cwd: root, agentName: name, callerCredFile: join(root, "fake-cred"),
      channelId: "test", bridgeUrl: "ws://127.0.0.1:9", sessionId: "550e8400-e29b-41d4-a716-446655440000" }, { base: env, root: workers, bin: "/fake/claude" });
    expect(command).not.toContain(secret);
    const run = join(workers, name, readdirSync(join(workers, name))[0]!);
    const raw = readFileSync(join(run, "launch.json"), "utf8");
    expect(raw).not.toContain(secret);
    expect((JSON.parse(raw) as ClaudeWorkerPlan).env.HOME).toBe(env.HOME);
    removeClaudeWorkerConfig(name, workers);
    const entry = { families: { claude: 2 } } as LendEntry;
    noteClaudeReadiness({ ready: false, reason: "本机 Claude Code 没登录", at: Date.now() });
    expect(claudeLendSlots(entry, () => {})).toBe(0); // 有旧 token 也不顶替本机登录
    noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
    expect(claudeLendSlots(entry)).toBe(2);
    expect(readFileSync(claudeTokenPath(env), "utf8")).toContain(secret); // 不自动删用户文件
  } finally { rmSync(root, { recursive: true, force: true }); }
});

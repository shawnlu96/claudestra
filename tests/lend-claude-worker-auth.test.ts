import { afterEach, expect, test } from "bun:test";
import { claudeAuthOutput } from "../src/lib/lend-claude-pause-auth.js";
import { claudeLendSlots, CLAUDE_REASONS, noteClaudeReadiness, probeClaudeLend, refreshClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import type { LendEntry } from "../src/lib/lend-config.js";

afterEach(() => noteClaudeReadiness(null));
const quota = async () => ({ observedAt: null, full: null, resetsAt: null });
const fake = (code: string) => Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code], {
  stdin: "ignore", stdout: "pipe", stderr: "ignore",
});

test("loggedIn:true 但真实子进程 exit 1：不可用且原因明确，不读额度", async () => {
  const proc = fake('console.log(JSON.stringify({loggedIn:true})); process.exit(1)');
  let readQuota = false;
  const r = await refreshClaudeReadiness(() => probeClaudeLend({ status: () => claudeAuthOutput(proc, 2000),
    quota: async () => { readQuota = true; return quota(); } }));
  expect(r).toMatchObject({ ready: false, reason: CLAUDE_REASONS.nonzero });
  expect(readQuota).toBe(false);
  expect(claudeLendSlots({ families: { claude: 2 } } as LendEntry)).toBe(0);
});

test("子进程已打印 loggedIn:true 但不退出：超时、杀掉进程、零位", async () => {
  const proc = fake('console.log(JSON.stringify({loggedIn:true})); setInterval(() => {}, 1000)');
  const r = await refreshClaudeReadiness(() => probeClaudeLend({ status: () => claudeAuthOutput(proc, 80), quota }));
  expect(r).toMatchObject({ ready: false, reason: CLAUDE_REASONS.timeout });
  expect(await proc.exited).not.toBe(0);
  expect(claudeLendSlots({ families: { claude: 2 } } as LendEntry)).toBe(0);
});

test("成功退出的 loggedIn:true、额度未知：可用", async () => {
  const proc = fake('console.log(JSON.stringify({loggedIn:true}))');
  expect(await probeClaudeLend({ status: () => claudeAuthOutput(proc, 2000), quota })).toBeNull();
});

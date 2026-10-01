/**
 * 测试一律用临时状态目录：lib/paths.ts 在加载时读 CLAUDESTRA_STATE_DIR，不隔离的话 recordMetric、
 * cron、config 之类会往真实的 ~/.claude-orchestrator 里写（用量统计、交接记录都会被测试数据污染）。
 * 已经显式设了就尊重（手动指定 / 子进程测试）。检查默认路径的用例在子进程里去掉这个变量再验。
 * 没加载本文件时（仓库外目录跑、绝对路径跑）由 lib/test-guard.ts 按 NODE_ENV=test 兜底。
 */
import { mkdtempSync } from "node:fs";
import { afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutoloadedEnvUnguarded } from "../src/lib/env-file.ts";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { TEST_FLAG } from "../src/lib/test-guard.ts";
import { installTestTmpRoot } from "./test-tmp-root.ts";

// Bun's test runner skips process exit events on completion; a preload afterAll runs once after all files' hooks.
// It also waits for the background stale-root sweep, which a short run would otherwise abandon mid-listing.
// The generous timeout covers listing a tmpdir that still holds ~10^6 leftovers; a timeout would fail the run.
const tmpRoot = installTestTmpRoot();
try {
  afterAll(async () => {
    try {
      await tmpRoot.swept;
    } finally {
      tmpRoot.cleanup();
    }
  }, { timeout: 15 * 60_000 });
} catch (error) {
  // Outside the runner (`bun --preload ... -e`) the pending sweep keeps the event loop alive and the exit hook cleans up.
  if (!(error instanceof Error) || !error.message.includes("Cannot use afterAll() outside of the test runner")) throw error;
}

// Bun 从 cwd 自动加载的 .env / .env.test（在主仓库根跑时就是线上配置）：值和文件里一样的键都删掉，
// 免得频道号、token、中继地址被测试当成自己的。只删同值的，终端显式 export 成别的值的照留。
for (const dir of new Set([process.cwd(), REPO_ROOT])) {
  for (const [k, v] of Object.entries(readAutoloadedEnvUnguarded(dir))) if (process.env[k] === v) delete process.env[k];
}

process.env[TEST_FLAG] = "1";
if (!process.env.CLAUDESTRA_STATE_DIR) process.env.CLAUDESTRA_STATE_DIR = mkdtempSync(join(tmpdir(), "cstra-test-state-"));

// bridge 一律指向没人听的端口，无条件：agent 会话里本来就带着 BRIDGE_URL，没设时默认又是线上的 3847，
// 漏注入依赖的用例会把消息真发给线上 bridge。频道号 / token 也清掉，免得身份被当成跑测试的那个 agent。
// 需要这些值的用例自己显式设（子进程测试照样继承这里的值）。
process.env.BRIDGE_URL = "ws://127.0.0.1:9";
process.env.BRIDGE_PORT = "9";
for (const k of ["CONTROL_CHANNEL_ID", "DISCORD_CHANNEL_ID", "DISCORD_BOT_TOKEN", "BRIDGE_CONTROL_TOKEN"]) delete process.env[k];

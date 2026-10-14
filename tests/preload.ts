/**
 * 测试一律用临时状态目录：lib/paths.ts 在加载时读 CLAUDESTRA_STATE_DIR，不隔离的话 recordMetric、
 * cron、config 之类会往真实的 ~/.claude-orchestrator 里写（用量统计、交接记录都会被测试数据污染）。
 * 已经显式设成临时目录下的就尊重（子进程测试）。检查默认路径的用例在子进程里去掉这个变量再验。
 * 没加载本文件时（仓库外目录跑、绝对路径跑）由 lib/test-guard.ts 按 NODE_ENV=test 兜底。
 */
import { afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCiIoTrace } from "../src/lib/ci-io-trace.ts";

// CI_IO_TRACE（merge-arch-SELECT2）：读取记录器得在 node:fs 的 ESM 具名绑定生成之前装上（见 src/lib/ci-io-trace.ts 文件头），
// 所以下面会碰 node:fs 的依赖都改成装完再动态 import；静态导入的只有不碰 node:fs 的几个
installCiIoTrace();
// 直接敲的全量 `bun test` 也过本机全量测试闸（docs/architecture/full-test-gate.md）：要排队就交给 scripts/test.ts 监管、本进程等它退出；
// CI、带文件、经 scripts/test.ts 起的（带许可标记）原样往下走。放在最前面：交出去时本进程什么都还没动
await (await import("../src/lib/full-test-gate-preload.ts")).gateDirectBunTest();
const { mkdtempSync } = await import("node:fs");
const { readAutoloadedEnvUnguarded } = await import("../src/lib/env-file.ts");
const { REPO_ROOT } = await import("../src/lib/repo-root.ts");
const { LEND_WORKER_MARK } = await import("../src/lib/runtimes/clean-env.ts");
const { TEST_FLAG, testSafeStateDir } = await import("../src/lib/test-guard.ts");
const { installTestTmpRoot } = await import("./test-tmp-root.ts");

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
process.env.CLAUDESTRA_STATE_DIR ||= mkdtempSync(join(tmpdir(), "cstra-test-state-"));
// 继承来的不在临时目录下（出借执行者的会话带着生产目录）就换掉。运行目录由 lib/paths.ts 加载时经 test-guard 换
testSafeStateDir(process.env.CLAUDESTRA_STATE_DIR);

// bridge 一律指向没人听的端口，无条件：agent 会话里本来就带着 BRIDGE_URL，没设时默认又是线上的 3847，
// 漏注入依赖的用例会把消息真发给线上 bridge。频道号 / token 也清掉，免得身份被当成跑测试的那个 agent。
// 需要这些值的用例自己显式设（子进程测试照样继承这里的值）。CLAUDESTRA_AGENT 同理：Pi / Codex agent 的 shell 带着它，台账身份会认它。
// LEND_WORKER_MARK 同理：出借 worker 的 shell 带着它，起 manager.ts 子进程按 owner 写临时台账的用例会被一律拒成 forbidden，
// 本地结果和 CI 对不上。只清 bun test 进程里的；状态目录上面已换成临时的，生产拒绝逻辑不变，要验拒绝的用例自己显式设。
process.env.BRIDGE_URL = "ws://127.0.0.1:9";
process.env.BRIDGE_PORT = "9";
for (const k of ["CONTROL_CHANNEL_ID", "DISCORD_CHANNEL_ID", "CLAUDESTRA_AGENT", "DISCORD_BOT_TOKEN", "BRIDGE_CONTROL_TOKEN", LEND_WORKER_MARK]) delete process.env[k];

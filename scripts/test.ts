// `bun run test` / `bun run check` 的测试入口：全量 bun test 先经本机全量测试闸拿名额（同时最多 N 个，docs/architecture/full-test-gate.md），
// 带文件 / 路径的直接透传；CI（CI=true / GITHUB_ACTIONS=true）不读策略、不碰闸，与直接 `bun test` 逐字一致。
import { fullTestGateDir } from "../src/lib/full-test-gate-policy.ts";
import { runFullTestGate } from "../src/lib/full-test-gate.ts";

const args = process.argv.slice(2);
process.exit(await runFullTestGate({ args, command: [process.execPath, "test", ...args], env: process.env, dir: fullTestGateDir() }));

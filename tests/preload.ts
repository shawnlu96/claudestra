/**
 * 测试一律用临时状态目录：lib/paths.ts 在加载时读 CLAUDESTRA_STATE_DIR，不隔离的话 recordMetric、
 * cron、config 之类会往真实的 ~/.claude-orchestrator 里写（用量统计、交接记录都会被测试数据污染）。
 * 已经显式设了就尊重（手动指定 / 子进程测试）。检查默认路径的用例在子进程里去掉这个变量再验。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CLAUDESTRA_STATE_DIR) process.env.CLAUDESTRA_STATE_DIR = mkdtempSync(join(tmpdir(), "cstra-test-state-"));

// bridge 一律指向没人听的端口，无条件：agent 会话里本来就带着 BRIDGE_URL，没设时默认又是线上的 3847，
// 漏注入依赖的用例会把消息真发给线上 bridge。频道号 / token 也清掉，免得身份被当成跑测试的那个 agent。
// 需要这些值的用例自己显式设（子进程测试照样继承这里的值）。
process.env.BRIDGE_URL = "ws://127.0.0.1:9";
process.env.BRIDGE_PORT = "9";
for (const k of ["CONTROL_CHANNEL_ID", "DISCORD_CHANNEL_ID", "DISCORD_BOT_TOKEN", "BRIDGE_CONTROL_TOKEN"]) delete process.env[k];

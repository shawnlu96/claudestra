/**
 * 测试一律用临时状态目录：lib/paths.ts 在加载时读 CLAUDESTRA_STATE_DIR，不隔离的话 recordMetric、
 * cron、config 之类会往真实的 ~/.claude-orchestrator 里写（用量统计、交接记录都会被测试数据污染）。
 * 已经显式设了就尊重（手动指定 / 子进程测试）。检查默认路径的用例在子进程里去掉这个变量再验。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CLAUDESTRA_STATE_DIR) process.env.CLAUDESTRA_STATE_DIR = mkdtempSync(join(tmpdir(), "cstra-test-state-"));

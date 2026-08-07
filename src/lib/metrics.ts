/**
 * 轻量 metrics 记录
 *
 * 存储：~/.claude-orchestrator/metrics.jsonl（append-only）
 * 每条 { ts, event, channelId?, agent?, duration_ms?, count?, meta? }
 *
 * Bridge/manager 在关键事件发生时调 recordMetric()。
 * 聚合查询由 readMetrics(filter) + 上层算出汇总。
 */

import { existsSync } from "fs";
import { mkdir, appendFile } from "fs/promises";

const HOME = process.env.HOME || "";
const METRICS_DIR = `${HOME}/.claude-orchestrator`;
const METRICS_PATH = `${METRICS_DIR}/metrics.jsonl`;

export type MetricEvent =
  | "bridge_start"
  | "message_in"        // Discord → agent
  | "message_out"       // agent → Discord (via reply tool)
  | "slash_invoked"     // Discord slash command
  | "modal_button"      // TUI modal 按钮点击
  | "agent_completed"   // Stop hook 触发
  | "agent_interrupt"   // Ctrl+C 发出
  | "agent_clear"       // 远程 /clear 清空会话
  | "auq_submit"        // AskUserQuestion 回传（提交）
  | "auq_cancel"        // AskUserQuestion 回传（取消）
  | "auq_detect"        // v2.17.2+ AskUserQuestion 检测（meta.source: pane/jsonl）
  | "agent_wedged"      // wedge watcher 报警
  | "error"
  | "cron_run"
  | "api_slash"                 // Web slash 直通注入
  | "claude_defaults_updated"   // 全局默认模型/effort 变更
  // v2.11+ HTTP peer(Discord peer 系列事件已随机制移除)
  | "http_peer_out_ok"
  | "http_peer_out_error"
  | "http_peer_out_timeout"
  // 长期在用但一直漏在 union 外的事件(bun build 不查类型,2026-07-20 审计补齐)
  | "message_dropped"
  | "agent_exited"
  | "agent_link_down"
  | "agent_pushback"
  | "agent_pushback_drain"
  | "agent_pushback_drain_silent"
  | "bg_activity_started"
  | "bg_activity_completed"
  | "bridge_start_cleanup"
  | "doppelganger_detected"
  | "ia_watchdog_nudge"
  | "reply_cross_agent_forward"
  // Stop 时检出原生 /clear 类 session 轮转并自动重绑（2026-07-23）
  | "session_selfheal"
  // per-会话模型/effort 切换端点（2026-07-23）
  | "agent_claude_updated"
  // v2.11.1+ web peer 管理端点（invite/join/accept/scope/remove，2026-07-24）
  | "peer_managed";

export interface MetricRecord {
  ts: string;                   // ISO 8601
  event: MetricEvent;
  channelId?: string;
  agent?: string;
  durationMs?: number;
  meta?: Record<string, any>;
}

let writePromise: Promise<void> = Promise.resolve();

async function ensureDir() {
  if (!existsSync(METRICS_DIR)) {
    await mkdir(METRICS_DIR, { recursive: true });
  }
}

/**
 * 记录一条 metric。不阻塞调用方（写入在后台 chain 中）。
 * 失败静默（metrics 不该影响主流程）。
 */
export function recordMetric(
  event: MetricEvent,
  fields: Omit<MetricRecord, "ts" | "event"> = {}
): void {
  const rec: MetricRecord = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  const line = JSON.stringify(rec) + "\n";
  writePromise = writePromise
    .then(async () => {
      await ensureDir();
      await appendFile(METRICS_PATH, line).catch(() => {});
    })
    .catch(() => {});
}

/**
 * 读取所有 metrics 记录（可选按时间戳过滤）。
 * 文件不存在返回空。
 */
export async function readMetrics(sinceTs = 0): Promise<MetricRecord[]> {
  if (!existsSync(METRICS_PATH)) return [];
  const text = await Bun.file(METRICS_PATH).text();
  const out: MetricRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as MetricRecord;
      if (sinceTs > 0) {
        const ts = new Date(rec.ts).getTime();
        if (!Number.isFinite(ts) || ts < sinceTs) continue;
      }
      out.push(rec);
    } catch { /* skip bad line */ }
  }
  return out;
}

export { METRICS_PATH };

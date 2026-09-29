/**
 * 统一派单的定时扫描（T48）：每分钟看一眼台账里还有没有没收到回执的派单，有才经 runManager 跑 `ledger dispatch-sweep`
 * （失败退避重发、认回执、送达 15 分钟没回执 / 连着送不出去就记一条 note）；sweep 返回的提醒由这里直接投给那张卡的 PM。
 * bridge 对台账只读，写全在 CLI（同 ledger-audit-service.ts）；提醒丢了（PM 不在线）不补发，那条 note 留在卡上。
 */
import type { ServerWebSocket } from "bun";
import { LedgerReader } from "../lib/ledger-read.js";
import { listDispatches } from "../lib/ledger-dispatch-log.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";

const INTERVAL_MS = 60_000;

interface Client { ws: ServerWebSocket<unknown>; channelId: string; cwd?: string }
type Notice = { taskId: string; pm: string | null; text: string };

export interface DispatchSweepDeps {
  clients: Map<string, Client>;
  deliver: (env: Envelope) => Promise<unknown>;
  runManager: (...args: string[]) => Promise<any>;
  /** 单测注入：有没有待扫的派单；不给 = 读台账 */
  hasOpen?: () => boolean;
}

const reader = new LedgerReader();
const hasOpenDispatches = (): boolean => {
  const db = reader.get();
  return !!db && listDispatches(db).length > 0;
};

async function notifyPm(d: DispatchSweepDeps, n: Notice): Promise<void> {
  const channelId = n.pm ? readRegistryAgentsSync().find((a) => a.name === n.pm)?.channelId : undefined;
  const client = channelId ? d.clients.get(channelId) : undefined;
  if (!n.pm || !channelId || !client) {
    console.warn(`[dispatch-sweep] ${n.taskId} 的提醒没投出去（PM ${n.pm ?? "未知"} 不在线），已记在卡上`);
    return;
  }
  await d.deliver({
    from: { kind: "bridge", label: "ledger-dispatch" },
    to: { kind: "local", channelId, ws: client.ws, cwd: client.cwd, agentName: n.pm },
    intent: "notification",
    content: n.text,
    meta: { messageId: newMessageId("dispatch"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle: true },
  });
}

/** 跑一轮；出错只记日志（下一分钟再来） */
export async function sweepOnce(d: DispatchSweepDeps): Promise<void> {
  if (!(d.hasOpen ?? hasOpenDispatches)()) return;
  try {
    const r = await d.runManager("ledger", "dispatch-sweep");
    for (const n of (Array.isArray(r?.notices) ? r.notices : []) as Notice[]) await notifyPm(d, n);
  } catch (e) {
    console.warn(`[dispatch-sweep] 这一轮失败: ${(e as Error).message}`);
  }
}

export function startDispatchSweeper(d: DispatchSweepDeps): void {
  let running = false;
  setInterval(() => {
    if (running) return; // 上一轮还在投（对方慢），这一轮跳过，不叠加
    running = true;
    void sweepOnce(d).finally(() => (running = false));
  }, INTERVAL_MS).unref?.();
}

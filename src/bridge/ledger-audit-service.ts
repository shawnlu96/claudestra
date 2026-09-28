/**
 * 台账巡检的定时器（T29，docs/architecture/ledger-audit.md）：每 15 分钟经 runManager 跑 `ledger audit --json`，
 * 把新出现、还没推过的异常按收件人合成一条通知，投递成功（含押后）再 `--ack`。bridge 对台账只读，写全在 CLI；
 * 去重靠 audit_findings 的 notifiedAt，所以 bridge 重启不重推、收件人不在线下一轮再推。
 * 不抢占：收件人主回合在跑 / 压缩中就放进押后队列，回合结束随其它排队消息一起到（bridge 通知本身不押，回合开头有丢弃窗口）。
 */
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import { auditNoticeText } from "../lib/ledger-audit.js";
import type { StoredFinding } from "../lib/ledger-audit-store.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { agentMsgMustWait } from "../lib/turn-state.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";
import { probeTurn } from "./turn-probe.js";

const INTERVAL_MS = 15 * 60_000;
/** 启动后多久跑第一轮：给 channel-server 重连留时间，否则收件人都算不在线 */
const FIRST_DELAY_MS = 90_000;
const AUDIT_CMD = `bun ${join(REPO_ROOT, "src/manager.ts")} ledger audit`;

interface Client { ws: ServerWebSocket<unknown>; channelId: string; cwd?: string }
type Outcome = { outcome?: { kind?: string } } | undefined;

export interface LedgerAuditDeps {
  clients: Map<string, Client>;
  deliver: (env: Envelope) => Promise<unknown>;
  hold: (env: Envelope) => void;
  lastMessageSource: { set(channelId: string, src: "agent"): unknown };
  runManager: (...args: string[]) => Promise<any>;
  /** 单测注入：判收件人忙不忙；不给 = 抓屏 + 事件态（bridge/turn-probe.ts） */
  busy?: (channelId: string, agent: string) => Promise<boolean>;
  /** 单测注入：agent → 频道；不给 = 读 registry */
  channelOf?: (agent: string) => string | undefined;
}

/** 推一条；收件人不在线、deliver 报 error / dropped 都算没推出去（不 ack，下一轮再推） */
async function notify(d: LedgerAuditDeps, to: string, list: readonly StoredFinding[]): Promise<boolean> {
  const channelId = d.channelOf ? d.channelOf(to) : readRegistryAgentsSync().find((a) => a.name === to)?.channelId;
  const client = channelId ? d.clients.get(channelId) : undefined;
  if (!channelId || !client) return false;
  const env: Envelope = {
    from: { kind: "bridge", label: "ledger-audit" },
    to: { kind: "local", channelId, ws: client.ws, cwd: client.cwd, agentName: to },
    intent: "notification",
    content: auditNoticeText(list, AUDIT_CMD),
    meta: { messageId: newMessageId("audit"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
  };
  d.lastMessageSource.set(channelId, "agent"); // bridge 发的：PM 处理完的 Stop 不去 @ owner
  const busy = d.busy ?? (async (ch, agent) => agentMsgMustWait(await probeTurn(ch, agent, process.env.CONTROL_CHANNEL_ID || "")));
  if (await busy(channelId, to)) {
    d.hold(env);
    return true;
  }
  const kind = ((await d.deliver(env)) as Outcome)?.outcome?.kind;
  return kind !== "error" && kind !== "dropped";
}

/** 跑一轮（导出给单测）；同一时刻只跑一轮，上一轮没完就跳过 */
export function ledgerAuditTicker(d: LedgerAuditDeps): () => Promise<void> {
  let running = false;
  let failing = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const r = await d.runManager("ledger", "audit", "--json");
      if (!r?.ok) throw new Error(String(r?.error ?? "ledger audit 失败"));
      const byTo = new Map<string, StoredFinding[]>();
      for (const f of (r.pending ?? []) as StoredFinding[]) if (f.notify) byTo.set(f.notify, [...(byTo.get(f.notify) ?? []), f]);
      const sent: string[] = [];
      for (const [to, list] of byTo) if (await notify(d, to, list)) sent.push(...list.map((f) => f.key));
      if (sent.length) {
        const a = await d.runManager("ledger", "audit", "--ack", sent.join(","));
        if (!a?.ok) throw new Error(`ack 失败（下一轮会重推）：${String(a?.error ?? "")}`);
        console.log(`🔎 台账巡检：推出 ${sent.length} 条（${[...byTo.keys()].join(", ")}）`);
      }
      if (failing) console.log("🔎 台账巡检恢复");
      failing = false;
    } catch (e) {
      if (!failing) console.error(`⚠️ 台账巡检出错（恢复前不再重复报）: ${(e as Error).message}`);
      failing = true;
    } finally {
      running = false;
    }
  };
}

let started = false;

/** bridge 启动时调一次 */
export function startLedgerAudit(d: LedgerAuditDeps): void {
  if (started) return;
  started = true;
  const tick = ledgerAuditTicker(d);
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), INTERVAL_MS).unref?.();
  }, FIRST_DELAY_MS).unref?.();
  console.log(`🔎 台账巡检启动（${FIRST_DELAY_MS / 1000}s 后首轮，之后每 ${INTERVAL_MS / 60_000} 分钟）`);
}

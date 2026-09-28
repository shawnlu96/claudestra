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

type Pending = StoredFinding & { fallback?: string };
type Sent = { kind: "sent" } | { kind: "queued"; messageId: string } | { kind: "failed" };
/** 调度助理连着这么多轮推不出去（不在线 / 投递失败），审查类的就改推 PM */
const FALLBACK_AFTER = 2;

/** 推一条。收件人在忙：进押后队列，返回 queued（投出去之前不算推过）；不在线 / deliver 报 error、dropped = failed */
const channelFor = (d: LedgerAuditDeps, to: string) => (d.channelOf ? d.channelOf(to) : readRegistryAgentsSync().find((a) => a.name === to)?.channelId);
const online = (d: LedgerAuditDeps, to: string) => {
  const ch = channelFor(d, to);
  return !!ch && d.clients.has(ch);
};

async function notify(d: LedgerAuditDeps, to: string, list: readonly StoredFinding[]): Promise<Sent> {
  const channelId = channelFor(d, to);
  const client = channelId ? d.clients.get(channelId) : undefined;
  if (!channelId || !client) return { kind: "failed" };
  const env: Envelope = {
    from: { kind: "bridge", label: "ledger-audit" },
    to: { kind: "local", channelId, ws: client.ws, cwd: client.cwd, agentName: to },
    intent: "notification",
    content: auditNoticeText(list, AUDIT_CMD),
    meta: { messageId: newMessageId("audit"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
  };
  const busy = d.busy ?? (async (ch, agent) => agentMsgMustWait(await probeTurn(ch, agent, process.env.CONTROL_CHANNEL_ID || "")));
  if (await busy(channelId, to)) {
    // 不动 lastMessageSource：PM 这一回合多半在处理 owner 的消息，改成 agent 会让它结束时不 @ owner
    d.hold(env);
    return { kind: "queued", messageId: env.meta.messageId };
  }
  d.lastMessageSource.set(channelId, "agent"); // 空闲时直投：PM 处理完这条的 Stop 不去 @ owner
  const kind = ((await d.deliver(env)) as Outcome)?.outcome?.kind;
  return kind === "error" || kind === "dropped" ? { kind: "failed" } : { kind: "sent" };
}

async function ack(d: LedgerAuditDeps, keys: readonly string[], queuedAs?: string): Promise<void> {
  const a = await d.runManager("ledger", "audit", "--ack", keys.join(","), ...(queuedAs ? ["--queued", queuedAs] : []));
  if (!a?.ok) throw new Error(`ack 失败（下一轮会重推）：${String(a?.error ?? "")}`);
}

/** 跑一轮（导出给单测）；同一时刻只跑一轮，上一轮没完就跳过 */
export function ledgerAuditTicker(d: LedgerAuditDeps): () => Promise<void> {
  let running = false;
  let failing = false;
  /** 收件人 → 连续推不出去的轮数（调度助理不在线时回落用） */
  const misses = new Map<string, number>();
  /** 项目 → 上一轮 skipped 的摘要：变了才打日志，数据源长期取不到时不刷屏也不悄悄停 */
  const lastSkipped = new Map<string, string>();
  const logSkipped = (projects: { project: string; skipped?: { rule: string; reason: string }[] }[]) => {
    for (const p of projects) {
      const sig = (p.skipped ?? []).map((x) => `${x.rule}：${x.reason}`).join("；");
      if ((lastSkipped.get(p.project) ?? "") !== sig) console.log(`🔎 台账巡检 ${p.project}：${sig ? `这些规则没跑——${sig}` : "所有规则恢复运行"}`);
      lastSkipped.set(p.project, sig);
    }
  };
  const recipientOf = (f: Pending) => {
    const to = f.notify as string;
    return f.fallback && (misses.get(to) ?? 0) >= FALLBACK_AFTER ? f.fallback : to;
  };
  return async () => {
    if (running) return;
    running = true;
    try {
      const r = await d.runManager("ledger", "audit", "--json");
      if (!r?.ok) throw new Error(String(r?.error ?? "ledger audit 失败"));
      logSkipped(r.projects ?? []);
      for (const to of [...misses.keys()]) if (online(d, to)) misses.delete(to); // 调度助理回来了：审查类的推回给它
      const byTo = new Map<string, Pending[]>();
      for (const f of (r.pending ?? []) as Pending[]) if (f.notify) byTo.set(recipientOf(f), [...(byTo.get(recipientOf(f)) ?? []), f]);
      let n = 0;
      for (const [to, list] of byTo) {
        const res = await notify(d, to, list);
        const keys = list.map((f) => f.key);
        if (res.kind === "failed") {
          const m = (misses.get(to) ?? 0) + 1;
          misses.set(to, m);
          if (m === FALLBACK_AFTER && list.some((f) => f.fallback)) console.log(`🔎 台账巡检：${to} 连续 ${m} 轮推不出去，审查类提醒改推 PM`);
          continue;
        }
        misses.delete(to);
        await ack(d, keys, res.kind === "queued" ? res.messageId : undefined);
        n += keys.length;
      }
      if (n) console.log(`🔎 台账巡检：推出 ${n} 条（${[...byTo.keys()].join(", ")}）`);
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

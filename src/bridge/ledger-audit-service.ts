/**
 * 台账巡检的定时器（T29，docs/architecture/ledger-audit.md）：每 15 分钟经 runManager 跑 `ledger audit --json`，
 * 把新出现、还没推过的异常按收件人合成一条通知，投递成功（含押后）再 `--ack`。bridge 对巡检结果只读，写全在 CLI（PULLTODO1 的 pm_todo / 观察记录例外，见下）；
 * 去重靠 audit_findings 的 notifiedAt，所以 bridge 重启不重推、收件人不在线下一轮再推。
 * 不抢占：收件人主回合在跑 / 压缩中就放进押后队列，回合结束随其它排队消息一起到（bridge 通知本身不押，回合开头有丢弃窗口）。
 * PULLTODO1（恢复键 pmTodoPull，lib/pm-todo-audit.ts）：发给当班 PM 的发现 on 时只记 pm-todo 条目（经 recordPmTodo 写本机台账）再 ack，不 deliver；
 * observe 照旧推送并记一条观察；off 与改前一致。升级（AUDESC1）与巡检自身失败照旧推送（action 级）。
 */
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import { auditNoticeText } from "../lib/ledger-audit.js";
import { auditResult, readAuditFailureTargets, type AuditFailureKind, type AuditFailureTarget } from "../lib/ledger-audit-failure.js";
import { ackRefArg, type StoredFinding } from "../lib/ledger-audit-store.js";
import { executorIdleNote } from "../lib/ledger-audit-snapshot.js";
import { openLedger } from "../lib/ledger-store.js";
import { pmNoticeLevel } from "../lib/pm-notice-level.js";
import { auditTodoPort, type AuditTodoPort } from "../lib/pm-todo-audit.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { agentMsgMustWait } from "../lib/turn-state.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";
import { probeTurn } from "./turn-probe.js";
import { ledgerAuditEscalator } from "./ledger-audit-escalate.js";
import { ledgerAuditFailures, type AuditNoticeIdentity, type AuditNoticeReceipt } from "./ledger-audit-failure.js";

const INTERVAL_MS = 15 * 60_000;
/** 启动后多久跑第一轮：给 channel-server 重连留时间，否则收件人都算不在线 */
const FIRST_DELAY_MS = 90_000;
/** 通知末尾给收件人的查看命令：--dry-run 谁都能跑、只读；不带它的写入只有 owner / master 能跑（PM 会被拒） */
const AUDIT_CMD = `bun ${join(REPO_ROOT, "src/manager.ts")} ledger audit --dry-run`;

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
  /** 单测注入：当前受巡检项目及当班 PM；生产从规范只读台账解析 */
  failureTargets?: () => AuditFailureTarget[];
  /** 单测注入：pmTodoPull 开关与 pm-todo 写口；不给 = 恢复策略 + 本机台账 */
  pmTodo?: AuditTodoPort;
  /** 单测注入：executor_idle 补的两个时长 + 开工单投递状态（RESTATEGO1）；不给 = 本机台账 + 会话记录 */
  idleNote?: (f: StoredFinding) => Promise<string | null>;
}

type Pending = StoredFinding & { fallback?: string };

/** RESTATEGO1：executor_idle 推送前接上 executorIdleNote；读不到 / 恢复键 off = 原文（推送与 ack 用的 key 不变） */
async function withIdleNotes(d: LedgerAuditDeps, list: Pending[]): Promise<Pending[]> {
  if (!list.some((f) => f.rule === "executor_idle")) return list;
  const opened: { db?: ReturnType<typeof openLedger> } = {};
  const note = d.idleNote ?? ((f: StoredFinding) => executorIdleNote(opened.db ??= openLedger(), f, Date.now()));
  try {
    return await Promise.all(list.map(async (f) => {
      if (f.rule !== "executor_idle") return f;
      const extra = await note(f).catch((e) => { console.error(`⚠️ 台账巡检：${f.taskId} 空闲时长没补上，原文照推：${(e as Error).message}`); return null; });
      return extra ? { ...f, detail: `${f.detail}（${extra}）` } : f;
    }));
  } finally {
    opened.db?.close();
  }
}
type Sent = AuditNoticeReceipt;
/** 调度助理连着这么多轮推不出去（不在线 / 投递失败），审查类的就改推 PM */
const FALLBACK_AFTER = 2;

/** 推一条。收件人在忙：进押后队列，返回 queued（投出去之前不算推过）；不在线 / deliver 报 error、dropped = failed */
const channelFor = (d: LedgerAuditDeps, to: string) => (d.channelOf ? d.channelOf(to) : readRegistryAgentsSync().find((a) => a.name === to)?.channelId);
const online = (d: LedgerAuditDeps, to: string) => {
  const ch = channelFor(d, to);
  return !!ch && d.clients.has(ch);
};

async function notify(d: LedgerAuditDeps, to: string, list: readonly StoredFinding[]): Promise<Sent> {
  return notifyText(d, to, auditNoticeText(list, AUDIT_CMD));
}

async function notifyText(d: LedgerAuditDeps, to: string, content: string, identity?: AuditNoticeIdentity): Promise<Sent> {
  const channelId = channelFor(d, to);
  const client = channelId ? d.clients.get(channelId) : undefined;
  if (!channelId || !client) return { kind: "failed" };
  const env: Envelope = {
    from: { kind: "bridge", label: "ledger-audit" },
    to: { kind: "local", channelId, ws: client.ws, cwd: client.cwd, agentName: to },
    intent: "notification",
    content,
    // waitForIdle 目前只是标记（router.ts），T13a 接进 deliverToLocal 前靠下面自己判忙 + 押后
    meta: { messageId: newMessageId("audit"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId(), ...identity, waitForIdle: true },
  };
  const busy = d.busy ?? (async (ch, agent) => agentMsgMustWait(await probeTurn(ch, agent, process.env.CONTROL_CHANNEL_ID || "")));
  if (await busy(channelId, to)) {
    // 不动 lastMessageSource：PM 这一回合多半在处理 owner 的消息，改成 agent 会让它结束时不 @ owner
    d.hold(env);
    return { kind: "queued", messageId: env.meta.messageId };
  }
  d.lastMessageSource.set(channelId, "agent"); // 空闲时直投：PM 处理完这条的 Stop 不去 @ owner
  const kind = ((await d.deliver(env)) as Outcome)?.outcome?.kind;
  return kind === "sent" ? { kind: "sent" } : { kind: "failed" };
}

/**
 * `--ack` 的参数（X7，形状同 ackEscalateArgs）：每条一个 id = <key>@<取到时的 firstSeen>，第一个是旗标的值，其余放在 `--` 之后；
 * 不用逗号拼（任务 id 里可以有逗号）。--queued 是旗标，得排在 `--` 前面。
 */
export function ackArgs(list: readonly Pick<StoredFinding, "key" | "firstSeen">[], queuedAs?: string): string[] {
  const [first = "", ...rest] = list.map(ackRefArg);
  return ["ledger", "audit", "--ack", first, ...(queuedAs ? ["--queued", queuedAs] : []), ...(rest.length ? ["--", ...rest] : [])];
}

/** 返回真正记成已推（或押后）的条数：过期的那几条不算 */
async function ack(d: LedgerAuditDeps, list: readonly Pending[], queuedAs?: string): Promise<number> {
  const a = await d.runManager(...ackArgs(list, queuedAs));
  if (a?.ok !== true) throw new Error(`ack 失败（下一轮会重推）：${String(a?.error ?? "")}`);
  if (a.stale) console.log(`🔎 台账巡检：${a.stale} 条在投递期间被解决又重新打开，下一轮按新一代再推`);
  return list.length - (Number(a.stale) || 0);
}

/** 跑一轮（导出给单测）；同一时刻只跑一轮，上一轮没完就跳过 */
export function ledgerAuditTicker(d: LedgerAuditDeps): () => Promise<void> {
  let running = false;
  let failing = false;
  const failures = ledgerAuditFailures({
    targets: () => (d.failureTargets ?? readAuditFailureTargets)(),
    notify: (to, content, identity) => notifyText(d, to, content, identity),
  });
  const escalate = ledgerAuditEscalator({ notify: (to, content) => notifyText(d, to, content), runManager: d.runManager }); // AUDESC1
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
  const todo = d.pmTodo ?? auditTodoPort(() => openLedger());
  /** 项目 → 当班 PM（与巡检失败告警同一口径）；读不了 = 空，全按改前推送 */
  const pmsOf = (): Map<string, string> => {
    try { return new Map((d.failureTargets ?? readAuditFailureTargets)().map((t) => [t.project, t.to])); }
    catch (e) { console.error(`⚠️ 台账巡检：读不到当班 PM，本轮照旧推送：${(e as Error).message}`); return new Map(); }
  };
  /** 发给当班 PM 的发现按 pmTodoPull 分：on 只进 pm-todo，observe 照推并记观察；其余（调度助理、PM 读不到）照旧 */
  const pullMode = (f: Pending, to: string, pms: Map<string, string>, modes: Map<string, string>) => {
    if (pms.get(f.project) !== to) return "off";
    if (!modes.has(f.project)) modes.set(f.project, todo.mode(f.project));
    return modes.get(f.project);
  };
  return async () => {
    if (running) return;
    running = true;
    let failureKind: AuditFailureKind = "manager_failed";
    try {
      const raw = await d.runManager("ledger", "audit", "--json");
      if (raw?.ok === false) throw new Error(String(raw?.error ?? "ledger audit 失败"));
      failureKind = "invalid_response";
      const r = auditResult(raw);
      failureKind = "round_failed";
      logSkipped(r.projects ?? []);
      for (const to of [...misses.keys()]) if (online(d, to)) misses.delete(to); // 调度助理回来了：审查类的推回给它
      const byTo = new Map<string, Pending[]>();
      const add = (f: Pending) => byTo.set(recipientOf(f), [...(byTo.get(recipientOf(f)) ?? []), f]);
      const pending = await withIdleNotes(d, ((r.pending ?? []) as Pending[]).filter((f) => f.notify));
      const pms = pending.length ? pmsOf() : new Map<string, string>(), modes = new Map<string, string>();
      const pulled: Pending[] = [], watched: Pending[] = [];
      for (const f of pending) {
        const mode = pullMode(f, recipientOf(f), pms, modes);
        if (mode === "on") pulled.push(f);
        else (mode === "observe" && watched.push(f), add(f));
      }
      let n = 0;
      if (pulled.length) {
        let recorded = false;
        try { todo.record(pulled), recorded = true; }
        catch (e) { console.error(`⚠️ 台账巡检：${pulled.length} 条没记进 pm-todo，照旧推送：${(e as Error).message}`); pulled.forEach(add); }
        if (recorded) {
          const k = await ack(d, pulled);
          console.log(`🔎 台账巡检：${k} 条只进 pm-todo（${[...new Set(pulled.map((f) => f.project))].join(", ")}）`);
        }
      }
      if (watched.length) {
        try { todo.observe(watched); } catch (e) { console.error(`⚠️ 台账巡检：pmTodoPull 观察没记上：${(e as Error).message}`); }
      }
      for (const [to, list] of byTo) {
        const res = await notify(d, to, list);
        if (res.kind === "failed") {
          const m = (misses.get(to) ?? 0) + 1;
          misses.set(to, m);
          if (m === FALLBACK_AFTER && list.some((f) => f.fallback)) console.log(`🔎 台账巡检：${to} 连续 ${m} 轮推不出去，审查类提醒改推 PM`);
          continue;
        }
        misses.delete(to);
        n += await ack(d, list, res.kind === "queued" ? res.messageId : undefined);
      }
      if (n) console.log(`🔎 台账巡检：推出 ${n} 条（${[...byTo.keys()].join(", ")}）`);
      await pmNoticeLevel.run("action", () => escalate(raw)); // AUDESC1：调度助理 60 分钟没处理的升级给 PM（不抛）；action 级，不进 pm-todo
      if (failing) console.log("🔎 台账巡检恢复");
      failing = false;
      failures.ok();
    } catch (e) {
      if (!failing) console.error(`⚠️ 台账巡检出错（恢复前不再重复报）: ${(e as Error).message}`);
      failing = true;
      await pmNoticeLevel.run("action", () => failures.fail(failureKind)); // 巡检自身失败：action 级，照旧推送
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

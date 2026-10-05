/**
 * ACP 回合失败卡（bridge/acp-link.ts，extra.failure = error）该不该推 owner：派单会话的失败由派活方接手——
 * - 调度作者 / 审查员：台账 scheduler_sessions 里 active、会话 = registry 这条的会话、所在任务 auto 且项目 = registry 的 projectId、
 *   最近一张 dispatch/review 单派给它（已认领、角色对得上）还没结果。调度器按这张卡退人工、通知当班 PM（scheduler-auto-ports.ts codexFailure）；
 * - 出借 worker：registry 明写 kind=worker，出借 journal 里它最新那张单在跑（started / result_pending）、会话 = registry 的会话。出借服务据卡停单回执 A。
 * 命中：卡照开（kind / extra.failure / 指纹都不变，调度和出借照常读到），只是 quiet（不卡活 → 不推 owner、不弹横幅，lib/ask-push.ts）。
 * 身份只认 registry 里登记这个频道的那条（宿主帧里没有名字可信），不按名字前缀。读不出来一律不 quiet、留诊断，照原路推 owner。
 * 监护的 quiet（agent-supervisor-bridge.ts failureCardQuiet）另算，两者取或。tests/runtime-failure-audience.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LedgerReader } from "./ledger-read.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { LEND_JOURNAL_PATH } from "./lend-journal.js";
import { isMasterAgent, readRegistryAgentsSync, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { ledgerResult, stepOfNode } from "./scheduler-work-order.js";

export interface AudienceView {
  registry(): RegistryAgent[];
  /** 内置台账（只读）；没有 = null */
  ledger(): Database | null;
  /** 出借 journal 里这个 agent 最新那张单；journal 不在 = null */
  lendOrder(agent: string): { orderId: string; state: string; sessionId: string | null } | null;
}

export type Audience =
  | { quiet: true; who: string; why: string }
  | { quiet: false; diag?: string };

/** 读侧只开只读连接：bridge 不能变成台账 / journal 的写者 */
export function audienceView(paths: { registry?: string; ledger?: string; lend?: string } = {}): AudienceView {
  const reader = new LedgerReader(paths.ledger);
  const lendPath = paths.lend ?? LEND_JOURNAL_PATH;
  return {
    registry: () => readRegistryAgentsSync(paths.registry ?? REGISTRY_PATH),
    ledger: () => reader.get(),
    lendOrder(agent) {
      if (!existsSync(lendPath)) return null;
      const db = new Database(lendPath, { readonly: true });
      try {
        db.exec("PRAGMA busy_timeout = 200");
        return db.query("SELECT orderId, state, sessionId FROM lend_orders WHERE agent = ? ORDER BY createdAt DESC LIMIT 1").get(agent) as never;
      } finally { db.close(); }
    },
  };
}

let current: AudienceView | null = null;
/** 单测：换成临时 registry / 台账 / journal 上的读侧；undefined 还原 */
export function setFailureAudienceViewForTest(v: AudienceView | undefined): void {
  current = v ?? null;
}

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

interface IntentRow { id: string; action: string; node: string; status: string; recipient: string | null; head: string | null }

/** 调度派单：台账绑定这个会话、它手上那张单已认领还没结果；归不上 = null */
function schedulerOrder(db: Database, row: RegistryAgent): string | null {
  if (!hasTable(db, "scheduler_sessions") || !hasTable(db, "scheduler_intents")) return null;
  const sessions = db.query("SELECT taskId, role FROM scheduler_sessions WHERE agent = ? AND sessionId = ? AND state = 'active'")
    .all(row.name, row.sessionId!) as { taskId: string; role: "author" | "reviewer" }[];
  for (const s of sessions) {
    const wf = getWorkflow(db, s.taskId);
    if (!wf || wf.mode !== "auto" || wf.project !== row.projectId) continue; // 退回人工的归 PM 盯、项目对不上的不认
    const last = db.query(`SELECT i.id, i.action, i.node, i.status, i.recipient, i.head FROM scheduler_intents AS i
      WHERE i.taskId = ? AND i.action IN ('dispatch','review') ORDER BY i.eventSeq DESC LIMIT 1`).get(s.taskId) as IntentRow | null;
    if (!last || last.recipient !== row.name || !["submitted", "done"].includes(last.status)) continue;
    if ((last.action === "review" || last.node === "adversarial_review") !== (s.role === "reviewer")) continue;
    // 与 codexFailure 的 claimedBefore 同一个认领事件：没认领的单，调度器不会把卡归给它
    if (!db.query("SELECT 1 FROM events WHERE dedupKey = ?").get(`scheduler:${last.id}:submitted`)) continue;
    const step = stepOfNode(last.node);
    if (!step) continue;
    const ref = { taskId: s.taskId, role: s.role, agent: row.name, sessionId: row.sessionId!, family: "codex" as const, transport: "acp" as const };
    if (ledgerResult(db, ref, { step, head: last.head, dedupKey: last.id, round: 0 })) continue; // 已交了：之后的失败不归这张单
    return `${s.taskId} ${s.role} 单 ${last.id}`;
  }
  return null;
}

/** 这个频道的回合失败该交给谁：quiet = 派活方接手、不推 owner */
export function failureAudience(channelId: string, view: AudienceView = current ?? (current = audienceView())): Audience {
  try {
    const row = view.registry().find((a) => a.channelId === channelId);
    if (!row || !row.sessionId || row.status === "stopped" || isMasterAgent(row.name)) return { quiet: false };
    const db = view.ledger();
    const order = db ? schedulerOrder(db, row) : null;
    if (order) return { quiet: true, who: row.name, why: `调度派单 ${order}` };
    if (row.kind === "worker") {
      const o = view.lendOrder(row.name);
      if (o && (o.state === "started" || o.state === "result_pending") && o.sessionId === row.sessionId) {
        return { quiet: true, who: row.name, why: `出借单 ${o.orderId}` };
      }
    }
    return { quiet: false };
  } catch (e) {
    return { quiet: false, diag: `读 registry / 台账 / 出借 journal 失败，回合失败卡照原路推 owner：${(e as Error).message}` };
  }
}

/** acp-link 的一行接线：判定并留痕 */
export function dispatchedFailureQuiet(channelId: string): boolean {
  const a = failureAudience(channelId);
  if (a.quiet) console.log(`🔕 回合失败卡不推 owner（${a.who}，${a.why}，派活方接手）`);
  else if (a.diag) console.warn(`⚠️ ${channelId} ${a.diag}`);
  return a.quiet;
}

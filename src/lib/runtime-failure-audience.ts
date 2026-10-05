/**
 * ACP 回合失败卡（bridge/acp-link.ts，extra.failure = error）该不该推 owner：派单会话的失败由派活方接手——
 * - 调度作者 / 审查员：台账 scheduler_sessions 里 active、会话 = registry 这条的会话、所在任务 auto 且项目 = registry 的 projectId、
 *   最近一张 dispatch/review 单派给它（已认领、角色对得上）还没结果。调度器按这张卡退人工、通知当班 PM（scheduler-auto-ports.ts codexFailure）。
 *   失败要证明属于这张单：宿主帧带的 sessionId = registry 的会话、failedAt 不早于这张单的认领（老宿主不带 = 证明不了）。
 * - 出借 worker（registry kind = worker）：出借 journal 里这个 agent 正跑（started）的 Codex 单、会话 = registry 的会话，且
 *   lend-turn-failure.ts turnFailureDoubt 认这次失败是本单当前回合的——与出借服务停单、回执借入方（lend-deps.ts failureOf）同一个判据，
 *   它认得了才静音；它不认（老宿主 / 迟到 / 会话对不上 / 之后又开了回合）就没人接手，照原路推 owner。
 * 命中：卡照开（kind / extra.failure / 指纹 / sessionId / failedAt 都不变，消费方照常读到），只是 quiet（不卡活 → 不推 owner、不弹横幅，lib/ask-push.ts）。
 * 身份只认 registry 里登记这个频道的那条（宿主帧里没有名字可信），不按名字前缀。读不出来（含 registry 损坏：不拿上次的缓存当本次核验）
 * 一律不 quiet、留诊断，照原路推 owner。监护的 quiet（agent-supervisor-bridge.ts failureCardQuiet）另算，两者取或。
 * tests/runtime-failure-audience.test.ts、tests/runtime-failure-audience-wiring.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LedgerReader } from "./ledger-read.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { isMasterAgent, normalizeRegistryAgents, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { ledgerResult, stepOfNode } from "./scheduler-work-order.js";
import { LEND_JOURNAL_PATH, liveOrders, type LendRow } from "./lend-journal.js";
import { turnFailureDoubt } from "./lend-turn-failure.js";
import { findSessionJsonlBySessionId } from "./session-source.js";
import { readJsonStateSync } from "./state-file.js";

export interface AudienceView {
  /** 本次真读到的 registry；读失败 / 损坏要抛（不能退回上次成功值） */
  registry(): RegistryAgent[];
  /** 内置台账（只读）；没有 = null */
  ledger(): Database | null;
  /** 出借 journal 里这个 agent 正跑（started）的单；没有 journal / 没有这单 = null；读坏要抛 */
  lendOrder(agent: string): LendRow | null;
  /** Codex 会话的 rollout 路径（判失败之后有没有再开回合）；找不到 = null */
  sessionPath(sessionId: string): string | null;
}

/** 宿主报的失败归属：哪个会话、什么时刻（老宿主不带） */
export interface FailureAt { sessionId?: string; failedAt?: number }

export type Audience =
  | { quiet: true; who: string; why: string }
  | { quiet: false; diag?: string };

/** 读侧只开只读连接：bridge 不能变成台账的写者 */
export function audienceView(paths: { registry?: string; ledger?: string; lend?: string } = {}): AudienceView {
  const reader = new LedgerReader(paths.ledger);
  const registryPath = paths.registry ?? REGISTRY_PATH;
  const lendPath = paths.lend ?? LEND_JOURNAL_PATH;
  return {
    registry() {
      const r = readJsonStateSync(registryPath);
      if (r.status === "missing") return [];
      if (r.status !== "ok") throw new Error(`registry 读不出来：${r.error}`);
      return normalizeRegistryAgents(r.data);
    },
    ledger: () => reader.get(),
    lendOrder(agent) {
      if (!existsSync(lendPath)) return null;
      const db = new Database(lendPath, { readonly: true });
      try {
        return liveOrders(db).find((r) => r.agent === agent && r.state === "started") ?? null; // 同 lend-claude-pause-worker.ts lendWorkerFailureOf
      } finally { db.close(); }
    },
    sessionPath: (id) => findSessionJsonlBySessionId("codex", id),
  };
}

let current: AudienceView | null = null;
/** 单测：换成临时 registry / 台账上的读侧；undefined 还原 */
export function setFailureAudienceViewForTest(v: AudienceView | undefined): void {
  current = v ?? null;
}

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

interface IntentRow { id: string; action: string; node: string; status: string; recipient: string | null; head: string | null }

/** 调度派单：台账绑定这个会话、它手上那张单已认领还没结果；归不上 = null。claimedAt = 认领事件时刻 */
function schedulerOrder(db: Database, row: RegistryAgent): { label: string; claimedAt: number } | null {
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
    const claim = db.query("SELECT ts FROM events WHERE dedupKey = ?").get(`scheduler:${last.id}:submitted`) as { ts: number } | null;
    if (!claim) continue;
    const step = stepOfNode(last.node);
    if (!step) continue;
    const ref = { taskId: s.taskId, role: s.role, agent: row.name, sessionId: row.sessionId!, family: "codex" as const, transport: "acp" as const };
    if (ledgerResult(db, ref, { step, head: last.head, dedupKey: last.id, round: 0 })) continue; // 已交了：之后的失败不归这张单
    return { label: `${s.taskId} ${s.role} 单 ${last.id}`, claimedAt: claim.ts };
  }
  return null;
}

/** 出借 worker：出借服务认得这次失败（会停单、回执借入方）才静音；认不了照原路推，留诊断 */
function lendAudience(row: RegistryAgent, failedAt: number, view: AudienceView): Audience {
  const order = view.lendOrder(row.name);
  if (!order || order.family !== "codex" || order.sessionId !== row.sessionId) return { quiet: false };
  const doubt = turnFailureDoubt({ extra: { failure: "error", sessionId: row.sessionId, failedAt } }, order, view.sessionPath);
  if (doubt) return { quiet: false, diag: `出借单 ${order.orderId} 的回合失败出借服务认不了（${doubt}），照原路推 owner` };
  return { quiet: true, who: row.name, why: `出借单 ${order.orderId}（出借服务停单并回执借入方）` };
}

/** 这个频道的回合失败该交给谁：quiet = 派活方接手、不推 owner */
export function failureAudience(channelId: string, at: FailureAt, view: AudienceView = current ?? (current = audienceView())): Audience {
  try {
    const row = view.registry().find((a) => a.channelId === channelId);
    if (!row || !row.sessionId || row.status === "stopped" || isMasterAgent(row.name)) return { quiet: false };
    // 归不到当前会话的失败（老宿主没报会话 / 时刻、换过会话的迟到帧）：不知道是谁的，照原路推
    if (at.sessionId !== row.sessionId || typeof at.failedAt !== "number" || !Number.isFinite(at.failedAt)) return { quiet: false };
    if (row.kind === "worker") return lendAudience(row, at.failedAt, view); // 上一行已核 at.sessionId = row.sessionId
    const db = view.ledger();
    const order = db ? schedulerOrder(db, row) : null;
    if (!order) return { quiet: false };
    if (at.failedAt < order.claimedAt) return { quiet: false }; // 失败早于这张单的认领：上一轮的迟到帧，不替它静音
    return { quiet: true, who: row.name, why: `调度派单 ${order.label}` };
  } catch (e) {
    return { quiet: false, diag: `读 registry / 台账失败，回合失败卡照原路推 owner：${(e as Error).message}` };
  }
}

/** acp-link 的一行接线：判定并留痕 */
export function dispatchedFailureQuiet(channelId: string, at: FailureAt): boolean {
  const a = failureAudience(channelId, at);
  if (a.quiet) console.log(`🔕 回合失败卡不推 owner（${a.who}，${a.why}，派活方接手）`);
  else if (a.diag) console.warn(`⚠️ ${channelId} ${a.diag}`);
  return a.quiet;
}

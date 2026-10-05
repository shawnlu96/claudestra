/**
 * Stalled manual cards (dispatch-recovery-MANUAL): a workflow-manual card with no event for longer than the owner's manualAfterMs
 * gets one prepared PM / owner action card per state version (task rev, workflow rev, last card event; changed evidence re-sends).
 * Normal waits (open ask, order in flight, deps), explicit holds (PM / owner hold, paused feature) and a frozen queue are never a
 * stall. This mechanism never hands a card back itself: a merge-revoked card with every proof is handed back by the existing
 * autoResumeTick (`ledger scheduler-auto-resume`); one still manual past the threshold gets a PM card instead, and PM's
 * workflow-resume and any owner approval stay with them. The claim re-reads the card and re-decides in its transaction (a freeze /
 * hold / ask that lands after the read means no card); a send in flight in this process is never re-sent, and the notice key
 * handed to notify is stable per version + evidence so the delivery side can drop a cross-process repeat. Policy comes through
 * CFG's port; missing = observe, broken = off, a null threshold only observes. observe never writes. tests/recovery-manual*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { blockedBy, depViews } from "./ledger-deps.js";
import { getFeature } from "./ledger-feature.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { busyAsLedgerError, getEventByDedup, getMeta, getTask, listDeps, listEvents, listTasks } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { ServiceFacts } from "./scheduler-autostart.js";
import { MERGE_RETRY_PREFIX, resumeVerdict, serviceBlock, type ResumeVerdict } from "./scheduler-autostart-resume.js";
import { openSafetyHold } from "./scheduler-review-swap.js";

/** CFG's policy value; manualAfterMs null = the owner has not set a threshold, so nothing is ever judged stalled. */
export interface RecoveryPolicy { mode: "on" | "observe" | "off"; manualAfterMs: number | null }
/** CFG's recoveryPolicy(project, mechanism) narrowed to this mechanism; the full signature over every key is assignable. */
export type ManualStallPolicyPort = (project: string, mechanism: "manualStall") => RecoveryPolicy;

export function manualStallPolicy(port: ManualStallPolicyPort | undefined, project: string): RecoveryPolicy & { diag: string | null } {
  if (!port) return { mode: "observe", manualAfterMs: null, diag: "未注入恢复策略 port（CFG 未接线），按 observe" };
  let p: RecoveryPolicy;
  try { p = port(project, "manualStall"); } catch (e) {
    return { mode: "off", manualAfterMs: null, diag: `读恢复策略失败，按 off：${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  const ms = p?.manualAfterMs;
  const valid = ["on", "observe", "off"].includes(p?.mode) && (ms === null || (typeof ms === "number" && Number.isFinite(ms) && ms >= 0));
  return valid ? { mode: p.mode, manualAfterMs: ms, diag: null } : { mode: "off", manualAfterMs: null, diag: `恢复策略返回值不合法，按 off：${JSON.stringify(p)}`.slice(0, 300) };
}

// ── facts ──

/** Waiting classes are never a stall; the others can be, once idle past the threshold. */
const WAITING = ["frozen", "held", "approval_wait", "external_wait", "deps_wait"] as const;
const STALLABLE = ["merge_revoked", "pm_takeover", "provider_refusal", "pm_manual", "unknown_origin"] as const;
export type ManualClass = (typeof WAITING)[number] | (typeof STALLABLE)[number];
export const isWaiting = (c: ManualClass): boolean => (WAITING as readonly string[]).includes(c);

const CLASS_WORD: Record<ManualClass, string> = {
  frozen: "项目队列冻结", held: "owner / PM 计划暂停", approval_wait: "审批等待", external_wait: "外部结果等待", deps_wait: "前置等待",
  merge_revoked: "合并撤销后待交回", pm_takeover: "PM 故障接管", provider_refusal: "provider 拒绝", pm_manual: "PM 人工推进", unknown_origin: "来历不明的 manual",
};

export interface ManualFacts {
  project: string; taskId: string; stage: LedgerTask["stage"]; agent: string | null; taskRev: number; workflowRev: number;
  /** last event on the card itself: any author / PM / scheduler step resets the clock */
  lastSeq: number; lastTs: number; lastActor: string | null;
  cls: ManualClass; why: string;
  /** the event that put the card in manual (takeover / fallback / merge resolve / hold), null when none is on record */
  origin: { seq: number; op: string; reason: string } | null;
  unknownIntents: string[];
  resume: ResumeVerdict;
  /** service / switch refusal for an automatic hand-back; null = the switches allow it */
  block: string | null;
}

const MODE_OPS = new Set(["merge_resolve", "deploy_resolve", "fallback_manual", "workflow_resume"]);
const originOf = (e: LedgerEvent) => ({ seq: e.seq, op: String(e.data.op),
  reason: String(e.data.takeover ?? e.data.hold ?? e.data.reason ?? e.data.outcome ?? e.text).slice(0, 300) });

/** What the last mode change says about who owns the card now; template-only manual→manual edits do not count. */
function originClass(events: readonly LedgerEvent[]): { cls: ManualClass; origin: ManualFacts["origin"]; why: string } {
  const t = events.findLast((e) => e.kind === "scheduler" && (MODE_OPS.has(String(e.data.op))
    || (e.data.op === "workflow" && (e.data.mode !== "manual" || !!e.data.takeover || !!e.data.hold))));
  if (!t) {
    const set = events.find((e) => e.kind === "scheduler" && e.data.op === "workflow" && e.data.mode === "manual");
    return set ? { cls: "pm_manual", origin: originOf(set), why: "流程一开始就设为 manual，由 PM 推进" }
      : { cls: "unknown_origin", origin: null, why: "台账里找不到切 manual 的事件" };
  }
  const o = originOf(t);
  if (t.data.op === "workflow" && t.data.hold) return { cls: "held", origin: o, why: `明确留在人工：${o.reason}` };
  if ((t.data.op === "merge_resolve" && (t.data.outcome === "cancelled" || t.data.outcome === "failed"))
    || (t.data.op === "fallback_manual" && String(t.data.reason ?? "").startsWith(MERGE_RETRY_PREFIX))) return { cls: "merge_revoked", origin: o, why: `合并撤销：${o.reason}` };
  if (t.data.takeover || t.data.op === "fallback_manual") return { cls: "pm_takeover", origin: o, why: `转人工：${o.reason}` };
  return { cls: "unknown_origin", origin: o, why: `最近的切换是 ${o.op}，与 manual 现状对不上` };
}

/** One manual card's facts, or null when it is not a live workflow-manual card. */
function readManualFacts(db: Database, taskId: string, svc: ServiceFacts): ManualFacts | null {
  const task = getTask(db, taskId), wf = task ? getWorkflow(db, taskId) : null;
  if (!task || !wf || wf.mode !== "manual" || task.stage === "done" || task.stage === "cancelled") return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  const last = events.at(-1);
  const intents = db.query("SELECT id, status FROM scheduler_intents WHERE taskId = ? AND status IN ('submitted','unknown')").all(task.id) as { id: string; status: string }[];
  const asks = db.query("SELECT id FROM asks WHERE taskId = ? AND state = 'open'").all(task.id) as { id: string }[];
  const blocked = blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project))).map((d) => d.from);
  const feature = task.featureId ? getFeature(db, task.featureId) : null;
  const hold = openSafetyHold(events);
  const o = originClass(events);
  const pick = (): Pick<ManualFacts, "cls" | "why"> => {
    const frozen = getMeta(db, task.project).queueFrozen;
    if (frozen.frozen) return { cls: "frozen", why: frozen.reason || "项目合并队列冻结" };
    if (o.cls === "held") return o;
    if (feature?.status === "paused") return { cls: "held", why: `feature ${feature.id} 已暂停` };
    if (asks.length) return { cls: "approval_wait", why: `待审批 ask：${asks.map((a) => a.id).join("、")}` };
    const out = intents.filter((i) => i.status === "submitted");
    if (out.length) return { cls: "external_wait", why: `在途意图：${out.map((i) => i.id).join("、")}` };
    if (blocked.length) return { cls: "deps_wait", why: `等待前置任务：${blocked.join("、")}` };
    // After every normal wait: a refusal record with an approval ask / order / dep still pending is that wait, not an unattended refusal.
    if (hold) return { cls: "provider_refusal", why: `模型安全拒绝留证 #${hold.seq} 未处置：${hold.text}`.slice(0, 300) };
    return o;
  };
  return { project: task.project, taskId: task.id, stage: task.stage, agent: task.agent ?? null, taskRev: task.rev, workflowRev: wf.rev,
    lastSeq: last?.seq ?? 0, lastTs: last?.ts ?? wf.updatedAt, lastActor: last?.actor ?? null, ...pick(), origin: o.origin,
    unknownIntents: intents.filter((i) => i.status === "unknown").map((i) => i.id), resume: resumeVerdict(db, task, wf), block: serviceBlock(db, task, svc) };
}

// ── decision (pure) ──

export interface ActionCard {
  taskId: string; project: string; cls: ManualClass; audience: "pm" | "owner";
  stage: string; agent: string | null; idleMs: number; lastSeq: number; lastActor: string | null;
  /** state version the card was prepared for; the fingerprint adds the evidence */
  version: string; fingerprint: string;
  origin: ManualFacts["origin"];
  evidence: string[];
  step: string;
  /** the formal command the addressee would run, with this version's revs filled in; null = no single command fits */
  command: string | null;
}

export type ManualDecision =
  | { kind: "wait"; why: string }
  | { kind: "fresh"; why: string }
  | { kind: "card"; card: ActionCard };

const stateVersion = (f: Pick<ManualFacts, "taskRev" | "workflowRev" | "lastSeq">): string => `t${f.taskRev}:w${f.workflowRev}:e${f.lastSeq}`;

const resumeCmd = (f: ManualFacts) => `ledger workflow-resume ${f.taskId} --rev ${f.taskRev} --workflow-rev ${f.workflowRev} --reason <核对结论>`;

/** The concrete next step for a stalled card; never an approval, never a choice the addressee has not made. */
function nextStep(f: ManualFacts): Pick<ActionCard, "audience" | "step" | "command"> {
  if (f.unknownIntents.length) {
    return { audience: "pm", step: `先对账结果不明的意图 ${f.unknownIntents.join("、")}（核外部结果后 scheduler-settle），对完再推进本卡`, command: `ledger scheduler-settle ${f.unknownIntents[0]} …` };
  }
  if (f.cls === "provider_refusal") {
    return { audience: "owner", step: "看拒绝留证与材料，决定换审 / 豁免（豁免须 owner 自己批准）/ 放弃；处置后解除留证。系统不重试、不代批", command: null };
  }
  if (f.cls === "merge_revoked") {
    if (f.resume.ok && !f.block) {
      return { audience: "pm", step: "交回证明齐全、开关允许，过了阈值仍是 manual：既有自动交回（scheduler-auto-resume）没有交回成功（多半被台账拒绝，见当时给 PM 的自动交回通知）；PM 对完账后手动交回", command: resumeCmd(f) };
    }
    if (f.resume.ok) return { audience: "pm", step: `交回证明齐全，但开关不允许自动交回（${f.block}）；由 PM 核对后手动交回，或 owner 决定开开关`, command: resumeCmd(f) };
    const who = f.agent ?? "执行者";
    return { audience: "pm", step: `交回条件未满足（${f.resume.why}）：催 ${who} 在 ${f.stage} 交付新 head，或 PM 改派 / 取消本卡`, command: null };
  }
  if (f.cls === "pm_takeover") {
    return { audience: "pm", step: `PM 接管后卡停在 ${f.stage}：推进本阶段（执行者 ${f.agent ?? "未指定"}），或核对接管原因已消除后交回自动`, command: resumeCmd(f) };
  }
  if (f.cls === "pm_manual") return { audience: "pm", step: `人工推进的卡停在 ${f.stage}：PM 推进本阶段或改派 / 取消`, command: null };
  return { audience: "pm", step: "找不到可信的转人工来历，系统不自动交回；PM 核对卡的来历后决定推进、交回或取消", command: null };
}

/** Pure: is this card stalled under the policy, and what card follows. A null threshold or a waiting class is never a stall. */
export function decideManual(f: ManualFacts, policy: RecoveryPolicy, now: number): ManualDecision {
  if (isWaiting(f.cls)) return { kind: "wait", why: `${CLASS_WORD[f.cls]}：${f.why}` };
  if (policy.manualAfterMs === null) return { kind: "fresh", why: "owner 未设 manualAfterMs 阈值，只观察、不判停滞" };
  const idleMs = Math.max(0, now - f.lastTs);
  if (idleMs < policy.manualAfterMs) return { kind: "fresh", why: `${idleMs}ms 无新事件，未到阈值 ${policy.manualAfterMs}ms` };
  const n = nextStep(f);
  const evidence = [`${CLASS_WORD[f.cls]}：${f.why}`, f.origin ? `转人工事件 #${f.origin.seq}（${f.origin.op}）：${f.origin.reason}` : "无转人工事件",
    `最近事件 #${f.lastSeq}${f.lastActor ? `（${f.lastActor}）` : ""}，${Math.floor(idleMs / 60_000)} 分钟无新事件`,
    f.resume.ok ? `交回证明：合并撤销 #${f.resume.facts.trigger}，新交付 #${f.resume.facts.deliver}` : `交回判定：${f.resume.why}`,
    ...(f.block ? [`开关：${f.block}`] : []), ...(f.unknownIntents.length ? [`结果不明意图：${f.unknownIntents.join("、")}`] : [])];
  const version = stateVersion(f);
  const fingerprint = createHash("sha256").update(JSON.stringify([f.taskId, version, f.cls, n.audience, n.step, evidence.filter((e) => !/分钟无新事件/.test(e))]))
    .digest("hex").slice(0, 16);
  return { kind: "card", card: { taskId: f.taskId, project: f.project, cls: f.cls, stage: f.stage, agent: f.agent, idleMs,
    lastSeq: f.lastSeq, lastActor: f.lastActor, version, fingerprint, origin: f.origin, evidence, ...n } };
}

export function actionCardText(c: ActionCard): string {
  return [`【manual 停滞 · 给 ${c.audience === "owner" ? "owner" : "PM"}】${c.taskId}（${c.project}）[${CLASS_WORD[c.cls]}] 阶段 ${c.stage}，执行者 ${c.agent ?? "未指定"}`,
    `下一步：${c.step}`, ...(c.command ? [`命令：${c.command}`] : []), "证据：", ...c.evidence.map((e) => `- ${e}`),
    `状态版本 ${c.version} · 指纹 ${c.fingerprint}（同版本同证据只提醒一次）`].join("\n");
}

// ── tick ──

const manualStallKey = (c: Pick<ActionCard, "taskId" | "version" | "fingerprint">): string => `recovery:manualStall:${c.taskId}:${c.version}:${c.fingerprint}`;
/** Unsent claims (send threw, process died) retry after 5 min, doubling, capped at 6 h; a sent card never re-sends. */
export const manualStallRetryAfter = (claims: number): number => Math.min(6 * 3600_000, 5 * 60_000 * 2 ** Math.max(0, claims - 1));

export interface ManualStallDeps {
  db: Database;
  now: number;
  svc: ServiceFacts;
  policy?: ManualStallPolicyPort;
  /** noticeKey is the same for every attempt at one version + evidence: the delivery side drops a key it has already delivered */
  notify(project: string, audience: "pm" | "owner", text: string, noticeKey: string): Promise<void>;
}

export type ManualStallOutcome =
  | { project: string; mode: "off"; diag: string | null }
  | { project: string; taskId: string; mode: "observe" | "on"; diag: string | null; cls: ManualClass;
    action: "none" | "would_notify" | "notified" | "deduped" | "retry_wait" | "raced" | "failed"; why: string; card?: ActionCard };

/** Claims for this card version so far (attempt n ≥ 2 is `key#n`) and when the last one was made. */
function claims(db: Database, key: string): { n: number; lastTs: number } {
  const r = db.query("SELECT COUNT(*) AS n, MAX(ts) AS ts FROM events WHERE dedupKey = ? OR substr(dedupKey, 1, ?) = ?")
    .get(key, key.length + 1, `${key}#`) as { n: number; ts: number | null };
  return { n: r.n, lastTs: r.ts ?? 0 };
}

type Claim = { ok: true; attempt: number } | { ok: false; action: "deduped" | "retry_wait" | "raced"; why: string };

/**
 * Re-read the card, re-decide and claim this attempt in one immediate transaction: a card that moved since the read (rev / workflow
 * rev / new event) or whose decision changed (frozen, held, an ask, an order out — none of which bump the revs) is raced, a sent
 * version is deduped, and two ticks racing on one version claim it once (the dedup key is UNIQUE).
 */
function claimNotice(d: ManualStallDeps, f: ManualFacts, card: ActionCard, policy: RecoveryPolicy): Claim {
  return busyAsLedgerError("写入", () => d.db.transaction((): Claim => {
    const cur = readManualFacts(d.db, f.taskId, d.svc);
    if (!cur || stateVersion(cur) !== card.version) return { ok: false, action: "raced", why: "卡在读和认领之间被改过，下一轮重读" };
    const again = decideManual(cur, policy, d.now);
    if (again.kind !== "card" || again.card.fingerprint !== card.fingerprint) {
      return { ok: false, action: "raced", why: `读和认领之间判定变了（${again.kind === "card" ? "证据变了" : again.why}），下一轮重读` };
    }
    const key = manualStallKey(card);
    const sent = getEventByDedup(d.db, `${key}:sent`);
    if (sent) return { ok: false, action: "deduped", why: `同一状态版本与证据已提醒过（#${sent.seq}）` };
    const c = claims(d.db, key);
    if (c.n && d.now - c.lastTs < manualStallRetryAfter(c.n)) return { ok: false, action: "retry_wait", why: `第 ${c.n} 次发送未确认送达，等退避` };
    const attempt = c.n + 1;
    const r = appendEvent(d.db, { actor: "scheduler", dedupKey: attempt === 1 ? key : `${key}#${attempt}`, now: d.now }, { project: f.project, target: "", kind: "note",
      text: `manual 停滞行动卡：${f.taskId}${attempt > 1 ? `（第 ${attempt} 次发送）` : ""}`, data: { recovery: { op: "manualStall", ...cardData(card), attempt } } });
    return r.duplicate ? { ok: false, action: "deduped", why: `另一路已认领（#${r.event.seq}）` } : { ok: true, attempt };
  }).immediate());
}

const cardData = (c: ActionCard) => ({ taskId: c.taskId, cls: c.cls, audience: c.audience, version: c.version, fingerprint: c.fingerprint, step: c.step,
  command: c.command, originSeq: c.origin?.seq ?? null, lastSeq: c.lastSeq });

/** Notice keys whose send is still out in this process (the scheduler tick runs under one lease holder). */
const IN_FLIGHT = new Set<string>();

type Live = Extract<ManualStallOutcome, { taskId: string }>;

async function onCard(d: ManualStallDeps, f: ManualFacts, policy: RecoveryPolicy & { diag: string | null }): Promise<Live> {
  const base = { project: f.project, taskId: f.taskId, mode: policy.mode as "observe" | "on", diag: policy.diag, cls: f.cls };
  const decision = decideManual(f, policy, d.now);
  if (decision.kind !== "card") return { ...base, action: "none", why: decision.why };
  const { card } = decision, text = actionCardText(card), key = manualStallKey(card);
  if (policy.mode === "observe") return { ...base, action: "would_notify", why: text, card };
  // Checked and set with no await in between: a send still out in this process holds its version past any backoff.
  if (IN_FLIGHT.has(key)) return { ...base, action: "retry_wait", why: "同一状态版本的上一次发送还没返回，不重发", card };
  const claim = claimNotice(d, f, card, policy);
  if (!claim.ok) return { ...base, action: claim.action, why: claim.why, card };
  IN_FLIGHT.add(key);
  try {
    await d.notify(f.project, card.audience, text, key);
  } catch (e) {
    // No sent marker: the claim only spaces the retry (manualStallRetryAfter), it never stands for a delivered card.
    return { ...base, action: "failed", why: e instanceof Error ? e.message : String(e), card };
  } finally {
    IN_FLIGHT.delete(key);
  }
  appendEvent(d.db, { actor: "scheduler", dedupKey: `${key}:sent`, now: d.now }, { project: f.project, target: "", kind: "note",
    text: `manual 停滞行动卡已送达：${f.taskId}`, data: { recovery: { op: "manualStallSent", ...cardData(card), attempt: claim.attempt } } });
  return { ...base, action: "notified", why: text, card };
}

/** One pass: off reads nothing; observe classifies and reports without writing; on claims and sends. */
export async function manualStallTick(d: ManualStallDeps): Promise<ManualStallOutcome[]> {
  const out: ManualStallOutcome[] = [];
  for (const project of d.svc.projects) {
    const policy = manualStallPolicy(d.policy, project);
    if (policy.mode === "off") { out.push({ project, mode: "off", diag: policy.diag }); continue; }
    const ids = d.db.query("SELECT taskId FROM task_workflows WHERE project = ? AND mode = 'manual' ORDER BY taskId").all(project) as { taskId: string }[];
    for (const { taskId } of ids) {
      const f = readManualFacts(d.db, taskId, d.svc);
      if (f) out.push(await onCard(d, f, policy));
    }
  }
  return out;
}

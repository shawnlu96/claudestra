/**
 * 角色模型档位过出借协议（TIER1b）：借入方 A 在领单时给建议、入账时记对方报的实际；出借方 B 在 worker 确认建成时按会话 id 记下实际、交付时只带本会话的那一份。
 * 受同一个 RecoveryPolicyPort roleModel 键管（role-model-settings-local.ts 的端口）：
 * - off：与没有这个功能时一致，不给建议、不记。
 * - observe（缺省）：材料里不带 suggest，只在卡上记一条 would-use（同卡同角色同值一条）。
 * - on：对带了 caps=suggest 的 claim 附 suggest；入账把对方报的 actual 记到卡和回执，给过建议却没报的记 unknown；旧对端没报的不落账，读出来就是 unknown。
 * 建议不当实际：B 只在自己的出借授权内起（lend-grant-spawn.ts lendModelArgs；TIER3b 在授权内接受降档见 task-tier-lend.ts），A 只记 B 报来的。表读不了 / 内容坏 = 不给建议并留诊断。
 * tests/role-model-lend.test.ts、tests/role-model-lend-peer.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getMeta, getOrder, setMeta, type LendRow } from "./lend-journal.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import type { LendFamily, ModelActual, ModelActualRecord, ModelSuggest } from "./lend-wire-types.js";
import { decideRecovery, recordObserved } from "./recovery-policy.js";
import { roleModelPort, type RoleModelPort } from "./role-model-settings-local.js";
import { roleModelOf, type CardRole } from "./role-model-settings.js";
import { actualFamilyProblem, launchActual, parseModelActual, parseModelSuggest } from "./role-model-settings-wire.js";
import { lendChoiceFor, TIER_CAP, tierLendActive, tierLendGate, tierLendRole, tierLendSuggest, type LendGate, type SuggestTierInfo } from "./task-tier-lend.js";

/** 出借单对应的卡片角色：开工 / 修复单是 author，对抗审查单是 adversarial-reviewer；仲裁等别的节点不在档位表里，不给建议 */
export function lendCardRole(step: string, node: string | null | undefined): CardRole | null {
  if (step === "write" || step === "fix") return "author";
  return step === "review" && node === "adversarial_review" ? "adversarial-reviewer" : null;
}

interface SuggestOrder { project: string; taskId: string; family: LendFamily; step: string; wire: { node?: string | null } }
/** note = 并进 claim 事件 data.lend 的那一段（建议原样、或没给建议的诊断），重复 claim 按它原样回 */
export interface ClaimSuggest { suggest: ModelSuggest | null; note: { suggest?: ModelSuggest; suggestDiagnostic?: string; suggestTier?: SuggestTierInfo } }
const NONE: ClaimSuggest = { suggest: null, note: {} };

/**
 * A 领单事务里调：这次 claim 带不带建议。对方没带 caps（旧对端）一律不带，也不记 would-use——应答与改前逐字节相同。
 * observe 的 would-use 用同一个 db 记（已在领单事务里）；记不上只少一条观察，不挡领单。
 */
export function claimSuggest(db: Database, o: SuggestOrder, caps: readonly string[] | undefined, now: number, port: RoleModelPort = roleModelPort()): ClaimSuggest {
  // TIER3b：只有对方 claim 带了 caps=tier（新 B 且它本机门开）且 A 本机 taskTierModels on 才走类型建议；否则下面是旧路径原样
  const tiered = tierLendActive(o.project, caps);
  const role = tiered ? tierLendRole(o.step, o.wire.node) : lendCardRole(o.step, o.wire.node);
  if (!caps?.includes("suggest") || !role) return NONE;
  const d = decideRecovery(port.policy(o.project, "roleModel"));
  if (d.kind === "skip") return NONE;
  const read = port.read();
  const cell = roleModelOf(read, role, o.family);
  const diagnostic = read.status === "invalid" || read.status === "unreadable" ? `模型档位表${read.status === "invalid" ? "内容不合法" : "读不了"}，不给建议` : null;
  if (d.kind === "act") {
    const broken = diagnostic || cell.source === "error" ? diagnostic ?? "模型档位表不可用，不给建议" : null;
    if (tiered) {
      // 类型 × 角色有效值，suggest 里带 tier / role 给 B 核（进摘要）；解析来源只记本机 claim 事件
      const t = tierLendSuggest(db, { taskId: o.taskId, family: o.family }, role, read, broken);
      if (!("diagnostic" in t)) return { suggest: t.suggest, note: { suggest: t.suggest, suggestTier: t.info } };
      // 协商了 tier 的 B 收到「没建议」会当旧 A 照机器默认起：证明不了 security 下限就不派这一单（事务回滚、单留在池里，B 下轮重领）
      if (t.unproven) throw new LedgerError("conflict", `${t.diagnostic}；证明不了 security 下限，这次不派单`, { lend: "unavailable" });
      return { suggest: null, note: { suggestDiagnostic: t.diagnostic } };
    }
    if (broken || cell.source === "error") return { suggest: null, note: { suggestDiagnostic: broken ?? "模型档位表不可用，不给建议" } };
    const suggest: ModelSuggest = o.family === "claude" ? { model: cell.value as string, source: cell.source } : { effort: cell.value, source: cell.source };
    return { suggest, note: { suggest } };
  }
  try {
    recordObserved(db, { project: o.project, mechanism: "roleModel", target: o.taskId, actionKey: `lend-suggest:${role}:${o.family}:${cell.value ?? "codex-config"}`,
      action: `随出借单建议 ${role}（${o.family}）用 ${cell.value ?? "对方 Codex 自己的配置"}（来源 ${cell.source}）`,
      data: { role, family: o.family, wouldUse: cell.value, source: cell.source, lend: true, ...(diagnostic ? { diagnostic } : {}) } }, now);
  } catch (e) {
    console.error(`[role-model] 记 ${o.taskId} 出借建议的 would-use 失败（领单照旧）：${(e as Error).message}`);
  }
  return NONE;
}

/** 持有人重复 claim：回它第一次领到的那一份建议（记在当代 claim 事件里），不按此刻的表重算——同一单的材料不变 */
export function notedSuggest(events: LedgerEvent[], o: { orderId: string; leaseGen: number }, caps: readonly string[] | undefined): ModelSuggest | null {
  if (!caps?.includes("suggest")) return null;
  const lend = events.map((e) => e.data.lend as Record<string, unknown> | undefined).findLast((l) => l?.orderId === o.orderId && l.op === "claim" && l.gen === o.leaseGen);
  const s = lend?.suggest === undefined ? null : parseModelSuggest(lend.suggest);
  return s && typeof s !== "string" ? s : null;
}

const UNKNOWN: ModelActualRecord = { model: null, effort: null, source: "unknown" };

/**
 * A 入账时调：这份结果的实际档位记不记、记什么。对方报了、或这一单领单时给过建议（suggested，说明当时开关是 on、对方认得这套字段）才看开关：
 * off = null（不记，和改前一样）；否则报了记报的，给过建议却没报的记 unknown。两样都没有（旧对端）= 不读开关、不写，读的时候按 unknown 算
 * （lendActualOf）——这条路上多读一次策略会打破 tests/recovery-materials-wiring-process.test.ts 钉住的「交付只读 uiDelivery」。
 * 报了但和这一单家族对不上（codex 单带了模型名）= refuse（字符串原因），整份不入账。
 */
export function intakeActual(o: { project: string; family: LendFamily }, reported: ModelActual | undefined, suggested: () => boolean,
  port: RoleModelPort = roleModelPort()): { record: ModelActualRecord | null } | { refuse: string } {
  const bad = reported ? actualFamilyProblem(o.family, reported) : null;
  if (bad) return { refuse: bad };
  if (!reported && !suggested()) return { record: null };
  if (decideRecovery(port.policy(o.project, "roleModel")).kind === "skip") return { record: null };
  return { record: reported ?? UNKNOWN };
}

/** 这一单实际用的模型 / 档位：卡上记过就是记的那一份，没记过（旧对端没报、或开关 off）= unknown——建议不当实际 */
export function lendActualOf(events: LedgerEvent[], orderId: string): ModelActualRecord {
  const lend = events.map((e) => e.data.lend as Record<string, unknown> | undefined).findLast((l) => l?.orderId === orderId && l.op === "actual");
  const a = lend ? parseModelActual(lend.actual) : null;
  return a && typeof a !== "string" ? a : UNKNOWN;
}

export const actualText = (a: ModelActualRecord): string =>
  a.source === "unknown" ? "unknown（对方没报）" : `模型 ${a.model ?? "对方默认"}、档位 ${a.effort ?? "对方默认"}（${a.source}）`;

// ── 出借方 B：journal 里的启动事实 ──

const launchKey = (orderId: string): string => `role-model-launch:${orderId}`;

/**
 * manager create 确认建成之后调（launchRecording）：把这次的实际连同建出来的会话 id 落进 journal——事实跟着会话走，不跟着订单号走。
 * args 就是这次真正带给 manager create 的 --model / --effort。只记不改：返回的诊断给日志。重起（上次没起成）按新建成的一次覆盖。
 */
export function recordLendLaunch(db: Database, orderId: string, sessionId: string, args: readonly string[]): string | null {
  const row = getOrder(db, orderId);
  if (!row) return null;
  const made = launchActual(row.family, row.wire?.suggest, args);
  // TIER3b：起之前按建议在授权内选过档（task-tier-lend.ts），偏离原因随同一条启动事实落下，不另记事件
  const choice = lendChoiceFor(db, orderId, args);
  setMeta(db, launchKey(orderId), JSON.stringify({ sessionId, actual: made.actual, ...(choice ? { choice } : {}) }));
  return choice ? choice.reason ?? null : made.diagnostic ?? null;
}

type ManagerCall = (...args: string[]) => Promise<Record<string, unknown>>;
/**
 * 包住起出借 worker 的那一次 manager 调用（lend-deps.ts worker.create）：只有它回了 ok 且带会话 id（= 这次确认建成）才记启动事实。
 * 没建成（同名 worker 已在、闸口拦下、超时）什么都不写：lend-drive.ts startWorker 这时可能认领一个别处建好的同名 worker，
 * 这次没用上的参数不是它的事实，也不盖掉建成它的那一次记下的。记不上只少一条事实（A 记 unknown），不挡起 worker。
 */
export const launchRecording = (db: Database, orderId: string, run: ManagerCall, log: (m: string) => void): ManagerCall => async (...args) => {
  const r = await run(...args);
  if (r.ok !== true || typeof r.sessionId !== "string" || !r.sessionId) return r;
  try {
    const hint = recordLendLaunch(db, orderId, r.sessionId, args);
    if (hint) log(`${orderId} 的模型档位建议：${hint}`);
  } catch (e) {
    log(`${orderId} 的启动事实没记上（交付不带 actual）：${(e as Error).message}`);
  }
  return r;
};

/**
 * 交付 / 结论正文里要带的 actual（B）：A 这次领单给过建议（= A 认得 actual 字段），且记下的启动事实正是这一行在用的会话的才带；
 * 旧 A、A 没开开关、没记到事实、或事实是别的会话的（认领了不是这次建的 worker）= 不带，正文与改前逐字节相同（A 那边记 unknown）。
 */
export function deliveredActual(db: Database, row: Pick<LendRow, "orderId" | "wire" | "sessionId">): { actual?: ModelActual } {
  if (!row.wire?.suggest || !row.sessionId) return {};
  const raw = getMeta(db, launchKey(row.orderId));
  let v: { sessionId?: unknown; actual?: unknown } | null;
  try { v = raw ? JSON.parse(raw) : null; } catch { return {}; /* 自己写的 JSON 读不回来：当没记到，不带（A 记 unknown） */ }
  if (!v || typeof v !== "object" || v.sessionId !== row.sessionId) return {};
  const a = parseModelActual(v.actual);
  return typeof a === "string" ? {} : { actual: a };
}

// ── 出借方 B：对方不认 caps 时的记忆 ──

const NO_CAPS_MS = 24 * 3_600_000;
const noCapsKey = (peer: string): string => `claim-caps-refused:${peer}`;
/** 不认 tier 的 peer → 到期时间：只在本进程内存里（不落盘、不进 journal），进程重启后再试一次 */
const noTier = new Map<string, number>();
/**
 * 这个 peer 的 claim 带不带 caps：最近 24 小时它拒过带 caps 的 claim（旧版严格解析）就不带，过了再试一次。
 * TIER3b：本机门开（taskTierModels on +「接受降档建议」开，tierLendGate）且这个 peer 24 小时内没拒过 tier 才多带 tier；门关 = 与改前逐字相同的 ["suggest"]。
 */
export function claimCaps(db: Database, peer: string, now: number, gate: () => LendGate = tierLendGate): { caps?: ("suggest" | "tier")[] } {
  if (Number(getMeta(db, noCapsKey(peer)) ?? 0) > now) return {};
  if ((noTier.get(peer) ?? 0) > now) return { caps: ["suggest"] };
  const g = gate();
  return g.on && g.acceptDowngrade ? { caps: ["suggest", TIER_CAP] } : { caps: ["suggest"] };
}
export const rememberNoCaps = (db: Database, peer: string, now: number): void => setMeta(db, noCapsKey(peer), String(now + NO_CAPS_MS));
/** 旧 A 不认 tier（回 invalid）：一天内只带 suggest，旧 A 仍拿到它认得的 caps，建议照旧给 */
export const rememberNoTier = (peer: string, now: number): void => { noTier.set(peer, now + NO_CAPS_MS); };
/** Tests only: forget the in-memory tier refusals. */
export const resetNoTier = (): void => noTier.clear();

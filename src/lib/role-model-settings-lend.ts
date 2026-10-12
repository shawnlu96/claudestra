/**
 * 角色模型档位过出借协议（TIER1b）：借入方 A 在领单时给建议、入账时记对方报的实际；出借方 B 在起 worker 时记下实际、交付时带上。
 * 受同一个 RecoveryPolicyPort roleModel 键管（role-model-settings-local.ts 的端口）：
 * - off：与没有这个功能时一致，不给建议、不记。
 * - observe（缺省）：材料里不带 suggest，只在卡上记一条 would-use（同卡同角色同值一条）。
 * - on：对带了 caps=suggest 的 claim 附 suggest；入账把对方报的 actual 记到卡和回执，给过建议却没报的记 unknown；旧对端没报的不落账，读出来就是 unknown。
 * 建议不当实际：B 只在自己的出借授权内起（lend-grant-spawn.ts lendModelArgs 一字不动），A 只记 B 报来的。表读不了 / 内容坏 = 不给建议并留诊断。
 * tests/role-model-lend.test.ts、tests/role-model-lend-peer.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getMeta, getOrder, setMeta, type LendRow } from "./lend-journal.js";
import type { LedgerEvent } from "./ledger-stages.js";
import type { LendFamily, ModelActual, ModelActualRecord, ModelSuggest } from "./lend-wire-types.js";
import { decideRecovery, recordObserved } from "./recovery-policy.js";
import { roleModelPort, type RoleModelPort } from "./role-model-settings-local.js";
import { roleModelOf, type CardRole } from "./role-model-settings.js";
import { actualFamilyProblem, launchActual, parseModelActual, parseModelSuggest } from "./role-model-settings-wire.js";

/** 出借单对应的卡片角色：开工 / 修复单是 author，对抗审查单是 adversarial-reviewer；仲裁等别的节点不在档位表里，不给建议 */
export function lendCardRole(step: string, node: string | null | undefined): CardRole | null {
  if (step === "write" || step === "fix") return "author";
  return step === "review" && node === "adversarial_review" ? "adversarial-reviewer" : null;
}

interface SuggestOrder { project: string; taskId: string; family: LendFamily; step: string; wire: { node?: string | null } }
/** note = 并进 claim 事件 data.lend 的那一段（建议原样、或没给建议的诊断），重复 claim 按它原样回 */
export interface ClaimSuggest { suggest: ModelSuggest | null; note: { suggest?: ModelSuggest; suggestDiagnostic?: string } }
const NONE: ClaimSuggest = { suggest: null, note: {} };

/**
 * A 领单事务里调：这次 claim 带不带建议。对方没带 caps（旧对端）一律不带，也不记 would-use——应答与改前逐字节相同。
 * observe 的 would-use 用同一个 db 记（已在领单事务里）；记不上只少一条观察，不挡领单。
 */
export function claimSuggest(db: Database, o: SuggestOrder, caps: readonly string[] | undefined, now: number, port: RoleModelPort = roleModelPort()): ClaimSuggest {
  const role = lendCardRole(o.step, o.wire.node);
  if (!caps?.includes("suggest") || !role) return NONE;
  const d = decideRecovery(port.policy(o.project, "roleModel"));
  if (d.kind === "skip") return NONE;
  const read = port.read();
  const cell = roleModelOf(read, role, o.family);
  const diagnostic = read.status === "invalid" || read.status === "unreadable" ? `模型档位表${read.status === "invalid" ? "内容不合法" : "读不了"}，不给建议` : null;
  if (d.kind === "act") {
    if (diagnostic || cell.source === "error") return { suggest: null, note: { suggestDiagnostic: diagnostic ?? "模型档位表不可用，不给建议" } };
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
 * 起 worker 前调（lend-deps.ts worker.create，args 就是随后带给 manager create 的 --model / --effort）：把这次的实际落进 journal。
 * 只记不改：返回的诊断给日志。重起（上次没起成）按新的一次覆盖。
 */
export function recordLendLaunch(db: Database, orderId: string, args: readonly string[]): string | null {
  const row = getOrder(db, orderId);
  if (!row) return null;
  const made = launchActual(row.family, row.wire?.suggest, args);
  setMeta(db, launchKey(orderId), JSON.stringify(made.actual));
  return made.diagnostic ?? null;
}

/**
 * 交付 / 结论正文里要带的 actual（B）：A 这次领单给过建议（= A 认得 actual 字段）且起 worker 时记下了事实才带；
 * 旧 A、A 没开开关、或没记到事实 = 不带，正文与改前逐字节相同（A 那边记 unknown）。
 */
export function deliveredActual(db: Database, row: Pick<LendRow, "orderId" | "wire">): { actual?: ModelActual } {
  if (!row.wire?.suggest) return {};
  const raw = getMeta(db, launchKey(row.orderId));
  let v: unknown;
  try { v = raw ? JSON.parse(raw) : null; } catch { return {}; /* 自己写的 JSON 读不回来：当没记到，不带（A 记 unknown） */ }
  const a = parseModelActual(v);
  return typeof a === "string" ? {} : { actual: a };
}

// ── 出借方 B：对方不认 caps 时的记忆 ──

const NO_CAPS_MS = 24 * 3_600_000;
const noCapsKey = (peer: string): string => `claim-caps-refused:${peer}`;
/** 这个 peer 的 claim 带不带 caps：最近 24 小时它拒过带 caps 的 claim（旧版严格解析）就不带，过了再试一次 */
export const claimCaps = (db: Database, peer: string, now: number): { caps?: string[] } => (Number(getMeta(db, noCapsKey(peer)) ?? 0) > now ? {} : { caps: ["suggest"] });
export const rememberNoCaps = (db: Database, peer: string, now: number): void => setMeta(db, noCapsKey(peer), String(now + NO_CAPS_MS));

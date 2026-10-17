/**
 * 出借协议里的任务类型档位（TIER3b）。新行为只走显式协商的 claim 能力位 caps=tier（LEND_CLAIM_CAPS）：B 只在本机门开时带它，A 只在对方带了且本机门开时用它。
 * 两端各自看自己的 taskTierModels 恢复键（task-tier-models.ts taskTierMode），任一端都不替对端开：
 * - A（借入方）：caps 带 tier 且本机键 on，claim 的建议用「类型 × 角色」有效值（resolveTierModel），并在同一个 suggest 对象里带上 tier、role
 *   （进 suggestDigest，role-model-settings-wire.ts）。证明不了 security 下限（类型核不清、security 卡表坏 / 读不了 / 下限不过）= 拒绝这次领单（unavailable，单留在池里），
 *   不编码成缺建议——否则 B 分不清这是旧 A，会按兼容路径照机器默认起。非 security 卡表坏仍只是不给建议。没协商 = 旧 roleModel 路径一字不变（role-model-settings-lend.ts claimSuggest）。
 * - B（出借方）：本机键 on +「接受降档建议」开（task-tier-lend-settings.ts，缺省开）时 claim 才带 tier（claimCaps）；起 worker 时只有建议带了 A 给的类型才在授权内选档：
 *   只等于或低于授权档，不升档；Claude 授权没写上限时以 Opus 为上限；Codex 用授权 effort 与 CODEX_EFFORT_LEVELS 有序表比，排不出位置不猜。
 *   角色要与 B 自己看到的订单节点对得上；security 不接受降档，且每个最终选择都过 tierFloorProblem——证明不了下限（含授权没写 Codex 档、Claude 不带 Opus 档的 --model、
 *   角色核不上）就拒绝启动。门关、或建议不带类型（旧 A / A 键没开）= 授权原参数，与改前逐字一致，不记任何新东西。
 * tests/task-tier-lend.test.ts。
 */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { reportCorrupt } from "./state-file.js";
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getMeta, setMeta } from "./lend-journal.js";
import type { ModelSuggest } from "./lend-wire-types.js";
import type { CardRole, RoleModelRead } from "./role-model-settings.js";
import { isCardRoleName, roleModelOf } from "./role-model-settings.js";
import { parseModelSuggest, suggestFamilyProblem } from "./role-model-settings-wire.js";
import { isOpusGrade, type CodexEffort } from "./task-tier-model-settings.js";
import { resolveTierModel, taskTierMode, tierFloorProblem } from "./task-tier-models.js";
import { isTaskTier, tierAtLaunch, type TaskTier } from "./task-tier-spec.js";
import { readTierLendSettings, TIER_LEND_SETTINGS_PATH } from "./task-tier-lend-settings.js";

/** B 起出借 worker 时挂的本机项目（lend-deps.ts LEND_PROJECT）：B 的恢复键按它读 */
const LEND_LOCAL_PROJECT = "lend";
/** claim 能力位：带了 = 这个 B 认得带类型的建议并会在授权内选档 */
export const TIER_CAP = "tier" as const;

/**
 * 出借单在类型档位里的卡片角色（只用在协商了 tier 的路径上）：开工 / 修复单 author，对抗审查 adversarial-reviewer，PM 审查 pm-reviewer；别的节点 = null。
 * 旧路径仍用 role-model-settings-lend.ts lendCardRole（不认 pm-reviewer），不改它的输出。
 */
export function tierLendRole(step: string, node: string | null | undefined): CardRole | null {
  if (step === "write" || step === "fix") return "author";
  if (step !== "review") return null;
  return node === "adversarial_review" ? "adversarial-reviewer" : node === "pm_review" || node === "pm-review" ? "pm-reviewer" : null;
}

// ── A：类型 × 角色的建议 ──

/** A 这一单走不走类型建议：对方 claim 带了 suggest + tier，且 A 本机 taskTierModels 是 on */
export const tierLendActive = (project: string, caps: readonly string[] | undefined): boolean =>
  !!caps?.includes("suggest") && caps.includes(TIER_CAP) && taskTierMode(project).mode === "on";

/** 记进 A 的 claim 事件 data.lend.suggestTier 的解析来源（可在 A 的台账上核对建议从哪来） */
export interface SuggestTierInfo { tier: TaskTier; role: CardRole; source: string }
/** unproven = 证明不了 security 下限（类型核不清，或就是 security）：A 不能把它编码成「缺建议」，调用方拒绝这次领单 */
export type TierSuggest = { suggest: ModelSuggest; info: SuggestTierInfo } | { diagnostic: string; unproven: boolean };

/**
 * 按卡上存的流程模板定类型（tierAtLaunch，不在领单事务里读规格卡），解析有效值并过 security 下限；类型核对不过 / 下限不过 = 不给建议并给诊断。
 * broken = 模型档位表坏 / 读不了的诊断（调用方读表时得出）：先定类型再看它，security 卡表坏也算证明不了。调用方先用 tierLendActive 分流。
 */
export function tierLendSuggest(db: Database, o: { taskId: string; family: "claude" | "codex" }, role: CardRole, read: RoleModelRead,
  broken: string | null = null): TierSuggest {
  const w = getWorkflow(db, o.taskId);
  const at = tierAtLaunch(w ? { template: w.template, specRev: w.specRev ?? 0 } : null, null);
  if (!at.ok) return { diagnostic: `任务类型核对不过，不给建议：${at.error}`, unproven: true };
  const unproven = at.tier === "security";
  if (broken) return { diagnostic: broken, unproven };
  const r = resolveTierModel(read, at.tier, role, o.family);
  const base = o.family === "codex" ? roleModelOf(read, role, "codex").value as CodexEffort | null : undefined;
  const floor = tierFloorProblem(at.tier, role, o.family, r.value, base);
  if (floor) return { diagnostic: `${floor}，不给建议`, unproven };
  const source = r.source === "tier-settings" || r.source === "role-settings" ? "settings" : "default";
  if (o.family === "claude" && typeof r.value !== "string") return { diagnostic: "类型解析没有得出 Claude 模型，不给建议", unproven };
  const tag = { tier: at.tier, role };
  const suggest: ModelSuggest = o.family === "claude" ? { model: r.value as string, source, ...tag } : { effort: r.value, source, ...tag };
  return { suggest, info: { tier: at.tier, role, source: r.source } };
}

// ── B：授权内选档 ──

const CLAUDE_GRADES = ["haiku", "sonnet", "opus"] as const;
/** Claude 型号档：haiku < sonnet < opus；认不出 = -1（排不出位置） */
const claudeGrade = (model: string | null | undefined): number =>
  typeof model === "string" ? CLAUDE_GRADES.findIndex((g) => new RegExp(`^claude-${g}-[a-z0-9.-]+$`).test(model)) : -1;
const effortRank = (e: unknown): number => CODEX_EFFORT_LEVELS.indexOf(e as CodexEffort);
const argAfter = (args: readonly string[], flag: string): string | null => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1]! : null; };

export interface LendChoiceInput {
  family: string;
  /** B 自己 journal 里这单的步骤与节点（核对 A 给的角色） */
  step: string;
  node: string | null;
  suggest: ModelSuggest | null | undefined;
  /** 授权原参数（lend-grant-spawn.ts choiceArgs）：codex 的 --model / --effort，claude 恒为 [] */
  grantArgs: readonly string[];
  /** Claude 授权上限（完整模型 id）；不写 = Opus */
  claudeCap?: string | null;
}
export interface LendGate { on: boolean; acceptDowngrade: boolean }
/**
 * active = 走了本卡的选择（门开、建议带了 A 给的类型）；false 时 args 就是授权原参数，调用方不得记任何新东西。
 * accepted = 用了建议；reason = 没用 / 偏离的原因；refuse = 证明不了 security 下限（或核不清是不是 security），不启动。
 */
export interface LendChoice { args: string[]; active: boolean; accepted: boolean; tier: TaskTier | null; reason?: string; refuse?: string }

const keep = (i: LendChoiceInput, tier: TaskTier | null, reason: string): LendChoice => ({ args: [...i.grantArgs], active: true, accepted: false, tier, reason });
const refused = (c: LendChoice, why: string): LendChoice => ({ ...c, refuse: `${why}，不启动` });

function claudeChoice(i: LendChoiceInput, tier: TaskTier, want: string): LendChoice {
  const cap = i.claudeCap ?? null;
  const capGrade = cap ? claudeGrade(cap) : CLAUDE_GRADES.indexOf("opus");
  const g = claudeGrade(want);
  if (g < 0 || capGrade < 0) return keep(i, tier, `核不出 ${want} 与授权上限 ${cap ?? "Opus"} 的排序，不猜档`);
  if (g > capGrade) {
    return cap ? { args: ["--model", cap], active: true, accepted: false, tier, reason: `建议的 ${want} 高于授权上限 ${cap}，不升档，用上限` }
      : keep(i, tier, `建议的 ${want} 高于授权上限，不升档`);
  }
  if (tier === "security" && !isOpusGrade(want)) return keep(i, tier, `security 不接受降档建议（建议 ${want}）`);
  return { args: ["--model", want], active: true, accepted: true, tier };
}

function codexChoice(i: LendChoiceInput, tier: TaskTier, want: string | null): LendChoice {
  const granted = argAfter(i.grantArgs, "--effort");
  if (want === null) return keep(i, tier, "建议不指定推理档，照授权");
  if (granted === null) return keep(i, tier, `授权没写推理档，核不出 ${want} 是否不高于授权，不猜档`);
  const w = effortRank(want), g = effortRank(granted);
  if (w < 0 || g < 0) return keep(i, tier, `核不出 ${want} 与授权档 ${granted} 的排序，不猜档`);
  if (w > g) return keep(i, tier, `建议的 ${want} 高于授权档 ${granted}，不升档，照授权`);
  if (w < g && tier === "security") return keep(i, tier, `security 不接受降档建议（建议 ${want}，授权 ${granted}）`);
  const model = argAfter(i.grantArgs, "--model");
  return { args: [...(model ? ["--model", model] : []), "--effort", want], active: true, accepted: true, tier };
}

/**
 * 每个 security 最终选择都过 TIER3 下限（不只接受建议那一支）：Claude 要带 Opus 档的 --model（不带 = 照本机默认起，证明不了）；
 * Codex 以授权写明的档为原档，授权没写档 = 无从证明。
 */
function securityProof(i: LendChoiceInput, role: CardRole, c: LendChoice): LendChoice {
  if (c.tier !== "security") return c;
  if (i.family === "claude") {
    const floor = tierFloorProblem("security", role, "claude", argAfter(c.args, "--model"), undefined);
    return floor ? refused(c, floor) : c;
  }
  const granted = argAfter(i.grantArgs, "--effort");
  if (!granted || effortRank(granted) < 0) return refused(c, `security 卡的 ${role}（Codex）授权没写可比较的推理档，证明不了不低于原档`);
  const floor = tierFloorProblem("security", role, "codex", argAfter(c.args, "--effort"), granted as CodexEffort);
  return floor ? refused(c, floor) : c;
}

/** 纯函数：B 这一单最终带给 manager create 的 --model / --effort */
export function lendLaunchChoice(i: LendChoiceInput, gate: LendGate): LendChoice {
  // 门关、没建议、或建议不带类型（旧 A / A 没协商）= 授权原参数，逐字同改前
  if (!gate.on || !gate.acceptDowngrade || !i.suggest || i.suggest.tier === undefined) return { args: [...i.grantArgs], active: false, accepted: false, tier: null };
  const s = parseModelSuggest(i.suggest);
  // 带了类型却核不清（形状 / 家族不对）：分不清是不是 security，按证明不了处理
  if (typeof s === "string") return refused(keep(i, null, `建议不可验证（${s}）`), "核不清任务类型与安全下限");
  if (suggestFamilyProblem(i.family, s)) return refused(keep(i, null, "建议与家族对不上"), "核不清任务类型与安全下限");
  const tier = isTaskTier(s.tier) ? s.tier : null;
  const role = isCardRoleName(s.role) ? s.role : null;
  if (!tier || !role) return refused(keep(i, null, "建议的类型 / 角色不认识"), "核不清任务类型与安全下限");
  const own = tierLendRole(i.step, i.node);
  if (own !== role) {
    const c = keep(i, tier, `建议的角色 ${role} 与本机订单节点（${own ?? "不在档位表"}）对不上，不接受降档，照授权`);
    return tier === "security" ? refused(c, "security 卡的角色核不上，证明不了安全下限") : c;
  }
  return securityProof(i, role, "model" in s ? claudeChoice(i, tier, s.model) : codexChoice(i, tier, s.effort));
}

/** B 本机的门：taskTierModels（项目 lend）是 on 且「接受降档建议」开；设置文件坏按关 */
export function tierLendGate(settingsPath = TIER_LEND_SETTINGS_PATH): LendGate {
  if (taskTierMode(LEND_LOCAL_PROJECT).mode !== "on") return { on: false, acceptDowngrade: false };
  const read = readTierLendSettings(settingsPath);
  if (read.status === "invalid" || read.status === "unreadable") {
    let version = "unstatable";
    try {
      const stat = statSync(settingsPath);
      version = `${stat.mtimeMs}:${stat.size}`;
    } catch { /* 连 stat 都被拒或文件刚被移走：稳定标记去重，下一次可读到元数据时再诊断。 */ }
    reportCorrupt(settingsPath, `设置读取异常，按不接受降档执行：${read.error}`, "task-tier-lend", false, version);
  }
  return { on: true, acceptDowngrade: read.settings.acceptDowngrade };
}

// ── B：选择记录（只 active 才写；启动事实仍由 role-model-settings-lend.ts recordLendLaunch 一处落） ──

const choiceKey = (orderId: string): string => `tier-lend-choice:${orderId}`;
export interface ChoiceNote { args: string[]; accepted: boolean; tier: TaskTier | null; reason?: string }

export function noteLendChoice(db: Database, orderId: string, c: LendChoice): void {
  if (!c.active) return;
  setMeta(db, choiceKey(orderId), JSON.stringify({ args: c.args, accepted: c.accepted, tier: c.tier, ...(c.reason ? { reason: c.reason } : {}) }));
}

/** 起 worker 时记下的选择；args 要和这次真正带的一致才算（否则是别的一次的，不认） */
export function lendChoiceFor(db: Database, orderId: string, args: readonly string[]): ChoiceNote | null {
  const raw = getMeta(db, choiceKey(orderId));
  if (!raw) return null;
  let v: ChoiceNote;
  try { v = JSON.parse(raw) as ChoiceNote; } catch { return null; /* 自己写的读不回来：当没记 */ }
  const flags = args.filter((a, k) => a === "--model" || a === "--effort" || args[k - 1] === "--model" || args[k - 1] === "--effort");
  return Array.isArray(v.args) && JSON.stringify(v.args) === JSON.stringify(flags) ? v : null;
}

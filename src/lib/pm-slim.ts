/**
 * 协调者启动瘦身（agents-PMSLIM1）：给命中 coordinator 策略的 Claude Code 会话在启动时带上
 * `autoCompactWindow` 和 `permissions.deny`（排除整组 MCP 工具），并把 bridge 注入的压缩动作从 /save-compact 换成 /compact <保留清单>。
 * 开关在状态目录 pm-slim.json 的 mode（off / observe / on，缺省 observe）；读不出来按 off，记一条短诊断。
 *   - off：命令、settings、注入和改前逐字一致；
 *   - observe：同样启动 / 注入，只往状态目录 pm-slim/<agent>.json 写候选工具组、窗口、动作与理由（不含 MCP 服务器定义或其他配置值）；
 *   - on：把候选合进 agent 自己那份 --settings（仍只传一份），压缩动作改 compact。
 * 生效点是启动（new / resume / restart 都走 claudeLaunchOptions）：on 的那次启动会把模式记进 pm-slim/<agent>.json，bridge 只认这份记录，
 * 所以中途切开关不改正在跑的会话，也不为瘦身自动重启。协调者按 ctx-boundary-policy 的同一张策略表匹配（项目 / 名字），执行者一律排除。
 * 设计见 docs/architecture/pm-slim.md，单测 tests/pm-slim.test.ts。
 */
import { readConfigSync } from "./config-store.js";
import { isExecutor, matchPolicy, resolvePolicies, type CompactAction, type CtxPolicy, type PolicyMatch } from "./ctx-boundary-policy.js";
import { isLinkedWorktree } from "./linked-worktree.js";
import { statePath } from "./paths.js";
import { readRegistryAgentsSync } from "./registry.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

export type PmSlimMode = "on" | "observe" | "off";
const MODES: readonly PmSlimMode[] = ["on", "observe", "off"];
const DEFAULT_MODE: PmSlimMode = "observe";
const COORDINATOR_POLICY = "coordinator";

export const pmSlimModePath = () => statePath("pm-slim.json");
export const pmSlimRecordPath = (agent: string) => statePath("pm-slim", `${agent}.json`);

/** 开关：文件不在 → observe；读坏了 / 不是对象 / mode 不认得 → off，带一句不含原值的诊断 */
export function readPmSlimMode(path = pmSlimModePath()): { mode: PmSlimMode; diag: string | null } {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return { mode: DEFAULT_MODE, diag: null };
  if (r.status === "corrupt") return { mode: "off", diag: "pm-slim.json 读不出来，按 off" };
  const d = r.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return { mode: "off", diag: "pm-slim.json 不是对象，按 off" };
  const m = (d as Record<string, unknown>).mode;
  if (m === undefined) return { mode: DEFAULT_MODE, diag: null };
  return MODES.includes(m as PmSlimMode) ? { mode: m as PmSlimMode, diag: null } : { mode: "off", diag: "pm-slim.json 的 mode 不是 on / observe / off，按 off" };
}

export interface PmSlimPlan {
  agent: string;
  mode: PmSlimMode;
  policy: string;
  /** 候选排除的工具组（permissions.deny 规则，如 mcp__playwright） */
  deny: string[];
  autoCompactWindow: number | null;
  /** on 时 bridge 实际注入的动作；observe / off 时是候选 */
  action: CompactAction;
  keep: "policy" | "default";
  reasons: string[];
}

export interface PmSlimTarget {
  name: string;
  projectId?: string | null;
  worktree?: boolean;
}

/** 纯函数：这个会话的瘦身计划。没命中 coordinator、或按执行者对待 → null（其余策略和执行者原样） */
export function pmSlimPlan(t: PmSlimTarget, policies: readonly CtxPolicy[], mode: PmSlimMode, diags: string[] = []): PmSlimPlan | null {
  const m = matchPolicy(policies, t);
  if (!m || m.policy.id !== COORDINATOR_POLICY || isExecutor(t)) return null;
  const p = m.policy;
  const deny = [...new Set(p.ccDeny ?? [])];
  const reasons = [
    `命中策略 ${p.id}（${m.via}）`,
    deny.length ? "候选工具组走 settings 的 permissions.deny，不改 MCP 服务器配置" : "策略没写 ccDeny，不排除工具组",
    p.ccWindow ? "候选 autoCompactWindow 取策略 ccWindow（CC 原生自动压缩触发点，不是每请求硬上限）" : "策略 ccWindow 为空，不带 autoCompactWindow",
    "压缩动作候选 compact（带保留清单），不再每次重写 HANDOFF",
    ...diags,
  ];
  return { agent: t.name, mode, policy: p.id, deny, autoCompactWindow: p.ccWindow, action: "compact", keep: p.keep ? "policy" : "default", reasons };
}

/** on 才合：autoCompactWindow 覆盖同名键，deny 与已有的合并去重（已有的在前）；其余键原样。observe / off / 没计划 → 原对象 */
export function applyPmSlimSettings(own: Record<string, unknown>, plan: PmSlimPlan | null | undefined): Record<string, unknown> {
  if (!plan || plan.mode !== "on") return own;
  const out: Record<string, unknown> = { ...own };
  if (plan.autoCompactWindow) out.autoCompactWindow = plan.autoCompactWindow;
  if (plan.deny.length) {
    const perm = own.permissions && typeof own.permissions === "object" && !Array.isArray(own.permissions) ? (own.permissions as Record<string, unknown>) : {};
    const had = Array.isArray(perm.deny) ? perm.deny.filter((s): s is string => typeof s === "string") : [];
    out.permissions = { ...perm, deny: [...new Set([...had, ...plan.deny])] };
  }
  return out;
}

/** 启动记录：bridge 据此判定这次会话是不是按 on 起的。写失败只记诊断——不能因为瘦身记录让会话起不来 */
function recordPmSlim(plan: PmSlimPlan, now = Date.now(), log: (t: string) => void = console.error): void {
  const { agent, ...rest } = plan;
  try {
    writeJsonAtomicSync(pmSlimRecordPath(agent), { at: new Date(now).toISOString(), ...rest });
  } catch (e) {
    log(`⚠ 协调者瘦身记录写不进去（${agent}）：${(e as Error).message}`);
  }
}

/** 上一次启动的记录（没有 / 坏了 → null） */
export function readPmSlimRecord(agent: string): { mode?: unknown; action?: unknown } | null {
  const r = readJsonStateSync(pmSlimRecordPath(agent));
  return r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as { mode?: unknown; action?: unknown }) : null;
}

/** bridge 有效动作决策的那一行：命中 coordinator 且这次会话按 on 启动 → compact；其余原样（执行者、其他策略、observe / off） */
export function pmSlimAction(agent: string, m: PolicyMatch | null, action: CompactAction, read = readPmSlimRecord): CompactAction {
  if (action !== "save-compact" || m?.policy.id !== COORDINATOR_POLICY) return action;
  const r = read(agent);
  return r?.mode === "on" && r.action === "compact" ? "compact" : action;
}

export interface PmSlimLaunchDeps {
  mode: () => { mode: PmSlimMode; diag: string | null };
  policies: () => ReturnType<typeof resolvePolicies>;
  projectId: (name: string) => string | undefined;
  worktree: (cwd: string | undefined) => boolean;
  record: (plan: PmSlimPlan) => void;
  log: (t: string) => void;
}

const livePmSlimDeps: PmSlimLaunchDeps = {
  mode: () => readPmSlimMode(),
  policies: () => resolvePolicies(readConfigSync().autoCompact?.policies),
  projectId: (name) => readRegistryAgentsSync().find((a) => a.name === name)?.projectId,
  worktree: (cwd) => isLinkedWorktree(cwd),
  record: (plan) => recordPmSlim(plan),
  log: (t) => console.error(t),
};

/**
 * 启动时调一次（claudeLaunchOptions）：算计划、写记录，返回给 buildClaudeCommand 合 settings 用。
 * 任何一步抛错 → 按 off（返回 null，不写记录），记一条短诊断。
 */
export function pmSlimForLaunch(name: string | undefined, cwd: string | undefined, deps: PmSlimLaunchDeps = livePmSlimDeps): PmSlimPlan | null {
  if (!name) return null;
  try {
    const { mode, diag } = deps.mode();
    const r = deps.policies();
    const diags = r.warnings.filter((w) => w.policy === COORDINATOR_POLICY && /^cc(Deny|Window)/.test(w.text)).map((w) => w.text);
    if (diag) diags.push(diag);
    const plan = pmSlimPlan({ name, projectId: deps.projectId(name), worktree: deps.worktree(cwd) }, r.policies, mode, diags);
    if (!plan) return null;
    if (diag) deps.log(`⚠ 协调者瘦身（${name}）：${diag}`);
    deps.record(plan);
    return plan;
  } catch (e) {
    deps.log(`⚠ 协调者瘦身（${name}）读配置失败，按 off：${(e as Error).message}`);
    return null;
  }
}

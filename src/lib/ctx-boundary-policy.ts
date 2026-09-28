/**
 * 上下文边界策略（纯函数）：按项目 / 名字模式给 agent 配压缩线。设计与字段说明见 docs/architecture/context-boundary.md，
 * 单测 tests/ctx-boundary-policy.test.ts。执行（读 pane、注入）在 bridge/ctx-boundary.ts。
 *
 * 两层：ccWindow 走启动时的 `--settings autoCompactWindow`（CC 自己压，回合中途也压）；window / hardCap 是 bridge 先动手、
 * 带保留清单的软边界。没匹配到策略的 agent 走全局 autoCompact（window / idleHours / emergency），行为和以前一样。
 */
import { isMasterAgent } from "./registry.js";

export type CompactAction = "compact" | "save-compact";

export interface CtxPolicy {
  id: string;
  projects: string[];
  names: string[];
  /** 软边界：超过且闲置满 idleMinutes 才注入 */
  window: number;
  idleMinutes: number;
  /** 硬上限：超过就不管闲不闲，注入后排队到回合结束 */
  hardCap: number;
  action: CompactAction;
  /** 第 1 层：CC 的 autoCompactWindow；null = 不带 */
  ccWindow: number | null;
  /** action=compact 时的保留清单；null = DEFAULT_KEEP_LIST */
  keep: string | null;
}

export interface PolicyWarning {
  policy: string | null;
  text: string;
}

/** CC 只认 10 万～100 万的整数，越界值会被它悄悄丢掉（2.1.283 实测，见文档）；我们在读配置时就报出来 */
const CC_WINDOW_MIN = 100_000;
const CC_WINDOW_MAX = 1_000_000;
/** CC 实际在「窗口 − 约 3.3 万」时压（旧的 75 万配置在约 72 万压）。hardCap 不低于这个点，带清单的那一步就永远等不到 */
const CC_COMPACT_BUFFER = 33_000;

export const DEFAULT_KEEP_LIST =
  "摘要务必保留：任务卡号、分支、worktree、当前 head 与 PR 号；未完成的步骤和被打断时正在做的那一步；PM 最近的指令；" +
  "owner 和 PM 的原话约束与硬规矩（例如只在沙箱发键、不 git add -A）；待回报事项；审查结论和还没修的问题";

/** 内置策略不写本机 agent 名；要把某个会话加进来，在 config.json 里写同 id 的条目覆盖 match（按 id 合并）。 */
export const BUILTIN_POLICIES: readonly CtxPolicy[] = [
  { id: "executor", projects: [], names: ["agent-task-*"], window: 200_000, idleMinutes: 3, hardCap: 250_000, action: "compact", ccWindow: 300_000, keep: null },
  { id: "coordinator", projects: [], names: ["agent-pm-*"], window: 300_000, idleMinutes: 5, hardCap: 400_000, action: "save-compact", ccWindow: null, keep: null },
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : null;

/** 按 id 合并出一条策略；返回 null = 这条不生效（原因已写进 warnings） */
function parseOne(e: Record<string, unknown>, id: string, base: CtxPolicy | null, warn: (t: string) => void): CtxPolicy | null {
  const m = isObj(e.match) ? e.match : {};
  const projects = strList(m.projects) ?? base?.projects ?? [];
  const names = strList(m.names) ?? base?.names ?? [];
  if (!projects.length && !names.length) {
    warn("没有匹配条件（match.projects / match.names），已忽略");
    return null;
  }
  const num = (k: "window" | "hardCap"): number | null => {
    if (e[k] === undefined) return base?.[k] ?? null;
    const v = posInt(e[k]);
    if (v === null) warn(`${k} 必须是正整数，收到 ${JSON.stringify(e[k])}`);
    return v ?? base?.[k] ?? null;
  };
  const window = num("window");
  if (window === null) {
    warn("缺 window，已忽略");
    return null;
  }
  let hardCap = num("hardCap") ?? window;
  if (hardCap < window) {
    warn(`hardCap ${hardCap} 小于 window ${window}，按 window 算`);
    hardCap = window;
  }
  let idleMinutes = base?.idleMinutes ?? 3;
  if (e.idleMinutes !== undefined) {
    if (typeof e.idleMinutes === "number" && Number.isFinite(e.idleMinutes) && e.idleMinutes >= 0) idleMinutes = e.idleMinutes;
    else warn(`idleMinutes 必须是非负数，收到 ${JSON.stringify(e.idleMinutes)}`);
  }
  let action: CompactAction = base?.action ?? "compact";
  if (e.action !== undefined) {
    if (e.action === "compact" || e.action === "save-compact") action = e.action;
    else warn(`action 只能是 compact 或 save-compact，收到 ${JSON.stringify(e.action)}`);
  }
  let ccWindow = base?.ccWindow ?? null;
  if (e.ccWindow === null) ccWindow = null;
  else if (e.ccWindow !== undefined) {
    const v = posInt(e.ccWindow);
    if (v !== null && v >= CC_WINDOW_MIN && v <= CC_WINDOW_MAX) ccWindow = v;
    else {
      warn(`ccWindow ${JSON.stringify(e.ccWindow)} 超出 CC 接受的 10 万～100 万整数，已忽略（CC 自己也会悄悄丢掉它）`);
      ccWindow = null;
    }
  }
  const keep = typeof e.keep === "string" && e.keep.trim() ? e.keep.replace(/\s*\n\s*/g, " ").trim() : base?.keep ?? null;
  return { id, projects, names, window, idleMinutes, hardCap, action, ccWindow, keep };
}

/**
 * 执行者（worktree 里的 agent-task-*）不跑 /save-compact：它写的是主仓的 memory 目录，和 PM 共用，HANDOFF.md 会被覆盖
 * （09-29 01:49 实测）。所以不管策略怎么配，执行者一律按 compact（带保留清单）执行；没匹配到策略的个人 agent 各在自己的仓里，照旧。
 */
const EXECUTOR_PREFIX = "agent-task-";
export function effectiveAction(agentName: string, action: CompactAction): CompactAction {
  return action === "save-compact" && agentName.startsWith(EXECUTOR_PREFIX) ? "compact" : action;
}

/** 名字模式有没有可能命中执行者：通配符前的字面部分与 agent-task- 互为前缀就算（宁可多报） */
function mayMatchExecutor(pattern: string): boolean {
  const lit = pattern.split(/[*?]/)[0];
  return lit.startsWith(EXECUTOR_PREFIX) || EXECUTOR_PREFIX.startsWith(lit);
}

/** 搭配问题：不拦，只报（配置照样生效；执行者的 action 在 effectiveAction 里兜住） */
function crossCheck(p: CtxPolicy, warn: (t: string) => void): void {
  if (p.ccWindow !== null && p.hardCap >= p.ccWindow - CC_COMPACT_BUFFER) {
    warn(`hardCap ${p.hardCap} 不低于 CC 的实际压缩点（约 ${p.ccWindow - CC_COMPACT_BUFFER}）：CC 会先压，带保留清单的那一步等不到`);
  }
  if (p.action === "save-compact" && (p.names.some(mayMatchExecutor) || (p.projects.length > 0 && p.names.length === 0))) {
    warn("action 是 save-compact，但会命中执行者（agent-task-*）：执行者一律改按 compact 执行——worktree 里的 save-compact 会写主仓 memory，覆盖 PM 的 HANDOFF");
  }
}

/**
 * config.json 的 autoCompact.policies → 生效的策略表。
 *   - 没写这个键：只用内置策略；
 *   - 条目按 id 合并到同 id 的内置策略上（只写想改的字段），`enabled: false` 关掉一条；新 id 是新策略；
 *   - 顺序：配置里写的在前（按写的顺序），没提到的内置策略在后——同一优先级取第一个命中的。
 */
export function resolvePolicies(raw: unknown): { policies: CtxPolicy[]; warnings: PolicyWarning[] } {
  const warnings: PolicyWarning[] = [];
  if (raw === undefined || raw === null) return { policies: [...BUILTIN_POLICIES], warnings };
  if (!Array.isArray(raw)) {
    warnings.push({ policy: null, text: "autoCompact.policies 不是数组，已忽略，按内置策略" });
    return { policies: [...BUILTIN_POLICIES], warnings };
  }
  const seen = new Set<string>();
  const out: CtxPolicy[] = [];
  raw.forEach((e, i) => {
    if (!isObj(e)) {
      warnings.push({ policy: null, text: `autoCompact.policies[${i}] 不是对象，已忽略` });
      return;
    }
    const id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : `policy-${i + 1}`;
    const warn = (text: string) => warnings.push({ policy: id, text });
    if (seen.has(id)) {
      warn("id 重复，后面这条已忽略");
      return;
    }
    seen.add(id);
    if (e.enabled === false) return;
    const p = parseOne(e, id, BUILTIN_POLICIES.find((b) => b.id === id) ?? null, warn);
    if (!p) return;
    crossCheck(p, warn);
    out.push(p);
  });
  for (const b of BUILTIN_POLICIES) if (!seen.has(b.id)) out.push(b);
  return { policies: out, warnings };
}

/** `*` 任意串、`?` 单字符，整名锚定、大小写敏感 */
export function globMatch(pattern: string, name: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(name);
}

function nameMatches(patterns: string[], name: string): boolean {
  // 大总管只认字面名，通配符（包括 "*"）不算：它是 owner 的主会话，不能被一条宽泛的模式顺手压掉
  if (isMasterAgent(name)) return patterns.some((p) => isMasterAgent(p));
  return patterns.some((p) => globMatch(p, name));
}

type PolicyVia = "project+name" | "project" | "name";
export interface PolicyMatch {
  policy: CtxPolicy;
  via: PolicyVia;
}

const RANK: Record<PolicyVia, number> = { "project+name": 3, project: 2, name: 1 };

/**
 * 优先级：同时写了项目和名字且都命中 > 只写项目 > 只写名字；同级取表里第一个。
 * 一条策略同时写了项目和名字时两个都要命中（且）。
 */
export function matchPolicy(policies: readonly CtxPolicy[], agent: { name: string; projectId?: string | null }): PolicyMatch | null {
  let best: PolicyMatch | null = null;
  for (const p of policies) {
    const pOk = p.projects.length > 0 && !!agent.projectId && p.projects.includes(agent.projectId);
    const nOk = p.names.length > 0 && nameMatches(p.names, agent.name);
    let via: PolicyVia | null = null;
    if (p.projects.length && p.names.length) via = pOk && nOk ? "project+name" : null;
    else if (p.projects.length) via = pOk ? "project" : null;
    else via = nOk ? "name" : null;
    if (via && (!best || RANK[via] > RANK[best.via])) best = { policy: p, via };
  }
  return best;
}

/** 注入给 agent 的那一行（tmux 发一行，所以清单不能带换行） */
export function compactCommand(action: CompactAction, keep: string | null): string {
  return action === "save-compact" ? "/save-compact" : `/compact ${keep ?? DEFAULT_KEEP_LIST}`;
}

/** 第 1 层：启动这个会话时要合进 `--settings` 的键。没策略 / 策略没写 ccWindow → 空对象（不带，CC 用默认）。 */
export function ccLaunchSettings(m: PolicyMatch | null): { autoCompactWindow?: number } {
  return m?.policy.ccWindow ? { autoCompactWindow: m.policy.ccWindow } : {};
}

// ── 这一轮用哪条线 ─────────────────────────────────────────────────────

/** 一个 agent 这一轮生效的边界：命中的策略，或退回全局 */
export interface Boundary {
  policy: string;
  via: PolicyVia | "global";
  /** 0 = 软边界关（全局 window=0） */
  window: number;
  /** null = 没有硬上限（全局且拿不到真实窗口） */
  hardCap: number | null;
  idleMs: number;
  action: CompactAction;
  keep: string | null;
  ccWindow: number | null;
}

export interface GlobalAutoCompact {
  window?: number;
  idleHours?: number;
  emergency?: boolean;
}

// 全局口径（从 stats-dashboard 原样搬来）：缺省 40 万 + 闲置 3 小时；拿得到真实窗口时软线收到 85%、救命线 93%。
// 救命线离 CC 默认的 ~967K 只剩几万，踩到就不管闲置（打断一次 ≪ 被 CC 裸压丢记忆）。来龙去脉：git log -S EMERGENCY_WINDOW_RATIO
const DEFAULT_GLOBAL_WINDOW = 400_000;
const DEFAULT_GLOBAL_IDLE_HOURS = 3;
const REAL_WINDOW_TRIGGER_RATIO = 0.85;
const EMERGENCY_WINDOW_RATIO = 0.93;

export function globalBoundary(cfg: GlobalAutoCompact | undefined, realWindow: number | null): Boundary {
  const w = cfg?.window;
  const base = w === 0 ? 0 : typeof w === "number" && Number.isFinite(w) && w > 0 ? w : DEFAULT_GLOBAL_WINDOW;
  const h = cfg?.idleHours;
  const idleHours = h === 0 ? 0 : typeof h === "number" && Number.isFinite(h) && h > 0 ? h : DEFAULT_GLOBAL_IDLE_HOURS;
  return {
    policy: "global",
    via: "global",
    window: base > 0 && realWindow ? Math.min(base, Math.floor(realWindow * REAL_WINDOW_TRIGGER_RATIO)) : base,
    // 救命线独立于软线：window=0 关了软线它照样兜底
    hardCap: cfg?.emergency !== false && realWindow ? Math.floor(realWindow * EMERGENCY_WINDOW_RATIO) : null,
    idleMs: idleHours * 3600_000,
    action: "save-compact",
    keep: null,
    ccWindow: null,
  };
}

/** 策略的线同样不越过真实窗口的 85% / 93%（小窗口模型上 CC 会先压） */
export function policyBoundary(m: PolicyMatch, realWindow: number | null): Boundary {
  const p = m.policy;
  const cap = (v: number, ratio: number) => (realWindow ? Math.min(v, Math.floor(realWindow * ratio)) : v);
  return {
    policy: p.id,
    via: m.via,
    window: cap(p.window, REAL_WINDOW_TRIGGER_RATIO),
    hardCap: cap(p.hardCap, EMERGENCY_WINDOW_RATIO),
    idleMs: p.idleMinutes * 60_000,
    action: p.action,
    keep: p.keep,
    ccWindow: p.ccWindow,
  };
}

// ── 决策表 ─────────────────────────────────────────────────────────────

/** pane 上读出的额度墙 / low-priority / 选择菜单 / 压缩中（来源 lib/lp-state.ts 的 paneQuotaState） */
export interface PaneQuotaState {
  wall: boolean;
  lp: "on" | "off" | "unknown";
  menu: boolean;
  compacting: boolean;
}

export interface BoundaryInput {
  ctx: number;
  window: number;
  hardCap: number | null;
  /** 最后一条真实对话距今满 idleMs，且画面不在忙 */
  idle: boolean;
  /** null = 读不到画面 */
  pane: PaneQuotaState | null;
  /** 画面上已有排队消息（「Press up to edit queued messages」） */
  queued: boolean;
  /** bridge 刚注入过压缩（守卫期内） */
  injectedRecently: boolean;
  lastTrig: number;
  now: number;
  retryMs: number;
}

export type SkipReason = "under" | "compacting" | "retry-wait" | "pane-unknown" | "quota-wall" | "menu" | "queued" | "busy";
export type BoundaryVerdict = { fire: true; kind: "idle" | "hard-cap" } | { fire: false; reason: SkipReason };

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  under: "没过线",
  compacting: "正在压缩",
  "retry-wait": "30 分钟内注入过，还没见效",
  "pane-unknown": "读不到画面",
  "quota-wall": "撞了额度墙又没开 low-priority",
  menu: "画面上有选择菜单",
  queued: "已经有排队的消息",
  busy: "还在忙",
};

/**
 * 按顺序判，先命中先返回：
 *   没过线 → 正在压缩 → 30 分钟重试冷却 → 读不到画面 → 撞墙且没开 LP → 画面上有选择菜单 → 已有排队消息
 *   → 过硬上限（忙也注入，排队到回合结束） → 过软线且闲置 → 其余（忙）不动。
 * 撞墙那条排在冷却之后、且不开火，所以不占重试计时；菜单那条挡的是「往菜单里敲字」——额度墙菜单第 3 项是花钱的 usage credits。
 */
export function boundaryDecision(i: BoundaryInput): BoundaryVerdict {
  const overSoft = i.window > 0 && i.ctx >= i.window;
  const overHard = i.hardCap !== null && i.ctx >= i.hardCap;
  if (!overSoft && !overHard) return { fire: false, reason: "under" };
  if (i.injectedRecently || i.pane?.compacting) return { fire: false, reason: "compacting" };
  if (i.lastTrig > 0 && i.now - i.lastTrig <= i.retryMs) return { fire: false, reason: "retry-wait" };
  if (!i.pane) return { fire: false, reason: "pane-unknown" };
  if (i.pane.wall && i.pane.lp !== "on") return { fire: false, reason: "quota-wall" };
  if (i.pane.menu) return { fire: false, reason: "menu" };
  if (i.queued) return { fire: false, reason: "queued" };
  if (overHard) return { fire: true, kind: "hard-cap" };
  if (i.idle) return { fire: true, kind: "idle" };
  return { fire: false, reason: "busy" };
}

// ── 显示 ───────────────────────────────────────────────────────────────

type BoundaryLevel = "ok" | "over" | "cap";

/** 面板 / 网页列表显示用：命中哪条、离软线还剩多少（负数 = 已超出）、过线等级 */
export interface CtxBoundaryView {
  policy: string;
  via: PolicyVia | "global";
  window: number;
  hardCap: number | null;
  remaining: number | null;
  level: BoundaryLevel;
  action: CompactAction;
  ccWindow: number | null;
  warnings: string[];
}

const LABEL: Record<string, string> = { executor: "执行类", coordinator: "协调类", global: "全局" };
/** 面板上显示的策略名：内置的给中文名，自定义的显示 id */
export const boundaryLabel = (policy: string): string => LABEL[policy] ?? policy;

export function boundaryView(b: Boundary, ctx: number | null, warnings: PolicyWarning[] = []): CtxBoundaryView {
  const c = ctx ?? 0;
  const level: BoundaryLevel = b.hardCap !== null && c >= b.hardCap ? "cap" : b.window > 0 && c >= b.window ? "over" : "ok";
  return {
    policy: b.policy,
    via: b.via,
    window: b.window,
    hardCap: b.hardCap,
    remaining: b.window > 0 && ctx !== null ? b.window - ctx : null,
    level,
    action: b.action,
    ccWindow: b.ccWindow,
    warnings: warnings.filter((w) => w.policy === b.policy).map((w) => w.text),
  };
}

/**
 * 批量管理（fleet）的纯逻辑：动作白名单、选人、结果汇总。发键在 bridge/fleet/runner.ts，这里不碰 tmux。
 * 大总管默认不在批量范围里：只有 includeMaster 或在 agents 里点名 master 才算「单独勾选」。
 * 用例见 tests/fleet-plan.test.ts。
 */
import { neutralizeDelegateMarker } from "./delegate-marker.js";
import type { LpMode } from "./lp-state.js";

export type FleetActionKind = "lp-on" | "lp-off" | "compact" | "save-compact" | "lp-compact" | "text";
export const FLEET_ACTIONS: readonly FleetActionKind[] = ["lp-on", "lp-off", "compact", "save-compact", "lp-compact", "text"];

export interface FleetAction {
  kind: FleetActionKind;
  /** compact / lp-compact 的保留清单；缺省用 compactKeep() */
  keep?: string;
  /** text 动作的正文（走 deliver，带来源头） */
  text?: string;
}

/** 只动 Claude Code 会话的动作（LP 与 /compact 都是 CC 的 TUI 命令）；text 走 deliver，所有运行时都能收 */
export function ccOnly(kind: FleetActionKind): boolean {
  return kind !== "text";
}

/**
 * 默认保留清单（config.json 的 fleet.compactKeep 可覆盖，面板可临时改）。不带编号数字：万一敲进了编号对话框，
 * 数字键会直接选中选项（权限框的 1 = Yes）
 */
export const DEFAULT_COMPACT_KEEP =
  "摘要必须让新上下文无需返工、无需重新提供约束就能接着干。务必保留:遇到的难点/问题及其处理与结果;提出、尝试或放弃过的方案及原因;" +
  "用户与 PM 的要求、决定、同意、否决、确立为约束/边界的内容——按原话;当前精确进度:已覆盖/已定/已完成的,分支名、head、PR 号;" +
  "未了、未决、已承诺、预期接下来发生的事,以及被额度打断时正在做的那一步;难以重建的细节——名字、数字、日期、原话、路径、命令、链接——原样保留。" +
  "以上宁长勿缺,其余从简。";

const MAX_KEEP = 2000;
const MAX_TEXT = 4000;

/**
 * 保留清单是用 send-keys -l 原样敲进输入框的：换行等于回车（半截清单会被当成命令提交），ESC 等控制字符会被 TUI 当成按键。
 * 所以控制字符一律换成空格、压成一行。
 */
function oneLine(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** text 与 keep 都会进 agent 的上下文：里面的委托标记（[📨 委托转达] 及变体）一律中和，不许冒充 owner 委托 */
const clean = (s: string) => neutralizeDelegateMarker(s);

export function compactCommand(keep: string): string {
  const k = oneLine(clean(keep));
  return k ? `/compact ${k}` : "/compact";
}

export function parseFleetAction(input: unknown): { ok: true; action: FleetAction } | { ok: false; error: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const kind = typeof input === "string" ? input : o.kind;
  if (typeof kind !== "string" || !FLEET_ACTIONS.includes(kind as FleetActionKind)) {
    return { ok: false, error: `动作只能是 ${FLEET_ACTIONS.join(" / ")}` };
  }
  const action: FleetAction = { kind: kind as FleetActionKind };
  if (o.keep !== undefined) {
    if (typeof o.keep !== "string" || o.keep.length > MAX_KEEP) return { ok: false, error: `keep 要是不超过 ${MAX_KEEP} 字的字符串` };
    if (kind === "compact" || kind === "lp-compact") action.keep = oneLine(clean(o.keep));
  }
  if (kind === "text") {
    if (typeof o.text !== "string" || !o.text.trim()) return { ok: false, error: "text 动作要带非空的 text" };
    if (o.text.length > MAX_TEXT) return { ok: false, error: `text 不能超过 ${MAX_TEXT} 字` };
    action.text = clean(o.text.trim());
  }
  return { ok: true, action };
}

// ── 选人 ──

export interface FleetCandidate {
  /** registry 名（带 agent- 前缀）；大总管是 "master" */
  name: string;
  project?: string;
  runtime: string;
  master: boolean;
  /** 窗口在、channel-server 连着 */
  online: boolean;
  lowPriority?: LpMode;
  walled?: boolean;
  contextTokens?: number;
}

export interface FleetSelect {
  agents?: string[];
  all?: boolean;
  project?: string;
  /** 条件：只要撞墙等待中的 */
  walled?: boolean;
  /** 条件：上下文超过这么多 token */
  ctxOver?: number;
  includeMaster?: boolean;
}

export const bareName = (n: string) => String(n).replace(/^agent-/, "");

export function parseFleetSelect(input: unknown): { ok: true; select: FleetSelect } | { ok: false; error: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const s: FleetSelect = {};
  if (o.agents !== undefined) {
    if (!Array.isArray(o.agents) || o.agents.some((a) => typeof a !== "string" || !a.trim())) return { ok: false, error: "agents 要是名字数组" };
    s.agents = (o.agents as string[]).map((a) => a.trim());
  }
  if (o.all !== undefined) s.all = o.all === true;
  if (o.project !== undefined) {
    if (typeof o.project !== "string" || !o.project.trim()) return { ok: false, error: "project 要是项目 id" };
    s.project = o.project.trim();
  }
  if (o.walled !== undefined) s.walled = o.walled === true;
  if (o.ctxOver !== undefined) {
    if (typeof o.ctxOver !== "number" || !Number.isFinite(o.ctxOver) || o.ctxOver < 0) return { ok: false, error: "ctxOver 要是非负数（token）" };
    s.ctxOver = o.ctxOver;
  }
  if (o.includeMaster !== undefined) s.includeMaster = o.includeMaster === true;
  if (!s.agents?.length && !s.all && !s.project) return { ok: false, error: "要指定 agents、all 或 project 之一" };
  return { ok: true, select: s };
}

export interface Excluded { name: string; reason: string }

/** 先定范围（点名 / 全部 / 项目，三者取并集），再按条件过滤（撞墙中、上下文超线，取交集） */
export function selectTargets<T extends FleetCandidate>(cands: T[], sel: FleetSelect): { targets: T[]; excluded: Excluded[] } {
  const byName = new Map(cands.map((c) => [bareName(c.name), c]));
  const named = new Set((sel.agents ?? []).map(bareName));
  const excluded: Excluded[] = [];
  for (const n of named) if (!byName.has(n)) excluded.push({ name: n, reason: "没有这个 agent" });
  const inScope = (c: FleetCandidate) =>
    named.has(bareName(c.name)) || (c.master ? !!sel.includeMaster : !!sel.all || (!!sel.project && c.project === sel.project));
  const targets: T[] = [];
  for (const c of cands) {
    if (!inScope(c)) continue;
    if (sel.walled && !c.walled) { excluded.push({ name: bareName(c.name), reason: "没在撞墙等待" }); continue; }
    if (sel.ctxOver !== undefined && !((c.contextTokens ?? 0) > sel.ctxOver)) {
      excluded.push({ name: bareName(c.name), reason: `上下文没超过 ${sel.ctxOver}` });
      continue;
    }
    targets.push(c);
  }
  return { targets, excluded };
}

/** 动作对这个 agent 适不适用；不适用返回跳过理由（不发键） */
export function notApplicable(action: FleetAction, c: FleetCandidate): string | null {
  if (!c.online) return "不在线";
  if (ccOnly(action.kind) && c.runtime !== "claude-code") return `运行时不支持（${c.runtime}）`;
  return null;
}

// ── 结果 ──

export type FleetOutcome = "done" | "queued" | "skipped" | "failed";
export interface FleetResult { agent: string; outcome: FleetOutcome; detail: string }

const OUTCOME_LABEL: Record<FleetOutcome, string> = { done: "已执行", queued: "已排队", skipped: "已跳过", failed: "失败" };
export const ACTION_LABEL: Record<FleetActionKind, string> = {
  "lp-on": "开 low-priority",
  "lp-off": "关 low-priority",
  compact: "/compact",
  "save-compact": "/save-compact",
  "lp-compact": "开 low-priority 再压缩",
  text: "自定义文本",
};

export function summarizeFleet(action: FleetAction, results: FleetResult[], excluded: Excluded[] = []) {
  const counts: Record<FleetOutcome, number> = { done: 0, queued: 0, skipped: 0, failed: 0 };
  for (const r of results) counts[r.outcome]++;
  const head = `${ACTION_LABEL[action.kind]}：${results.length} 个 agent · ` +
    (Object.keys(counts) as FleetOutcome[]).filter((k) => counts[k]).map((k) => `${OUTCOME_LABEL[k]} ${counts[k]}`).join(" · ");
  const lines = results.map((r) => `- ${bareName(r.agent)}：${OUTCOME_LABEL[r.outcome]}${r.detail ? `（${r.detail}）` : ""}`);
  const ex = excluded.map((e) => `- ${e.name}：未选中（${e.reason}）`);
  return { counts, text: [results.length ? head : `${ACTION_LABEL[action.kind]}：没有选中任何 agent`, ...lines, ...ex].join("\n") };
}

export const outcomeLabel = (o: FleetOutcome) => OUTCOME_LABEL[o];

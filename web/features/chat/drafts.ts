/**
 * 输入框草稿（2026-07-13 owner：未发送文字按 agent 存 localStorage，切走再回来原样
 * 恢复，发送即清）。2026-09-24 起从 composer 抽出来并加订阅：侧栏要给「非激活且有
 * 草稿」的会话打标（owner「切到其他会话时，左侧列表会显示一个【草稿】的标记」），
 * 所以有无草稿必须是可订阅的状态，而不是 composer 私藏的 localStorage 读写。
 * 纯逻辑 + 模块级 store，无 React；单测见 tests/web-drafts.test.ts。
 */

export const DRAFT_KEY_PREFIX = "cstra_draft_";

export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function draftKey(agent: string): string {
  return DRAFT_KEY_PREFIX + agent;
}

export function readDraft(storage: MinimalStorage | null, agent: string): string {
  if (!storage || !agent) return "";
  try {
    return storage.getItem(draftKey(agent)) || "";
  } catch {
    return ""; // 隐私模式读不到 = 没草稿
  }
}

/** 空白即删：只存有内容的草稿，侧栏标记也以此为准。 */
export function writeDraft(storage: MinimalStorage | null, agent: string, value: string): void {
  if (!storage || !agent) return;
  try {
    if (value.trim()) storage.setItem(draftKey(agent), value);
    else storage.removeItem(draftKey(agent));
  } catch {
    /* 隐私模式写不进：本次会话内 composer 的 state 仍在，只是刷新后丢 */
  }
}

// ── 模块级 store：有无草稿变化时通知订阅者（每 300ms 的随打随存不触发重渲） ──
const subs = new Set<() => void>();
let override: MinimalStorage | null | undefined;

/** 根 tsconfig 无 dom lib：不直接引用 window / localStorage；测试用 setDraftStorage 注入 */
function storage(): MinimalStorage | null {
  if (override !== undefined) return override;
  try {
    return ((globalThis as { localStorage?: MinimalStorage }).localStorage as MinimalStorage | undefined) ?? null;
  } catch {
    return null; // 某些嵌入环境访问 localStorage 直接抛 SecurityError
  }
}

export function setDraftStorage(s: MinimalStorage | null | undefined): void {
  override = s;
}

function notify(): void {
  subs.forEach((f) => f());
}

export function loadDraft(agent: string): string {
  return readDraft(storage(), agent);
}

export function hasDraft(agent: string): boolean {
  return readDraft(storage(), agent).trim().length > 0;
}

export function saveDraft(agent: string, value: string): void {
  const before = hasDraft(agent);
  writeDraft(storage(), agent, value);
  if (hasDraft(agent) !== before) notify();
}

export function clearDraft(agent: string): void {
  saveDraft(agent, "");
}

export function subscribeDrafts(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

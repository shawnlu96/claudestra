/**
 * 切模型 / 档位后的乐观显示（owner 2026-07-27:「切换完直接把模型显示成新的，读到 jsonl 不一样再改」）。
 * 切换成功后先记在这里，agents 列表优先显示；一旦会话记录里实测到**切换之后**的记录（无论值是否一致），
 * 实测重新接管并清掉本条——切换静默失败最多骗到下一条消息为止。
 * 内存态，bridge 重启即退回纯实测链（只差一条消息的显示滞后，可接受）。
 * Claude Code、Pi、Codex 三条切换路径共用。
 */
import type { SessionTailInfo } from "../lib/session-tail.js";

const switchOverride = new Map<string, { model?: { v: string; ts: number }; effort?: { v: string; ts: number } }>();
const overrideKey = (name: string) => String(name).replace(/^agent-/, "");

/** 记一次"刚切换"的乐观值 */
export function rememberSwitchOverride(name: string, patch: { model?: string; effort?: string }): void {
  const key = overrideKey(name);
  const prev = switchOverride.get(key) ?? {};
  const now = Date.now();
  switchOverride.set(key, {
    model: patch.model ? { v: patch.model, ts: now } : prev.model,
    effort: patch.effort ? { v: patch.effort, ts: now } : prev.effort,
  });
}

/** 列表侧取乐观值：比实测记录新才算数；两个字段都被实测追上就顺手清掉 */
export function pickSwitchOverride(name: string, info: SessionTailInfo | null | undefined) {
  const key = overrideKey(name);
  const ov = switchOverride.get(key);
  if (!ov) return { model: null as string | null, effort: null as string | null };
  const model = ov.model && ov.model.ts > (info?.modelTs ?? 0) ? ov.model.v : null;
  const effort = ov.effort && ov.effort.ts > (info?.effortTs ?? 0) ? ov.effort.v : null;
  if (model === null && effort === null) switchOverride.delete(key);
  return { model, effort };
}

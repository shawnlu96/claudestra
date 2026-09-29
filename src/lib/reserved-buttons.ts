/**
 * bridge 自己处理的按钮 / 选单 id（不经 LLM：管理面板、权限弹窗、编排班子提案确认……）的中央保留表。
 * 这些按钮一点就直接执行，所以只能由 bridge 自己贴：agent（reply / send_to_agent / 行内按钮）、本机进程（notify）、
 * peer 发出的消息里只要带了保留 id 就整条拒绝——否则被提示注入的 agent 贴一个「✅ 继续」、id 却是 team_ok:… / swmodel_yes:…，
 * owner 一点就替它执行了。新增 bridge 处理的按钮必须登记在 lib/reserved-button-ids.ts（网页有一份 twin）：tests/reserved-buttons.test.ts 会扫
 * bridge/management.ts 与 bridge/discord-interactions.ts 里的 id 字面量，漏登记就失败。
 */
import { parseInlineButtons } from "./inline-buttons.js";
import { isReservedButtonId } from "./reserved-button-ids.js";

export { isReservedButtonId, RESERVED_BUTTONS } from "./reserved-button-ids.js";

/** components 里所有按钮 / 选单的 id（行：{type:"buttons",buttons:[{id}]}、{type:"select"|"multiselect",id}） */
function componentIds(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  const out: string[] = [];
  for (const row of components) {
    if (!row || typeof row !== "object") continue;
    const r = row as { id?: unknown; buttons?: unknown };
    if (typeof r.id === "string") out.push(r.id);
    if (Array.isArray(r.buttons)) for (const b of r.buttons) if (b && typeof (b as { id?: unknown }).id === "string") out.push((b as { id: string }).id);
  }
  return out;
}

/** 消息里第一个撞上保留表的 id（正文里的行内按钮 + components）；没有为 null */
export function reservedButtonIn(text: string, components: unknown): string | null {
  const ids = [...parseInlineButtons(text).map((b) => b.id), ...componentIds(components)];
  return ids.find(isReservedButtonId) ?? null;
}

/**
 * 谁发的消息可以带保留 id：只有 bridge 自己的代码路径。bridge 名下的 notify:*（本机任何进程都能经 ws 发 notify）不算；
 * 返回拒绝原因，null = 放行。
 */
export function reservedButtonRefusal(
  from: { kind: string; label?: string },
  text: string,
  components: unknown,
): string | null {
  if (from.kind === "bridge" && !(from.label ?? "").startsWith("notify:")) return null;
  const hit = reservedButtonIn(text, components);
  return hit ? `按钮 id「${hit}」是 bridge 保留的管理按钮（点了不经 LLM 直接执行），只有 bridge 自己能发；换一个 id` : null;
}

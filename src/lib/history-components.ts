/**
 * 历史里 reply 附带的 components 清洗（从 session-history.ts 原样搬出，给大文件腾行数；tests/session-history.test.ts 覆盖）。
 */
import type { ReplyComponentRow } from "./session-history.js";

/** jsonl 里的 components 不可信——只放行结构完整的按钮行/选单行，其余丢弃。 */
export function sanitizeComponents(raw: unknown): ReplyComponentRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplyComponentRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.type === "buttons" && Array.isArray(r.buttons)) {
      const buttons = r.buttons
        .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
        .filter((b) => typeof b.id === "string" && typeof b.label === "string")
        .map((b) => ({
          id: b.id as string,
          label: b.label as string,
          ...(typeof b.style === "string" ? { style: b.style } : {}),
          ...(typeof b.emoji === "string" ? { emoji: b.emoji } : {}),
        }));
      if (buttons.length) out.push({ type: "buttons", buttons });
    } else if ((r.type === "select" || r.type === "multiselect") && typeof r.id === "string" && Array.isArray(r.options)) {
      const options = r.options
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .filter((o) => typeof o.label === "string" && typeof o.value === "string")
        .map((o) => ({
          label: o.label as string,
          value: o.value as string,
          ...(typeof o.description === "string" ? { description: o.description } : {}),
        }));
      if (options.length) {
        // v2.14+ multiselect 与 select 同构，只多 min/max/submitLabel 三个可选字段。
        // ⚠ 这里漏认一种类型的后果不是「样式不对」而是**整组交互从历史里消失**——
        // 刷新页面后按钮就没了（owner 2026-07-25 实报「哪有多选按钮」）。
        out.push({
          type: r.type as "select" | "multiselect",
          id: r.id,
          ...(typeof r.placeholder === "string" ? { placeholder: r.placeholder } : {}),
          ...(r.type === "multiselect" && typeof r.min === "number" ? { min: r.min } : {}),
          ...(r.type === "multiselect" && typeof r.max === "number" ? { max: r.max } : {}),
          ...(r.type === "multiselect" && typeof r.submitLabel === "string"
            ? { submitLabel: r.submitLabel }
            : {}),
          options,
        });
      }
    }
  }
  return out;
}

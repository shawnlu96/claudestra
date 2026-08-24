/**
 * reply() 交互组件的「已作答」状态模型（bug ① 修复,2026-08-24）。
 *
 * 旧模型 `replyClickedId?: string` 是**消息级单值**:一条 reply 里放多个 select
 * row,答完任一行 → 整条消息所有行一起禁用(`disabled = !!m.replyClickedId`),
 * 且存不下「A 行选了 x、B 行选了 y」。owner 实报「多次多选 selector 点了就灰」,
 * 且 agent 只收到第 1 行的回投、其余静默丢失。
 *
 * 新模型:`replyClicks: Record<rowKey, chosenValue>` —— 每一**行**独立作答。
 * rowKey 必须在「点击时(前端有 row+ri)」和「历史还原时(BFF 有 components 数组)」
 * 两侧都能算出同一个值,所以刻意做成 (row, ri) 的纯函数。
 */
import type { WebComponentRow } from "./events";

/**
 * 行的稳定 key:buttons 行按下标(同一 components 数组里位置稳定、两侧同序遍历),
 * select/multiselect 行按 row.id(带类型前缀防跨类型撞号)。
 */
export function replyRowKey(row: WebComponentRow, ri: number): string {
  if (row.type === "buttons") return `b${ri}`;
  return `${row.type === "multiselect" ? "m" : "s"}:${row.id}`;
}

/** 存进 replyClicks[rowKey] 的值:buttons=按钮 id;select/multiselect=`<id>:<值(逗号分隔)>`。
 *  与前端 `chosen` 高亮判定、MultiSelectRow 的已答解析对齐。 */
export interface ClickedRow {
  rowKey: string;
  choiceValue: string;
  label: string;
}

/**
 * 历史还原:把一条回投 payload(`[button:X]` / `[select:ID:V]`)映射回它所属的行。
 * 返回 rowKey + 存储值 + 人类可读 label(渲染成用户气泡)。
 */
export function matchClickedRow(
  rows: WebComponentRow[] | undefined,
  btnId: string | null,
  selId: string | null,
  selValue: string | null,
): ClickedRow | null {
  if (!rows) return null;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (row.type === "buttons" && btnId) {
      const btn = row.buttons.find((b) => b.id === btnId);
      if (btn) return { rowKey: replyRowKey(row, ri), choiceValue: btnId, label: btn.label };
    }
    if (row.type === "select" && selId && row.id === selId && selValue) {
      const opt = row.options.find((o) => o.value === selValue);
      if (opt) return { rowKey: replyRowKey(row, ri), choiceValue: `${selId}:${selValue}`, label: opt.label };
    }
    // 多选回投是逗号分隔的 [select:id:v1,v2] —— 逐个映射回 label 再拼。
    if (row.type === "multiselect" && selId && row.id === selId && selValue) {
      const values = selValue.split(",").map((v) => v.trim()).filter(Boolean);
      const labels = values
        .map((v) => row.options.find((o) => o.value === v)?.label)
        .filter((l): l is string => !!l);
      if (labels.length) {
        return { rowKey: replyRowKey(row, ri), choiceValue: `${selId}:${values.join(",")}`, label: labels.join("、") };
      }
    }
  }
  return null;
}

/**
 * 老快照兼容:只有 `replyClickedId`(单值)时,推出它属于哪一行 → 等价的 replyClicks。
 * clickedId 形态:buttons=按钮 id;select/multiselect=`<id>:<值>`。查不到返回空对象
 * (退化成「都没答」,总比全锁死好)。
 */
export function deriveClicksFromLegacy(
  clickedId: string | undefined,
  rows: WebComponentRow[] | undefined,
): Record<string, string> {
  if (!clickedId || !rows) return {};
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (row.type === "buttons" && row.buttons.some((b) => b.id === clickedId)) {
      return { [replyRowKey(row, ri)]: clickedId };
    }
    if ((row.type === "select" || row.type === "multiselect") && clickedId.startsWith(`${row.id}:`)) {
      return { [replyRowKey(row, ri)]: clickedId };
    }
  }
  return {};
}

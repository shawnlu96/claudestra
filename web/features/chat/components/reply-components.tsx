"use client";
import { useMemo, useState } from "react";
import type { ChatMessage } from "../type";
import type { WebComponentRow } from "@/lib/chat/events";
import { replyRowKey, deriveClicksFromLegacy } from "@/lib/chat/reply-clicks";
import { useChatStoreApi } from "../chat-store";
import { editComposer, useComposerSnap, useOpenForms } from "../form-sync";
import { pickedFromText, renderFormLine, setFormValues, syncable, toggleFormValue } from "@/lib/chat/form-compose";
import { useT } from "@/lib/i18n";

/**
 * reply() 附带的交互组件（按钮 / 选单）Web 渲染。点击 → 回投
 * [button:<id>] / [select:<id>:<value>] 给 agent（与 Discord 侧语义一致），
 * 展示气泡用人类可读 label。
 *
 * bug ①（2026-08-24）：作答是**按行独立**的——一条 reply 里的多个 select row /
 * 按钮行各答各的，答完一行不再锁死其余行。状态在 m.replyClicks（rowKey→值），
 * 老快照的单值 replyClickedId 退化推导（deriveClicksFromLegacy）。
 */

const BTN_STYLE: Record<string, string> = {
  primary: "btn-primary",
  success: "btn-success",
  danger: "btn-error",
  secondary: "btn-ghost border border-base-content/15",
};
const btnClass = (style?: string) => BTN_STYLE[style ?? "secondary"] ?? BTN_STYLE.secondary;

export function ReplyComponents({ m }: { m: ChatMessage }) {
  const store = useChatStoreApi();
  const rows = m.replyComponents;
  // busy = 正在回投的那一行的 rowKey（只锁该行，不锁全条）。
  const [busy, setBusy] = useState("");
  // 每行的已答值：优先 replyClicks（新），回退老快照的单值。
  const clicks = useMemo(
    () => m.replyClicks ?? deriveClicksFromLegacy(m.replyClickedId, rows),
    [m.replyClicks, m.replyClickedId, rows],
  );
  if (!rows || rows.length === 0) return null;

  // 某一行的一次作答。rowKey 定位到行；choiceValue 存进 replyClicks 供高亮。
  const choose = async (rowKey: string, choiceValue: string, label: string, wire: string) => {
    if (clicks[rowKey] != null || busy) return;
    setBusy(rowKey);
    await store.clickReplyComponent(m.id, rowKey, choiceValue, label, wire);
    setBusy("");
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {rows.map((row: WebComponentRow, ri) => {
        const key = replyRowKey(row, ri);
        // Discord 同款语义：没答过的行一直可点（用户习惯隔几条消息再回来点）。
        // bug ① 前这里是 !!m.replyClickedId（整条消息级）——多行时答一行锁全部。
        const rowAnswered = clicks[key] != null;
        const rowBusy = busy === key;
        if (row.type === "buttons") {
          return (
            <div key={ri} className="flex flex-wrap gap-2">
              {row.buttons.map((b) => {
                const label = `${b.emoji ? `${b.emoji} ` : ""}${b.label}`;
                const chosen = clicks[key] === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    disabled={rowAnswered || busy !== ""}
                    onClick={() => choose(key, b.id, label, `[button:${b.id}]`)}
                    className={`btn btn-sm ${btnClass(b.style)} ${
                      rowAnswered && !chosen ? "opacity-40" : ""
                    } ${chosen ? "ring-2 ring-offset-1 ring-base-content/30" : ""}`}
                  >
                    {rowBusy && busy === key && !chosen ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      label
                    )}
                    {chosen && <span className="ml-1">✓</span>}
                  </button>
                );
              })}
            </div>
          );
        }
        // multiselect：勾选多项 + 一次提交（owner 2026-07-25:「参照 Claude 那种
        // 多选而不是单选」）。回投格式与 Discord 对齐：逗号分隔的
        // [select:<id>:<v1>,<v2>]，agent 侧一套解析吃两端。
        if (row.type === "multiselect") {
          return (
            <MultiSelectRow
              key={ri} messageId={m.id}
              row={row}
              disabled={rowAnswered}
              busy={busy !== ""}
              answeredValue={clicks[key]}
              onSubmit={(values, display) =>
                choose(
                  key,
                  `${row.id}:${values.join(",")}`,
                  display,
                  `[select:${row.id}:${values.join(",")}]`,
                )
              }
            />
          );
        }
        // select：选项竖排按钮，点一个即回投 [select:<id>:<value>]
        return (
          <div key={ri} className="flex flex-col gap-1">
            {row.placeholder && (
              <span className="text-[11px] opacity-50">{row.placeholder}</span>
            )}
            {row.options.map((o) => {
              const choiceId = `${row.id}:${o.value}`;
              const chosen = clicks[key] === choiceId;
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={rowAnswered || busy !== ""}
                  onClick={() => choose(key, choiceId, o.label, `[select:${row.id}:${o.value}]`)}
                  className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    chosen
                      ? "border-primary bg-primary/15"
                      : "border-base-content/10 bg-base-100/40 hover:bg-base-content/[0.04]"
                  } ${rowAnswered && !chosen ? "opacity-40" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="font-medium opacity-90">{o.label}</span>
                    {o.description && (
                      <span className="ml-1 opacity-50">{o.description}</span>
                    )}
                  </span>
                  {chosen && <span className="ml-auto shrink-0">✓</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 多选行：勾选若干项，再点提交一次性回投。
 * 未作答时勾选状态**就是输入框里该表单那一行**（lib/chat/form-compose.ts）：每勾 / 取消一项
 * 改写那一行，owner 手改那一行勾选也跟着变。同一 id 复用时的旧表单、选项不合格的表单、没有
 * 输入框（分享模式）时退回本地勾选，照样能「提交」。已作答的那一组保持勾选状态展示。
 */
function MultiSelectRow({
  messageId,
  row,
  disabled,
  busy,
  answeredValue,
  onSubmit,
}: {
  messageId: string;
  row: Extract<WebComponentRow, { type: "multiselect" }>;
  disabled: boolean;
  busy: boolean;
  /** 已答值 `<rowId>:<v1>,<v2>`（本行），用于回显勾选。 */
  answeredValue?: string;
  /** display = 气泡里显示的可读行（与输入框同步行、历史还原同形） */
  onSubmit: (values: string[], display: string) => void;
}) {
  const t = useT();
  const composer = useComposerSnap();
  const forms = useOpenForms();
  const form = forms.find((f) => f.messageId === messageId && f.row.id === row.id);
  const synced = !!form && composer.present && syncable(row) && forms.find((f) => f.row.id === row.id) === form;
  const [local, setLocal] = useState<string[]>([]);
  const owner = synced ? pickedFromText(composer.text, form, forms) : null;
  // 已作答时从本行已答值还原选中项（格式 `<rowId>:<v1>,<v2>`），否则读输入框里的同步行 / 本地勾选
  const answered = answeredValue?.startsWith(`${row.id}:`)
    ? answeredValue.slice(row.id.length + 1).split(",").filter(Boolean)
    : null;
  const picked = answered ?? (synced ? (owner?.parsed.values ?? []) : local);
  const locked = disabled || busy;
  const min = Math.max(1, Number(row.min) || 1);
  const max = Number(row.max) || row.options.length;
  const toggle = (v: string) => {
    if (locked) return;
    if (synced) editComposer((prev) => toggleFormValue(prev, form, forms, v));
    else setLocal((p) => (p.includes(v) ? p.filter((x) => x !== v) : p.length >= max ? p : [...p, v]));
  };
  const canSubmit = !locked && picked.length >= min && picked.length <= max;

  return (
    <div className="flex flex-col gap-1">
      {row.placeholder && <span className="text-[11px] opacity-50">{row.placeholder}</span>}
      {row.options.map((o) => {
        const on = picked.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            disabled={locked}
            onClick={() => toggle(o.value)}
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
              on
                ? "border-primary bg-primary/15"
                : "border-base-content/10 bg-base-100/40 hover:bg-base-content/[0.04]"
            } ${locked && !on ? "opacity-40" : ""}`}
          >
            <span
              className={`mt-[3px] grid size-3.5 shrink-0 place-items-center rounded border text-[10px] leading-none ${
                on ? "border-primary bg-primary text-primary-content" : "border-base-content/30"
              }`}
            >
              {on ? "✓" : ""}
            </span>
            <span className="min-w-0">
              <span className="font-medium opacity-90">{o.label}</span>
              {o.description && <span className="ml-1 opacity-50">{o.description}</span>}
            </span>
          </button>
        );
      })}
      {!disabled && (
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            // 快速提交 = 这组已答，输入框里它的同步行一并撤掉（补充文字留着）
            if (synced) editComposer((prev) => setFormValues(prev, form, forms, []));
            onSubmit(picked, renderFormLine(row, form?.title ?? row.id, picked));
          }}
          className="btn btn-primary btn-sm mt-1 self-start"
        >
          {row.submitLabel || t("提交")}
          {picked.length > 0 && ` (${picked.length})`}
        </button>
      )}
      {!disabled && owner && (
        <span className={`text-[11px] ${owner.over ? "text-warning" : "opacity-50"}`}>
          {owner.over ? t("最多选 {n} 项：超出时这一行按普通文字发送", { n: max }) : t("已同步到输入框，可补一句再发送")}
        </span>
      )}
    </div>
  );
}

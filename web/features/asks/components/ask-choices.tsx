"use client";
import { useState } from "react";
import type { WebComponentRow } from "@/lib/chat/events";
import { CheckMark } from "@/features/chat/components/check-mark";
import { useT } from "@/lib/i18n";

/**
 * 卡片上的作答区。三种来源三种形状：
 *   reply       agent 的按钮 / 单选 / 多选 + 一个文本框（owner 17:25：「勾选之外，还要再加上一栏我可以输入的地方」）
 *   auq         AskUserQuestion 的题目与选项（回传走 /agents/:name/answer 的按键）
 *   permission  允许 / 本会话都允许 / 拒绝（同上）
 * 作答本身由卡片做（ask-card.tsx），这里只把选择整理成 wire / 下标交上去。
 */

const BTN: Record<string, string> = { primary: "btn-primary", success: "btn-success", danger: "btn-error" };
const btn = (style?: string) => BTN[style ?? ""] ?? "btn-ghost border border-base-content/15";

function OptionChip({ on, label, description, onClick, disabled }: { on: boolean; label: string; description?: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        on ? "border-primary bg-primary/15" : "border-base-content/10 bg-base-100/40 hover:bg-base-content/[0.04]"
      }`}
    >
      <CheckMark on={on} />
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {description && <span className="ml-1 opacity-50">{description}</span>}
      </span>
    </button>
  );
}

/** agent 的 components：按钮一点就交（连同文本框里写的）；单选 / 多选勾好了点「提交」 */
export function ReplyChoices({ rows, allowText, busy, onAnswer }: { rows: WebComponentRow[]; allowText: boolean; busy: boolean; onAnswer: (choices: string[], text: string) => void }) {
  const t = useT();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [text, setText] = useState("");
  const selects = rows.filter((r): r is Exclude<WebComponentRow, { type: "buttons" }> => r.type !== "buttons");
  const toggle = (row: (typeof selects)[number], v: string) =>
    setPicked((p) => {
      const cur = p[row.id] ?? [];
      if (row.type === "select") return { ...p, [row.id]: cur[0] === v ? [] : [v] };
      const max = Number(row.max) || row.options.length;
      return { ...p, [row.id]: cur.includes(v) ? cur.filter((x) => x !== v) : cur.length >= max ? cur : [...cur, v] };
    });
  const selectWires = selects.filter((r) => (picked[r.id] ?? []).length > 0).map((r) => `[select:${r.id}:${picked[r.id].join(",")}]`);
  const canSubmit = !busy && (selectWires.length > 0 || (allowText && text.trim() !== ""));
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row, ri) =>
        row.type === "buttons" ? (
          <div key={ri} className="flex flex-wrap gap-2">
            {row.buttons.map((b) => (
              <button key={b.id} type="button" disabled={busy} className={`btn btn-sm ${btn(b.style)}`} onClick={() => onAnswer([`[button:${b.id}]`, ...selectWires], text.trim())}>
                {b.emoji ? `${b.emoji} ` : ""}
                {b.label}
              </button>
            ))}
          </div>
        ) : (
          <div key={ri} className="flex flex-col gap-1">
            {row.placeholder && <span className="text-[11px] opacity-50">{row.placeholder}</span>}
            {row.options.map((o) => (
              <OptionChip key={o.value} on={(picked[row.id] ?? []).includes(o.value)} label={o.label} description={o.description} disabled={busy} onClick={() => toggle(row, o.value)} />
            ))}
          </div>
        ),
      )}
      {allowText && (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={t("想补充什么，写在这里（可选）")}
          className="textarea textarea-sm w-full resize-none bg-base-200/60 text-[13px]"
        />
      )}
      {(selects.length > 0 || allowText) && (
        <button type="button" disabled={!canSubmit} className="btn btn-primary btn-sm self-start" onClick={() => onAnswer(selectWires, text.trim())}>
          {t("提交")}
        </button>
      )}
    </div>
  );
}

interface AuqQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

/** AskUserQuestion：每题选一个（多选题可多个），一次提交；也可以取消（等于在终端按 Esc） */
export function AuqChoices({ questions, busy, onSubmit, onCancel }: { questions: AuqQuestion[]; busy: boolean; onSubmit: (sel: number[][]) => void; onCancel: () => void }) {
  const t = useT();
  const [sel, setSel] = useState<number[][]>(() => questions.map(() => []));
  const pick = (qi: number, oi: number, multi: boolean) =>
    setSel((s) => s.map((cur, i) => (i !== qi ? cur : multi ? (cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi]) : [oi])));
  const ready = !busy && sel.every((s) => s.length > 0);
  return (
    <div className="flex flex-col gap-3">
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{q.question || q.header}</span>
          {(q.options ?? []).map((o, oi) => (
            <OptionChip key={oi} on={sel[qi].includes(oi)} label={o.label} description={o.description} disabled={busy} onClick={() => pick(qi, oi, !!q.multiSelect)} />
          ))}
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" disabled={!ready} className="btn btn-primary btn-sm" onClick={() => onSubmit(sel)}>
          {t("提交")}
        </button>
        <button type="button" disabled={busy} className="btn btn-ghost btn-sm" onClick={onCancel}>
          {t("取消")}
        </button>
      </div>
    </div>
  );
}

/** 权限弹框：选项行就是 bridge 给的三个按钮（id = 按键端点的 action） */
export function PermissionChoices({ rows, busy, onPick }: { rows: WebComponentRow[]; busy: boolean; onPick: (action: string, label: string) => void }) {
  const buttons = rows.flatMap((r) => (r.type === "buttons" ? r.buttons : []));
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.map((b) => (
        <button key={b.id} type="button" disabled={busy} className={`btn btn-sm ${btn(b.style)}`} onClick={() => onPick(b.id, b.label)}>
          {b.label}
        </button>
      ))}
    </div>
  );
}

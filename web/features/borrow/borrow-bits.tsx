"use client";
/** 借入面板的小部件：hello / beat 年龄、项目开关、名额数字框。点击把被点的元素交给调用方，失败时抖它。 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useT } from "@/lib/i18n";
import { ageBand, ageParts, clampMaxOpen, helloAgeSec, parseMaxOpen } from "./borrow-model";
import { CheckIcon, ClockIcon, MinusIcon, PlusIcon } from "./icons";
import { shake } from "./motion";

const AGE_TEXT = { s: "{n} 秒前", m: "{n} 分钟前", h: "{n} 小时前" } as const;
const BAND_CLASS = { none: "text-base-content/40", fresh: "text-base-content/55", aging: "text-base-content/55", stale: "text-warning" } as const;

/** 距今多久；at 为 null → 「无 hello」（label 可换） */
export function AgeTag(props: { at: number | null; serverNow: number; receivedAt: number; tick: number; none?: string }) {
  const t = useT();
  const sec = helloAgeSec(props.at, props.serverNow, props.receivedAt, props.tick);
  const band = ageBand(sec);
  const parts = sec === null ? null : ageParts(sec);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums ${BAND_CLASS[band]}`}>
      <ClockIcon className="size-3" />
      {parts ? t(AGE_TEXT[parts.unit], { n: parts.n }) : t(props.none ?? "无 hello")}
    </span>
  );
}

export function ProjectChips(props: {
  options: { id: string; name: string }[];
  picked: readonly string[];
  dropped?: readonly string[];
  disabled: boolean;
  onToggle: (id: string, el: HTMLElement) => void;
}) {
  const { options, picked } = props;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {options.map((o) => {
        const on = picked.includes(o.id);
        return (
          <button
            key={o.id}
            className={`btn btn-xs h-auto min-h-6 max-w-full gap-1 rounded-full py-0.5 font-normal ${on ? "btn-primary btn-soft" : "btn-ghost border-base-content/15 text-base-content/55"}`}
            aria-pressed={on}
            disabled={props.disabled}
            onClick={(e: MouseEvent<HTMLButtonElement>) => props.onToggle(o.id, e.currentTarget)}
          >
            {on && <CheckIcon className="size-3 shrink-0" />}
            <span className="truncate">{o.name}</span>
          </button>
        );
      })}
      {(props.dropped ?? []).map((id) => (
        <span key={id} className="badge badge-ghost badge-sm font-mono text-base-content/35 line-through">{id}</span>
      ))}
    </div>
  );
}

/**
 * 上限的数字框：点数字变输入框（数字键盘），回车 / 失焦交一次；空或非数字退回原值，越界夹到边界并抖一下。
 * −/+ 每点一下交一次。onCommit 只在值真的变了时调；peer 卡每交一次就存一次、存的期间 disabled，新增表单只改本地值。
 */
export function Stepper(props: { value: number; limit: number; min?: number; label?: string; disabled: boolean; onCommit: (n: number, el: HTMLElement | null) => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const v = props.value;
  const min = props.min ?? 1;

  const commit = (n: number) => {
    if (n !== v) props.onCommit(n, box.current);
  };
  const step = (d: 1 | -1) => commit(clampMaxOpen(v + d, props.limit, min));
  const startEdit = () => {
    done.current = false;
    setEditing(true);
  };
  const finish = (raw: string | null) => {
    if (done.current) return; // 回车后输入框卸载还会再来一次 blur
    done.current = true;
    setEditing(false);
    if (raw === null) return;
    const p = parseMaxOpen(raw, props.limit, min);
    if (!p || p.clamped) shake(box.current);
    if (p) commit(p.value);
  };

  return (
    <div ref={box} className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-base-200 px-1 text-[12px] tabular-nums text-base-content">
      <button className="btn btn-ghost btn-xs btn-circle" aria-label={`${props.label ?? t("名额")} −1`} disabled={props.disabled || editing || v <= min} onClick={() => step(-1)}>
        <MinusIcon className="size-3" />
      </button>
      {editing ? (
        <input
          ref={input}
          className="input input-xs h-6 w-11 rounded-md px-1 text-center font-semibold tabular-nums"
          inputMode="numeric"
          pattern="[0-9]*"
          enterKeyHint="done"
          disabled={props.disabled}
          defaultValue={String(v)}
          aria-label={props.label ?? t("名额")}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finish(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") finish(e.currentTarget.value);
            else if (e.key === "Escape") finish(null);
          }}
        />
      ) : (
        <button
          className="min-w-7 rounded-md px-1 font-semibold underline decoration-base-content/30 decoration-dotted underline-offset-4 hover:bg-base-300 disabled:no-underline"
          aria-label={props.label ?? t("名额")}
          disabled={props.disabled}
          onClick={startEdit}
        >
          {v}
        </button>
      )}
      <button className="btn btn-ghost btn-xs btn-circle" aria-label={`${props.label ?? t("名额")} +1`} disabled={props.disabled || editing || v >= props.limit} onClick={() => step(1)}>
        <PlusIcon className="size-3" />
      </button>
    </div>
  );
}

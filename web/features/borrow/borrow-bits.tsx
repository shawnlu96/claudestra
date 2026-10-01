"use client";
/** 借入面板的小部件：hello / beat 年龄、项目开关、上限加减。点击把被点的元素交给调用方，失败时抖它。 */
import type { MouseEvent } from "react";
import { useT } from "@/lib/i18n";
import { ageBand, ageParts, helloAgeSec } from "./borrow-model";
import { CheckIcon, ClockIcon, MinusIcon, PlusIcon } from "./icons";

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

export function Stepper(props: { value: number; limit: number; disabled: boolean; onStep: (delta: 1 | -1, el: HTMLElement) => void }) {
  const t = useT();
  return (
    <div className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full bg-base-200 px-1 text-[11.5px] tabular-nums">
      <button
        className="btn btn-ghost btn-xs btn-circle"
        aria-label={t("减少上限")}
        disabled={props.disabled || props.value <= 1}
        onClick={(e) => props.onStep(-1, e.currentTarget)}
      >
        <MinusIcon className="size-3" />
      </button>
      <span className="min-w-8 text-center">
        {t("上限")} <span className="font-semibold">{props.value}</span>
      </span>
      <button
        className="btn btn-ghost btn-xs btn-circle"
        aria-label={t("增加上限")}
        disabled={props.disabled || props.value >= props.limit}
        onClick={(e) => props.onStep(1, e.currentTarget)}
      >
        <PlusIcon className="size-3" />
      </button>
    </div>
  );
}

"use client";
import { useState } from "react";
import type { FleetActionKind } from "@/lib/api/fleet";
import { useT } from "@/lib/i18n";
import { ACTION_META, MORE_ACTIONS, PRIMARY_ACTIONS } from "./fleet-meta";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";

const SEG = "btn btn-sm join-item flex-1 whitespace-nowrap px-2 font-medium";
const segTone = (on: boolean) => (on ? "btn-primary" : "btn-ghost border-base-300");

export interface ActionPickerProps {
  action: FleetActionKind;
  setAction: (k: FleetActionKind) => void;
  keep: string | null;
  keepDefault: string;
  setKeep: (s: string | null) => void;
  text: string;
  setText: (s: string) => void;
}

/**
 * 「做什么」：最常用的三个做成分段按钮，其余收进「更多」（展开成第二排，不用弹层——手机上弹层会被滚动区裁掉）。
 * 说明只显示选中那个动作的一行；压缩类的保留清单收在「高级」里，默认折叠。
 */
export function ActionPicker(p: ActionPickerProps) {
  const t = useT();
  const inMore = MORE_ACTIONS.includes(p.action);
  const [moreOpen, setMoreOpen] = useState(inMore);
  const needsKeep = p.action === "compact" || p.action === "lp-compact";
  return (
    <section className="space-y-2">
      <div className="join w-full">
        {PRIMARY_ACTIONS.map((k) => (
          <button key={k} type="button" className={`${SEG} ${segTone(p.action === k)}`} onClick={() => p.setAction(k)}>
            {t(ACTION_META[k].label)}
          </button>
        ))}
        <button type="button" className={`${SEG} gap-1 ${segTone(inMore)}`} aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
          <span className="truncate">{inMore ? t(ACTION_META[p.action].label) : t("更多")}</span>
          <ChevronDownIcon className={`size-3.5 shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
        </button>
      </div>
      {moreOpen && (
        <div className="flex flex-wrap gap-1.5">
          {MORE_ACTIONS.map((k) => (
            <button
              key={k}
              type="button"
              className={`btn btn-xs rounded-full font-normal ${p.action === k ? "btn-primary" : "btn-ghost border-base-300"}`}
              onClick={() => p.setAction(k)}
            >
              {t(ACTION_META[k].label)}
            </button>
          ))}
        </div>
      )}
      <p className="text-[11px] leading-snug text-base-content/55">{t(ACTION_META[p.action].hint)}</p>
      {needsKeep && <KeepList keep={p.keep} keepDefault={p.keepDefault} setKeep={p.setKeep} />}
      {p.action === "text" && (
        <textarea
          className="textarea textarea-bordered textarea-sm w-full text-sm"
          rows={3}
          placeholder={t("要发给它们的话（会带「批量指令」来源头）")}
          value={p.text}
          onChange={(e) => p.setText(e.target.value)}
        />
      )}
    </section>
  );
}

/** 「高级」折叠区：折叠时只一行说明用的是默认还是自定义清单；改动只对这一次生效 */
function KeepList({ keep, keepDefault, setKeep }: { keep: string | null; keepDefault: string; setKeep: (s: string | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const custom = keep !== null && keep !== keepDefault;
  return (
    <div className="rounded-lg border border-base-300">
      <button type="button" className="flex min-h-9 w-full items-center gap-1.5 px-3 text-left text-xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRightIcon className={`size-3.5 shrink-0 text-base-content/50 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="shrink-0 font-medium">{t("高级")}</span>
        <span className="min-w-0 truncate text-base-content/50">{custom ? t("自定义保留清单（只对这一次生效）") : t("默认保留清单")}</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-base-300 px-3 py-2">
          <textarea
            className="textarea textarea-bordered textarea-sm w-full text-xs leading-relaxed"
            rows={4}
            value={keep ?? keepDefault}
            onChange={(e) => setKeep(e.target.value)}
            aria-label={t("保留清单")}
          />
          <div className="flex items-center gap-2 text-[11px] text-base-content/50">
            <span className="min-w-0 flex-1">{t("默认值在 config.json 的 fleet.compactKeep")}</span>
            {custom && (
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setKeep(null)}>
                {t("恢复默认")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";
/** Per-family agent slots and read-only quota; successful saves flash and failures shake. */
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { machineNow, stillOn, type LocalBody, type LocalProjectView, type QuotaReport } from "./borrow-api";
import { cardLocked, saveThenRefresh, type Feed } from "./borrow-feed";
import { LOCAL_MAX, localAgentsBody, oneAtATime, resetIn, weekUsed } from "./borrow-model";
import { Stepper } from "./borrow-bits";
import { MonitorIcon, PauseIcon } from "./icons";
import { fadeIn, flash, shake } from "./motion";

const FAMILIES = ["claude", "codex"] as const;
const FAMILY_LABEL = { claude: "Claude", codex: "Codex" };

/** 「本周」+ 每家一根细条和百分比；悬停看几天后重置。读不到 = 「—」 */
export function QuotaLine(props: { quota: QuotaReport | null | undefined; now: number; walled?: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-base-content/65">
      <span className="text-base-content/45">{t("本周已用")}</span>
      {FAMILIES.map((f) => {
        const w = weekUsed(props.quota, f, props.now);
        const r = w && resetIn(w.resetAt, props.now);
        const title = r ? t(r.unit === "d" ? "{n} 天后重置" : "{n} 小时后重置", { n: r.n }) : undefined;
        const tone = !w ? "" : w.pct >= 90 ? "bg-error" : w.pct >= 70 ? "bg-warning" : "bg-primary";
        return (
          <span key={f} className="inline-flex items-center gap-1.5" title={title}>
            <span className="font-mono">{f}</span>
            <span className="h-1.5 w-10 overflow-hidden rounded-full bg-base-content/10">
              {w && <span className={`block h-full rounded-full ${tone}`} style={{ width: `${w.pct}%` }} />}
            </span>
            <span className="font-semibold text-base-content/85">{w ? `${w.pct}%` : "—"}</span>
            {f === "claude" && props.walled && <PauseIcon className="size-3 text-warning" />}
          </span>
        );
      })}
    </div>
  );
}

/** One local project row; saves remain locked until the refreshed server snapshot arrives. */
export function LocalRow(props: {
  project: LocalProjectView; name: string; quota: { quota: QuotaReport; walled: boolean } | null | undefined;
  serverNow: number; canWrite: boolean; seq: number; feed: Feed;
}) {
  const { project: p, feed } = props;
  const t = useT();
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [waitAfter, setWaitAfter] = useState<number | null>(null);
  const locked = cardLocked(busy, waitAfter, props.seq);
  useEffect(() => fadeIn(card.current), []);
  const gate = useRef<ReturnType<typeof oneAtATime> | null>(null);
  const save = (body: LocalBody, el: HTMLElement | null) => {
    if (locked) return;
    void (gate.current ??= oneAtATime(setBusy))(async () => {
      const at = machineNow();
      const r = await saveThenRefresh({ project: p.id, body, at, feed, hold: setWaitAfter });
      if (r === "failed" && stillOn(at)) shake(el);
      if (r === "saved") flash(card.current);
    });
  };
  const disabled = locked || !props.canWrite;
  return (
    <div ref={card} className="space-y-2 rounded-lg bg-base-100 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <MonitorIcon className="size-3.5 shrink-0 text-base-content/50" />
        <span className="shrink-0 text-[12.5px] font-semibold">{t("本机")}</span>
        <span className="min-w-0 truncate text-[12px] text-base-content/55">{props.name}</span>
      </div>
      <QuotaLine quota={props.quota?.quota} walled={props.quota?.walled} now={props.serverNow} />
      <div className="grid grid-cols-2 gap-3 text-xs">
        {FAMILIES.map((f) => (
          <div key={f} className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-medium">{FAMILY_LABEL[f]}</span>
            <Stepper value={p.agents?.[f] ?? 0} limit={LOCAL_MAX} min={0} label={`${FAMILY_LABEL[f]} ${t("名额")}`}
              disabled={disabled} onCommit={(n, el) => save(localAgentsBody(p, f, n), el)} />
          </div>
        ))}
      </div>
    </div>
  );
}

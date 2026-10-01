"use client";
/**
 * 分配表的部件（i28-Q1）：档位四选一、角色勾选、本周已用，以及本机这一行。peer 行与本机行用同一套部件，
 * 都是一点就存（saveThenRefresh：存的期间到拿回写后快照之前整行锁住，成功一闪、失败抖被点的那个）。
 * 额度只读、只做参考：读不到显示「—」，派单不看它。
 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useLang, useT } from "@/lib/i18n";
import { machineNow, PRIORITIES, stillOn, type Family, type LocalProjectView, type Priority, type QuotaReport, type Role } from "./borrow-api";
import { cardLocked, saveThenRefresh, type Feed } from "./borrow-feed";
import { LOCAL_MAX, localTierDisabled, oneAtATime, resetIn, weekUsed } from "./borrow-model";
import { LimitLine, Stepper } from "./borrow-bits";
import { CheckIcon, MonitorIcon, PauseIcon } from "./icons";
import { fadeIn, flash, shake } from "./motion";

const FAMILIES: Family[] = ["codex", "claude"];
const TIER_TEXT: Record<Priority, string> = { first: "先用", balance: "平分", low: "少用", off: "不用" };
/** 「审查」「开发」也是台账阶段短词，不能进全局字典（tests/web-ledger-stage.test.ts）：角色名在这里按语言取 */
const ROLE_TEXT: Record<Role, { zh: string; en: string }> = { review: { zh: "审查", en: "Review" }, write: { zh: "开发", en: "Build" } };

/** 四个短词的分段按钮；当前档高亮，「不用」用中性色。点同一档不发请求 */
export function TierPicker(props: { value: Priority; disabled: boolean; onPick: (p: Priority, el: HTMLElement) => void }) {
  const t = useT();
  return (
    <div className="join shrink-0" role="radiogroup" aria-label={t("档位")}>
      {PRIORITIES.map((p) => {
        const on = p === props.value;
        // 主题的 primary 是中性灰，soft 底色分不出当前档：当前档反色（「不用」反成半透明，不抢眼）
        const tone = !on ? "btn-ghost text-base-content/55" : p === "off" ? "bg-base-content/25 text-base-content font-semibold" : "bg-base-content text-base-100 font-semibold";
        return (
          <button
            key={p}
            role="radio"
            aria-checked={on}
            className={`btn join-item btn-xs border-base-content/10 px-2.5 font-normal ${tone}`}
            disabled={props.disabled}
            onClick={(e: MouseEvent<HTMLButtonElement>) => !on && props.onPick(p, e.currentTarget)}
          >
            {t(TIER_TEXT[p])}
          </button>
        );
      })}
    </div>
  );
}

/** 审查 / 开发两个勾；readOnly = 只显示（本机这一行的角色是项目级配置） */
export function RolePicker(props: { roles: readonly Role[]; disabled: boolean; readOnly?: boolean; onToggle?: (r: Role, el: HTMLElement) => void }) {
  const lang = useLang();
  return (
    <div className="flex shrink-0 gap-1">
      {(["review", "write"] as const).map((r) => {
        const on = props.roles.includes(r);
        if (props.readOnly) {
          return on ? <span key={r} className="badge badge-ghost badge-sm gap-1 text-base-content/60"><CheckIcon className="size-3" />{ROLE_TEXT[r][lang]}</span> : null;
        }
        return (
          <button
            key={r}
            className={`btn btn-xs h-auto min-h-6 gap-1 rounded-full py-0.5 font-normal ${on ? "btn-primary btn-soft" : "btn-ghost border-base-content/15 text-base-content/55"}`}
            aria-pressed={on}
            disabled={props.disabled}
            onClick={(e: MouseEvent<HTMLButtonElement>) => props.onToggle?.(r, e.currentTarget)}
          >
            {on && <CheckIcon className="size-3" />}
            {ROLE_TEXT[r][lang]}
          </button>
        );
      })}
    </div>
  );
}

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

/** 一行的「档位 · 角色」：窄屏折成两行 */
export function AllocStrip(props: { tier: Priority; roles: readonly Role[]; disabled: boolean; rolesReadOnly?: boolean;
  onTier: (p: Priority, el: HTMLElement) => void; onRole?: (r: Role, el: HTMLElement) => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-base-content/70">
      <span className="inline-flex items-center gap-2">
        <span className="shrink-0">{t("档位")}</span>
        <TierPicker value={props.tier} disabled={props.disabled} onPick={props.onTier} />
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="shrink-0">{t("角色")}</span>
        <RolePicker roles={props.roles} disabled={props.disabled} readOnly={props.rolesReadOnly} onToggle={props.onRole} />
      </span>
    </div>
  );
}

const asRoles = (rs: readonly string[] | undefined): Role[] => (rs ?? ["review"]).filter((r): r is Role => r === "review" || r === "write");

/** 本机这一行：一个 scheduler.json 项目一行。档位、并发上限可改；角色、仓库是项目级配置，只读 */
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
  const save = (body: { priority?: Priority; maxActiveWorkers?: number }, el: HTMLElement | null) => {
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
        <span className={`badge badge-sm ml-auto shrink-0 ${p.mode === "off" ? "badge-ghost text-base-content/55" : "border-primary/30 bg-primary/10 text-primary"}`}>
          {t(p.mode === "off" ? "只用本机" : "平均分配")}
        </span>
      </div>
      <QuotaLine quota={props.quota?.quota} walled={props.quota?.walled} now={props.serverNow} />
      <AllocStrip tier={p.localPriority ?? "balance"} roles={asRoles(p.roles)} rolesReadOnly disabled={localTierDisabled(disabled, p)}
        onTier={(tier, el) => save({ priority: tier }, el)} />
      <LimitLine name="" local n={p.maxActiveWorkers}>
        <Stepper value={p.maxActiveWorkers} limit={LOCAL_MAX} min={0} disabled={disabled} onCommit={(n, el) => save({ maxActiveWorkers: n }, el)} />
      </LimitLine>
    </div>
  );
}

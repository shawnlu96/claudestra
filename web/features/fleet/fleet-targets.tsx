"use client";
import { useMemo, useState } from "react";
import type { ProjectMeta } from "@/features/chat/type";
import type { FleetAgent, FleetOutcome, FleetResult } from "@/lib/api/fleet";
import { useT } from "@/lib/i18n";
import { bare, OUTCOME_META } from "./fleet-meta";
import { CheckIcon, ClockIcon, EyeIcon, MinusIcon, XIcon } from "./icons";
import { LpBadge } from "./lp-badge";

const OUTCOME_ICON: Record<FleetOutcome, typeof CheckIcon> = { done: CheckIcon, queued: ClockIcon, skipped: MinusIcon, failed: XIcon };

export interface TargetPickerProps {
  agents: FleetAgent[];
  projects: ProjectMeta[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  /** 上一次执行的逐个结果（按 bare 名）；预演时是会被执行的名单 */
  results: Map<string, FleetResult>;
  dryTargets: Set<string>;
}

/**
 * 「选谁」：带数字的快捷筛选只是帮你勾选，真正发出去的永远是勾中的名单；大总管默认不进快捷筛选。
 * 结果直接挂在每行末尾（小标悬停看原因，手机上点一下展开原因）。
 */
export function TargetPicker(p: TargetPickerProps) {
  const t = useT();
  const [ctxK, setCtxK] = useState(200);
  const [includeMaster, setIncludeMaster] = useState(false);
  const [reasonOf, setReasonOf] = useState("");
  const eligible = useMemo(() => p.agents.filter((a) => a.online && (!a.master || includeMaster)), [p.agents, includeMaster]);
  const projName = useMemo(() => new Map(p.projects.map((x) => [x.id, x.name])), [p.projects]);
  const inUse = useMemo(() => p.projects.filter((x) => p.agents.some((a) => a.project === x.id)), [p.projects, p.agents]);
  const filters = [
    { key: "all", label: t("全部"), list: eligible },
    { key: "walled", label: t("撞墙中"), list: eligible.filter((a) => a.lp?.walled) },
    { key: "ctx", label: t("上下文 >{n}k", { n: ctxK }), list: eligible.filter((a) => (a.contextTokens ?? 0) > ctxK * 1000) },
  ];
  const setList = (list: FleetAgent[]) => p.setPicked(new Set(list.map((a) => a.name)));
  const same = (list: FleetAgent[]) => list.length > 0 && list.length === p.picked.size && list.every((a) => p.picked.has(a.name));
  const toggle = (name: string) => {
    const s = new Set(p.picked);
    if (s.has(name)) s.delete(name);
    else s.add(name);
    p.setPicked(s);
  };
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`btn btn-xs gap-1 rounded-full font-normal ${same(f.list) ? "btn-primary" : "btn-ghost border-base-300"}`}
            disabled={!f.list.length}
            onClick={() => setList(f.list)}
          >
            {f.label}
            <span className="font-mono tabular-nums opacity-60">{f.list.length}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-base-content/60">
        {inUse.length > 0 && (
          <select className="select select-xs w-auto max-w-40" value="" aria-label={t("按项目")} onChange={(e) => e.target.value && setList(eligible.filter((a) => a.project === e.target.value))}>
            <option value="">{t("按项目…")}</option>
            {inUse.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1">
          {t("阈值")}
          <input
            className="input input-xs w-14 font-mono tabular-nums"
            type="number"
            min={0}
            value={ctxK}
            onChange={(e) => setCtxK(Number(e.target.value) || 0)}
            aria-label={t("上下文阈值（千 token）")}
          />
          k
        </label>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5" title={t("快捷筛选包括大总管")}>
          <input type="checkbox" className="checkbox checkbox-xs" checked={includeMaster} onChange={(e) => setIncludeMaster(e.target.checked)} />
          {t("含大总管")}
        </label>
      </div>
      <div className="overflow-hidden rounded-xl border border-base-300">
        <div className="flex min-h-9 items-center border-b border-base-300 bg-base-200/60 px-3 text-xs text-base-content/60">
          <span className="tabular-nums">{t("已选 {n} / {total}", { n: p.picked.size, total: p.agents.length })}</span>
          {p.picked.size > 0 && (
            <button type="button" className="btn btn-ghost btn-xs ml-auto" onClick={() => p.setPicked(new Set())}>
              {t("清空")}
            </button>
          )}
        </div>
        <ul className="divide-y divide-base-200">
          {p.agents.map((a) => (
            <AgentRow
              key={a.name}
              a={a}
              project={a.project ? projName.get(a.project) : undefined}
              checked={p.picked.has(a.name)}
              onToggle={() => toggle(a.name)}
              result={p.results.get(bare(a.name))}
              dry={p.dryTargets.has(bare(a.name))}
              showReason={reasonOf === a.name}
              onReason={() => setReasonOf((v) => (v === a.name ? "" : a.name))}
            />
          ))}
          {!p.agents.length && <li className="px-3 py-6 text-center text-xs text-base-content/40">{t("没有 agent")}</li>}
        </ul>
      </div>
    </section>
  );
}

interface RowProps {
  a: FleetAgent;
  project?: string;
  checked: boolean;
  onToggle: () => void;
  result?: FleetResult;
  dry: boolean;
  showReason: boolean;
  onReason: () => void;
}

/** 一行 ≥ 44px：整行可点勾选；元信息（运行时 / 上下文 / 离线）等宽小字靠右，结果小标在最后 */
function AgentRow({ a, project, checked, onToggle, result, dry, showReason, onReason }: RowProps) {
  const t = useT();
  return (
    <li>
      <label className={`flex min-h-11 items-center gap-2.5 px-3 py-1.5 ${a.online ? "cursor-pointer hover:bg-base-200/50" : "cursor-not-allowed"}`}>
        <input type="checkbox" className="checkbox checkbox-sm" checked={checked} disabled={!a.online} onChange={onToggle} aria-label={bare(a.name)} />
        <span className={`min-w-0 flex-1 ${a.online ? "" : "opacity-45"}`}>
          <span className="block truncate text-sm">{a.master ? t("大总管") : bare(a.name)}</span>
          {project && <span className="block truncate text-[11px] leading-tight text-base-content/45">{project}</span>}
        </span>
        <LpBadge lp={a.lp} />
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-base-content/45">
          {a.runtime !== "claude-code" && <span>{a.runtime}</span>}
          {typeof a.contextTokens === "number" && <span>{Math.round(a.contextTokens / 1000)}k</span>}
          {!a.online && <span className="font-sans">{t("离线")}</span>}
        </span>
        <ResultChip result={result} dry={dry} onClick={onReason} />
      </label>
      {showReason && result && <div className="pb-2 pl-11 pr-3 text-[11px] leading-snug text-base-content/60">{result.detail}</div>}
    </li>
  );
}

function ResultChip({ result, dry, onClick }: { result?: FleetResult; dry: boolean; onClick: () => void }) {
  const t = useT();
  if (dry) {
    return (
      <span className="badge badge-sm badge-outline shrink-0 gap-1 border-base-300 text-base-content/60">
        <EyeIcon className="size-3" />
        {t("会执行")}
      </span>
    );
  }
  if (!result) return null;
  const m = OUTCOME_META[result.outcome];
  const Icon = OUTCOME_ICON[result.outcome];
  return (
    <button
      type="button"
      className={`badge badge-sm shrink-0 cursor-help gap-1 ${m.badge}`}
      title={result.detail}
      onClick={(e) => {
        e.preventDefault(); // 在 label 里：点小标只展开原因，不切勾选
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon className="size-3" />
      {t(m.label)}
    </button>
  );
}

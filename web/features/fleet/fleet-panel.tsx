"use client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useChatStore } from "@/features/chat/chat-store";
import { PanelHeader } from "@/features/chat/components/panel-header";
import { ResponsiveShell } from "@/features/chat/components/responsive-shell";
import { fetchFleetState, followLpEvents, runFleet, type FleetActionKind, type FleetAgent, type FleetOutcome, type FleetReport } from "@/lib/api/fleet";
import { useT } from "@/lib/i18n";
import { ActionPicker } from "./fleet-actions";
import { bare, OUTCOME_META } from "./fleet-meta";
import { TargetPicker } from "./fleet-targets";
import { EyeIcon, RefreshIcon } from "./icons";

/**
 * 批量管理面板（bridge/fleet/，docs/architecture/fleet-ops.md）：选一个动作、勾一批 agent，结果挂回每一行。
 * 底部操作栏（预演 / 执行 N 个）固定在面板底；执行要点两下（第二下 3 秒内确认）。
 * 开着时订阅 SSE 的 low_priority 事件实时刷新徽章。只有 owner 本人的全权设备能用，其余设备这里显示 403 原因。
 */
function useFleetState(open: boolean) {
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [keepDefault, setKeepDefault] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const s = await fetchFleetState();
      setAgents(s.agents);
      setKeepDefault(s.compactKeep);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    fetchFleetState(ac.signal).then(
      (s) => (setAgents(s.agents), setKeepDefault(s.compactKeep), setErr("")),
      (e) => ac.signal.aborted || setErr((e as Error).message), // 面板关了才回来的错误不显示
    );
    followLpEvents({
      signal: ac.signal,
      onEvent: (agent, lp) => setAgents((list) => list.map((a) => (bare(a.name) === bare(agent) ? { ...a, lp } : a))),
    }).catch(() => undefined); // 流断了只是徽章不再实时，打开面板 / 点刷新会重拉
    return () => ac.abort();
  }, [open]);
  return { agents, keepDefault, err, loading, load };
}

export function FleetPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const projects = useChatStore((s) => s.state.projects);
  const { agents, keepDefault, err, loading, load } = useFleetState(open);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [action, setActionRaw] = useState<FleetActionKind>("lp-compact");
  const [keep, setKeep] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<FleetReport | null>(null);
  const [runErr, setRunErr] = useState("");
  const results = useMemo(() => new Map((report?.dryRun ? [] : (report?.results ?? [])).map((r) => [bare(r.agent), r])), [report]);
  const dryTargets = useMemo(() => new Set(report?.dryRun ? report.targets.map(bare) : []), [report]);

  if (!open) return null;

  const setAction = (k: FleetActionKind) => {
    setActionRaw(k);
    setReport(null); // 换了动作，上一次的结果小标不再对应
    setArmed(false);
  };
  const names = [...picked];
  const needsKeep = action === "compact" || action === "lp-compact";
  const go = async (dryRun: boolean) => {
    setArmed(false);
    setRunning(true);
    setRunErr("");
    try {
      const kind = { kind: action, ...(needsKeep ? { keep: keep ?? keepDefault } : {}), ...(action === "text" ? { text } : {}) };
      setReport(await runFleet({ action: kind, select: { agents: names.map(bare) }, dryRun }));
      if (!dryRun) void load();
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const arm = () => {
    setArmed(true);
    setTimeout(() => setArmed(false), 3000);
  };
  const blocked = running || !names.length || (action === "text" && !text.trim());

  return (
    <ResponsiveShell z="z-[90]" panelClass="sm:max-w-2xl" onClose={onClose}>
      <PanelHeader title="批量管理" onClose={onClose}>
        <button type="button" className="btn btn-ghost btn-sm btn-square ml-auto" disabled={loading} aria-label={t("刷新状态")} title={t("刷新状态")} onClick={() => void load()}>
          <RefreshIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </PanelHeader>
      <div className="min-h-0 flex-1 touch-pan-y space-y-5 overflow-y-auto overscroll-contain px-3 pb-4 pt-3" style={{ WebkitOverflowScrolling: "touch" }}>
        {err && <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{t(err)}</div>}
        <Section title={t("做什么")}>
          <ActionPicker action={action} setAction={setAction} keep={keep} keepDefault={keepDefault} setKeep={setKeep} text={text} setText={setText} />
        </Section>
        <Section title={t("选谁")}>
          <TargetPicker agents={agents} projects={projects} picked={picked} setPicked={setPicked} results={results} dryTargets={dryTargets} />
        </Section>
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-base-300 bg-base-100 px-3 pt-2" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}>
        <button type="button" className="btn btn-ghost btn-sm gap-1.5 border-base-300" disabled={blocked} onClick={() => void go(true)}>
          <EyeIcon className="size-4" />
          {t("预演")}
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-xs">
          <RunStatus report={report} runErr={runErr} n={names.length} />
        </div>
        <button type="button" className={`btn btn-sm min-w-24 ${armed ? "btn-warning" : "btn-primary"}`} disabled={blocked} onClick={() => (armed ? void go(false) : arm())}>
          {running ? <span className="loading loading-spinner loading-xs" /> : armed ? t("确认执行 {n} 个?", { n: names.length }) : t("执行 {n} 个", { n: names.length })}
        </button>
      </footer>
    </ResponsiveShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-base-content/55">{title}</div>
      {children}
    </div>
  );
}

const TONE: Record<FleetOutcome, string> = { done: "text-success", queued: "text-info", skipped: "text-base-content/50", failed: "text-error" };

/** 操作栏中间那一句：报错 / 预演说明 / 上一次结果按类计数 / 已选几个 */
function RunStatus({ report, runErr, n }: { report: FleetReport | null; runErr: string; n: number }) {
  const t = useT();
  if (runErr) return <span className="text-error" title={runErr}>{t(runErr)}</span>;
  if (report?.dryRun) return <span className="text-base-content/55" title={t("预演没有发任何键")}>{t("预演：{n} 个会执行", { n: report.targets.length })}</span>;
  if (report) {
    const counts = (Object.keys(TONE) as FleetOutcome[]).map((o) => [o, report.results.filter((r) => r.outcome === o).length] as const).filter(([, c]) => c);
    if (!counts.length) return <span className="text-base-content/55">{t("没有选中任何 agent")}</span>;
    return (
      <span className="inline-flex gap-2 tabular-nums">
        {counts.map(([o, c]) => <span key={o} className={TONE[o]}>{t(OUTCOME_META[o].label)} {c}</span>)}
      </span>
    );
  }
  return <span className="text-base-content/45">{n ? t("已选 {n} 个", { n }) : t("先勾选 agent")}</span>;
}

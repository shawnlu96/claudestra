"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/features/chat/chat-store";
import { ResponsiveShell } from "@/features/chat/components/responsive-shell";
import type { ProjectMeta } from "@/features/chat/type";
import {
  fetchFleetState, followLpEvents, runFleet, type FleetActionKind, type FleetAgent, type FleetOutcome, type FleetReport,
} from "@/lib/api/fleet";
import { useT } from "@/lib/i18n";
import { LpBadge } from "./lp-badge";

/**
 * 批量管理面板（bridge/fleet/，docs/architecture/fleet-ops.md）：勾一批 agent，发同一个动作，逐个看结果。
 * 快捷筛选（全部 / 撞墙中 / 上下文超线 / 按项目）只是帮你勾选，真正发出去的永远是勾中的名单；大总管要单独勾。
 * 开着时订阅 SSE 的 low_priority 事件实时刷新徽章。只有 owner 本人的全权设备能用，其余设备这里显示 403 原因。
 */
const bare = (n: string) => n.replace(/^agent-/, "");
const ACTIONS: { kind: FleetActionKind; label: string }[] = [
  { kind: "lp-on", label: "开 low-priority" },
  { kind: "lp-off", label: "关 low-priority" },
  { kind: "lp-compact", label: "开 LP 再压缩" },
  { kind: "compact", label: "压缩" },
  { kind: "save-compact", label: "存记忆再压缩" },
  { kind: "text", label: "发一段话" },
];
const OUTCOME: Record<FleetOutcome, { label: string; tone: string }> = {
  done: { label: "已执行", tone: "text-success" },
  queued: { label: "已排队", tone: "text-info" },
  skipped: { label: "已跳过", tone: "text-base-content/50" },
  failed: { label: "失败", tone: "text-error" },
};

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
  const [action, setAction] = useState<FleetActionKind>("lp-on");
  const [keep, setKeep] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<FleetReport | null>(null);
  const [runErr, setRunErr] = useState("");

  if (!open) return null;

  const needsKeep = action === "compact" || action === "lp-compact";
  const names = [...picked];
  const body = (dryRun: boolean) => ({
    action: { kind: action, ...(needsKeep ? { keep: keep ?? keepDefault } : {}), ...(action === "text" ? { text } : {}) },
    select: { agents: names.map(bare) },
    dryRun,
  });
  const go = async (dryRun: boolean) => {
    setArmed(false);
    setRunning(true);
    setRunErr("");
    try {
      setReport(await runFleet(body(dryRun)));
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
      <header className="flex min-h-12 shrink-0 items-center gap-1 border-b border-base-300 bg-base-100 px-3" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <button className="btn btn-ghost btn-sm -ml-1 px-2 sm:hidden" aria-label={t("返回")} onClick={onClose}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="truncate font-semibold">{t("批量管理")}</span>
        <button className="btn btn-ghost btn-sm ml-auto" disabled={loading} onClick={() => void load()}>
          {loading ? <span className="loading loading-spinner loading-xs" /> : t("刷新状态")}
        </button>
        <button className="btn btn-ghost btn-sm max-sm:hidden" aria-label={t("关闭")} onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 touch-pan-y space-y-4 overflow-y-auto overscroll-contain px-3 pt-3" style={{ WebkitOverflowScrolling: "touch", paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}>
        {err && <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{t(err)}</div>}
        <Picker agents={agents} projects={projects} picked={picked} setPicked={setPicked} />
        <ActionPicker action={action} setAction={setAction} keep={keep ?? keepDefault} setKeep={setKeep} text={text} setText={setText} />
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-sm" disabled={blocked} onClick={() => void go(true)}>{t("预演")}</button>
          <button className={`btn btn-sm ${armed ? "btn-warning" : "btn-primary"}`} disabled={blocked} onClick={() => (armed ? void go(false) : arm())}>
            {running ? <span className="loading loading-spinner loading-xs" /> : armed ? t("确认对 {n} 个 agent 执行?", { n: names.length }) : t("执行（{n} 个）", { n: names.length })}
          </button>
          {runErr && <span className="text-xs text-error">{t(runErr)}</span>}
        </div>
        {report && <Results report={report} />}
      </div>
    </ResponsiveShell>
  );
}

function Picker({ agents, projects, picked, setPicked }: { agents: FleetAgent[]; projects: ProjectMeta[]; picked: Set<string>; setPicked: (s: Set<string>) => void }) {
  const t = useT();
  const [ctxK, setCtxK] = useState(200);
  const [includeMaster, setIncludeMaster] = useState(false);
  const pick = (pred: (a: FleetAgent) => boolean) =>
    setPicked(new Set(agents.filter((a) => (a.master ? includeMaster : true) && a.online && pred(a)).map((a) => a.name)));
  const toggle = (name: string) => {
    const s = new Set(picked);
    if (s.has(name)) s.delete(name);
    else s.add(name);
    setPicked(s);
  };
  const projOf = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const inUse = useMemo(() => projects.filter((p) => agents.some((a) => a.project === p.id)), [projects, agents]);
  return (
    <section className="space-y-2">
      <div className="text-xs font-semibold text-base-content/60">{t("选谁")}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button className="btn btn-xs" onClick={() => pick(() => true)}>{t("全部")}</button>
        <button className="btn btn-xs" onClick={() => pick((a) => !!a.lp?.walled)}>{t("撞墙中")}</button>
        <span className="join">
          <button className="btn join-item btn-xs" onClick={() => pick((a) => (a.contextTokens ?? 0) > ctxK * 1000)}>{t("上下文超过")}</button>
          <input className="input join-item input-xs w-16 font-mono" type="number" min={0} value={ctxK} onChange={(e) => setCtxK(Number(e.target.value) || 0)} aria-label={t("上下文阈值（千 token）")} />
          <span className="join-item flex items-center border border-base-300 px-1.5 text-xs text-base-content/50">k</span>
        </span>
        {inUse.length > 0 && (
          <select className="select select-xs" value="" onChange={(e) => e.target.value && pick((a) => a.project === e.target.value)} aria-label={t("按项目")}>
            <option value="">{t("按项目…")}</option>
            {inUse.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <button className="btn btn-ghost btn-xs" onClick={() => setPicked(new Set())}>{t("清空")}</button>
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-xs text-base-content/60">
          <input type="checkbox" className="checkbox checkbox-xs" checked={includeMaster} onChange={(e) => setIncludeMaster(e.target.checked)} />
          {t("快捷筛选包括大总管")}
        </label>
      </div>
      <ul className="divide-y divide-base-200 rounded-lg border border-base-300">
        {agents.map((a) => (
          <li key={a.name} className="flex items-center gap-2 px-2 py-1.5">
            <input type="checkbox" className="checkbox checkbox-sm" checked={picked.has(a.name)} disabled={!a.online} onChange={() => toggle(a.name)} aria-label={bare(a.name)} />
            <span className={`min-w-0 flex-1 truncate text-sm ${a.online ? "" : "text-base-content/40"}`}>
              {a.master ? t("大总管") : bare(a.name)}
              {a.project && projOf.get(a.project) && <span className="ml-1.5 text-[11px] text-base-content/40">{projOf.get(a.project)!.name}</span>}
            </span>
            <LpBadge lp={a.lp} />
            {a.runtime !== "claude-code" && <span className="shrink-0 font-mono text-[10px] text-base-content/40">{a.runtime}</span>}
            {typeof a.contextTokens === "number" && <span className="shrink-0 font-mono text-[10px] tabular-nums text-base-content/40">{Math.round(a.contextTokens / 1000)}k</span>}
            {!a.online && <span className="shrink-0 text-[10px] text-base-content/40">{t("离线")}</span>}
          </li>
        ))}
        {!agents.length && <li className="px-2 py-3 text-center text-xs text-base-content/40">{t("没有 agent")}</li>}
      </ul>
    </section>
  );
}

function ActionPicker(p: { action: FleetActionKind; setAction: (k: FleetActionKind) => void; keep: string; setKeep: (s: string) => void; text: string; setText: (s: string) => void }) {
  const t = useT();
  return (
    <section className="space-y-2">
      <div className="text-xs font-semibold text-base-content/60">{t("做什么")}</div>
      <div className="flex flex-wrap gap-1.5">
        {ACTIONS.map((a) => (
          <button key={a.kind} className={`btn btn-xs ${p.action === a.kind ? "btn-primary" : "btn-outline"}`} onClick={() => p.setAction(a.kind)}>
            {t(a.label)}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-base-content/50">{t(HINTS[p.action])}</p>
      {(p.action === "compact" || p.action === "lp-compact") && (
        <label className="block space-y-1">
          <span className="text-[11px] text-base-content/50">{t("保留清单（只对这一次生效；默认值在 config.json 的 fleet.compactKeep）")}</span>
          <textarea className="textarea textarea-bordered textarea-sm w-full text-xs" rows={4} value={p.keep} onChange={(e) => p.setKeep(e.target.value)} />
        </label>
      )}
      {p.action === "text" && (
        <textarea className="textarea textarea-bordered textarea-sm w-full text-sm" rows={3} placeholder={t("要发给它们的话（会带「批量指令」来源头）")} value={p.text} onChange={(e) => p.setText(e.target.value)} />
      )}
    </section>
  );
}

const HINTS: Record<FleetActionKind, string> = {
  "lp-on": "只对撞墙中的会话生效；已经开着的跳过，忙的不发（排队的开关可能切反）。",
  "lp-off": "只对开着的会话发；已经关着的跳过。",
  "lp-compact": "开 low-priority → 打断它自动开始的续跑 → 清输入框 → 带保留清单压缩。",
  compact: "带保留清单发 /compact；忙的会排队，回合结束后执行。",
  "save-compact": "发 /save-compact：先把要点存进记忆，再自动压缩。",
  text: "像你亲自发的一样投递给每个 agent，开头带「批量指令」来源头。",
};

function Results({ report }: { report: FleetReport }) {
  const t = useT();
  return (
    <section className="space-y-1.5">
      <div className="text-xs font-semibold text-base-content/60">{report.dryRun ? t("预演结果（没有发任何键）") : t("执行结果")}</div>
      <div className="text-xs text-base-content/70">{t(report.summary.split("\n")[0] ?? "")}</div>
      <ul className="space-y-0.5 text-xs">
        {report.results.map((r) => (
          <li key={r.agent} className="flex gap-2">
            <span className="w-28 shrink-0 truncate font-mono">{bare(r.agent)}</span>
            <span className={`shrink-0 ${OUTCOME[r.outcome].tone}`}>{t(OUTCOME[r.outcome].label)}</span>
            <span className="min-w-0 text-base-content/60">{r.detail}</span>
          </li>
        ))}
        {report.dryRun && report.targets.map((n) => <li key={n} className="font-mono">{bare(n)}</li>)}
        {report.excluded.map((e) => (
          <li key={`x:${e.name}`} className="flex gap-2 text-base-content/40">
            <span className="w-28 shrink-0 truncate font-mono">{e.name}</span>
            <span>{t("未选中")}（{e.reason}）</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

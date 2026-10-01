"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLang } from "@/lib/i18n";
import { machines } from "@/lib/machines";
import { ApiError } from "@/lib/api/client";
import { fetchAgentUsage, type AgentUsage, type AgentUsageTurn, type AgentTokenSums } from "@/lib/api/usage-agent";
import { Icon } from "@/features/collab/collab-icons";
import { AGENT_USAGE_WORDS, BASIS_LABELS, SOURCE_LABELS, STEP_LABELS } from "../agent-usage-i18n";
import { openUsageTask } from "../agent-usage";
import css from "./agent-usage.module.css";

type Tr = (word: string) => string;
type Props = { name: string; projects: string[]; onClose: () => void };
const METRICS: [keyof AgentTokenSums, string][] = [
  ["input", "输入"], ["cacheRead", "cache 读"], ["cacheCreation", "cache 写"], ["output", "输出"], ["reasoning", "推理"], ["calls", "调用数"],
];
const n = (value: number) => value.toLocaleString();

function Metrics({ entries }: { entries: [string, number][] }) {
  return <dl className={css.metrics}>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{n(value)}</dd></div>)}</dl>;
}

function UsageTurn({ turn, t, lang, open, busy, failed }: {
  turn: AgentUsageTurn; t: Tr; lang: string; open: () => void; busy: boolean; failed: boolean;
}) {
  const attr = turn.attr;
  return <li className={`${css.turn} ${css.enter}`}>
    <div className={css.header}>
      <time className={css.time} dateTime={new Date(turn.startedAt).toISOString()}>
        {new Date(turn.startedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </time>
      <span className={css.muted}>{turn.runtime}</span>
    </div>
    <div className={css.source}><span className={css.muted}>{t(SOURCE_LABELS[turn.kind] ?? "其他来源")}</span>{turn.trigger && ` · ${turn.trigger}`}</div>
    <Metrics entries={[[t("调用数"), turn.calls], [t("看到的上下文"), turn.contextSeen], [t("合计"), turn.totalTokens], [t("新产出"), turn.output]]} />
    {turn.reasoning > 0 && <div className={css.muted}>{t("推理")} · {n(turn.reasoning)}</div>}
    <div className={css.tools}>{turn.tools.map((tool) => <span className={css.tool} key={tool.name}>{tool.name} × {n(tool.count)}</span>)}</div>
    <div className={css.attr}>{attr.task ? <>
      <button type="button" className={`${css.link} ${busy ? css.pulse : ""}`} onClick={open} disabled={busy} aria-label={`${t("打开卡片")} ${attr.task}`}>
        {attr.task}{failed && <Icon name="rotateCcw" className="inline ml-1" />}
      </button>
      {` · ${t(STEP_LABELS[attr.step ?? ""] ?? "步骤不明")} · ${attr.round === null ? t("轮次不明") : t("第 {n} 轮").replace("{n}", String(attr.round))}`}
    </> : <span className={css.muted}>{t(BASIS_LABELS[attr.basis ?? "pending"] ?? "待归属")}</span>}</div>
  </li>;
}

function UsageBody({ name, projects, onClose }: Props) {
  const lang = useLang();
  const t: Tr = (word) => lang === "zh" ? word : AGENT_USAGE_WORDS[word] ?? word;
  const [data, setData] = useState<AgentUsage | null>(null);
  const [period, setPeriod] = useState<"today" | "week">("today");
  const [busy, setBusy] = useState(true), [failed, setFailed] = useState(false), [hidden, setHidden] = useState(false);
  const [opening, setOpening] = useState<string | null>(null), [linkFailed, setLinkFailed] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null), navigation = useRef<AbortController | null>(null);
  const load = async (before?: string) => {
    request.current?.abort();
    const ctrl = new AbortController(); request.current = ctrl;
    setBusy(true); setFailed(false);
    try {
      const page = await fetchAgentUsage(name, before, ctrl.signal);
      if (!ctrl.signal.aborted) setData((prev) => ({ ...page, turns: before && prev ? [...prev.turns, ...page.turns] : page.turns }));
    } catch (error) {
      // Permissions hide this owner-only section; all other failures offer an animated retry without exposing backend details.
      if (!ctrl.signal.aborted) {
        if (error instanceof ApiError && error.status === 403) { setHidden(true); setData(null); }
        else setFailed(true);
      }
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void load(); });
    return () => { active = false; request.current?.abort(); navigation.current?.abort(); };
    // The outer key changes on both agent and machine switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = async (task: string) => {
    navigation.current?.abort();
    const ctrl = new AbortController(); navigation.current = ctrl;
    setOpening(task); setLinkFailed(null);
    try {
      await openUsageTask(task, projects, ctrl.signal);
      if (!ctrl.signal.aborted) onClose();
    } catch {
      // A missing card or transient connection failure leaves a retry icon on that card, keeping the ledger visible.
      if (!ctrl.signal.aborted) setLinkFailed(task);
    } finally {
      if (!ctrl.signal.aborted) setOpening(null);
    }
  };
  if (hidden) return null;
  const summary = data?.[period];
  return <section className={css.section} aria-label={t("token 账")} aria-busy={busy}>
    <div className={css.header}><h3 className={css.title}>{t("token 账")}</h3><Icon name="history" /></div>
    <div className={css.tabs}>{(["today", "week"] as const).map((p) => <button type="button" key={p} aria-pressed={period === p}
      className={`btn btn-xs ${period === p ? "btn-primary" : "btn-ghost"}`} onClick={() => setPeriod(p)}>{t(p === "today" ? "今天" : "近 7 天")}</button>)}</div>
    {summary && <div key={period} className={css.enter}>
      <div className={css.muted}>{t("合计")}</div><div className={css.total}>{n(summary.total.totalTokens)}</div>
      <Metrics entries={METRICS.map(([key, label]) => [t(label), summary.total[key]])} />
      <div className={css.models}>{summary.rows.map((row) => <div className={css.model} key={`${row.runtime}:${row.model}`}>
        <div className={css.modelName}>{row.runtime} · {row.model}{row.modelBasis === "request" ? ` (${t("请求")})` : ""}</div>
        <Metrics entries={METRICS.map(([key, label]) => [t(label), row[key]])} />
      </div>)}</div>
    </div>}
    <h4 className={`${css.title} mt-4 mb-2`}>{t("最近轮次")}</h4>
    {data && !data.turns.length && <p className={css.muted}>{t(data.state === "missing" ? "尚未建立 token 账。"
      : data.state === "expired" ? "轮次明细已超过 30 天保留期。" : "暂时没有 token 记录。")}</p>}
    <ol className={css.turns}>{data?.turns.map((turn) => <UsageTurn key={turn.id} turn={turn} t={t} lang={lang}
      open={() => void open(turn.attr.task!)} busy={opening === turn.attr.task && opening !== null} failed={linkFailed === turn.attr.task && linkFailed !== null} />)}</ol>
    <div className={css.footer}>
      {busy ? <span className={css.pulse} role="status" aria-label={t("加载中")}><Icon name="hourglass" /></span>
        : failed ? <button type="button" className="btn btn-ghost btn-sm" aria-label={t("重试")} onClick={() => void load(data?.next ?? undefined)}>
          <Icon name="rotateCcw" /></button>
        : data?.next && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load(data.next!)}>{t("加载更多")}<Icon name="chevronDown" /></button>}
    </div>
  </section>;
}

export function AgentUsageSection(props: Props) {
  const fp = useSyncExternalStore((cb) => machines.subscribe(cb), () => machines.currentFp(), () => null);
  return <UsageBody key={`${fp ?? "local"}:${props.name}`} {...props} />;
}

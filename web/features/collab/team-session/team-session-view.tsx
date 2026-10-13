"use client";
/**
 * 团队卡详情的「会话」区（team-project-TEAMVIS8）：这张卡绑定的作者 / 审查员会话，点开后按页向主场要（team-session-source.ts），只读。
 * 只读的意思：这里只有「查看 / 收起」「更早的消息」「重新获取」和工具行的展开；没有输入框、终端，不调消息 / say 接口，
 * 不读写本机 chat store（不走 collab-detail 的「打开会话」那条本机流程）。取页只在用户点的时候发，失败不自动重发。
 * 外观照本机会话页：气泡、角色头、工具折叠的类名取自 features/chat/components 的 message-list.tsx / tool-rows.tsx
 * （那边是写在组件里的 Tailwind 类，没有 CSS module 可 import，这里逐条照搬、不另起样式）；不直接用 Message：
 * 它挂了长按 / 右键菜单和左滑引用，会写本机 chat store。工具行图标用 collab-icons，不用 toolIcon 的 emoji。
 * 消息文字按原文显示、不渲染 markdown（见下面 Text 的说明）。
 * 契约没有「已截断」位，不显示「已截断」；「已遮蔽 N 段」数正文里的遮蔽占位符（team-session-model.ts）。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "@/lib/i18n";
import { SourceHeader } from "../../chat/components/source-header";
import { cleanSummary } from "../../chat/message-text";
import { toolGroupLayout } from "../../chat/tool-group";
import { Icon } from "../collab-icons";
import type { Tr } from "../collab-model";
import s from "../collab.module.css";
import { teamSessionTr } from "./team-session-i18n";
import { messageCount, sessionGroups, type SessionMessage, type SessionTool } from "./team-session-model";
import { teamSessionStoreOf, type SessionCard, type SessionFailure, type SessionPages } from "./team-session-source";

type Phase = "idle" | "loading" | "ready" | SessionFailure;
const REASON: Record<SessionFailure, string> = {
  home_offline: "主场离线，暂时看不了会话", not_open: "主场未开放会话", not_member: "你不在该项目成员里", expired: "请求已过期",
  gate_refused: "主场拒绝提供这张卡的会话", unsupported: "中心暂未开放会话", unavailable: "会话暂时读不到",
};
/** 这几种可以再要一次（只在用户点的时候发）；主场没开 / 不是成员 / 主场拒发再点也一样，不给按钮 */
const RETRY: ReadonlySet<Phase> = new Set(["home_offline", "expired", "unavailable"]);

function MaskNote({ n, tr }: { n: number; tr: Tr }) {
  if (n <= 0) return null;
  return (
    <span data-masked={n} className="inline-flex shrink-0 items-center gap-1 text-[11px] text-base-content/45">
      <Icon name="shieldCheck" size={11} />
      {tr("已遮蔽 {n} 段", { n })}
    </span>
  );
}

/**
 * 文字段：按原文显示（保留换行，chat-domd 的行高 / 断词），不解析 markdown。不用 @/components/domd：它带 import.meta（试解析 Worker），
 * 而协作视图的包在 tests/web-collab-unified-browser.test.ts 里按普通 <script> 加载，一引进来整包语法错。
 */
function Text({ text }: { text: string }) {
  return <div className="chat-domd whitespace-pre-wrap break-words">{text}</div>;
}

/** 工具行：默认折叠（工具名 + 一行摘要），点开看主场给的全部内容；类名同 tool-rows.tsx HistoryToolRow 的完成态 */
function ToolRow({ tool, tr }: { tool: SessionTool; tr: Tr }) {
  const [open, setOpen] = useState(false);
  const summary = cleanSummary(tool.summary);
  const name = tool.name || tr("工具输出");
  return (
    <div data-tool-row="" className="rounded-lg border border-success/30 bg-success/[0.06]">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-left font-mono cstra-tool-text">
        <span className="shrink-0 opacity-70"><Icon name="terminal" size={12} /></span>
        <span className="shrink-0 font-semibold text-success">{name}</span>
        {summary && <span className="min-w-0 flex-1 truncate text-base-content/50">{summary.slice(0, 80)}</span>}
        <MaskNote n={tool.masked} tr={tr} />
        <span className={`ml-auto shrink-0 opacity-30 transition-transform ${open ? "rotate-90" : ""}`}><Icon name="chevronRight" size={12} /></span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 pt-0.5">
          <pre data-tool-output="" className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono cstra-tool-sub text-base-content/50">
            {tool.summary || name}
          </pre>
        </div>
      )}
    </div>
  );
}

/** 连续的工具调用：单步平铺，多步收进一个框、默认只露最新一步（chat/tool-group.ts 的同一套规则，类名同 ToolGroup） */
function ToolGroup({ tools, tr }: { tools: SessionTool[]; tr: Tr }) {
  const [open, setOpen] = useState(false);
  const layout = toolGroupLayout(tools.length, open, false);
  const row = (tool: SessionTool, i: number) => <ToolRow key={i} tool={tool} tr={tr} />;
  if (!layout.framed) return <div className="my-2 space-y-1">{tools.map(row)}</div>;
  return (
    <div className="my-2 rounded-xl border border-base-content/10 bg-base-content/[0.02] p-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11px] text-base-content/50 transition-colors hover:bg-base-content/5 hover:text-base-content/80">
        <Icon name="chevronRight" size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span>{tr("{n} 步工具调用", { n: tools.length })}</span>
        <span className="ml-auto shrink-0">{open ? tr("收起列表") : tr("展开全部")}</span>
      </button>
      <div className="space-y-1">{layout.showAll ? tools.map(row) : row(tools[tools.length - 1]!, tools.length - 1)}</div>
    </div>
  );
}

/** 别人发来的用户气泡（message-list.tsx 里非本人的那一支：靠左、信息色描边） */
const USER_BUBBLE = "cstra-bubble relative break-words rounded-[4px_15px_15px_15px] border border-info/25 bg-info/[0.06] px-[15px] py-[11px] "
  + "text-[length:var(--chat-font-size,14.5px)] leading-[var(--cstra-lead-user)] text-base-content/90";

/** 一条消息：角色头 + 气泡（用户）/ 全宽正文（助手）/ 居中分隔条（系统），类名同 message-list.tsx 的 Message / SystemDivider */
const Bubble = memo(function Bubble({ m, tr }: { m: SessionMessage; tr: Tr }) {
  if (m.role === "system") {
    return (
      <div data-role="system" className="relative mb-[22px] flex select-none items-center gap-3">
        <span className="h-px flex-1 bg-base-content/10" />
        <span title={m.text} className="max-w-[70%] shrink-0 truncate text-[11px] font-medium tracking-wide text-base-content/35">{m.text}</span>
        <span className="h-px flex-1 bg-base-content/10" />
      </div>
    );
  }
  if (m.role === "user") {
    return (
      <div data-role="user" className="relative mb-[22px] flex flex-col items-start gap-2">
        <SourceHeader from={tr("用户")} />
        {m.text && (
          <div className="max-w-[85%]">
            <div data-bubble="user" className={USER_BUBBLE}>
              <Text text={m.text} />
            </div>
          </div>
        )}
        <MaskNote n={m.masked} tr={tr} />
        {m.tools.length > 0 && <div className="w-full"><ToolGroup tools={m.tools} tr={tr} /></div>}
      </div>
    );
  }
  return (
    <div data-role="assistant" className="relative mb-[22px] w-full">
      <div className="mb-[9px] flex items-center gap-2">
        <span className="flex size-[22px] items-center justify-center rounded-full bg-accent text-[11px] text-white"><Icon name="zap" size={12} /></span>
        <span className="text-xs font-semibold text-base-content/60">{tr("助手")}</span>
      </div>
      {m.text && <div className="cstra-bubble text-[length:var(--chat-font-size,16px)]"><Text text={m.text} /></div>}
      <MaskNote n={m.masked} tr={tr} />
      {m.tools.length > 0 && <ToolGroup tools={m.tools} tr={tr} />}
    </div>
  );
});

function Status({ phase, busy, onRetry, tr }: { phase: Phase; busy: boolean; onRetry: () => void; tr: Tr }) {
  if (busy) {
    return (
      <div className={s.rr} data-session-status="loading" role="status">
        <div className={s.tx} style={{ display: "flex", alignItems: "center", gap: 6 }}><Icon name="hourglass" size={13} />{tr("正在向主场机器读取会话…")}</div>
      </div>
    );
  }
  if (phase === "idle" || phase === "ready" || phase === "loading") return null;
  return (
    <div className={s.rr} data-session-status={phase} role="status">
      <div className={s.tx} style={{ display: "flex", alignItems: "center", gap: 6 }}><Icon name="circleAlert" size={13} />{tr(REASON[phase])}</div>
      {RETRY.has(phase) && (
        <button type="button" className={s.btn} style={{ marginTop: 8 }} data-session-retry="" onClick={onRetry}>
          <Icon name="rotateCcw" size={13} />
          {tr("重新获取")}
        </button>
      )}
    </div>
  );
}

/**
 * project = 协作视图的团队项目键；featureId = 卡所在的中心 feature；cardId = 团队卡号（主场卡号）。
 * 不是团队项目（没有中心身份）不渲染。调用方按卡给 key：换卡即重挂，上一张卡在途的请求随卸载中止。
 * blocked = 读正文时中心已经答过「没开 / 不是成员」：取页同样过不去，只写原因、不给「查看会话」（不白发一次请求）。
 * 不是成员时取页器同样撤权（清缓存、在途的页不收），这里已经读到的页也收掉。
 */
export function TeamSessionSec({ project, featureId, cardId, blocked, tr: base }: {
  project: string; featureId: string; cardId: string; blocked?: "unsupported" | "not_member" | null; tr: Tr;
}) {
  const lang = useLang();
  const tr = useMemo(() => teamSessionTr(base, lang), [base, lang]);
  const store = useMemo(() => teamSessionStoreOf(project), [project]);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<SessionPages | null>(null);
  const card = useRef<SessionCard | null>(null);
  const inflight = useRef<AbortController | null>(null);
  /** 上一次要的是哪一页：「重新获取」原样再要一次 */
  const wanted = useRef<string | null>(null);
  useEffect(() => () => inflight.current?.abort(), []);
  useEffect(() => {
    if (blocked !== "not_member" || !store) return;
    store.revoke();
    inflight.current?.abort();
    inflight.current = null;
    card.current = null;
  }, [blocked, store]);
  // 变成「不是成员」的那一次渲染就把已读到的页收掉（之后再放开也不会露出旧正文）
  const [was, setWas] = useState(blocked);
  if (was !== blocked) {
    setWas(blocked);
    if (blocked === "not_member") { setBusy(false); setOpen(false); setPages(null); setPhase("idle"); }
  }
  const groups = useMemo(() => sessionGroups(pages?.records ?? []), [pages]);
  if (!store) return null;

  /** cached = 刚点开：这张卡读过就直接显示缓存，不发请求 */
  const load = async (cursor: string | null, cached = false) => {
    inflight.current?.abort();
    const ctrl = (inflight.current = new AbortController());
    wanted.current = cursor;
    setBusy(true);
    try {
      const found = card.current ?? await store.resolve(featureId, cardId, ctrl.signal);
      // 对卡号时中心就答了 403：缓存已清，已经显示的也收掉
      if (found === "not_member") { setPages(null); setPhase("not_member"); return; }
      card.current = found;
      const hit = cached && card.current ? store.peek(card.current) : null;
      if (hit) { setPages(hit); setPhase("ready"); return; }
      const got = card.current ? await store.fetchPage(card.current, cursor, ctrl.signal) : { status: "unavailable" as const };
      if (ctrl.signal.aborted) return;
      if (got.status === "page") { setPages(got.pages); setPhase("ready"); }
      else {
        // 非成员 / 主场拒发 / 未开放：缓存已清，已经显示的也收掉；离线、过期等保留已读到的页
        setPages(card.current ? store.peek(card.current) : null);
        if (got.status === "not_member") card.current = null;
        setPhase(got.status);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) { console.warn(`[team] 读会话页失败：${(e as Error).message}`); setPhase("unavailable"); }
    } finally {
      if (inflight.current === ctrl) { inflight.current = null; setBusy(false); }
    }
  };
  const toggle = () => {
    if (open) { inflight.current?.abort(); inflight.current = null; setBusy(false); setOpen(false); return; }
    setOpen(true);
    void load(null, true);
  };
  const total = messageCount(groups);

  return (
    <div className={s.sec} data-team-session={blocked ?? (busy ? "loading" : phase)}>
      <h5>{tr("会话")}</h5>
      <div className={s.pp}>
        <span className={s.av}><Icon name="messageSquare" size={14} /></span>
        <div>
          <div className={s.n}>{tr("作者 / 审查员会话")}</div>
          <div className={s.d}>{tr("按页向主场机器读取，只读")}</div>
          {blocked ? <div className={s.d} data-session-status={blocked}>{tr(REASON[blocked])}</div> : (
            <button type="button" className={s.btn} style={{ marginTop: 8 }} aria-expanded={open} data-session-toggle="" onClick={toggle}>
              {tr(open ? "收起会话" : "查看会话")}
            </button>
          )}
        </div>
      </div>
      {open && !blocked && (
        <div data-session-viewer="" style={{ marginTop: 12 }} className="max-h-[560px] overflow-y-auto rounded-xl border border-base-content/10 p-3">
          {groups.map((g, i) => (
            <section key={g.sessionId} data-session-group={i + 1}>
              <div className="mb-3 flex items-center gap-2 text-[11px] text-base-content/45">
                <Icon name="history" size={12} />
                <span>{tr("会话 {n}", { n: i + 1 })}</span>
                <span>· {tr("{n} 条消息", { n: g.messages.length })}</span>
              </div>
              {i === groups.length - 1 && pages?.nextCursor && (
                <button type="button" className={s.btn} style={{ marginBottom: 14 }} disabled={busy} data-session-more=""
                  onClick={() => void load(pages.nextCursor)}>
                  <Icon name="history" size={13} />
                  {tr("更早的消息")}
                </button>
              )}
              {g.messages.map((m) => <Bubble key={m.key} m={m} tr={tr} />)}
            </section>
          ))}
          {phase === "ready" && !busy && total === 0 && (
            pages?.nextCursor ? (
              <button type="button" className={s.btn} data-session-more="" onClick={() => void load(pages.nextCursor)}>
                <Icon name="history" size={13} />
                {tr("更早的消息")}
              </button>
            ) : <div className={s.rr} data-session-status="empty"><div className={s.tx}>{tr("这张卡还没有会话内容")}</div></div>
          )}
          <Status phase={phase} busy={busy} onRetry={() => void load(wanted.current)} tr={tr} />
        </div>
      )}
    </div>
  );
}

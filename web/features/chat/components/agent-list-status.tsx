"use client";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { agentListView, type AgentListStatus, type AgentListView } from "../agent-list-state";
import { agentListNow } from "../agent-list-loader";
import { useNow } from "../use-now";
import { useT } from "@/lib/i18n";

/**
 * 会话列表加载状态的薄呈现（状态推导在 agent-list-state.ts）：侧栏列表顶上一行 + 启动页底下一行。
 * 只是一行文字 + 重试按钮，不盖住列表——手机上已有的会话照常可点。
 */

/** 侧栏 / 启动页共用的状态文案（retryAt 倒计时按秒走） */
function useAgentListText(st: AgentListStatus, view: AgentListView): string {
  const t = useT();
  useNow(st.retryAt !== null ? 1_000 : 0); // 只用来每秒重渲染；「现在」取 loader 的时钟
  const secs = st.retryAt !== null ? Math.max(1, Math.ceil((st.retryAt - agentListNow()) / 1000)) : null;
  switch (view) {
    case "waiting": return t("加载中…");
    case "slow": return t("会话列表加载较慢，仍在连接…");
    case "retrying":
      if (st.phase === "loading") return t("会话列表加载失败，正在重试…");
      return secs ? t("会话列表加载失败，{s} 秒后自动重试", { s: secs }) : t("会话列表加载失败");
    case "denied": return t("没有权限读取会话列表，可能需要重新配对");
    case "empty": return t("暂无会话");
    case "stale":
      return secs && st.phase !== "loading" ? t("列表刷新失败，显示的是上次的结果 · {s} 秒后重试", { s: secs }) : t("列表刷新失败，显示的是上次的结果");
    default: return "";
  }
}

function RetryButton({ st, className }: { st: AgentListStatus; className: string }) {
  const t = useT();
  const store = useChatStoreApi();
  return (
    <button type="button" className={className} disabled={st.manual} onClick={() => void store.loadAgents("manual")}>
      {st.manual ? t("正在重试…") : t("重试")}
    </button>
  );
}

/** 侧栏列表顶部：list = 不渲染；stale = 列表照旧 + 一条细提示；其余 = 占位文字（只有真空才说「暂无会话」） */
export function AgentListNotice({ count }: { count: number }) {
  const st = useChatStore((s) => s.state.agentList);
  const view = agentListView(st, count);
  const text = useAgentListText(st, view);
  if (view === "list") return null;
  const retry = view === "retrying" || view === "denied" || view === "stale";
  if (view === "stale")
    return (
      <div role="status" data-agent-list={view} className="mb-2 flex items-center gap-2 rounded-lg bg-warning/10 px-2 py-1.5 text-xs text-base-content/70">
        <span className="min-w-0 flex-1">{text}</span>
        <RetryButton st={st} className="btn btn-ghost btn-xs shrink-0" />
      </div>
    );
  return (
    <div role="status" data-agent-list={view} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-4 text-sm">
      <span className={view === "denied" || view === "retrying" ? "text-base-content/70" : "opacity-50"}>{text}</span>
      {retry && <RetryButton st={st} className="btn btn-ghost btn-xs" />}
    </div>
  );
}

/** 启动页：首拉慢 / 失败时说清楚，给「重试」和「先进入」（进入后侧栏继续显示同一状态，不当作加载成功） */
export function SplashListStatus({ onSkip }: { onSkip: () => void }) {
  const t = useT();
  const st = useChatStore((s) => s.state.agentList);
  const view = agentListView(st, 0);
  const text = useAgentListText(st, view);
  if (view !== "slow" && view !== "retrying") return null;
  return (
    <div role="status" data-agent-list={view} className="mt-6 flex max-w-[min(20rem,calc(100vw-32px))] flex-col items-center gap-3 text-center">
      <span className="text-xs text-base-content/60">{text}</span>
      <div className="flex gap-2">
        {view === "retrying" && <RetryButton st={st} className="btn btn-sm" />}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSkip}>{t("先进入")}</button>
      </div>
    </div>
  );
}

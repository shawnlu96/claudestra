"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { RUNTIME_EFFORT_OPTIONS, modelLabel, switcherKindFor } from "../claude-options";
import { useClaudeModelCatalog } from "../claude-models";
import { PiModelSwitcher } from "./pi-model-switcher";
import { CodexModelSwitcher } from "./codex-model-switcher";
import { useT } from "@/lib/i18n";

/**
 * TopBar 的会话级模型/effort 徽章 + 快速切换器（owner 2026-07-23）。
 *
 * 徽章常显当前值（`Fable 5 · xhigh`，数据来自 agents 列表的兜底链:jsonl 实测 →
 * registry → 全局默认）；点开下拉面板直接点选切换——走 BFF /api/agents/
 * claude-settings → Bridge 注入原生 /model、/effort（与 TUI 手打同一路径）。
 * 回合进行中 Bridge 409，就地提示不打断。切换成功 refreshAgents 拉回真值。
 */
export function ClaudeSwitcher({ agent }: { agent: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const catalog = useClaudeModelCatalog(open), models = catalog.models;

  // 点面板外任意处关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (agent.status === "stopped") return null;

  // v2.23+ Pi 会话走自己的切换器：模型来自 provider 配置（models.json）而不是
  // Claude Code 的别名表，切换走扩展命令 `/claudestra-model`、`/claudestra-thinking`
  // 的 tmux 注入（不是 CC 的 `/model`、`/effort` 语义）。见 pi-model-switcher.tsx。
  // Codex 同理有自己的（目录来自 `codex debug models`，切换 = 写 registry 后重启），见 codex-model-switcher.tsx。
  const kind = switcherKindFor(agent.runtime);
  if (kind === "pi") return <PiModelSwitcher agent={agent} />;
  if (kind === "codex") return <CodexModelSwitcher agent={agent} />;
  if (kind !== "claude") return null;

  const apply = async (patch: { model?: string; effort?: string }) => {
    const key = patch.model ?? patch.effort ?? "";
    setSaving(key);
    setErr("");
    try {
      const res = await fetch("/api/agents/claude-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agent.name, ...patch }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(res.status === 409 ? t("回合进行中，等结束后再切") : j.error || t("切换失败"));
        return;
      }
      store.refreshAgents();
      setOpen(false);
    } catch {
      setErr(t("切换失败"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        className="flex items-center gap-1 rounded-full bg-base-200 px-2 py-0.5 font-mono text-[10.5px] text-base-content/60 transition-colors hover:bg-base-300"
        title={t("当前模型与 effort，点击切换")}
        onClick={() => {
          setOpen((v) => !v);
          setErr("");
        }}
      >
        <span className="max-w-[72px] truncate">{modelLabel(agent.model, models)}</span>
        <span className="opacity-40">·</span>
        <span>{agent.effort || "?"}</span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-50">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="panel-pop absolute left-0 top-full z-30 mt-1.5 w-56 max-w-[80vw] rounded-xl border border-base-content/10 bg-base-100 p-3 shadow-lg">
          <div className="mb-1 text-[11px] text-base-content/50">{t("模型")}</div>
          <div className="mb-2.5 flex flex-wrap gap-1">
            {models.length === 0 && <ModelCatalogStatus loading={catalog.loading} error={catalog.error} retry={catalog.retry} />}
            {models.map((o) => (
              <button
                key={o.value}
                className={`btn btn-xs ${agent.model === o.value ? "btn-primary" : "btn-ghost bg-base-200"}`}
                disabled={saving !== null}
                onClick={() => apply({ model: o.value })}
              >
                {saving === o.value ? "…" : o.label}
              </button>
            ))}
          </div>
          <div className="mb-1 text-[11px] text-base-content/50">Effort</div>
          <div className="flex flex-wrap gap-1">
            {RUNTIME_EFFORT_OPTIONS.map((e) => (
              <button
                key={e}
                className={`btn btn-xs font-mono ${agent.effort === e ? "btn-primary" : "btn-ghost bg-base-200"}`}
                disabled={saving !== null}
                title={e === "ultracode" ? t("xhigh + 动态 workflow 编排;仅本 session,需 CC 开启 dynamic workflows") : undefined}
                onClick={() => apply({ effort: e })}
              >
                {saving === e ? "…" : e}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[10px] leading-snug text-base-content/35">
            {t("ultracode = xhigh + 动态编排,仅本 session(重启回落);需 CC /config 开启 dynamic workflows")}
          </div>
          {err && <div className="mt-2 text-[11px] text-error">{err}</div>}
        </div>
      )}
    </div>
  );
}

/** 目录为空时的占位：请求中显示「加载中…」；失败显示原因 + 重试（打开面板时 hook 也会自动重拉一次）。 */
function ModelCatalogStatus({ loading, error, retry }: { loading: boolean; error: string | null; retry: () => void }) {
  const t = useT();
  if (loading || !error) return <span className="text-[11px] text-base-content/40">{t("加载中…")}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-error">
      {t("加载失败")}: {error}
      <button className="btn btn-ghost btn-xs" onClick={retry}>{t("重试")}</button>
    </span>
  );
}

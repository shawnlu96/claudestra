"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { MODEL_OPTIONS, RUNTIME_EFFORT_OPTIONS, modelLabel } from "../claude-options";
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
        <span className="max-w-[72px] truncate">{modelLabel(agent.model)}</span>
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
            {MODEL_OPTIONS.map((o) => (
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

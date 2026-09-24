"use client";
import { useCallback, useRef, useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { useT } from "@/lib/i18n";
import { postRuntimeSwitch, useDismiss } from "../runtime-switch";
import { EffortButtons, SwitcherBadge } from "./switcher-parts";

/**
 * Codex 会话的模型 / 推理档位切换器（TopBar）。
 *
 * 选项来自 Codex 自己的模型目录（桥接跑 `codex debug models`），每个模型支持的档位不同
 * （GPT-6-Astra 到 ultra，GPT-5.5 只到 xhigh），所以档位按当前模型列。Codex 没有能带参数的
 * 切换命令，桥接的做法是写 registry 后重启、接着原会话——上下文保留，但回合进行中不能切。
 */

interface CodexModelOption {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
}

/** 目录拉不到时的档位兜底：所有 Codex 模型都支持的那一段 */
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"];

export function CodexModelSwitcher({ agent }: { agent: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<CodexModelOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, wrapRef);

  // 目录只在首次展开时拉（在点开的事件里发起，不进 effect）；失败留在面板里，下次点开再拉
  const loadModels = async () => {
    if (models !== null || loading) return;
    setLoading(true);
    try {
      const r = await fetch("/api/agents/codex-settings");
      const j = (await r.json().catch(() => ({}) /* 回包不是 JSON（代理错误页之类）：按空处理，下面报错 */)) as {
        data?: { models?: CodexModelOption[]; error?: string };
        error?: string;
      };
      if (!r.ok || !j.data?.models) throw new Error(j.data?.error || j.error || `HTTP ${r.status}`);
      setModels(j.data.models);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const apply = async (patch: { model?: string; effort?: string }) => {
    setSaving(patch.model ?? patch.effort ?? "");
    setErr("");
    const e = await postRuntimeSwitch("/api/agents/codex-settings", { agent: agent.name, ...patch }, t("切换失败"));
    setSaving(null);
    if (e) return setErr(e);
    store.refreshAgents();
    setOpen(false);
  };

  const current = models?.find((m) => m.id === agent.model);
  const locked = saving !== null || !!agent.busy;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    setErr("");
    if (next) void loadModels();
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <SwitcherBadge
        label={current?.name ?? agent.model ?? "?"}
        effort={agent.effort}
        title={t("Codex 会话：当前模型与推理档位，点击切换")}
        maxW="max-w-[96px]"
        onClick={toggle}
      />
      {open && (
        <div className="panel-pop absolute left-0 top-full z-30 mt-1.5 w-60 max-w-[80vw] rounded-xl border border-base-content/10 bg-base-100 p-3 shadow-lg">
          <div className="mb-1 text-[11px] text-base-content/50">{t("模型")}</div>
          {loading && !models && <div className="px-1 py-1 text-[11px] text-base-content/40">{t("加载中…")}</div>}
          <ModelList models={models ?? []} current={agent.model} saving={saving} disabled={locked} onPick={(id) => apply({ model: id })} />
          <div className="mb-1 text-[11px] text-base-content/50">{t("推理档位")}</div>
          <EffortButtons
            levels={current?.efforts.length ? current.efforts : FALLBACK_EFFORTS}
            current={agent.effort}
            saving={saving}
            disabled={locked}
            onPick={(e) => e !== agent.effort && apply({ effort: e })}
          />
          <div className="mt-1.5 text-[10px] leading-snug text-base-content/35">
            {agent.busy ? t("回合进行中，等结束后再切") : t("切换会重启会话，接着原来的对话，上下文不丢")}
          </div>
          {err && <div className="mt-2 text-[11px] text-error">{err}</div>}
        </div>
      )}
    </div>
  );
}

function ModelList(p: {
  models: CodexModelOption[];
  current: string | null | undefined;
  saving: string | null;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div className="mb-2.5 flex flex-col gap-0.5">
      {p.models.map((m) => (
        <button
          key={m.id}
          className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] transition-colors ${
            m.id === p.current ? "bg-primary/15 text-base-content" : "hover:bg-base-200"
          }`}
          disabled={p.disabled}
          title={m.id}
          onClick={() => m.id !== p.current && p.onPick(m.id)}
        >
          <span className="truncate">{m.name}</span>
          <span className="ml-auto font-mono text-[10px] opacity-50">{p.saving === m.id ? "…" : m.id === p.current ? "✓" : ""}</span>
        </button>
      ))}
    </div>
  );
}

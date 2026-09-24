"use client";
import { useCallback, useRef, useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { PI_THINKING_LEVELS, piModelLabel } from "../claude-options";
import { useT } from "@/lib/i18n";
import { useKeepInViewport } from "@/lib/keep-in-viewport";
import { postRuntimeSwitch, useDismiss } from "../runtime-switch";
import { EffortButtons, SwitcherBadge } from "./switcher-parts";

/**
 * Pi 会话的模型 / 思考档位切换器（TopBar）。
 *
 * 为什么不复用 ClaudeSwitcher 的面板：Pi 的模型来自 provider 配置
 * （`~/.pi/agent/models.json`，写法 `provider/model`），不是 Claude Code 的别名表；
 * 切换也不走 CC 的 `/model`、`/effort` 注入（Pi 的 `/model` 是"打开选择器"的交互
 * 语义），而是走 Claudestra 扩展注册的确定性命令 `/claudestra-model`、
 * `/claudestra-thinking`（由桥接侧 tmux 注入，扩展内部直接调 setModel /
 * setThinkingLevel）。
 *
 * 徽章值仍是桥接实测的真实值（agent.model / agent.effort），切换成功后
 * refreshAgents() 拉回真值——与 CC 那条路同款：乐观值先显示，实测追上后接管。
 */

interface PiModelOption {
  id: string;
  provider: string;
  name: string;
  input: string[];
  images: boolean;
  thinking: boolean;
  contextWindow: number | null;
}

export function PiModelSwitcher({ agent }: { agent: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<PiModelOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useKeepInViewport(popRef, open);
  const close = useCallback(() => setOpen(false), []);

  // 面板外点击 / Esc 关闭（与 CC 面板同款交互）
  useDismiss(open, close, wrapRef);

  // 模型清单只在**首次展开**时拉一次（在点开的事件里发起，不进 effect）；
  // 失败留在面板里可重试（下次点开再拉）。
  const loadModels = async () => {
    if (models !== null || loading) return;
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/agents/pi-settings");
      const j = (await r.json().catch(() => ({}))) as {
        data?: { models?: PiModelOption[] };
        error?: string;
      };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setModels(j.data?.models ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setErr("");
    if (next) void loadModels();
  };

  const apply = async (patch: { model?: string; effort?: string }) => {
    setSaving(patch.model ?? patch.effort ?? "");
    setErr("");
    const e = await postRuntimeSwitch("/api/agents/pi-settings", { agent: agent.name, ...patch }, t("切换失败"));
    setSaving(null);
    if (e) return setErr(e);
    store.refreshAgents();
    setOpen(false);
  };

  // 当前模型可能带 `:thinking` 后缀（provider/model:low），比对时剥掉
  const currentId = (agent.model ?? "").replace(/:.*$/, "");
  const providers = [...new Set((models ?? []).map((m) => m.provider))];

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <SwitcherBadge label={piModelLabel(agent.model)} effort={agent.effort} title={t("Pi 会话：当前模型与思考档位，点击切换")} maxW="max-w-[110px]" onClick={toggle} />
      {open && (
        <div ref={popRef} className="panel-pop absolute left-0 top-full z-30 mt-1.5 w-64 max-w-[80vw] rounded-xl border border-base-content/10 bg-base-100 p-3 shadow-lg">
          <div className="mb-1 text-[11px] text-base-content/50">{t("模型")}</div>
          <div className="mb-2.5 max-h-56 overflow-y-auto">
            {loading && !models ? (
              <div className="px-1 py-1 text-[11px] text-base-content/40">{t("加载中…")}</div>
            ) : null}
            {models && models.length === 0 ? (
              <div className="px-1 py-1 text-[11px] text-base-content/40">
                {t("没有可用的 Pi 模型（检查 ~/.pi/agent/models.json）")}
              </div>
            ) : null}
            {providers.map((p) => (
              <div key={p} className="mb-1.5">
                <div className="mb-1 font-mono text-[10px] text-base-content/35">{p}</div>
                <div className="flex flex-col gap-0.5">
                  {(models ?? [])
                    .filter((m) => m.provider === p)
                    .map((m) => (
                      <button
                        key={m.id}
                        className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] transition-colors ${
                          m.id === currentId ? "bg-primary/15 text-base-content" : "hover:bg-base-200"
                        }`}
                        disabled={saving !== null}
                        title={m.id}
                        onClick={() => apply({ model: m.id })}
                      >
                        <span className="truncate">{m.name || m.id}</span>
                        {m.images ? <span title={t("支持图片")}>🖼</span> : null}
                        {m.thinking ? <span title={t("支持思考")}>🧠</span> : null}
                        {saving === m.id ? (
                          <span className="ml-auto opacity-60">…</span>
                        ) : m.id === currentId ? (
                          <span className="ml-auto opacity-60">✓</span>
                        ) : null}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mb-1 text-[11px] text-base-content/50">{t("思考档位")}</div>
          <EffortButtons levels={PI_THINKING_LEVELS} current={agent.effort} saving={saving} disabled={saving !== null} onPick={(e) => apply({ effort: e })} />
          <div className="mt-1 text-[10px] leading-snug text-base-content/35">
            {t("Pi 的档位与 Claude Code 的 effort 不是一套值（off 是 Pi 独有）")}
          </div>
          {err && <div className="mt-2 text-[11px] text-error">{err}</div>}
        </div>
      )}
    </div>
  );
}

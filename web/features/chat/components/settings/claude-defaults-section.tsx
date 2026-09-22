"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { EFFORT_OPTIONS } from "../../claude-options";
import type { ClaudeModelOption } from "../../claude-models";
import { Section } from "./section";

/** 全局默认 effort 选项——与会话级切换器共用（claude-options.ts）；模型清单见 useClaudeModels */
const GLOBAL_EFFORT_OPTIONS = EFFORT_OPTIONS;

/** Claude 全局默认(直读写 ~/.claude/settings.json,经 bridge) */
export function useClaudeDefaults(open: boolean) {
  const [gModel, setGModel] = useState("");
  const [gEffort, setGEffort] = useState("");
  const [gLoaded, setGLoaded] = useState(false);
  const [gMsg, setGMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置：拆分前与语音 Key 同属一个 effect（那条 warning 留在 groq-key-section），不新增基线
    setGMsg("");
    setGLoaded(false);
    fetch("/api/settings/claude-defaults")
      .then((r) => r.json())
      .then((j: { data?: { model: string | null; effort: string | null } }) => {
        if (j.data) {
          setGModel(j.data.model || "");
          setGEffort(j.data.effort || "");
          setGLoaded(true);
        }
      })
      .catch(() => setGMsg("读取失败"));
  }, [open]);

  const saveGlobalDefault = async (patch: { model?: string; effort?: string }) => {
    setGMsg("保存中…");
    try {
      const res = await fetch("/api/settings/claude-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = (await res.json()) as { data?: { model: string | null; effort: string | null }; error?: string };
      if (res.ok && j.data) {
        setGModel(j.data.model || "");
        setGEffort(j.data.effort || "");
        setGMsg("已保存");
      } else {
        setGMsg(j.error || "保存失败");
      }
    } catch {
      setGMsg("保存失败");
    }
  };

  return { gModel, setGModel, gEffort, setGEffort, gLoaded, gMsg, saveGlobalDefault };
}

export function ClaudeDefaultsSection({
  defaults,
  modelOptions: GLOBAL_MODEL_OPTIONS,
}: {
  defaults: ReturnType<typeof useClaudeDefaults>;
  /** useClaudeModels() 的结果——由 SettingsModal 调用（挂载时机与拆分前一致） */
  modelOptions: ClaudeModelOption[];
}) {
  const t = useT();
  const { gModel, setGModel, gEffort, setGEffort, gLoaded, gMsg, saveGlobalDefault } = defaults;
  return (
        <Section
          title={t("Claude 全局默认")}
          desc={t("影响所有未单独钉模型/effort 的新会话（含终端里直接开的 claude）。已钉的 agent 不受影响。")}
        >
        <div className="grid grid-cols-2 gap-3">
          <label className="form-control">
            <span className="label-text mb-1 text-xs text-base-content/60">{t("模型")}</span>
            <select
              className="select select-bordered select-sm w-full"
              value={gModel}
              disabled={!gLoaded}
              onChange={(e) => {
                setGModel(e.target.value);
                void saveGlobalDefault({ model: e.target.value });
              }}
            >
              {gModel !== "" && !GLOBAL_MODEL_OPTIONS.some((o) => o.value === gModel) && (
                <option value={gModel}>{gModel}</option>
              )}
              {gModel === "" && <option value="">{t("未设置")}</option>}
              {GLOBAL_MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-xs text-base-content/60">Effort</span>
            <select
              className="select select-bordered select-sm w-full"
              value={gEffort}
              disabled={!gLoaded}
              onChange={(e) => {
                setGEffort(e.target.value);
                void saveGlobalDefault({ effort: e.target.value });
              }}
            >
              {gEffort !== "" && !GLOBAL_EFFORT_OPTIONS.includes(gEffort as (typeof GLOBAL_EFFORT_OPTIONS)[number]) && (
                <option value={gEffort}>{gEffort}</option>
              )}
              {gEffort === "" && <option value="">{t("未设置")}</option>}
              {GLOBAL_EFFORT_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        </div>
        {gMsg && <div className="mt-2 text-xs text-base-content/60">{t(gMsg)}</div>}
        </Section>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";
import { getCodexDefaults, putCodexDefaults, type CodexDefaults } from "@/lib/api/settings";

/**
 * Codex 全局默认（bridge 读写 ~/.codex/config.toml 顶层的 model / model_reasoning_effort）。
 * 与 Claude 那个分区不同，这里自己随挂载拉取：只在「Codex」页出现，拉目录要跑一次 `codex debug models`，
 * 不值得每次打开设置都跑。选「Codex 默认」= 删掉那一行。
 */
export function CodexDefaultsSection() {
  const t = useT();
  const [d, setD] = useState<CodexDefaults | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    getCodexDefaults()
      .then((r) => alive && setD(r))
      .catch((e) => alive && setMsg((e as Error).message || "读取失败"));
    return () => {
      alive = false;
    };
  }, []);

  const save = async (patch: { model?: string; effort?: string }) => {
    setMsg("保存中…");
    try {
      const r = await putCodexDefaults(patch);
      setD((prev) => (prev ? { ...prev, model: r.model, effort: r.effort } : prev));
      setMsg(r.effortCleared ? "已保存；新模型不支持原来的推理档，已改回该模型的默认档" : "已保存");
    } catch (e) {
      setMsg((e as Error).message || "保存失败");
    }
  };

  const models = d?.models ?? [];
  const model = d?.model ?? "";
  const effort = d?.effort ?? "";
  // 档位选项跟着「实际会用的模型」走：没设模型时就是 Codex 的默认模型
  const shown = models.find((m) => m.id === (model || d?.codexDefault.model));
  const efforts = shown?.efforts.length ? shown.efforts : effort ? [effort] : [];
  const defaultLabel = (v: string | null | undefined) => (v ? `${t("Codex 默认")}（${v}）` : t("Codex 默认"));

  return (
    <Section
      title={t("Codex 全局默认")}
      desc={t("影响所有未单独钉模型/推理档的新 Codex 会话（含终端里直接开的 codex）。已钉的 agent 和正在运行的会话不受影响。")}
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="form-control">
          <span className="label-text mb-1 text-xs text-base-content/60">{t("模型")}</span>
          <select
            className="select select-bordered select-sm w-full"
            value={model}
            disabled={!d || !d.catalogOk}
            onChange={(e) => void save({ model: e.target.value })}
          >
            <option value="">{defaultLabel(d?.codexDefault.model)}</option>
            {model !== "" && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="form-control">
          <span className="label-text mb-1 text-xs text-base-content/60">{t("推理档")}</span>
          <select
            className="select select-bordered select-sm w-full"
            value={effort}
            disabled={!d}
            onChange={(e) => void save({ effort: e.target.value })}
          >
            <option value="">{defaultLabel(shown?.defaultEffort)}</option>
            {efforts.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      </div>
      {d && !d.catalogOk && <div className="mt-2 text-xs text-warning">{t("读不到 Codex 模型目录（codex 没装或出错），暂时只能改推理档。")}</div>}
      {msg && <div className="mt-2 text-xs text-base-content/60">{t(msg)}</div>}
    </Section>
  );
}

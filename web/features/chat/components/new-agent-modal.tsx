"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";

/** 模型选项(值 = manager 侧别名,空 = 跟随全局 settings.json 默认)。 */
const MODEL_OPTIONS = [
  { value: "", label: "默认（跟随全局）" },
  { value: "fable", label: "Fable 5" },
  { value: "opus", label: "Opus 4.8" },
  { value: "sonnet", label: "Sonnet 4.6" },
  { value: "haiku", label: "Haiku 4.5" },
] as const;

/** Effort 选项(经 --effort 传 CC,session 级,不写全局默认)。 */
const EFFORT_OPTIONS = [
  { value: "", label: "默认（跟随全局）" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
] as const;

/**
 * 新建 agent 弹窗：填 name / dir / purpose (+可选钉模型/effort) → store.createAgent
 * → Bridge runManager create。选了模型/effort 会写进 registry,restart 也保持——
 * 与 TUI /model、/effort 不同,不会改写全局 settings.json(owner 2026-07-16)。
 * daisyUI modal（遵 prin b8ce13：只用 DaisyUI + Tailwind）。
 */
export function NewAgentModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const store = useChatStoreApi();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [purpose, setPurpose] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setName("");
    setDir("");
    setPurpose("");
    setModel("");
    setEffort("");
    setError("");
    setBusy(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async () => {
    const n = name.trim();
    const d = dir.trim();
    if (!n || !d) {
      setError(t("name 和 dir 必填"));
      return;
    }
    setBusy(true);
    setError("");
    const res = await store.createAgent(n, d, purpose.trim() || undefined, {
      model: model || undefined,
      effort: effort || undefined,
    });
    setBusy(false);
    if (res.ok) {
      reset();
      onClose();
    } else {
      setError(res.error || t("创建失败"));
    }
  };

  return (
    <div className="modal modal-open overlay-in">
      <div className="panel-pop modal-box">
        <h3 className="text-lg font-semibold">{t("新建会话")}</h3>
        <p className="mt-1 text-xs opacity-60">
          {t("在指定目录起一个 Claude Code agent（经 Bridge）。")}
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <label className="form-control">
            <span className="label-text mb-1 text-sm">{t("名称")}</span>
            <input
              className="input input-bordered input-sm w-full"
              placeholder="worker-alpha"
              value={name}
              disabled={busy}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-sm">{t("工作目录")}</span>
            <input
              className="input input-bordered input-sm w-full font-mono"
              placeholder={t("~/code/project 或 /abs/path")}
              value={dir}
              disabled={busy}
              onChange={(e) => setDir(e.target.value)}
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-sm">{t("用途（可选）")}</span>
            <input
              className="input input-bordered input-sm w-full"
              placeholder={t("这个 agent 干什么")}
              value={purpose}
              disabled={busy}
              onChange={(e) => setPurpose(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <span className="label-text mb-1 text-sm">{t("模型")}</span>
              <select
                className="select select-bordered select-sm w-full"
                value={model}
                disabled={busy}
                onChange={(e) => setModel(e.target.value)}
              >
                {MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-control">
              <span className="label-text mb-1 text-sm">Effort</span>
              <select
                className="select select-bordered select-sm w-full"
                value={effort}
                disabled={busy}
                onChange={(e) => setEffort(e.target.value)}
              >
                {EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="-mt-1 text-[11px] leading-snug opacity-45">
            {t("只钉这个 agent（重启保持），不改全局默认——和终端里 /model、/effort 会写全局不同。")}
          </p>
        </div>

        {error && (
          <div className="mt-3 text-sm text-error break-words">{t(error)}</div>
        )}

        <div className="modal-action">
          <button className="btn btn-ghost btn-sm" onClick={close} disabled={busy}>
            {t("取消")}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={busy}
          >
            {busy && <span className="loading loading-spinner loading-xs" />}
            {t("创建")}
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={close} />
    </div>
  );
}

"use client";
import { useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";

/** 模型选项(值 = manager 侧别名,空 = 跟随全局 settings.json 默认)。 */
const MODEL_OPTIONS = [
  { value: "", label: "默认（跟随全局）" },
  { value: "fable", label: "Fable 5" },
  { value: "opus", label: "Opus 5" },
  { value: "opus-4-8", label: "Opus 4.8" },
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
  const projects = useChatStore((s) => s.state.projects);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [purpose, setPurpose] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  // v2.21+ project 归属:"" = 自动(按目录);选定后目录变下拉(project 的 dirs + 自定义)
  const [project, setProject] = useState("");
  const [dirCustom, setDirCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const selProj = projects.find((p) => p.id === project);

  const reset = () => {
    setName("");
    setDir("");
    setPurpose("");
    setModel("");
    setEffort("");
    setProject("");
    setDirCustom(false);
    setError("");
    setBusy(false);
  };

  // 角色预设(owner 2026-08-28:「方便地加一个 agent 来 review 整个项目/测试」)。
  // 只是填表快捷方式——名字建议 + purpose 模板,一切仍可改。
  const applyPreset = (kind: "review" | "test") => {
    const base = selProj?.id || "code";
    const pname = selProj?.name || base;
    if (kind === "review") {
      setName(`${base}-review`);
      setPurpose(`负责 review project「${pname}」的代码:跨仓审查改动、指出问题、把关质量`);
    } else {
      setName(`${base}-test`);
      setPurpose(`负责 project「${pname}」的测试:跑测试套件、补测试、验证同伴的改动`);
    }
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
      project: project || undefined,
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
            <span className="label-text mb-1 text-sm">{t("所属 project")}</span>
            <select
              className="select select-bordered select-sm w-full"
              value={project}
              disabled={busy}
              onChange={(e) => {
                const id = e.target.value;
                setProject(id);
                setDirCustom(false);
                const p = projects.find((x) => x.id === id);
                // 选定 project → 目录预填它的第一个仓
                if (p?.dirs.length) setDir(p.dirs[0]);
              }}
            >
              <option value="">{t("自动（按目录归属/新建）")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.emoji || "📁"} {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-sm">{t("工作目录")}</span>
            {selProj && !dirCustom ? (
              <select
                className="select select-bordered select-sm w-full font-mono"
                value={dir}
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setDirCustom(true);
                    setDir("");
                  } else {
                    setDir(e.target.value);
                  }
                }}
              >
                {selProj.dirs.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                <option value="__custom__">{t("自定义路径…")}</option>
              </select>
            ) : (
              <input
                className="input input-bordered input-sm w-full font-mono"
                placeholder={t("~/code/project 或 /abs/path")}
                value={dir}
                disabled={busy}
                onChange={(e) => setDir(e.target.value)}
              />
            )}
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
            {/* 角色预设:一键填好名字建议 + purpose 模板 */}
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                className="btn btn-ghost btn-xs border border-base-content/15"
                disabled={busy}
                onClick={() => applyPreset("review")}
              >
                🔍 {t("Review 员")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs border border-base-content/15"
                disabled={busy}
                onClick={() => applyPreset("test")}
              >
                🧪 {t("测试员")}
              </button>
            </div>
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

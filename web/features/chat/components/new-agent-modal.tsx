"use client";
import { useState, useEffect } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";
// 模型清单来自 CC 自己的模型目录(值 = 完整 model id,manager 原样透传);别在这里另维护一份
// ——写死的表跟后端别名表一起漂移过两次(2026-09-15 缺 Sonnet 5、09-22 缺 Opus 5.5)
import { useClaudeModels } from "../claude-models";

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
 * 某个运行时在这台机器上能不能用（bridge GET /api/v1/runtimes，经 BFF /api/runtimes）。
 * v2.24+ Codex 靠它决定出不出现在下拉里；查不到一律当不可用（安全方向：不显示点了会报错的选项）。
 */
function useRuntimeAvailable(id: string): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/runtimes")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: { runtimes?: { id: string; available: boolean }[] } } | null) => {
        if (alive) setAvailable(j?.data?.runtimes?.some((r) => r.id === id && r.available) === true);
      })
      .catch(() => {}); // 查不到就当不可用：不显示这个选项，是安全方向
    return () => {
      alive = false;
    };
  }, [id]);
  return available;
}

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
  const claudeModels = useClaudeModels();
  const [effort, setEffort] = useState("");
  // v2.21+ project 归属:"" = 自动(按目录);选定后目录变下拉(project 的 dirs + 自定义)
  const [project, setProject] = useState("");
  // v2.23+ 运行时：Pi coding agent（工具集与 Claude Code 不同）+ 它的能力档案
  const [runtime, setRuntime] = useState("");
  // 这台机器有没有装 Pi：没有就**不显示任何 Pi 入口**（owner 2026-09-14 要求
  // 「让没装 pi 的人无感」）。失败/桥接不可达一律当没有 —— 安全方向（宁可少显示，
  // 也不给一个点了才报错的选项）。
  const [piAvailable, setPiAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: { piAvailable?: boolean } } | null) => {
        if (alive) setPiAvailable(j?.data?.piAvailable === true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const codexAvailable = useRuntimeAvailable("codex");
  const [piBase, setPiBase] = useState("");
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
    setRuntime("");
    setPiBase("");
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
      runtime: runtime || undefined,
      piBase: runtime === "pi" && piBase ? piBase : undefined,
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
          {runtime === "pi" && piAvailable
            ? t("在指定目录起一个 Pi coding agent（经 Bridge）。工具集与 Claude Code 不同。")
            : runtime === "codex" && codexAvailable
              ? t("在指定目录起一个 Codex agent（经 Bridge）。只支持免审批模式，职责在建线程时写入。")
              : t("在指定目录起一个 Claude Code agent（经 Bridge）。")}
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
          {piAvailable || codexAvailable ? (
          <label className="form-control">
            <span className="label-text mb-1 text-sm">{t("运行时")}</span>
            <select
              className="select select-bordered select-sm w-full"
              value={runtime}
              disabled={busy}
              onChange={(e) => {
                setRuntime(e.target.value);
                if (e.target.value !== "pi") setPiBase("");
                // 两个运行时的模型标识不通用（Claude 别名 vs Pi 的 provider/model-id），切换就清空
                setModel("");
              }}
            >
              <option value="">{t("Claude Code（默认）")}</option>
              {piAvailable ? <option value="pi">Pi coding agent</option> : null}
              {codexAvailable ? <option value="codex">Codex</option> : null}
            </select>
          </label>
          ) : null}
          {runtime === "pi" ? (
            <label className="form-control">
              <span className="label-text mb-1 text-sm">{t("能力档案")}</span>
              <select
                className="select select-bordered select-sm w-full"
                value={piBase}
                disabled={busy}
                onChange={(e) => setPiBase(e.target.value)}
              >
                <option value="">{t("继承全局（你桌面装的那套扩展）")}</option>
                <option value="minimal">{t("最小集（只带内置工具 + 通道）")}</option>
              </select>
              <span className="mt-1 text-[11px] leading-snug opacity-45">
                {t("最小集不继承 ~/.pi/agent 里的包（联网搜索、子代理等），cron / 无人值守场景更合适。")}
              </span>
            </label>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <label className="form-control">
              <span className="label-text mb-1 text-sm">{t("模型")}</span>
              {runtime === "pi" || runtime === "codex" ? (
                // Pi 的 --model 收的是 provider/model-id，Codex 收它自己的模型 id，Claude 别名表
                // 对两者都无意义：选个 sonnet-5 会原样透传 → 起不来（review #10 应修项）
                <input
                  type="text"
                  className="input input-bordered input-sm w-full"
                  value={model}
                  disabled={busy}
                  placeholder={runtime === "pi" ? t("provider/model-id（留空 = Pi 默认）") : t("Codex 模型 id（留空 = Codex 默认）")}
                  onChange={(e) => setModel(e.target.value)}
                />
              ) : (
                <select
                  className="select select-bordered select-sm w-full"
                  value={model}
                  disabled={busy}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">{t("默认（跟随全局）")}</option>
                  {claudeModels.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
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

"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";

/**
 * 定时任务管理弹窗(设置 → 自动化 → 定时任务;owner 2026-08-26「cron 没有 UI」)。
 * 列表 + 行内编辑(原地改 schedule/prompt,保 id/lastRun——不重建)+ 新建 + 开关 + 删除。
 * 数据面走 /api/cron(BFF)→ bridge /api/v1/cron* → runManager,与 CLI/Discord
 * 面板三方等价。删除有二次确认;记忆卫生任务(mem0-hygiene)也在列表里,与
 * 设置页的专属板块指向同一条任务。
 */

interface CronJobView {
  id: string;
  name: string;
  schedule: string;
  dir: string;
  prompt: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  targetAgent: string | null;
  /** v2.21.3+ 临时 agent 的 effort 档;null = 缺省 medium(targetAgent 模式不适用) */
  effort?: string | null;
}

/** 临时 agent 的档位选项(缺省 medium:Fable 5.1 文档说 medium ≈ Fable 5 且更省额度) */
const EFFORT_CHOICES = ["medium", "low", "high", "xhigh", "max"] as const;

async function cronAction(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch("/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/** 单个任务行:折叠态一行概览,展开态编辑表单。 */
function JobRow({ job, onChanged }: { job: CronJobView; onChanged: () => void }) {
  const t = useT();
  const [expand, setExpand] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [schedule, setSchedule] = useState(job.schedule);
  const [prompt, setPrompt] = useState(job.prompt);
  const [confirmDel, setConfirmDel] = useState(false);

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg("");
    const r = await cronAction(body);
    if (!r.ok) setMsg(r.error || t("操作失败"));
    setBusy(false);
    onChanged();
    return !!r.ok;
  };

  const dirty = schedule.trim() !== job.schedule || prompt.trim() !== job.prompt;

  return (
    <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setExpand((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold">{job.name}</span>
            <code className="shrink-0 rounded bg-base-content/10 px-1.5 py-0.5 text-[11px]">{job.schedule}</code>
            {job.targetAgent ? (
              <span className="shrink-0 text-[11px] opacity-50">→ {job.targetAgent}</span>
            ) : (
              <span className="shrink-0 text-[11px] opacity-50">⚙ {job.effort || "medium"}</span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-base-content/50">
            {t("下次")} {job.enabled ? fmtTime(job.nextRun) : t("已停用")} · {t("上次")} {fmtTime(job.lastRun)}
          </div>
        </button>
        <input
          type="checkbox"
          className="toggle toggle-sm shrink-0"
          checked={job.enabled}
          disabled={busy}
          onChange={() => void run({ action: "toggle", id: job.id })}
        />
      </div>

      {expand && (
        <div className="mt-3 space-y-2 border-t border-base-content/10 pt-3">
          <label className="flex items-center gap-2 text-[12.5px]">
            <span className="shrink-0 opacity-60">{t("表达式")}</span>
            <input
              className="input input-sm input-bordered w-full font-mono"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="0 10 * * 1"
            />
          </label>
          <label className="block text-[12.5px]">
            <span className="opacity-60">{t("任务指令")}</span>
            <textarea
              className="textarea textarea-bordered mt-1 w-full text-[12.5px] leading-relaxed"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <div className="text-[11px] opacity-40">
            {t("目录")} {job.dir}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary btn-xs"
              disabled={busy || !dirty || !schedule.trim() || !prompt.trim()}
              onClick={() =>
                void run({
                  action: "edit",
                  id: job.id,
                  ...(schedule.trim() !== job.schedule ? { schedule: schedule.trim() } : {}),
                  ...(prompt.trim() !== job.prompt ? { prompt: prompt.trim() } : {}),
                }).then((ok) => ok && setExpand(false))
              }
            >
              {t("保存")}
            </button>
            {confirmDel ? (
              <>
                <button
                  className="btn btn-error btn-xs"
                  disabled={busy}
                  onClick={() => void run({ action: "remove", id: job.id })}
                >
                  {t("确认删除")}
                </button>
                <button className="btn btn-ghost btn-xs" onClick={() => setConfirmDel(false)}>
                  {t("取消")}
                </button>
              </>
            ) : (
              <button className="btn btn-ghost btn-xs text-error/80" onClick={() => setConfirmDel(true)}>
                {t("删除")}
              </button>
            )}
            {msg && <span className="text-[11px] text-error/80">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 新建任务折叠表单。 */
function AddJobForm({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 10 * * 1");
  const [dir, setDir] = useState("~");
  const [prompt, setPrompt] = useState("");
  const [effort, setEffort] = useState<string>("medium");

  if (!open) {
    return (
      <button className="btn btn-ghost btn-sm w-full border border-dashed border-base-content/20" onClick={() => setOpen(true)}>
        ＋ {t("新建定时任务")}
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-base-content/10 bg-base-200/40 p-3">
      <div className="flex gap-2">
        <input
          className="input input-sm input-bordered flex-1"
          placeholder={t("任务名(唯一)")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input input-sm input-bordered w-36 font-mono"
          placeholder="0 10 * * 1"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <input
          className="input input-sm input-bordered min-w-0 flex-1 font-mono"
          placeholder={t("工作目录(默认 ~)")}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
        {/* 临时 agent 的 effort 档:无人值守批处理缺省 medium,要更强就手动拉高 */}
        <select
          className="select select-sm select-bordered w-28"
          value={effort}
          title={t("临时 agent 的 effort 档")}
          onChange={(e) => setEffort(e.target.value)}
        >
          {EFFORT_CHOICES.map((lv) => (
            <option key={lv} value={lv}>
              ⚙ {lv}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="textarea textarea-bordered w-full text-[12.5px]"
        rows={3}
        placeholder={t("任务指令:到点起一个临时 agent 执行,完成后自动清理并报告")}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <button
          className="btn btn-primary btn-xs"
          disabled={busy || !name.trim() || !schedule.trim() || !prompt.trim()}
          onClick={async () => {
            setBusy(true);
            setMsg("");
            const r = await cronAction({ action: "add", name: name.trim(), schedule: schedule.trim(), dir: dir.trim() || "~", prompt: prompt.trim(), effort });
            setBusy(false);
            if (r.ok) {
              setOpen(false);
              setName("");
              setPrompt("");
              onChanged();
            } else {
              setMsg(r.error || t("创建失败"));
            }
          }}
        >
          {t("创建")}
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => setOpen(false)}>
          {t("取消")}
        </button>
        {msg && <span className="text-[11px] text-error/80">{msg}</span>}
      </div>
    </div>
  );
}

export function CronModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [jobs, setJobs] = useState<CronJobView[]>([]);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/cron");
      const j = (await r.json()) as { ok?: boolean; error?: string; jobs?: CronJobView[] };
      if (j.ok) setJobs(j.jobs || []);
      else setErr(j.error || t("加载失败"));
    } catch {
      setErr(t("加载失败"));
    }
    setLoaded(true);
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    void reload();
  }, [open, reload]);

  if (!open) return null;

  return createPortal(
    <div
      className="overlay-in fixed inset-0 z-[90] grid place-items-center bg-black/50 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="panel-pop flex max-h-[88dvh] w-full max-w-md flex-col rounded-2xl bg-base-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="text-base font-semibold">{t("定时任务")}</span>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-5 pb-5 pt-1">
          <p className="text-xs leading-relaxed text-base-content/50">
            {t("到点起一个临时 agent 执行指令,完成后报告并清理。改频率/指令是原地编辑,不丢运行历史。")}
          </p>
          {err && <div className="text-xs text-error/80">{err}</div>}
          {loaded && jobs.length === 0 && !err && (
            <div className="py-4 text-center text-xs opacity-40">{t("还没有定时任务")}</div>
          )}
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onChanged={() => void reload()} />
          ))}
          <AddJobForm onChanged={() => void reload()} />
        </div>
      </div>
    </div>,
    document.body
  );
}

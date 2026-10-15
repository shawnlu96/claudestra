"use client";
/**
 * 侧栏 project 菜单「接入编排」弹窗（ONB-3）：打开即 dry-run 读清单，改参数自动重核，点「接入」跑同一条 `team onboard`。
 * 清单内容、拦截原因全由后端给（/api/v1/projects/:id/onboard）；这里只排版。只在有 manage 授权时从菜单进来。
 * 菜单点开后自己就关了，弹窗挂在常驻的 ProjectMenu 里（ProjectOnboardHost），由 openProjectOnboard 唤起。
 */
import { useEffect, useState, type ReactNode } from "react";
import { onboardProject, type OnboardItem, type OnboardResult } from "@/lib/api/project-onboard";
import { useT } from "@/lib/i18n";
import { CenteredModal } from "./centered-modal";
import { CheckIcon, TriangleAlertIcon, XIcon } from "./line-icons";
import type { ProjectMeta } from "../type";

const subs = new Set<(p: ProjectMeta | null) => void>();
export function openProjectOnboard(p: ProjectMeta | null): void {
  subs.forEach((f) => f(p));
}

const LABEL: Record<OnboardItem["key"], string> = { project: "目录", git: "仓库", scheduler: "调度配置", team: "编排班子" };
const ICON: Record<OnboardItem["status"], { tone: string; icon: ReactNode }> = {
  ok: { tone: "text-success", icon: <CheckIcon size={14} /> },
  done: { tone: "text-success", icon: <CheckIcon size={14} /> },
  todo: { tone: "text-info", icon: <span className="text-sm leading-none">＋</span> },
  diff: { tone: "text-warning", icon: <TriangleAlertIcon size={14} /> },
  blocked: { tone: "text-error", icon: <XIcon size={14} /> },
};

/** lucide plug：菜单项图标 */
export function PlugIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

function Row({ it }: { it: OnboardItem }) {
  const t = useT();
  const s = ICON[it.status];
  return (
    <li data-onboard-item={it.key} data-status={it.status} className="flex items-start gap-2.5 py-2 text-[13px] leading-snug">
      <span className={`flex h-[1lh] w-4 shrink-0 items-center justify-center ${s.tone}`}>{s.icon}</span>
      <span className="w-16 shrink-0 text-base-content/60">{t(LABEL[it.key])}</span>
      <span className="min-w-0 flex-1 whitespace-normal break-words">{t(it.text)}</span>
    </li>
  );
}

function OnboardDialog({ p, onClose }: { p: ProjectMeta; onClose: () => void }) {
  const t = useT();
  // undefined = 还没读到仓库状态：首轮不带，读到后按「没有 origin 就本地合并」给缺省
  const [localMerge, setLocalMerge] = useState<boolean | undefined>(undefined);
  const [checks, setChecks] = useState("");
  const [max, setMax] = useState("2");
  // 结果记着它答的是哪组参数：参数一变，「检查中」由键不等推出来，不在 effect 里同步改状态
  const [res, setRes] = useState<{ key: string; r: OnboardResult } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const maxN = /^\d+$/.test(max.trim()) ? Number(max) : undefined;
  const params = { localMerge, checks, maxWorkers: maxN };
  const key = JSON.stringify(params);
  const checking = !done && res?.key !== key;
  const busy = submitting ? "submit" : checking ? "check" : null;

  useEffect(() => {
    if (done) return;
    let live = true;
    const want = JSON.stringify({ localMerge, checks, maxWorkers: maxN });
    const id = setTimeout(() => {
      void onboardProject(p.id, { localMerge, checks, maxWorkers: maxN }, true).then((r) => {
        if (!live) return;
        setRes({ key: want, r });
        if (localMerge === undefined && r.git) setLocalMerge(r.git === "no-origin");
      });
    }, 350);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [p.id, localMerge, checks, maxN, done]);

  const submit = async () => {
    setSubmitting(true);
    const r = await onboardProject(p.id, params, false);
    setRes({ key, r });
    setSubmitting(false);
    setDone(r.ok);
  };
  const shown = res?.r ?? null;
  const ready = !!shown?.ok && shown.items.some((x) => x.status === "todo") && !busy && !done;
  const nothingToDo = !!shown?.ok && !done && !checking && shown.items.every((x) => x.status === "ok");
  return (
    <CenteredModal onClose={onClose} layer="base">
      <div className="flex items-center justify-between px-5 pb-2 pt-4">
        <span className="min-w-0 truncate text-base font-semibold">
          {t("接入编排")} · {p.name || p.id}
        </span>
        <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-5 pt-1">
        <p className="text-xs leading-relaxed text-base-content/50">
          {t("逐项核对，只补缺的：没有调度配置就新增，已有的只列差异不覆盖；班子要 owner 在卡片上确认。")}
        </p>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="checkbox checkbox-sm" checked={!!localMerge} disabled={done} onChange={(e) => setLocalMerge(e.target.checked)} />
          {t("本地合并（仓库没有 origin 时必选）")}
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block text-base-content/60">{t("检查命令（逗号分隔；新增调度配置时必填）")}</span>
          <input className="input input-bordered input-sm w-full" value={checks} disabled={done} placeholder="cargo test, cargo clippy"
            onChange={(e) => setChecks(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <span className="text-base-content/60">{t("并发上限")}</span>
          <input className="input input-bordered input-sm w-20" inputMode="numeric" value={max} disabled={done} onChange={(e) => setMax(e.target.value)} />
        </label>
        <ul className="divide-y divide-base-200 rounded-xl bg-base-200/40 px-3">
          {shown?.items.length ? shown.items.map((it) => <Row key={it.key} it={it} />) : <li className="py-2 text-[13px] text-base-content/50">{t("检查中…")}</li>}
        </ul>
        {/* 拦住的原因已在清单行里；清单外的失败（没权限、写失败、卡片没贴出去）才单独显示 */}
        {shown?.error && !shown.items.some((x) => x.status === "blocked") && <p className="text-[13px] text-error">{t(shown.error)}</p>}
        {done && <p className="text-[13px] text-success">{t("已接入；班子提案确认后，重启 PM 让角色生效。")}</p>}
        {nothingToDo && <p className="text-[13px] text-base-content/60">{t("都已就绪，不用再接入。")}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t(done ? "关闭" : "取消")}
          </button>
          {!done && (
            <button className="btn btn-primary btn-sm" disabled={!ready} onClick={() => void submit()}>
              {busy === "submit" ? t("接入中…") : busy === "check" ? t("检查中…") : t("接入")}
            </button>
          )}
        </div>
      </div>
    </CenteredModal>
  );
}

/** 常驻在 ProjectMenu 里；同一时间最多一个弹窗 */
export function ProjectOnboardHost() {
  const [p, setP] = useState<ProjectMeta | null>(null);
  useEffect(() => {
    subs.add(setP);
    return () => {
      subs.delete(setP);
    };
  }, []);
  if (!p || typeof document === "undefined") return null;
  return <OnboardDialog key={p.id} p={p} onClose={() => setP(null)} />;
}

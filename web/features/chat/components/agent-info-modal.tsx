"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { closeAgentInfo, fetchAgentInfo, setAgentExternal, setAgentLabel, useAgentInfoTarget, type AgentInfo } from "../agent-info";
import { fmtTs } from "../fmt-time";
import { CenteredModal } from "./centered-modal";

/**
 * 会话详情弹窗（owner 2026-09-27）：registry 里的静态信息 + 列表里的实时状态，以及 external 闸门的开关。
 * external 是 peer 共享的正式闸门（src/lib/peer-scope-gate.ts）：关着的 agent 在 Peer 面板里选不上；
 * 正在共享时关闭要输入会话名确认（ConfirmOff），后端同步把它从各 peer 的 scope 里摘掉。
 * 单实例，挂在 AgentMenu 的 portal 里；打开状态在 ../agent-info.ts。
 */
function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1.5 text-[13px]">
      <div className="text-base-content/45">{k}</div>
      <div className={`min-w-0 break-all ${mono ? "font-mono text-[12px]" : ""}`}>{v ?? <span className="text-base-content/30">—</span>}</div>
    </div>
  );
}

type ConfirmOffProps = { name: string; peers: string[]; busy: boolean; onCancel: () => void; onConfirm: (typed: string) => void };
function ConfirmOff({ name, peers, busy, onCancel, onConfirm }: ConfirmOffProps) {
  const t = useT();
  const [typed, setTyped] = useState("");
  return (
    <CenteredModal onClose={onCancel}>
      <div className="p-5">
        <h3 className="text-base font-semibold text-error">{t("关闭 external 闸门")}</h3>
        <p className="mt-2 text-[13px] text-base-content/80">
          {t("该会话正在共享给以下 peer，关闭后他们将立刻失去访问。输入会话名以确认：")}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {peers.map((p) => (
            <span key={p} className="badge badge-warning badge-sm">{p}</span>
          ))}
        </div>
        <input
          className="input input-bordered input-sm mt-3 w-full font-mono"
          placeholder={name}
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed === name) onConfirm(typed);
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>{t("取消")}</button>
          <button className="btn btn-error btn-sm" disabled={busy || typed !== name} onClick={() => onConfirm(typed)}>{t("确认关闭")}</button>
        </div>
      </div>
    </CenteredModal>
  );
}

/** 「显示名」行：输入 + 保存（owner 2026-09-27），空 = 清除；保存后回调刷新详情与列表 */
function LabelRow({ name, current, onSaved }: { name: string; current: string; onSaved: () => void }) {
  const t = useT();
  const [v, setV] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setV(current), [current]);
  const save = async () => {
    setBusy(true);
    setErr("");
    const r = await setAgentLabel(name, v.trim());
    setBusy(false);
    if (!r.ok) setErr(r.error);
    else onSaved();
  };
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1.5 text-[13px]">
      <div className="text-base-content/45">{t("显示名")}</div>
      <div className="min-w-0">
        <div className="flex gap-1.5">
          <input
            className="input input-bordered input-xs min-w-0 flex-1"
            placeholder={t("留空则只显示会话名")}
            value={v}
            maxLength={40}
            disabled={busy}
            onChange={(e) => setV(e.target.value)}
          />
          <button className="btn btn-primary btn-xs" disabled={busy || v.trim() === current} onClick={() => void save()}>{t("保存")}</button>
        </div>
        {err && <div className="mt-1 text-[11px] text-error">{err}</div>}
      </div>
    </div>
  );
}

function InfoBody({ name, onClose }: { name: string; onClose: () => void }) {
  const t = useT();
  const store = useChatStoreApi();
  const live = useChatStore((s) => s.state.agents.find((a) => a.name === name));
  const projects = useChatStore((s) => s.state.projects);
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const load = () =>
    fetchAgentInfo(name).then((r) => {
      if (r.ok) setInfo(r.data.agent);
      else setErr(r.error);
    });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按 name 重拉
  }, [name]);

  const apply = async (on: boolean, typed?: string) => {
    setBusy(true);
    setErr("");
    setNote("");
    const r = await setAgentExternal(name, on, typed);
    setBusy(false);
    if (!r.ok) {
      if (r.needConfirm) setConfirm(r.sharedWith ?? info?.sharedWith ?? []);
      else setErr(r.error);
      return;
    }
    setConfirm(null);
    if (r.data.removedFromPeers?.length) setNote(`${t("已从以下 peer 的共享范围移除：")}${r.data.removedFromPeers.join(", ")}`);
    await load();
    void store.refreshAgents();
  };
  const project = projects.find((p) => p.id === (info?.projectId ?? live?.projectId));
  const status = live ? (live.status === "active" ? (live.busy ? t("工作中") : t("运行中")) : t("已停止")) : info?.status;
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-base-300 px-5 py-3">
        <div className="min-w-0">
          <div className="text-[11px] text-base-content/45">{t("会话详情")}</div>
          <div className="truncate text-base font-semibold">{live?.displayName ?? info?.displayName ?? name}</div>
        </div>
        <button className="btn btn-ghost btn-sm btn-circle" aria-label={t("关闭")} onClick={onClose}>✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {err && <div className="mb-2 rounded-lg bg-error/10 px-3 py-2 text-[12px] text-error">{t("加载失败")}: {err}</div>}
        <Row k={t("名称")} v={name} mono />
        <LabelRow name={name} current={info?.label ?? ""} onSaved={() => { void load(); void store.refreshAgents(); }} />
        <Row k={t("用途")} v={info?.purpose || live?.purpose || null} />
        <Row k={t("工作目录")} v={info?.cwd} mono />
        <Row k="Project" v={project ? `${project.emoji ? project.emoji + " " : ""}${project.name || project.id}` : (info?.projectId ?? null)} />
        <Row k={t("运行时")} v={info?.runtime ?? live?.runtime ?? null} />
        <Row k={t("模型")} v={live?.model ? `${live.model}${live.effort ? ` · ${live.effort}` : ""}` : (info?.model ?? null)} />
        <Row k={t("状态")} v={status ?? null} />
        <Row k={t("会话 ID")} v={info?.sessionId} mono />
        <Row k={t("Discord 频道")} v={info?.channelId} mono />
        <Row k={t("创建时间")} v={info?.created ? fmtTs(info.created) : null} mono />
        <Row k={t("最近活动")} v={live?.lastActivityTs ? fmtTs(new Date(live.lastActivityTs).toISOString()) : null} mono />
        <div className="mt-3 rounded-xl border border-base-300 p-3">
          <label className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[13px] font-medium">{t("对外共享（external）")}</div>
              <div className="mt-0.5 text-[12px] text-base-content/55">
                {t("开启后可共享给 peer；对方能看到该会话的全部上下文。关闭时会从所有 peer 的共享范围里移除。")}
              </div>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-success mt-0.5 shrink-0"
              checked={info?.external === true}
              disabled={busy || !info}
              onChange={(e) => void apply(e.target.checked)}
            />
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px] text-base-content/60">
            <span>{info?.sharedWith.length ? t("已共享给") : t("未共享")}</span>
            {info?.sharedWith.map((p) => (
              <span key={p} className="badge badge-ghost badge-sm">{p}</span>
            ))}
          </div>
          {note && <div className="mt-2 text-[12px] text-success">{note}</div>}
        </div>
      </div>
      {confirm && (
        <ConfirmOff name={name} peers={confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={(typed) => void apply(false, typed)} />
      )}
    </>
  );
}

/** 单实例：目标为 null 时不渲染 */
export function AgentInfoModal() {
  const name = useAgentInfoTarget();
  if (!name) return null;
  return (
    <CenteredModal onClose={closeAgentInfo}>
      <InfoBody name={name} onClose={closeAgentInfo} />
    </CenteredModal>
  );
}

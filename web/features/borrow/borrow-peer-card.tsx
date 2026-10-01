"use client";
/**
 * 一个借入 peer 的卡片：协议徽章、hello 年龄、各家族「可放 / 上报空闲」、在跑 / 上限、不可用原因原文，
 * 以及按钮改设置（项目逐个开关、上限加减、两下删除）。每次点击立刻经 bridge 写入：
 * 成功整卡一闪，失败回到原值并抖一下被点的按钮。
 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useT } from "@/lib/i18n";
import { removeBorrowPeer, saveBorrowPeer, type DroppedView, type Family, type PeerView } from "./borrow-api";
import { canToggleOff, clampMaxOpen, peerState, reportedFree, toggleProject, type PeerState } from "./borrow-model";
import { AgeTag, ProjectChips, Stepper } from "./borrow-bits";
import { CircleAlertIcon, PauseIcon, RepeatIcon, ServerIcon, TrashIcon, ZapIcon } from "./icons";
import { fadeIn, fadeOut, flash, shake } from "./motion";

const FAMILIES: Family[] = ["codex", "claude"];

function ProtoBadge({ state }: { state: PeerState }) {
  const t = useT();
  if (state === "unknown") return null;
  // proto 1 是老协议，不是故障：中性灰；proto 2 不论此刻能不能放都标「推送」
  return state === "poll" ? (
    <span className="badge badge-ghost badge-sm gap-1 text-base-content/60"><RepeatIcon className="size-3" />{t("只轮询")}</span>
  ) : (
    <span className="badge badge-sm gap-1 border-success/30 bg-success/10 text-success"><ZapIcon className="size-3" />{t("推送")}</span>
  );
}

/** 某家族此刻被暂停：单家族额度暂停只停它，其它原因的暂停停整台 */
const familyPaused = (p: PeerView, f: Family, now: number): boolean =>
  !!p.paused && p.paused.until > now && (p.paused.reason === `${f}_quota` || !p.paused.reason.endsWith("_quota"));

function Capacity({ peer, now }: { peer: PeerView; now: number }) {
  const t = useT();
  const c = peer.capacity;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-base-content/65">
      {FAMILIES.map((f) => {
        const free = reportedFree(peer, f);
        return (
          <span key={f} className={`inline-flex items-center gap-1 ${familyPaused(peer, f, now) ? "text-base-content/35" : ""}`}>
            <span className="font-mono">{f}</span>
            <span className="font-semibold text-base-content/85">{c ? c.slots[f] : "–"}</span>
            <span className="text-base-content/40">/ {free ?? "–"}</span>
            {familyPaused(peer, f, now) && <PauseIcon className="size-3" />}
          </span>
        );
      })}
      <span className="inline-flex items-center gap-1">
        {t("在跑")} <span className="font-semibold text-base-content/85">{c ? c.open : "–"}</span>
        <span className="text-base-content/40">/ {peer.maxOpen}</span>
      </span>
      {peer.grant && <span className="text-base-content/45">{t("今日余 {n} 单", { n: peer.grant.ordersLeftToday })}</span>}
    </div>
  );
}

type Draft = { projects: string[]; maxOpen: number };

export function BorrowPeerCard(props: {
  peer: PeerView;
  options: { id: string; name: string }[];
  limit: number;
  dropped: DroppedView[];
  serverNow: number;
  receivedAt: number;
  tick: number;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { peer, options, limit, dropped, serverNow, receivedAt, tick, onChanged } = props;
  const t = useT();
  const card = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const state = peerState(peer);
  const cur: Draft = draft ?? { projects: peer.projects, maxOpen: peer.maxOpen };

  useEffect(() => fadeIn(card.current), []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);

  const save = async (next: Draft, el: HTMLElement) => {
    setDraft(next);
    setBusy(true);
    try {
      await saveBorrowPeer(peer.peer, next);
      await onChanged();
      flash(card.current);
    } catch {
      shake(el); // 回弹：draft 清掉就是服务端的原值
    } finally {
      setDraft(null);
      setBusy(false);
    }
  };
  const remove = async (e: MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy(true);
    try {
      await removeBorrowPeer(peer.peer);
      await fadeOut(card.current);
      await onChanged();
    } catch {
      shake(el);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={card} className="space-y-2 rounded-lg bg-base-100 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ServerIcon className="size-3.5 shrink-0 text-base-content/50" />
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{peer.peer}</span>
        <ProtoBadge state={state} />
        <AgeTag at={peer.capacity?.helloAt ?? null} serverNow={serverNow} receivedAt={receivedAt} tick={tick} />
        {props.canWrite && (
          <button
            className={`btn btn-ghost btn-xs ml-auto btn-square ${armed ? "text-error" : "text-base-content/45"}`}
            disabled={busy}
            aria-label={t("移除")}
            onClick={(e) => void remove(e)}
          >
            <TrashIcon className="size-3.5" />
          </button>
        )}
      </div>
      <Capacity peer={peer} now={serverNow} />
      {peer.capacity?.why && state !== "poll" && (
        <div className="flex items-start gap-1 text-[11.5px] text-warning">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{t(peer.capacity.why)}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <ProjectChips
          options={options}
          picked={cur.projects}
          dropped={dropped.filter((d) => d.project).map((d) => d.project as string)}
          disabled={busy || !props.canWrite}
          canToggle={(id) => canToggleOff(cur.projects, id)}
          onToggle={(id, el) => void save({ ...cur, projects: toggleProject(cur.projects, id, options.map((o) => o.id)) }, el)}
        />
        <Stepper
          value={cur.maxOpen}
          limit={limit}
          disabled={busy || !props.canWrite}
          onStep={(d, el) => void save({ ...cur, maxOpen: clampMaxOpen(cur.maxOpen + d, limit) }, el)}
        />
      </div>
    </div>
  );
}

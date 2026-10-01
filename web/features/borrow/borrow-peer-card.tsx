"use client";
/**
 * 一个借入 peer 的卡片：协议徽章、hello 年龄、各家族「可放 / 上报空闲」、在跑 / 上限、不可用原因原文，
 * 以及按钮改设置（项目逐个开关、同时最多跑几单、两下删除）。每次点击立刻经 bridge 写入：
 * 成功整卡一闪，失败回到原值并抖一下被点的按钮。
 */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { removeBorrowPeer, saveBorrowPeer, type DroppedView, type Family, type PeerView } from "./borrow-api";
import { canToggleOff, lenderCap, peerState, reportedFree, serialLatest, toggleProject, type PeerState } from "./borrow-model";
import { AgeTag, LimitLine, ProjectChips, Stepper } from "./borrow-bits";
import { CircleAlertIcon, PauseIcon, RepeatIcon, ServerIcon, TrashIcon, ZapIcon } from "./icons";
import { fadeIn, fadeOut, flash, shake } from "./motion";

const FAMILIES: Family[] = ["codex", "claude"];

function ProtoBadge({ state }: { state: PeerState }) {
  const t = useT();
  if (state === "unknown") return null;
  // proto 1 是老协议，不是故障：中性灰；proto 2 不论此刻能不能放都标「推送」
  return state === "poll" ? (
    <span className="badge badge-ghost badge-sm shrink-0 gap-1 whitespace-nowrap text-base-content/60"><RepeatIcon className="size-3" />{t("只轮询")}</span>
  ) : (
    <span className="badge badge-sm shrink-0 gap-1 whitespace-nowrap border-success/30 bg-success/10 text-success"><ZapIcon className="size-3" />{t("推送派单")}</span>
  );
}

/** 某家族此刻被暂停：单家族额度暂停只停它，其它原因的暂停停整台 */
const familyPaused = (p: PeerView, f: Family, now: number): boolean =>
  !!p.paused && p.paused.until > now && (p.paused.reason === `${f}_quota` || !p.paused.reason.endsWith("_quota"));

function Capacity({ peer, now, age }: { peer: PeerView; now: number; age: ReactNode }) {
  const t = useT();
  const c = peer.capacity;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-base-content/65">
      {age}
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

/** 对方授权的名额比我方上限小：实际最多只跑得到它，标在句末（warning 色）；不小于或没上报不显示 */
function LenderCapBadge({ peer, maxOpen }: { peer: PeerView; maxOpen: number }) {
  const t = useT();
  const m = lenderCap(peer, maxOpen);
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => fadeIn(el.current), [m]);
  if (m === null) return null;
  return (
    <span ref={el} className="badge badge-sm shrink-0 gap-1 whitespace-nowrap border-warning/30 bg-warning/10 text-warning">
      <CircleAlertIcon className="size-3" />
      {t("对方只开了 {n} 个", { n: m })}
    </span>
  );
}

/** 删一条借入：成功整行淡出再刷新，失败抖被点的按钮（卡片与失效行共用） */
export async function dropPeer(peer: string, row: HTMLElement | null, el: HTMLElement, onChanged: () => Promise<void>): Promise<void> {
  try {
    await removeBorrowPeer(peer);
    await fadeOut(row);
    await onChanged();
  } catch {
    shake(el);
  }
}

type Draft = { projects: string[]; maxOpen: number };
type SaveJob = { peer: string; next: Draft; el: HTMLElement | null; reload: () => Promise<void> };

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

  // 本卡的保存排成一队（serialLatest）：微调 flush 出的值和随后输入的值不并发，最后落下的是最后提交的
  const queue = useRef<((job: SaveJob) => Promise<void>) | null>(null);
  const save = (next: Draft, el: HTMLElement | null) => {
    setDraft(next);
    setBusy(true);
    queue.current ??= serialLatest<SaveJob>(async (job, isLatest) => {
      try {
        await saveBorrowPeer(job.peer, job.next);
        await job.reload();
        flash(card.current);
      } catch {
        shake(job.el); // 回弹：draft 清掉就是服务端的原值
      } finally {
        if (isLatest()) {
          setDraft(null);
          setBusy(false);
        }
      }
    });
    void queue.current({ peer: peer.peer, next, el, reload: onChanged });
  };
  const remove = async (e: MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy(true);
    await dropPeer(peer.peer, card.current, el, onChanged);
    setBusy(false);
  };

  return (
    <div ref={card} className="space-y-2 rounded-lg bg-base-100 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ServerIcon className="size-3.5 shrink-0 text-base-content/50" />
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{peer.peer}</span>
        <ProtoBadge state={state} />
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
      <Capacity peer={peer} now={serverNow} age={<AgeTag at={peer.capacity?.helloAt ?? null} serverNow={serverNow} receivedAt={receivedAt} tick={tick} />} />
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
          onToggle={(id, el) => (canToggleOff(cur.projects, id) ? void save({ ...cur, projects: toggleProject(cur.projects, id, options.map((o) => o.id)) }, el) : shake(el))}
        />
      </div>
      <LimitLine name={peer.peer} n={cur.maxOpen} badge={<LenderCapBadge peer={peer} maxOpen={cur.maxOpen} />}>
        <Stepper value={cur.maxOpen} limit={limit} deferred disabled={busy || !props.canWrite} onCommit={(n, el) => void save({ ...cur, maxOpen: n }, el)} />
      </LimitLine>
    </div>
  );
}

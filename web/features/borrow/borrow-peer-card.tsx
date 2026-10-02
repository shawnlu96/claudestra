"use client";
/** Peer totals and busy counts are read-only; project selection and removal remain editable. */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useT } from "@/lib/i18n";
import { machineNow, stillOn, type DroppedView, type Family, type PeerBody, type PeerView } from "./borrow-api";
import { cardLocked, dropPeer, saveThenRefresh, type Feed } from "./borrow-feed";
import { canToggleOff, oneAtATime, peerAgentSlots, peerState, toggleProject, type PeerState } from "./borrow-model";
import { QuotaLine } from "./borrow-alloc";
import { AgeTag, ProjectChips } from "./borrow-bits";
import { CircleAlertIcon, PauseIcon, RepeatIcon, ServerIcon, TrashIcon, ZapIcon } from "./icons";
import { fadeIn, fadeOut, flash, shake } from "./motion";

const FAMILIES: Family[] = ["claude", "codex"];

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

function Capacity({ peer, now }: { peer: PeerView; now: number }) {
  const t = useT();
  return (
    <div className="grid grid-cols-2 gap-3 text-xs tabular-nums">
      {FAMILIES.map((f) => {
        const slots = peerAgentSlots(peer, f);
        return (
          <div key={f} className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-medium">{f === "claude" ? "Claude" : "Codex"}</span>
            <span className="font-semibold">{slots?.total ?? "—"}</span>
            <span className="text-[11px] text-base-content/50">{t("在跑")} {slots?.busy ?? "—"}</span>
            {familyPaused(peer, f, now) && <PauseIcon className="size-3 text-warning" />}
          </div>
        );
      })}
    </div>
  );
}

export function BorrowPeerCard(props: {
  peer: PeerView;
  options: { id: string; name: string }[];
  dropped: DroppedView[];
  serverNow: number;
  receivedAt: number;
  tick: number;
  canWrite: boolean;
  /** 当前快照的序号（borrow-feed.ts）：写成功后要等更大的才解锁 */
  seq: number;
  feed: Feed;
}) {
  const { peer, options, dropped, serverNow, receivedAt, tick, feed } = props;
  const t = useT();
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [waitAfter, setWaitAfter] = useState<number | null>(null);
  const locked = cardLocked(busy, waitAfter, props.seq);
  const [armed, setArmed] = useState(false);
  const state = peerState(peer);

  useEffect(() => fadeIn(card.current), []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);

  // 一张卡同时只做一件写；写在途、或写成功后还没拿到写之后的快照，都锁着项目开关和删除（borrow-feed.ts）
  const gate = useRef<ReturnType<typeof oneAtATime> | null>(null);
  const write = (job: () => Promise<void>) => {
    if (!locked) void (gate.current ??= oneAtATime(setBusy))(job);
  };
  const save = (next: PeerBody, el: HTMLElement | null) =>
    write(async () => {
      const at = machineNow();
      const r = await saveThenRefresh({ peer: peer.peer, body: next, at, feed, hold: setWaitAfter });
      if (r === "failed" && stillOn(at)) shake(el);
      if (r === "saved") flash(card.current);
    });
  const remove = (e: MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    if (!armed) return setArmed(true);
    setArmed(false);
    write(() => dropPeer(peer.peer, feed, { fade: () => fadeOut(card.current), fail: () => shake(el) }));
  };

  return (
    <div ref={card} className="space-y-2 rounded-lg bg-base-100 px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        {/* 名字和徽章一起换行，删除钮固定在右上：窄屏不会单独掉到第二行 */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <ServerIcon className="size-3.5 shrink-0 text-base-content/50" />
          <span className="max-w-full truncate font-mono text-[12.5px] font-semibold">{peer.peer}</span>
          <ProtoBadge state={state} />
        </div>
        {props.canWrite && (
          <button
            className={`btn btn-ghost btn-xs shrink-0 btn-square ${armed ? "text-error" : "text-base-content/45"}`}
            disabled={locked}
            aria-label={t("移除")}
            onClick={remove}
          >
            <TrashIcon className="size-3.5" />
          </button>
        )}
      </div>
      <Capacity peer={peer} now={serverNow} />
      <AgeTag at={peer.capacity?.helloAt ?? null} serverNow={serverNow} receivedAt={receivedAt} tick={tick} />
      <QuotaLine quota={peer.quota} now={serverNow} />
      {peer.capacity?.why && state !== "poll" && (
        <div className="flex items-start gap-1 text-[11.5px] text-warning">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{t(peer.capacity.why)}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <ProjectChips
          options={options}
          picked={peer.projects}
          dropped={dropped.filter((d) => d.project).map((d) => d.project as string)}
          disabled={locked || !props.canWrite}
          onToggle={(id, el) => (canToggleOff(peer.projects, id) ? save({ projects: toggleProject(peer.projects, id, options.map((o) => o.id)) }, el) : shake(el))}
        />
      </div>
    </div>
  );
}

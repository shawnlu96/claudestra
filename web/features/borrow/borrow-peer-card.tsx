"use client";
/**
 * 一个借入 peer 的卡片（分配表的一行）：协议徽章、hello 年龄、各家族「可放 / 上报空闲」、在跑 / 上限、本周已用、不可用原因原文，
 * 以及按钮改设置（项目逐个开关、档位、角色、同时最多跑几单、两下删除）。每次点击只存改的那一格（没带的 CLI 沿用），
 * 存的期间到拿回写之后的快照为止整张卡禁用（不留本地草稿）：
 * 成功整卡一闪，失败抖一下被点的按钮。请求在点击那一刻绑定机器，切了机器就不再动这张卡。
 */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { machineNow, stillOn, type DroppedView, type Family, type PeerBody, type PeerView } from "./borrow-api";
import { cardLocked, dropPeer, saveThenRefresh, type Feed } from "./borrow-feed";
import { canToggleOff, lenderCap, oneAtATime, peerPriority, peerRoles, peerState, reportedFree, toggleProject, toggleRole, type PeerState } from "./borrow-model";
import { AllocStrip, QuotaLine } from "./borrow-alloc";
import { AgeTag, LimitLine, ProjectChips, Stepper } from "./borrow-bits";
import { CircleAlertIcon, FlagIcon, PauseIcon, RepeatIcon, ServerIcon, TrashIcon, ZapIcon } from "./icons";
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

/** 这台 peer 被某项目的 reviewFirst 点名：审查单先给它，压过档位 */
function ReviewFirstBadge() {
  const t = useT();
  return (
    <span className="badge badge-sm shrink-0 gap-1 whitespace-nowrap border-primary/30 bg-primary/10 text-primary">
      <FlagIcon className="size-3" />{t("审查先给")}
    </span>
  );
}

export function BorrowPeerCard(props: {
  peer: PeerView;
  options: { id: string; name: string }[];
  limit: number;
  dropped: DroppedView[];
  serverNow: number;
  receivedAt: number;
  tick: number;
  canWrite: boolean;
  /** 当前快照的序号（borrow-feed.ts）：写成功后要等更大的才解锁 */
  seq: number;
  /** scheduler.json 某项目的 reviewFirst 点名了它 */
  reviewFirst: boolean;
  feed: Feed;
}) {
  const { peer, options, limit, dropped, serverNow, receivedAt, tick, feed } = props;
  const t = useT();
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [waitAfter, setWaitAfter] = useState<number | null>(null);
  const locked = cardLocked(busy, waitAfter, props.seq);
  const [armed, setArmed] = useState(false);
  const state = peerState(peer);
  const cur = { projects: peer.projects, maxOpen: peer.maxOpen, roles: peerRoles(peer) };

  useEffect(() => fadeIn(card.current), []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);

  // 一张卡同时只做一件写；写在途、或写成功后还没拿到写之后的快照，都锁着 −、+、输入框、项目开关和删除（borrow-feed.ts）
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
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ServerIcon className="size-3.5 shrink-0 text-base-content/50" />
        <span className="max-w-full truncate font-mono text-[12.5px] font-semibold">{peer.peer}</span>
        <ProtoBadge state={state} />
        {props.reviewFirst && <ReviewFirstBadge />}
        {props.canWrite && (
          <button
            className={`btn btn-ghost btn-xs ml-auto btn-square ${armed ? "text-error" : "text-base-content/45"}`}
            disabled={locked}
            aria-label={t("移除")}
            onClick={remove}
          >
            <TrashIcon className="size-3.5" />
          </button>
        )}
      </div>
      <Capacity peer={peer} now={serverNow} age={<AgeTag at={peer.capacity?.helloAt ?? null} serverNow={serverNow} receivedAt={receivedAt} tick={tick} />} />
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
          picked={cur.projects}
          dropped={dropped.filter((d) => d.project).map((d) => d.project as string)}
          disabled={locked || !props.canWrite}
          onToggle={(id, el) => (canToggleOff(cur.projects, id) ? save({ projects: toggleProject(cur.projects, id, options.map((o) => o.id)) }, el) : shake(el))}
        />
      </div>
      <AllocStrip tier={peerPriority(peer)} roles={cur.roles} disabled={locked || !props.canWrite} onTier={(priority, el) => save({ priority }, el)}
        onRole={(r, el) => {
          const roles = toggleRole(cur.roles, r);
          return roles ? save({ roles }, el) : shake(el);
        }} />
      <LimitLine name={peer.peer} n={cur.maxOpen} badge={<LenderCapBadge peer={peer} maxOpen={cur.maxOpen} />}>
        <Stepper value={cur.maxOpen} limit={limit} disabled={locked || !props.canWrite} onCommit={(n, el) => save({ maxOpen: n }, el)} />
      </LimitLine>
    </div>
  );
}

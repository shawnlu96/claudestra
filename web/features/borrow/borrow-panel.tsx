"use client";
/**
 * 设置 · Peer 协作页底部的「借入」面板（i28-R7b）：借谁的机器、每台现在能放几单、协议版本、远端在跑的单。
 * 开着时每 15 秒拉一次，页面切到后台就停；读接口 403 / 404（不是 owner 全权设备 / 老 bridge）整块不渲染。
 * 改设置的按钮只给 canRunFleet 的设备（与 bridge 写门同一来源）。分配表（i28-Q1）：本机一行（每个项目）+ 每台 peer 一行，
 * 本机 Claude / Codex 名额一点就存，peer 的 hello 名额与在跑数只读。
 */
import { useEffect, useState } from "react";
import { fleetAccess } from "@/lib/api/fleet";
import { useT } from "@/lib/i18n";
import { Section } from "@/features/chat/components/settings/section";
import { addableContacts, POLL_MS, sortPeers, stalePeers } from "./borrow-model";
import { LocalRow } from "./borrow-alloc";
import { BorrowPeerCard } from "./borrow-peer-card";
import { borrowFeed, EMPTY_FEED, visiblePeers, type FeedState } from "./borrow-feed";
import { NewPeer } from "./borrow-new-peer";
import { RemoteRows } from "./borrow-remote";
import { StaleEntry } from "./borrow-stale";
import { ActivityIcon, PlusIcon } from "./icons";

function useBorrowView() {
  const [s, setS] = useState<FeedState>(EMPTY_FEED);
  const [feed] = useState(() => borrowFeed(setS));
  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      void feed.load();
      iv ??= setInterval(() => void feed.load(), POLL_MS);
    };
    const stop = () => {
      if (iv) clearInterval(iv);
      iv = null;
      feed.stop();
    };
    const onVis = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [feed]);
  return { ...s, feed };
}

/** 年龄的时钟：tick 从 0 开始（= 按服务端 now 算），之后每 5 秒走一次 */
function useTick(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

function useCanWrite(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    void fleetAccess().then((v) => live && setOk(v));
    return () => void (live = false);
  }, []);
  return ok;
}

export function BorrowPanel() {
  const t = useT();
  const { view, receivedAt, hidden, seq, gone, feed } = useBorrowView();
  const reload = feed.load;
  const tick = useTick(5000);
  const canWrite = useCanWrite();
  const [adding, setAdding] = useState<string | null>(null);
  if (hidden || !view) return null;
  const options = view.borrow.projects;
  const stale = stalePeers(view).filter((s) => !gone.has(s.peer));
  const addable = addableContacts(view).filter((c) => c !== adding);
  const stamp = { serverNow: view.now, receivedAt, tick };
  const names = new Map(options.map((p) => [p.id, p.name]));
  return (
    <div className="mt-3 space-y-3">
      <Section title={t("借别人的电脑跑我的活")}>
        <div className="space-y-2">
          {view.projects.map((p) => (
            <LocalRow key={p.id} project={p} name={names.get(p.id) ?? p.id} quota={view.localQuota} serverNow={view.now} canWrite={canWrite} seq={seq} feed={feed} />
          ))}
          {sortPeers(visiblePeers({ view, gone })).map((p) => (
            <BorrowPeerCard key={p.peer} peer={p} options={options} canWrite={canWrite} seq={seq} feed={feed}
              dropped={view.borrow.dropped.filter((d) => d.peer === p.peer)} {...stamp} />
          ))}
          {stale.map((s) => <StaleEntry key={s.peer} s={s} view={view} canWrite={canWrite} feed={feed} />)}
          {adding && <NewPeer key={adding} peer={adding} view={view} onCancel={() => setAdding(null)} onChanged={reload} />}
          {canWrite && addable.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {addable.map((c) => (
                <button key={c} className="btn btn-ghost btn-xs gap-1 rounded-full border-base-content/15 font-mono font-normal" onClick={() => setAdding(c)}>
                  <PlusIcon className="size-3" />
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      </Section>
      {view.remote.length > 0 && (
        <Section title={<span className="inline-flex items-center gap-1.5"><ActivityIcon className="size-3.5" />{t("远端在跑")}</span>}>
          <RemoteRows rows={view.remote} {...stamp} />
        </Section>
      )}
    </div>
  );
}

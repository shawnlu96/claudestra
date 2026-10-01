"use client";
/**
 * 设置 · Peer 协作页底部的「借入」面板（i28-R7b）：借谁的机器、每台现在能放几单、协议版本、远端在跑的单。
 * 开着时每 15 秒拉一次，页面切到后台就停；读接口 403 / 404（不是 owner 全权设备 / 老 bridge）整块不渲染。
 * 改设置的按钮只给 canRunFleet 的设备（与 bridge 写门同一来源）。remote.mode 还没有写入口，这里只读显示。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fleetAccess } from "@/lib/api/fleet";
import { useT } from "@/lib/i18n";
import { Section } from "@/features/chat/components/settings/section";
import { borrowSaver, fetchBorrow, type BorrowView, type DroppedCode, type DroppedView } from "./borrow-api";
import { addableContacts, canSubmitNew, POLL_MS, sortPeers, toggleProject } from "./borrow-model";
import { LimitLine, ProjectChips, Stepper } from "./borrow-bits";
import { BorrowPeerCard, dropPeer } from "./borrow-peer-card";
import { RemoteRows } from "./borrow-remote";
import { ActivityIcon, CheckIcon, PlusIcon, ServerIcon, TrashIcon, XIcon } from "./icons";
import { fadeIn, shake } from "./motion";

type Loaded = { view: BorrowView | null; receivedAt: number; hidden: boolean };

function useBorrowView() {
  const [s, setS] = useState<Loaded>({ view: null, receivedAt: 0, hidden: false });
  const ctrl = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    try {
      const view = await fetchBorrow(ac.signal);
      if (!ac.signal.aborted) setS(view ? { view, receivedAt: Date.now(), hidden: false } : { view: null, receivedAt: 0, hidden: true });
    } catch (e) {
      // 断网 / 超时：保留上一次的数据，下一轮再拉；面板不因为一次失败消失
      if (!ac.signal.aborted) console.warn("[borrow] 拉取失败", e);
    }
  }, []);
  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      void load();
      iv ??= setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (iv) clearInterval(iv);
      iv = null;
      ctrl.current?.abort();
    };
    const onVis = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [load]);
  return { ...s, reload: load };
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

const DROPPED_TEXT: Record<DroppedCode, string> = {
  contact_gone: "联系人已删除", contact_disabled: "联系人已禁用", fp_changed: "对方实例换了", project_gone: "项目已删除", personal: "个人项目",
};

function ProjectModes({ view }: { view: BorrowView }) {
  const t = useT();
  const names = new Map(view.borrow.projects.map((p) => [p.id, p.name]));
  if (!view.projects.length) return null;
  return (
    <ul className="divide-y divide-base-content/5 rounded-lg bg-base-100">
      {view.projects.map((p) => (
        <li key={p.id} className="flex min-w-0 items-center gap-2 px-3 py-2 text-[12px]">
          <span className="min-w-0 truncate">{names.get(p.id) ?? p.id}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-base-content/45">{t("本机 {n} 位", { n: p.maxActiveWorkers })}</span>
          <span className={`badge badge-sm ml-auto shrink-0 ${p.mode === "off" ? "badge-ghost text-base-content/55" : "border-primary/30 bg-primary/10 text-primary"}`}>
            {t(p.mode === "off" ? "只用本机" : "平均分配")}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 声明了、但整条已失效的借入（联系人删了 / 禁用 / 换实例）：只给删除 */
function DeadEntry({ d, canWrite, onChanged }: { d: DroppedView; canWrite: boolean; onChanged: () => Promise<void> }) {
  const t = useT();
  const row = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const drop = async (el: HTMLElement) => {
    setBusy(true);
    await dropPeer(d.peer, row.current, el, onChanged);
    setBusy(false);
  };
  return (
    <div ref={row} className="flex min-w-0 items-center gap-2 rounded-lg bg-base-100 px-3 py-2 text-[12px] text-base-content/45">
      <ServerIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-mono line-through">{d.peer}</span>
      <span className="shrink-0 text-[11px]">{t(DROPPED_TEXT[d.code])}</span>
      {canWrite && (
        <button className="btn btn-ghost btn-xs btn-square ml-auto" disabled={busy} aria-label={t("移除")} onClick={(e) => void drop(e.currentTarget)}>
          <TrashIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function NewPeer({ peer, view, onCancel, onChanged }: { peer: string; view: BorrowView; onCancel: () => void; onChanged: () => Promise<void> }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [maxOpen, setMaxOpen] = useState(3);
  const [busy, setBusy] = useState(false);
  const limit = view.borrow.maxOpenLimit;
  const order = view.borrow.projects.map((p) => p.id);
  useEffect(() => fadeIn(box.current), []);
  const submit = async (el: HTMLElement) => {
    setBusy(true);
    try {
      await borrowSaver.create(peer, { projects, maxOpen }); // 删后重加：恢复这个 peer 的保存
      await onChanged();
      onCancel();
    } catch {
      shake(el);
      setBusy(false);
    }
  };
  return (
    <div ref={box} className="space-y-2 rounded-lg border border-dashed border-base-content/20 bg-base-100 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ServerIcon className="size-3.5 shrink-0 text-base-content/50" />
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{peer}</span>
        <button className="btn btn-ghost btn-xs btn-square ml-auto" disabled={busy} aria-label={t("取消")} onClick={onCancel}>
          <XIcon className="size-3.5" />
        </button>
        <button
          className="btn btn-primary btn-xs btn-square"
          disabled={busy || !canSubmitNew(projects, maxOpen, limit)}
          aria-label={t("借用这台电脑")}
          onClick={(e) => void submit(e.currentTarget)}
        >
          {busy ? <span className="loading loading-spinner loading-xs" /> : <CheckIcon className="size-3.5" />}
        </button>
      </div>
      <ProjectChips options={view.borrow.projects} picked={projects} disabled={busy} onToggle={(id) => setProjects((cur) => toggleProject(cur, id, order))} />
      <LimitLine name={peer} n={maxOpen}>
        <Stepper value={maxOpen} limit={limit} disabled={busy} onCommit={setMaxOpen} />
      </LimitLine>
    </div>
  );
}

export function BorrowPanel() {
  const t = useT();
  const { view, receivedAt, hidden, reload } = useBorrowView();
  const tick = useTick(5000);
  const canWrite = useCanWrite();
  const [adding, setAdding] = useState<string | null>(null);
  if (hidden || !view) return null;
  const options = view.borrow.projects;
  const deadPeers = view.borrow.dropped.filter((d) => !d.project);
  const addable = addableContacts(view).filter((c) => c !== adding);
  const stamp = { serverNow: view.now, receivedAt, tick };
  return (
    <div className="mt-3 space-y-3">
      <Section title={t("借别人的电脑跑我的活")}>
        <div className="space-y-2">
          <ProjectModes view={view} />
          {sortPeers(view.peers).map((p) => (
            <BorrowPeerCard key={p.peer} peer={p} options={options} limit={view.borrow.maxOpenLimit} canWrite={canWrite} onChanged={reload}
              dropped={view.borrow.dropped.filter((d) => d.peer === p.peer)} {...stamp} />
          ))}
          {deadPeers.map((d) => <DeadEntry key={d.peer} d={d} canWrite={canWrite} onChanged={reload} />)}
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

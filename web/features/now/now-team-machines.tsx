"use client";
/**
 * 「团队与额度」里的机器行（XMACH1）：伙伴机器 n/total 在线、借出在跑 N 单、借入在跑 N 单（停住的写「其中 K 单停住」）。
 * 两行点开就地展开，列原组件 LentOrders / RemoteRows；点一单打开那个 agent / 那个任务。只看、只跳转，收回等操作留在设置 · 伙伴机器。
 * 只在 live（页面版或侧栏条展开）时由 now-team 挂上；页面切到后台整段卸下，useLendState 的轮询随之停。
 * 借入读今天页共用的那份 useSharedBorrowView（「在干活」计数也读它，同一条 15 秒轮询，后台自停）。
 * 纯计算在 now-machines-model.ts。也导出设置页两处原位置的那行链接（RunningElsewhereLink）。
 */
import { useState, useSyncExternalStore, type MouseEvent } from "react";
import { useT } from "@/lib/i18n";
import { usePeerOnline } from "../chat/components/contacts-lines";
import { useChatNav } from "../chat/components/nav-context";
import { Icon } from "../collab/collab-icons";
import { RemoteRows } from "../borrow/borrow-remote";
import { useSharedBorrowView } from "../borrow/use-borrow-view";
import { ServerIcon } from "../borrow/icons";
import { LendIcon } from "../lend/lend-icons";
import { useLendState } from "../lend/lend-state";
import { LentOrders } from "../lend/lent-orders";
import { machinesView, type PeerOnline } from "./now-machines-model";
import { Fold, ROW, ROW_ON, useNowT, useOpeners, type Translate } from "./now-ui";
import { openToday } from "./today-nav";

const subscribeVis = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const visibleNow = () => document.visibilityState !== "hidden";
const visibleSsr = () => true;

export function NowTeamMachines() {
  const tr = useNowT();
  const peers = usePeerOnline();
  const visible = useSyncExternalStore(subscribeVis, visibleNow, visibleSsr);
  if (!peers?.total || !visible) return null;
  return <MachineRows peers={peers} tr={tr} />;
}

/** 一行可展开的：图标 + 「借出在跑 N 单」+ 警示色「其中 K 单停住」+ 箭头；展开的内容走 Fold 的高度动效 */
function FoldLine({ hook, icon, text, stuck, tr, children }: {
  hook: string; icon: React.ReactNode; text: string; stuck: number; tr: Translate; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div {...{ [`data-now-${hook}`]: "" }}>
      <button type="button" className={`${ROW_ON} text-base-content/70`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="flex shrink-0 text-base-content/50">{icon}</span>
        <span className="min-w-0 truncate">{text}</span>
        {stuck > 0 && <span className="shrink-0 text-warning" data-now-machines-stuck>{tr("其中 {n} 单停住", { n: stuck })}</span>}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={13} className="ml-auto shrink-0 text-base-content/40" />
      </button>
      <Fold open={open}>
        <div className="pb-1 pl-2">{children}</div>
      </Fold>
    </div>
  );
}

function MachineRows({ peers, tr }: { peers: PeerOnline; tr: Translate }) {
  const lend = useLendState();
  const borrow = useSharedBorrowView();
  const open = useOpeners();
  const view = machinesView(peers, lend, borrow);
  if (!view) return null;
  const { lent, borrowed } = view;
  return (
    <div className="flex flex-col" data-now-machines>
      <p className={`${ROW} text-base-content/70`} data-now-peers-online>
        <ServerIcon className="size-3.5 shrink-0 text-base-content/50" />
        <span className="tabular-nums">{tr("伙伴机器 {n}/{total} 在线", { n: view.peers.online, total: view.peers.total })}</span>
      </p>
      {lent && (
        <FoldLine hook="lent" icon={<LendIcon name="activity" size={14} />} text={tr("借出在跑 {n} 单", { n: lent.orders.length })} stuck={lent.stuck} tr={tr}>
          <LentOrders orders={lent.orders} stopping={lent.stopping} now={lent.now} onOpen={open.agent} />
        </FoldLine>
      )}
      {borrowed && borrow.view && (
        <FoldLine hook="borrowed" icon={<Icon name="zap" size={14} />} text={tr("借入在跑 {n} 单", { n: borrowed.rows.length })} stuck={borrowed.stuck} tr={tr}>
          <RemoteRows rows={borrowed.rows} serverNow={borrow.view.now} receivedAt={borrow.receivedAt} tick={0} onOpen={(r) => open.task(r.project, r.taskId)} />
        </FoldLine>
      )}
    </div>
  );
}

/**
 * 设置 · 伙伴机器页里，原来「借出中的单」「远端在跑」两处换成的这一行：点了去今天页的团队与额度块，并关掉设置弹窗
 * （弹窗的开关在 Sidebar 里，这里点它的遮罩关，与点弹窗外面同一条路）。
 */
export function RunningElsewhereLink() {
  const t = useT();
  const nav = useChatNav();
  const go = (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.closest<HTMLElement>(".overlay-in")?.click();
    openToday("team", nav);
  };
  return (
    <button type="button" className="link link-hover block px-1 text-left text-[12px] text-base-content/50" data-running-elsewhere onClick={go}>
      {t("在跑的单在『今天 · 团队与额度』")}
    </button>
  );
}

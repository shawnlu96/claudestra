"use client";
/**
 * 项目组里的「协作视图」入口按绑定选源（团队视图 = 同一个 CollabView 换数据源）：
 * 未绑定 / 个人项目 → 原样的本机 CollabEntry；已绑定 → 同一行、同一标签，打开中心 key（与侧栏 N5 列表同字节），不探本机台账；
 * 绑定不可区分 / 还没核对上 / 中心 403 → 一行禁用说明，不回退本机。
 */
import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { machines } from "@/lib/machines";
import { bindingState, lostCenterKey, machineCenterKey, resolveCollabSource, invalidCenterKey, subscribeBindings, type BindingState,
  type BlockedReason } from "@/lib/collab-source-binding";
import { CollabEntry } from "./collab-entry";
import { setLedgerAccess, useLedgerAccess } from "./collab-cache";
import { closeCollab, useCollabNav } from "./collab-nav";
import { useCollabT } from "./collab-i18n";

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

const REASON: Record<BlockedReason, string> = {
  ambiguous: "绑定无法区分（同一中心项目在多个团队），已停用",
  checking: "团队绑定暂时读不到，稍后自动重试",
  revoked: "团队权限已失效",
};

export function useCollabBindings(fp: string): BindingState {
  const sub = useCallback((cb: () => void) => subscribeBindings(fp, cb), [fp]);
  const get = useCallback(() => bindingState(fp), [fp]);
  return useSyncExternalStore(sub, get, get);
}

/**
 * 改绑关旧视图的宿主：入口挂在可折叠的项目组里，全部折叠时没有入口在订阅。
 * 这里单独起一个常驻的小根（不进页面 DOM），只要打开着的是这台机器的中心 key（不论从项目组还是 N5 列表打开），
 * 就持有该机 store 的订阅（15s / focus 刷新不停），每次回包都核对，key 过期（改绑 / 解绑 / 停用）即关掉视图
 */
let guardMounted = false;
function mountOpenViewGuard() {
  if (guardMounted || typeof document === "undefined") return;
  guardMounted = true;
  createRoot(document.createElement("div")).render(<OpenViewGuard />);
}

function OpenViewGuard() {
  const open = useCollabNav().project;
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  return fp && open && machineCenterKey(fp, open) ? <CloseWhenStale key={fp} fp={fp} open={open} /> : null;
}

function CloseWhenStale({ fp, open }: { fp: string; open: string }) {
  const state = useCollabBindings(fp);
  useEffect(() => {
    if (invalidCenterKey(fp, open)) closeCollab();
  }, [fp, open, state]);
  return null;
}

export function UnifiedCollabEntry({ projectId }: { projectId: string }) {
  useEffect(mountOpenViewGuard, []);
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  // 没选机器就没有共享绑定可言（同 N5 侧栏列表不出现）
  return fp ? <MachineEntry key={fp} fp={fp} projectId={projectId} /> : <CollabEntry projectId={projectId} />;
}

function MachineEntry({ fp, projectId }: { fp: string; projectId: string }) {
  const t = useCollabT();
  const { identities, settled } = useCollabBindings(fp);
  const base = resolveCollabSource(identities, projectId, fp);
  const key = base.kind === "center" ? base.key : null;
  // 身份已不在 context 里：看消失前的中心 key 是否已确认 403（撤权 ≠ 解绑）
  const lost = base.kind === "local" ? lostCenterKey(fp, projectId) : null;
  const access = useLedgerAccess(key ?? lost ?? projectId);
  const choice = key || lost ? resolveCollabSource(identities, projectId, fp, (k) => k === (key ?? lost) && access === "no", lost) : base;
  // context 已证明有读凭据：预置可读，CollabEntry 就不会去探 `/ledger/<中心 key>`
  useLayoutEffect(() => {
    if (key && access === "unknown") setLedgerAccess(key, "yes");
  }, [key, access]);
  if (choice.kind === "local") return <CollabEntry projectId={projectId} />;
  if (choice.kind === "blocked") {
    if (!settled) return null;
    return <li><p role="status" data-collab-blocked={choice.reason} className="px-2 text-xs opacity-60">
      {t("协作视图")} · {REASON[choice.reason]}</p></li>;
  }
  return access === "yes" ? <CollabEntry projectId={choice.key} /> : null;
}

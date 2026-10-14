"use client";
/**
 * 项目组里的「协作视图」入口按绑定选源（团队视图 = 同一个 CollabView 换数据源）：
 * 未绑定 / 个人项目 → 原样的本机 CollabEntry；已绑定 → 同一行、同一标签，打开中心 key（与侧栏 N5 列表同字节），不探本机台账；
 * 绑定不可区分 / 还没核对上 / 中心 403 → 一行禁用说明，不回退本机。
 */
import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ambiguous } from "@/lib/shared-projects-bindings";
import { sharedProjectsTr } from "@/lib/i18n-dict-shared-projects";
import { useLang } from "@/lib/i18n";
import { machines } from "@/lib/machines";
import { bindingState, lostCenterKey, machineCenterKey, resolveCollabSource, invalidCenterKey, subscribeBindings, type BindingState,
  type BlockedReason, type CollabSourceChoice } from "@/lib/collab-source-binding";
import { CollabEntry } from "./collab-entry";
import { setLedgerAccess, useLedgerAccess, type Access } from "./collab-cache";
import { closeCollab, useCollabNav } from "./collab-nav";
import { useCollabT } from "./collab-i18n";

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

export const BLOCKED_REASON: Record<BlockedReason, string> = {
  ambiguous: ambiguous,
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
let guardRoot: Root | null = null;
function mountOpenViewGuard() {
  if (guardRoot || typeof document === "undefined") return;
  guardRoot = createRoot(document.createElement("div"));
  guardRoot.render(<OpenViewGuard />);
}

/** 测试用：卸掉常驻小根（挂 happy-dom 的测试注销前调，别让它订着 machines 留给同进程后面的测试文件）；下一次入口挂载再起 */
export function unmountOpenViewGuardForTest(): void {
  guardRoot?.unmount();
  guardRoot = null;
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

/**
 * 一个本机项目的协作视图选源，带撤权判断（项目组入口、「现在」各项目、侧栏团队区的保留行都用这一个，开出来的键才字节相等）。
 * key = 可区分的中心键（没有 = 本机 / 停用）；access = 该键（或本机项目）台账读不读得了。
 */
export function useCollabChoice(fp: string, projectId: string): { choice: CollabSourceChoice; key: string | null; access: Access; settled: boolean } {
  const { identities, settled } = useCollabBindings(fp);
  const base = resolveCollabSource(identities, projectId, fp);
  const key = base.kind === "center" ? base.key : null;
  // 身份已不在 context 里：看消失前的中心 key 是否已确认 403（撤权 ≠ 解绑）
  const lost = base.kind === "local" ? lostCenterKey(fp, projectId) : null;
  const access = useLedgerAccess(key ?? lost ?? projectId);
  const choice = key || lost ? resolveCollabSource(identities, projectId, fp, (k) => k === (key ?? lost) && access === "no", lost) : base;
  return { choice, key, access, settled };
}

function MachineEntry({ fp, projectId }: { fp: string; projectId: string }) {
  const t = useCollabT(), projectTr = sharedProjectsTr(useLang());
  const { choice, key, access, settled } = useCollabChoice(fp, projectId);
  // context 已证明有读凭据：预置可读，CollabEntry 就不会去探 `/ledger/<中心 key>`
  useLayoutEffect(() => {
    if (key && access === "unknown") setLedgerAccess(key, "yes");
  }, [key, access]);
  if (choice.kind === "local") return <CollabEntry projectId={projectId} />;
  if (choice.kind === "blocked") {
    if (!settled) return null;
    return <li><p role="status" data-collab-blocked={choice.reason} className="px-2 text-xs opacity-60">
      {t("协作视图")} · {choice.reason === "ambiguous" ? projectTr(BLOCKED_REASON[choice.reason]) : t(BLOCKED_REASON[choice.reason])}</p></li>;
  }
  return access === "yes" ? <CollabEntry projectId={choice.key} team /> : null;
}

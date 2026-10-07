"use client";
/**
 * 项目组里的「协作视图」入口按绑定选源（团队视图 = 同一个 CollabView 换数据源）：
 * 未绑定 / 个人项目 → 原样的本机 CollabEntry；已绑定 → 同一行、同一标签，打开中心 key（与侧栏 N5 列表同字节），不探本机台账；
 * 绑定不可区分 / 还没核对上 / 中心 403 → 一行禁用说明，不回退本机。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { bindingState, resolveCollabSource, subscribeBindings, type BindingState, type BlockedReason } from "@/lib/collab-source-binding";
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

export function UnifiedCollabEntry({ projectId }: { projectId: string }) {
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  // 没选机器就没有共享绑定可言（同 N5 侧栏列表不出现）
  return fp ? <MachineEntry key={fp} fp={fp} projectId={projectId} /> : <CollabEntry projectId={projectId} />;
}

function MachineEntry({ fp, projectId }: { fp: string; projectId: string }) {
  const t = useCollabT();
  const { identities, settled } = useCollabBindings(fp);
  const base = resolveCollabSource(identities, projectId, fp);
  const key = base.kind === "center" ? base.key : null;
  const access = useLedgerAccess(key ?? projectId);
  const choice = key ? resolveCollabSource(identities, projectId, fp, (k) => k === key && access === "no") : base;
  const open = useCollabNav().project;
  // context 已证明有读凭据：预置可读，CollabEntry 就不会去探 `/ledger/<中心 key>`
  useLayoutEffect(() => {
    if (key && access === "unknown") setLedgerAccess(key, "yes");
  }, [key, access]);
  // 绑定变了（A→B / 解绑 / 停用）而打开着的还是旧 key：关掉，旧视图的迟到回包随组件卸载作废
  const prev = useRef(key);
  useEffect(() => {
    const old = prev.current;
    if (old === key) return;
    prev.current = key;
    if (old && open === old) closeCollab();
  }, [key, open]);
  if (choice.kind === "local") return <CollabEntry projectId={projectId} />;
  if (choice.kind === "blocked") {
    if (!settled) return null;
    return <li><p role="status" data-collab-blocked={choice.reason} className="px-2 text-xs opacity-60">
      {t("协作视图")} · {REASON[choice.reason]}</p></li>;
  }
  return access === "yes" ? <CollabEntry projectId={choice.key} /> : null;
}

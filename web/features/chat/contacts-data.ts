/**
 * 联系人数据（侧栏「联系人」分组与输入框 @ 候选共用一份）：GET /api/v1/peers/contacts，每分钟一次。
 * 这个接口只读 bridge 内存里的 peer presence（bridge 每分钟探测一次），拉得再勤也不会更新，所以跟着 60s 走。
 * 非全权设备拿到 403 → allowed=false，侧栏整组不出、@ 只剩本机 agent，换机器前不再问；老 bridge 没这个接口（404）也不出，但照常轮询：升级后就能判准。
 * 这个接口的门是 isFullScope（= canManage），与建 agent、会话清单、归档同一道，所以顺带当「这台设备是不是全权」用（useFullScope）。
 * 切机器时清空重拉，旧机器迟到的响应丢掉——否则会把 A 机器的联系人显示在 B 机器下。
 */
import { useSyncExternalStore } from "react";
import { peerContacts } from "@/lib/api/system";
import { ApiError } from "@/lib/api/client";
import { machines } from "@/lib/machines";
import type { PeerContact } from "./contact-types";

export interface ContactsSnap {
  fp: string | null;
  /** null 还没拉到 / false 这台设备看不了联系人 / true 可以 */
  allowed: boolean | null;
  /** 全权凭据：200 true、403 false；404（v2.32 前的 bridge 没这个接口）按 true——那时候的入口本来就不藏，门由服务端守 */
  fullScope: boolean | null;
  contacts: PeerContact[];
}

const POLL_MS = 60_000;
/** 这台机器还一次都没判定过（首拉碰上 bridge 重启 / 超时）时的重试间隔：不然全权入口要藏满一轮 60s */
const RETRY_MS = 5_000;
const EMPTY: ContactsSnap = { fp: null, allowed: null, fullScope: null, contacts: [] };
let snap: ContactsSnap = EMPTY;
const subs = new Set<() => void>();
/** 正在拉哪台机器（undefined = 没有在途请求）：切机器后旧请求还挂着也要立刻拉新机器的 */
let inflightFp: string | null | undefined;
let stop: (() => void) | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;

function emit(next: ContactsSnap): void {
  snap = next;
  subs.forEach((f) => f());
}

async function load(): Promise<void> {
  const fp = machines.currentFp();
  if (inflightFp === fp || document.visibilityState === "hidden") return;
  if (snap.fp === fp && snap.fullScope === false) return; // 这台机器答过 403：换机器前不再问（权限不会自己变）
  inflightFp = fp;
  try {
    const j = await peerContacts<{ contacts?: PeerContact[] }>();
    if (machines.currentFp() !== fp) return;
    emit({ fp, allowed: true, fullScope: true, contacts: Array.isArray(j.contacts) ? j.contacts : [] });
  } catch (e) {
    if (machines.currentFp() !== fp) return;
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) emit({ fp, allowed: false, fullScope: e.status === 404, contacts: [] });
    // 其它失败（网络抖动 / 503 / 凭据失效由 api 客户端统一处理）保留上一份判定；从没判定过才按未知（入口先藏）并尽快重试
    else if (snap.fullScope === null) {
      clearTimeout(retry);
      retry = setTimeout(() => void load(), RETRY_MS);
    }
  } finally {
    if (inflightFp === fp) inflightFp = undefined;
  }
}

function start(): () => void {
  void load();
  const timer = setInterval(() => void load(), POLL_MS);
  const onVisible = () => void (document.visibilityState === "visible" && load());
  document.addEventListener("visibilitychange", onVisible);
  const unMachines = machines.subscribe(() => {
    if (machines.currentFp() === snap.fp) return;
    emit({ ...EMPTY, fp: machines.currentFp() });
    void load();
  });
  return () => {
    clearInterval(timer);
    clearTimeout(retry);
    document.removeEventListener("visibilitychange", onVisible);
    unMachines();
  };
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  stop ??= start();
  return () => {
    subs.delete(cb);
    if (!subs.size && stop) {
      stop();
      stop = null;
    }
  };
}

export function useContacts(): ContactsSnap {
  return useSyncExternalStore(subscribe, () => snap, () => EMPTY);
}

/**
 * 这台设备是不是全权凭据（null = 还没问到）。宿主级入口（未纳管会话、归档、Agent 管理 / 新建）只在 true 时出现：
 * guest、部分 scope、manage 关掉的设备点进去只会 403，不如不给入口。不另起探测，与联系人共用一次请求。
 */
export function useFullScope(): boolean | null {
  return useSyncExternalStore(subscribe, () => snap.fullScope, () => null);
}

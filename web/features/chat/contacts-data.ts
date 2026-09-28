/**
 * 联系人数据（侧栏「联系人」分组与输入框 @ 候选共用一份）：GET /api/v1/peers/contacts，每分钟一次。
 * 这个接口只读 bridge 内存里的 peer presence（bridge 每分钟探测一次），拉得再勤也不会更新，所以跟着 60s 走。
 * 非全权设备拿到 403 → allowed=false，侧栏整组不出、@ 只剩本机 agent；老版本 bridge 没这个接口（404）同样处理。
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
  contacts: PeerContact[];
}

const POLL_MS = 60_000;
const EMPTY: ContactsSnap = { fp: null, allowed: null, contacts: [] };
let snap: ContactsSnap = EMPTY;
const subs = new Set<() => void>();
/** 正在拉哪台机器（undefined = 没有在途请求）：切机器后旧请求还挂着也要立刻拉新机器的 */
let inflightFp: string | null | undefined;
let stop: (() => void) | null = null;

function emit(next: ContactsSnap): void {
  snap = next;
  subs.forEach((f) => f());
}

async function load(): Promise<void> {
  const fp = machines.currentFp();
  if (inflightFp === fp || document.visibilityState === "hidden") return;
  inflightFp = fp;
  try {
    const j = await peerContacts<{ contacts?: PeerContact[] }>();
    if (machines.currentFp() !== fp) return;
    emit({ fp, allowed: true, contacts: Array.isArray(j.contacts) ? j.contacts : [] });
  } catch (e) {
    if (machines.currentFp() !== fp) return;
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) emit({ fp, allowed: false, contacts: [] });
    // 其它失败（网络抖动 / 503 / 凭据失效由 api 客户端统一处理）保留上一份，下一轮再拉：联系人只是参考信息
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

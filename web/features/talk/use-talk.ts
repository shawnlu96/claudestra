"use client";
/**
 * Chat 页的数据：我是谁、房间列表、目录、当前房间的消息。刷新时机：挂载、SSE talk 事件（只推给房间成员）、回到前台、切机器。
 * SSE 断了按 1s → 30s 退避重连，重连成功先全量重拉一次（事件不补发）。当前房间记在 URL ?room=，推送点进来直达。
 * 切机器时整个页面按 fp 重挂（talk-app.tsx 的 key），这里不用手动清状态。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { followTalkEvents, roomMessages, talkMe, talkPeople, talkRooms, type TalkMessage, type TalkPerson, type TalkRoom } from "@/lib/api/talk";

export interface TalkMe {
  id: string;
  isOwner: boolean;
}

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

function roomFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("room");
}
function writeRoomToUrl(key: string | null): void {
  const url = new URL(window.location.href);
  if (key) url.searchParams.set("room", key);
  else url.searchParams.delete("room");
  window.history.replaceState(window.history.state, "", url.toString());
}

/** 当前机器指纹：talk-app 按它重挂整个页面 */
export function useMachineFp(): string | null {
  return useSyncExternalStore(subscribeMachines, currentFp, noFp);
}

export function useTalk() {
  const [me, setMe] = useState<TalkMe | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [rooms, setRooms] = useState<TalkRoom[]>([]);
  const [people, setPeople] = useState<TalkPerson[]>([]);
  const [active, setActiveState] = useState<string | null>(roomFromUrl);
  const [messages, setMessages] = useState<TalkMessage[]>([]);
  const [loadingRoom, setLoadingRoom] = useState(false);
  const activeRef = useRef(active);

  const reloadList = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([talkRooms(), talkPeople()]);
      setRooms(r.rooms);
      setPeople(p.people);
    } catch (e) {
      console.warn(`[talk] 列表没拉到: ${(e as Error).message}`);
    }
  }, []);

  const reloadRoom = useCallback(async (key: string | null) => {
    if (!key) return setMessages([]);
    try {
      const r = await roomMessages(key);
      if (activeRef.current === key) setMessages(r.messages);
    } catch (e) {
      // 404 = 不是成员或房间没了：退回列表，别停在一个读不到的房间上
      if ((e as { status?: number }).status === 404 && activeRef.current === key) {
        activeRef.current = null;
        setActiveState(null);
        writeRoomToUrl(null);
      } else console.warn(`[talk] 消息没拉到: ${(e as Error).message}`);
    }
  }, []);

  const setActive = useCallback((key: string | null) => {
    setActiveState(key);
    activeRef.current = key;
    writeRoomToUrl(key);
    setMessages([]);
    if (key) {
      setLoadingRoom(true);
      void reloadRoom(key).finally(() => setLoadingRoom(false));
    }
  }, [reloadRoom]);

  useEffect(() => {
    let dead = false;
    talkMe()
      .then((r) => {
        if (dead) return;
        setMe({ id: r.me.id, isOwner: r.me.isOwner });
        void reloadList();
        if (activeRef.current) void reloadRoom(activeRef.current);
      })
      .catch((e) => !dead && setDenied((e as Error).message || "forbidden"));
    return () => {
      dead = true;
    };
  }, [reloadList, reloadRoom]);

  useTalkRefresh(!!me, reloadList, reloadRoom, activeRef);

  const room = rooms.find((r) => r.key === active) ?? null;
  return { me, denied, rooms, people, active, room, messages, loadingRoom, setActive, reloadList, reloadRoom };
}

/** SSE：收到 talk 事件重拉列表，是当前房间就重拉消息；断了退避重连，连上先全量补拉；回到前台也补拉（后台时流可能早断了） */
function useTalkRefresh(on: boolean, reloadList: () => Promise<void>, reloadRoom: (key: string | null) => Promise<void>, activeRef: { current: string | null }) {
  // SSE：收到 talk 事件重拉列表；是当前房间就重拉消息
  useEffect(() => {
    if (!on) return;
    const ctrl = new AbortController();
    let delay = 1000;
    void (async () => {
      while (!ctrl.signal.aborted) {
        try {
          await followTalkEvents({
            signal: ctrl.signal,
            onOpen: () => {
              delay = 1000;
              void reloadList();
              if (activeRef.current) void reloadRoom(activeRef.current);
            },
            onTalk: (room) => {
              void reloadList();
              if (room && room === activeRef.current) void reloadRoom(room);
            },
          });
        } catch (e) {
          if (ctrl.signal.aborted) return;
          console.warn(`[talk] 事件流断了，${delay / 1000}s 后重连: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    })();
    return () => ctrl.abort();
  }, [on, reloadList, reloadRoom, activeRef]);

  // 回到前台：补拉（后台时 SSE 可能早断了）
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void reloadList();
      if (activeRef.current) void reloadRoom(activeRef.current);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reloadList, reloadRoom, activeRef]);
}

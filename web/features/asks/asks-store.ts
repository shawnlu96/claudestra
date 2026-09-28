/**
 * 「待你处理」的网页状态（docs 13 §4.4）：侧栏入口、抽屉、聊天气泡上的状态都读这一份。
 * 刷新时机：挂载、自己那条只收 ask 的 SSE（/events?types=ask，没开会话时也实时）、回到前台、可见时每 30 秒兜底。
 * 顺带报网页可见性（POST /presence，推送规则据此判 owner 在不在）：切前台 / 后台各一次，可见时每分钟一次。
 * 凭据读不了台账（403）就当没有待办，也不再轮询。切机器由调用方换 key 重挂（start 见到新 key 先清空）。
 * 作答是乐观的（T11b 第 8 条）：answer() 提交前就把卡标成已答（移出「等你处理」、计数减 1），服务端确认 / SSE 回来再校正，失败回滚并在卡上留原因。
 * 线上 owner 反映答完卡片迟迟不走：作答接口要等投递给 agent（抓屏判忙、读 registry）才回 202，机器一忙就拖好几秒。
 */
import { useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchAsks, followAskEvents, postPresence } from "@/lib/api/asks";
import { askFromLink, hashBase, leavePlan, shouldPush } from "@/lib/hash-nav";
import { backGuard, isNarrow, stripHash } from "@/lib/hash-nav-browser";
import { applyPending, ASK_EVENT_REFRESH_MS, PENDING_MAX_MS, type PendingAnswer, type WebAsk } from "./asks-model";

export interface AsksSnap {
  asks: WebAsk[];
  loaded: boolean;
  /** 抽屉开着吗；focus = 要滚到的那张卡 */
  open: boolean;
  focus: string | null;
  /** owner 正在用时新来的卡活 ask：顶部横幅（不推送） */
  banner: WebAsk | null;
  /** 作答后卡片上那一句（按 askId）：成功「已发给 X」/ 失败的原因。卡片换了分组会重挂、组件里的 state 会丢，所以记在这里 */
  notes: Record<string, AskNote>;
}

export interface AskNote {
  ok: boolean;
  text: string;
}

const EMPTY: AsksSnap = { asks: [], loaded: false, open: false, focus: null, banner: null, notes: {} };
let snap: AsksSnap = EMPTY;
/** 服务端最近一次给的列表；显示的是它盖上待确认的作答（applyPending） */
let server: WebAsk[] = [];
const pending = new Map<string, PendingAnswer>();
let machineKey: string | null = null;
let denied = false;
const seen = new Set<string>();
const subs = new Set<() => void>();

function set(p: Partial<AsksSnap>): void {
  snap = { ...snap, ...p };
  for (const f of subs) f();
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * 服务端列表 + 待确认的作答 → 显示用的列表；已确认 / 盖太久的从待确认表里删掉。
 * 失败的那句（断网没发出去）在服务端结案后清掉：这件在别处答了，红字再挂着就是误导
 */
function show(extra: Partial<AsksSnap> = {}): void {
  const v = applyPending(server, pending, Date.now());
  for (const id of v.settled) pending.delete(id);
  const notes = extra.notes ?? snap.notes;
  const stale = Object.keys(notes).filter((id) => !notes[id].ok && server.some((a) => a.id === id && a.state !== "open"));
  const kept = stale.length ? Object.fromEntries(Object.entries(notes).filter(([id]) => !stale.includes(id))) : notes;
  set({ asks: v.asks, ...extra, notes: kept });
}

const note = (id: string, n: AskNote | null) => {
  const notes = { ...snap.notes };
  if (n) notes[id] = n;
  else delete notes[id];
  return notes;
};

/**
 * 乐观作答：先盖上「已答」再提交；成功等服务端确认（SSE / 下一次拉取），失败撤掉那一笔、留下原因，再重拉一次以服务端为准。
 * 出错不再往外抛：原因记在 notes 里由卡片显示；返回成没成
 */
async function answer(id: string, shown: PendingAnswer["answer"], submit: () => Promise<unknown>, words: { ok: string; fail: (e: unknown) => string }): Promise<boolean> {
  const mine: PendingAnswer = { at: Date.now(), answer: shown, inFlight: true };
  pending.set(id, mine);
  show({ notes: note(id, null) });
  try {
    await submit();
    // 盖多久从请求回来算；到点自己撤（不等下一次拉取），服务端还说开着就回到「等你处理」
    if (pending.get(id) === mine) pending.set(id, { at: Date.now(), answer: shown });
    setTimeout(() => show(), PENDING_MAX_MS + 1);
    set({ notes: note(id, { ok: true, text: words.ok }) });
    return true;
  } catch (e) {
    // 只撤自己这一笔：请求在飞时又点了一次，那一笔的覆盖不能被这次的失败带走
    if (pending.get(id) === mine) pending.delete(id);
    show({ notes: note(id, { ok: false, text: words.fail(e) }) });
    return false;
  } finally {
    void refresh();
  }
}

/** 拉取序号：先发后到的旧结果（例如写库前发出的 30 秒轮询）不能盖掉后发先到的新结果 */
let fetchSeq = 0;
let appliedSeq = 0;

async function refresh(): Promise<void> {
  if (denied) return;
  const my = ++fetchSeq;
  try {
    const r = await fetchAsks();
    if (my < appliedSeq) return;
    appliedSeq = my;
    const fresh = r.asks.filter((a) => a.state === "open" && !seen.has(a.id));
    // 第一次拉到的不算「新来的」；之后新来的卡活 ask 在前台就弹横幅
    const bannerAsk = snap.loaded && visible() ? fresh.find((a) => a.blocking === true && a.kind !== "accept") : undefined;
    for (const a of r.asks) seen.add(a.id);
    server = r.asks;
    show({ loaded: true, ...(bannerAsk ? { banner: bannerAsk } : {}) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      denied = true;
      server = [];
      show({ loaded: true });
    }
    // 其余（断网、切机器中止）：保留上一份，下次刷新再来
  }
}

/**
 * 手机上抽屉是一页 #asks（lib/hash-nav.ts，与会话页 #chat 同一套）：打开压一条打过标的历史项，左滑 / 返回键 /
 * 左上角返回都是出栈，popstate 按 hash 开关。桌面是侧边抽屉，不压栈。
 */
const ASKS_HASH = "#asks";
const onAsksPage = () => hashBase(window.location.hash) === ASKS_HASH;

function enter(focus: string | null): void {
  if (shouldPush(window.location.hash, ASKS_HASH, isNarrow())) window.history.pushState({ cstra: "asks" }, "", ASKS_HASH);
  set({ open: true, focus, banner: null });
}

function leave(): void {
  const plan = leavePlan(window.location.hash, ASKS_HASH, window.history.state, "asks", backGuard.busy());
  if (plan === "wait") return;
  if (plan === "back") return backGuard.back(); // popstate 收起
  if (plan === "strip") stripHash();
  set({ open: false, focus: null });
}

function presence(v: boolean): void {
  if (!denied) void postPresence(v).catch(() => undefined); // 心跳丢一次无妨，一分钟后还有下一次
}

export const asksStore = {
  get: (): AsksSnap => snap,
  subscribe(f: () => void): () => void {
    subs.add(f);
    return () => void subs.delete(f);
  },
  refresh,
  answer,
  openDrawer: (focus: string | null = null) => enter(focus),
  closeDrawer: leave,
  /** 「回到对话」：只收起、不出栈——会话页的 #chat 压在 #asks 上面，从会话左滑回来抽屉重新打开 */
  leaveForChat: () => set({ open: false, focus: null }),
  dismissBanner: () => set({ banner: null }),
  /** 侧栏入口挂载时调；返回卸载。key = 当前机器 */
  start(key: string): () => void {
    if (key !== machineKey) {
      machineKey = key;
      appliedSeq = fetchSeq; // 上一台机器还在飞的拉取回来也不认
      denied = false;
      seen.clear();
      pending.clear();
      server = [];
      snap = EMPTY;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), ASK_EVENT_REFRESH_MS);
    };
    const onVis = () => {
      presence(visible());
      if (visible()) void refresh();
    };
    const poll = setInterval(() => visible() && void refresh(), 30_000);
    const beat = setInterval(() => visible() && presence(true), 60_000);
    const ctrl = new AbortController();
    void (async () => {
      // 断了就退避重连（5s → 60s）；连上先重拉一次，断线期间的变化不会丢
      for (let wait = 5_000; !ctrl.signal.aborted; wait = Math.min(wait * 2, 60_000)) {
        await followAskEvents({ signal: ctrl.signal, onOpen: () => ((wait = 2_500), void refresh()), onAsk: soon }).catch(() => undefined); // 断线 / 403：等一会儿再连
        if (denied) return;
        await new Promise((r) => setTimeout(r, wait));
      }
    })();
    // 已有窗口时点「待你处理」推送：SW 发 cstra-open-ask（web/public/sw.js），直接打开抽屉定位；别的机器发的先不管（按当前机器显示）
    const onSw = (e: MessageEvent) => {
      const d = e.data as { type?: string; ask?: string };
      if (d?.type === "cstra-open-ask" && d.ask) enter(d.ask);
    };
    // 左滑 / 返回键落到 #asks 就开（含从「回到对话」的会话页退回来），离开就关
    const onPop = () => {
      const on = onAsksPage();
      if (on !== snap.open) set({ open: on, focus: null });
    };
    navigator.serviceWorker?.addEventListener("message", onSw);
    window.addEventListener("popstate", onPop);
    document.addEventListener("visibilitychange", onVis);
    void refresh();
    presence(visible());
    // 推送深链 /chat?ask=<id>：摘掉参数再压 #asks，返回落在会话列表而不是退出应用；带 #asks 刷新（iOS 冷恢复）= 原样重开
    const deep = askFromLink(window.location.href);
    if (deep) {
      const qs = new URLSearchParams(window.location.search);
      qs.delete("ask");
      window.history.replaceState(null, "", `${window.location.pathname}${qs.size ? `?${qs}` : ""}${window.location.hash}`);
      enter(deep);
    } else if (onAsksPage()) set({ open: true });
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      clearInterval(beat);
      ctrl.abort();
      navigator.serviceWorker?.removeEventListener("message", onSw);
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("visibilitychange", onVis);
    };
  },
};

const none = (): AsksSnap => EMPTY;
export function useAsks(): AsksSnap {
  return useSyncExternalStore(asksStore.subscribe, asksStore.get, none);
}

const noSubscribe = () => () => undefined;
/** 只在 on 时订阅：每条助手消息都挂着 useReplyAsk，没有按钮的气泡不订阅、快照恒为 EMPTY，ask 事件来了也不重算不重渲染 */
export function useAsksIf(on: boolean): AsksSnap {
  return useSyncExternalStore(on ? asksStore.subscribe : noSubscribe, on ? asksStore.get : none, none);
}

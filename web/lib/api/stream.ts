/**
 * 某 agent 的持久输出流（此前 BFF app/api/chat/stream 的编排：订阅 bridge /api/v1/events、按 agent 过滤、翻译成协议 v1、
 * 连流先补拉 /pending 与 /bg-tasks）。现在浏览器直接订阅 bridge，翻译在本地（lib/chat/stream-shape.ts）。
 * 返回一条重新编码的 SSE 字节流：`data: <WebStreamEvent+eid>\n\n`；上游的心跳 / 注释帧转成 `data: [DONE]`——
 * chat-store 的 consumeSSEStream 与「25s 无字节判死」看门狗零改动。
 */
import { apiAgentName } from "@/lib/chat/agents";
import { SSE_DONE, type AnchoredStreamEvent, type WebStreamEvent } from "@/lib/chat/events";
import { agentNameVariants, bgReplayEvents, drainFrames, pendingEvents, translate, type Lang } from "@/lib/chat/stream-shape";
import { api, apiStream } from "./client";
import { selfIds } from "./history";

interface Pending {
  question: { questions: unknown; ts: number } | null;
  thinking?: boolean;
  compacting?: boolean;
}
interface BgTasks {
  tasks: ({ id: string; kind: "subagent" | "shell"; title: string; lines: string[] } & Record<string, unknown>)[];
  seq?: number; // 取快照那一刻总线最后一条事件的 seq；老 bridge 不带
}

const enc = new TextEncoder();
/**
 * 连流补拉的快照（/pending、/bg-tasks）晚于实时事件到达时的合流。挂起态（status / ask）是覆盖语义：实时已说过就以实时为准，
 * 快照不往回拨（已结束的回合重新「思考中」、已答的问题再弹）。后台任务是「快照 + 增量」：store 的 bg-update 追加行、
 * bg-start 不改已有卡的类型，所以实时 bg 事件得排在快照后面放（isBgEvent，由 openAgentEventStream 排队），这里不动它们。
 */
export class ReplayMerge {
  private status = false;
  private ask = false;
  see(e: WebStreamEvent): void {
    if (e.t === "status" || e.t === "done") this.status = true;
    else if (e.t === "ask" || e.t === "ask-cleared") this.ask = true;
  }
  merge(snapshot: WebStreamEvent[]): WebStreamEvent[] {
    return snapshot.filter((e) => !(e.t === "status" && this.status) && !(e.t === "ask" && this.ask));
  }
}

/** 后台任务事件是快照之上的增量：快照到达前先排队（快照请求 5s 超时，最多压这么久），聊天类事件不等 */
export const isBgEvent = (e: WebStreamEvent): boolean => e.t.startsWith("bg-");

/**
 * 快照覆盖到总线哪条：bridge 写 recent 与发 bg 增量在同一同步段，seq ≤ 快照 seq 且任务在快照里的 bg 事件已含在快照的
 * lines / 进度里，再放就重复（不论它比快照早到还是晚到）。不在快照里的任务（快照前已收尾的 subagent）照放。
 * 老 bridge 不带 seq / 快照失败 → null，不判（保持只排序不去重）。
 */
type BgCover = { seq: number; ids: Set<string> } | null;
const bgCoverOf = (bg: BgTasks): BgCover => (typeof bg.seq === "number" ? { seq: bg.seq, ids: new Set((bg.tasks || []).map((t) => t.id)) } : null);
const bgCovered = (c: BgCover, e: WebStreamEvent, seq: number): boolean => !!c && seq <= c.seq && "id" in e && typeof e.id === "string" && c.ids.has(e.id);

const frame = (evt: AnchoredStreamEvent | typeof SSE_DONE) => enc.encode(`data: ${evt === SSE_DONE ? SSE_DONE : JSON.stringify(evt)}\n\n`);

/**
 * since：断点续传锚——bridge 重放 seq>since 的缓冲事件。signal：调用方的中止句柄（切会话 / 看门狗 / 切机器）。
 * 连接失败 / 非 2xx 抛 ApiError（401 → DeviceInvalidError）。
 */
export async function openAgentEventStream(agent: string, opts: { since?: number; signal?: AbortSignal; lang: Lang }): Promise<ReadableStream<Uint8Array>> {
  const apiName = apiAgentName(agent);
  const name = encodeURIComponent(apiName);
  const variants = agentNameVariants(apiName);
  // agents=：只要这个 agent 的事件与补发（下面照旧按名字再筛一道——老 bridge 不认这个参数，照发全部）
  const q = new URLSearchParams({ agents: [...variants].join(",") });
  if (opts.since) q.set("since", String(opts.since));
  const [res, ids] = await Promise.all([apiStream(`/events?${q}`, { signal: opts.signal }), selfIds()]);
  const upstream = res.body!.getReader();
  const dec = new TextDecoder();
  // 连流即补拉挂起态（thinking → composer 立刻进「停止」态；未答的 AUQ）与 bg 任务快照；失败、慢都不挡实时事件，到了再按 ReplayMerge 合入
  const replay = Promise.all([
    api<Pending>(`/agents/${name}/pending`, { timeoutMs: 5000, signal: opts.signal }).then(pendingEvents, () => []),
    api<BgTasks>(`/agents/${name}/bg-tasks`, { timeoutMs: 5000, signal: opts.signal }).then(
      (bg) => ({ events: bgReplayEvents(bg.tasks || []), cover: bgCoverOf(bg) }),
      () => ({ events: [], cover: null as BgCover }),
    ),
  ]);
  let buffer = "";
  let closed = false;
  const seen = new ReplayMerge();
  let heldBg: { e: WebStreamEvent; seq: number }[] | null = []; // 快照到达前的实时 bg 事件；null = 快照已放完，直接放
  let cover: BgCover = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame(SSE_DONE)); // 连上先给一个字节：看门狗与「stream connected」计时从现在起
      void replay.then(([pending, bg]) => {
        const held = heldBg ?? [];
        heldBg = null;
        cover = bg.cover;
        if (closed) return;
        for (const e of seen.merge([...pending, ...bg.events])) controller.enqueue(frame(e));
        for (const h of held) if (!bgCovered(cover, h.e, h.seq)) controller.enqueue(frame(h.e));
      }).catch(() => undefined); // 上游读错时流已 errored、enqueue 会抛：读端那边已按断流重连，快照不要了
    },
    async pull(controller) {
      const { done, value } = await upstream.read();
      if (done) {
        closed = true;
        return controller.close();
      }
      const { events, rest } = drainFrames(buffer + dec.decode(value, { stream: true }));
      buffer = rest;
      let emitted = 0;
      for (const evt of events) {
        if (!variants.has(evt.agent)) continue;
        const mapped = translate(evt, opts.lang, ids);
        if (!mapped) continue;
        seen.see(mapped);
        // 扣下延后补发的 bg 帧不带 eid：eid 是按序的断点锚，倒着补会被读端当成 bridge 重启去整页重拉；
        // 断流时还没补出去的 bg 增量也不靠 since 重放——重连会重新拉 /bg-tasks 快照
        if (isBgEvent(mapped) && heldBg) heldBg.push({ e: mapped, seq: evt.seq });
        else if (isBgEvent(mapped) && bgCovered(cover, mapped, evt.seq)) continue;
        else {
          controller.enqueue(frame({ ...mapped, eid: evt.seq })); // eid = bridge seq：下次重连 ?since=<eid>
          emitted++;
        }
      }
      // 这一块全是心跳 / 注释 / 别的 agent 的帧：补一个 [DONE] 让读端知道流活着
      if (!emitted) controller.enqueue(frame(SSE_DONE));
    },
    cancel(reason) {
      closed = true;
      upstream.cancel(reason).catch(() => undefined); // 上游已经断了再 cancel 会抛，这里只是善后
    },
  });
}

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
}

const enc = new TextEncoder();
/**
 * 连流补拉的快照（/pending、/bg-tasks）晚于实时事件到达时的合流：实时事件说过的就以它为准，快照只补没说过的。
 * 否则慢链路上快照后到会把状态往回拨——已结束的回合重新「思考中」、已收尾的后台任务复活、已答的问题再弹。
 */
export class ReplayMerge {
  private status = false;
  private ask = false;
  private bgSync = false;
  private readonly bgSeen = new Set<string>();
  private readonly bgLive = new Set<string>();
  see(e: WebStreamEvent): void {
    if (e.t === "status" || e.t === "done") this.status = true;
    else if (e.t === "ask" || e.t === "ask-cleared") this.ask = true;
    else if (e.t === "bg-sync") this.bgSync = true;
    else if (e.t === "bg-start" || e.t === "bg-update" || e.t === "bg-done") {
      this.bgSeen.add(e.id);
      if (e.t === "bg-done") this.bgLive.delete(e.id);
      else if (e.t === "bg-start") this.bgLive.add(e.id);
    }
  }
  merge(snapshot: WebStreamEvent[]): WebStreamEvent[] {
    return snapshot.flatMap((e): WebStreamEvent[] => {
      if (e.t === "status") return this.status ? [] : [e];
      if (e.t === "ask") return this.ask ? [] : [e];
      if (e.t === "bg-start" || e.t === "bg-update" || e.t === "bg-done") return this.bgSeen.has(e.id) ? [] : [e];
      // 全集快照之后才起的任务也在跑：并进去，否则 bg-sync 会把它标成已完成
      if (e.t === "bg-sync") return this.bgSync ? [] : [{ ...e, ids: [...new Set([...e.ids, ...this.bgLive])] }];
      return [e];
    });
  }
}

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
    api<BgTasks>(`/agents/${name}/bg-tasks`, { timeoutMs: 5000, signal: opts.signal }).then((bg) => bgReplayEvents(bg.tasks || []), () => []),
  ]);
  let buffer = "";
  let closed = false;
  const seen = new ReplayMerge();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame(SSE_DONE)); // 连上先给一个字节：看门狗与「stream connected」计时从现在起
      void replay.then((lists) => {
        if (!closed) for (const e of seen.merge(lists.flat())) controller.enqueue(frame(e));
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
        controller.enqueue(frame({ ...mapped, eid: evt.seq })); // eid = bridge seq：下次重连 ?since=<eid>
        emitted++;
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

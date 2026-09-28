/**
 * 订阅 bridge /events，只把 types 里的事件逐条回调出去；onOpen 在连上时调一次（调用方据此全量重拉，T8c 约定）。
 * 流正常结束或出错都 resolve / reject 给调用方决定重连；signal 中止即关连接。协作视图（ledger.ts）、批量面板（fleet.ts）共用。
 */
import { apiStream } from "./client";
import { drainFrames, type BridgeEvent } from "@/lib/chat/stream-shape";

export async function followBridgeEvents(opts: { signal: AbortSignal; types: ReadonlySet<string>; onOpen?: () => void; onEvent: (e: BridgeEvent) => void }): Promise<void> {
  const res = await apiStream("/events", { signal: opts.signal });
  opts.onOpen?.();
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const { events, rest } = drainFrames(buffer + dec.decode(value, { stream: true }));
      buffer = rest;
      for (const evt of events) if (opts.types.has(evt.type)) opts.onEvent(evt);
    }
  } finally {
    reader.cancel().catch(() => undefined); // 已断开的流再 cancel 会抛，这里只是善后
  }
}

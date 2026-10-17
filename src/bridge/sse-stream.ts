import { eventsQueryFilter, replayEventsSince, subscribeEvents, type EventFilter } from "./event-bus.js";

/** Per-connection queue budget; one crossing frame and the overflow notice may exceed it. */
const SSE_QUEUE_BYTE_LIMIT = 8 * 1024 * 1024;

/** GET /events: filtered replay, live events and a 5s heartbeat below Bun's idle timeout. */
export function createSseResponse(req: Request, extraFilter?: EventFilter): Response {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since") ?? req.headers.get("Last-Event-ID");
  const since = sinceParam !== null ? Number(sinceParam) : NaN;
  const filter = eventsQueryFilter(url.searchParams, extraFilter);
  let unsub: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let abort: (() => void) | undefined;
  let stopped = false;
  let lastSeq = Number.isFinite(since) ? since : 0;
  const cleanup = () => {
    stopped = true;
    unsub?.();
    unsub = undefined;
    if (ping !== undefined) clearInterval(ping);
    ping = undefined;
    if (abort) req.signal.removeEventListener("abort", abort);
    abort = undefined;
  };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (frame: string, seq?: number) => {
        if (stopped) return;
        try {
          controller.enqueue(enc.encode(frame));
          if (seq !== undefined) lastSeq = seq;
          if ((controller.desiredSize ?? 0) < 0) {
            controller.enqueue(enc.encode(`event: overflow\ndata: ${JSON.stringify({ seq: lastSeq })}\n\n`));
            controller.close();
            cleanup();
            console.log(`[sse] overflow: closed connection at seq=${lastSeq}`);
          }
        } catch {
          cleanup(); // A cancelled reader cannot receive more bytes; detach all producers.
        }
      };
      abort = () => {
        cleanup();
        controller.close();
      };
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) return abort();
      const send = (evt: { seq: number }) => enqueue(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`, evt.seq);
      enqueue(": connected\n\n"); // Flush headers immediately, including when replay is empty.
      if (Number.isFinite(since)) {
        for (const evt of replayEventsSince(since, filter)) {
          send(evt);
          if (stopped) break;
        }
      }
      // Replay can overflow before a live subscription exists; never resurrect that connection.
      if (stopped) return;
      unsub = subscribeEvents(filter, send);
      ping = setInterval(() => enqueue(": ping\n\n"), 5_000);
    },
    cancel() { cleanup(); },
  }, { highWaterMark: SSE_QUEUE_BYTE_LIMIT, size: (chunk) => chunk!.byteLength });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

import { beforeEach, expect, spyOn, test } from "bun:test";
import { createSseResponse } from "../src/bridge/sse-stream.js";
import { __resetEventBusForTest, emitEvent, replayEventsSince, subscriberCount } from "../src/bridge/event-bus.js";

beforeEach(__resetEventBusForTest);
const publish = (text = "x".repeat(1024), agent = "a") => emitEvent({ agent, chatId: agent, type: "assistant_text", data: { text } });
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

test("unread SSE closes at 8 MiB with a final overflow cursor and detaches its subscriber", async () => {
  const reader = createSseResponse(new Request("http://localhost/events")).body!.getReader();
  let last = 0;
  try {
    for (let i = 0; i < 10_000 && subscriberCount(); i++) last = publish().seq;
    expect(subscriberCount()).toBe(0);
    for (let i = 0; i < 100; i++) publish("after overflow");
    let bytes = 0, tail = "", previous = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      previous = tail;
      tail = decode(value);
    }
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(bytes).toBeLessThan(8 * 1024 * 1024 + 2048);
    expect(previous).toContain(`id: ${last}\n`);
    expect(tail).toBe(`event: overflow\ndata: {"seq":${last}}\n\n`);
  } finally { await reader.cancel(); }
});

test("10,000 normally consumed events preserve wire bytes and order; Last-Event-ID replays", async () => {
  const reader = createSseResponse(new Request("http://localhost/events?agent=a")).body!.getReader();
  try {
    expect(decode((await reader.read()).value)).toBe(": connected\n\n");
    for (let i = 0; i < 10_000; i++) {
      const evt = publish();
      expect(decode((await reader.read()).value)).toBe(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`);
    }
    expect(subscriberCount()).toBe(1);
  } finally { await reader.cancel(); }
  expect(subscriberCount()).toBe(0);
  const cursor = publish("before reconnect").seq;
  publish("other agent", "b");
  const missed = publish("missed");
  const res = createSseResponse(new Request("http://localhost/events?agent=a", { headers: { "Last-Event-ID": String(cursor) } }));
  const resumed = res.body!.getReader();
  try {
    expect(decode((await resumed.read()).value)).toBe(": connected\n\n");
    expect(decode((await resumed.read()).value)).toBe(`id: ${missed.seq}\ndata: ${JSON.stringify(missed)}\n\n`);
    expect(replayEventsSince(cursor, { agent: "a" })).toEqual([missed]);
  } finally { await resumed.cancel(); }
});

test("replay spanning agents can overflow before subscribe without leaving a producer behind", async () => {
  for (let i = 0; i < 8; i++) publish("x".repeat(1500_000), `agent-${i}`);
  const reader = createSseResponse(new Request("http://localhost/events?since=0")).body!.getReader();
  try {
    expect(subscriberCount()).toBe(0);
    let tail = "", count = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      tail = decode(value);
      count++;
    }
    expect(count).toBe(8); // connected, six events, overflow
    expect(tail).toBe('event: overflow\ndata: {"seq":6}\n\n');
  } finally { await reader.cancel(); }
});

test("abort and cancel release subscription and heartbeat; ping stays at five seconds", async () => {
  const intervals = spyOn(globalThis, "setInterval");
  const clears = spyOn(globalThis, "clearInterval");
  const signal = new AbortController();
  const reader = createSseResponse(new Request("http://localhost/events", { signal: signal.signal })).body!.getReader();
  try {
    expect(decode((await reader.read()).value)).toBe(": connected\n\n");
    const call = intervals.mock.calls.at(-1)!;
    expect(call[1]).toBe(5000);
    (call[0] as () => void)();
    expect(decode((await reader.read()).value)).toBe(": ping\n\n");
    signal.abort();
    expect(subscriberCount()).toBe(0);
    expect(clears).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
    expect(clears).toHaveBeenCalledTimes(1);
  } finally {
    await reader.cancel();
    intervals.mockRestore();
    clears.mockRestore();
  }
});

test("already-aborted requests never subscribe", async () => {
  const signal = new AbortController();
  signal.abort();
  const res = createSseResponse(new Request("http://localhost/events", { signal: signal.signal }));
  expect(subscriberCount()).toBe(0);
  expect(await res.text()).toBe("");
});

test("web parser recognizes overflow after normal frames and stops at the control event", async () => {
  const { drainFrames } = await import("../web/lib/chat/stream-shape");
  const evt = publish("before overflow");
  const frame = `id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`;
  expect(drainFrames(`${frame}event: overflow\ndata: {"seq":${evt.seq}}\n\n${frame}`))
    .toMatchObject({ events: [evt], rest: "", overflow: true });
  expect(drainFrames('event: overflow\ndata: {"seq":1}'))
    .toEqual({ events: [], rest: 'event: overflow\ndata: {"seq":1}' });
});

test("chat and collaboration consume preceding events, cancel overflow streams, and finish without waiting for EOF", async () => {
  const { setAppConfigForTest } = await import("../web/lib/app-config");
  // Runtime imports avoid pulling the web JSX graph into the backend typecheck.
  const chatPath = "@/lib/api/stream", ledgerPath = "@/lib/api/ledger";
  const { openAgentEventStream } = await import(chatPath) as {
    openAgentEventStream(agent: string, opts: { lang: "zh" }): Promise<ReadableStream<Uint8Array>>;
  };
  const { followEventStream } = await import(ledgerPath) as {
    followEventStream(path: string, opts: { signal: AbortSignal; onEvent: (event: unknown) => void }): Promise<void>;
  };
  const realFetch = globalThis.fetch;
  let cancelled = 0;
  const evt = { seq: 42, ts: "now", agent: "agent-a", chatId: "a", type: "assistant_text", data: { text: "before overflow" } };
  const enc = new TextEncoder();
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "test", version: "" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname;
    if (path === "/api/v1/events") return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\nevent: overflow\ndata: {"seq":42}\n\n`)); },
      cancel() { cancelled++; },
    }));
    const body = path.endsWith("/pending") ? { question: null } : path.endsWith("/bg-tasks") ? { tasks: [] } : { ownerIds: [] };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const reader = (await openAgentEventStream("a", { lang: "zh" })).getReader();
    let wire = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        wire += decode(value);
      }
    } finally { await reader.cancel(); }
    expect(wire).toContain('"text":"before overflow"');
    expect(wire).toContain('"eid":42');
    expect(wire).not.toContain('"seq":42');
    expect(cancelled).toBe(1);
    const received: unknown[] = [];
    await followEventStream("/events", { signal: new AbortController().signal, onEvent: (e) => received.push(e) });
    expect(received).toEqual([evt]);
    expect(cancelled).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
    setAppConfigForTest(null);
  }
});


test("one oversized live event reaches a reading consumer without disconnecting it", async () => {
  const reader = createSseResponse(new Request("http://localhost/events")).body!.getReader();
  try {
    await reader.read();
    const evt = publish("汉😀".repeat(1_300_000));
    expect(decode((await reader.read()).value)).toBe(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`);
    expect(subscriberCount()).toBe(1);
    const next = publish("still connected");
    expect(decode((await reader.read()).value)).toContain(`id: ${next.seq}\n`);
  } finally { await reader.cancel(); }
});


test("an oversized unread frame still closes and cancellation is safe before its deferred check", async () => {
  for (const cancelFirst of [false, true]) {
    const reader = createSseResponse(new Request("http://localhost/events")).body!.getReader();
    await reader.read();
    const evt = publish("x".repeat(9 * 1024 * 1024));
    if (cancelFirst) await reader.cancel();
    await Promise.resolve();
    expect(subscriberCount()).toBe(0);
    if (!cancelFirst) {
      const wire = decode((await reader.read()).value);
      expect(wire).toBe(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`);
      expect(decode((await reader.read()).value)).toBe(`event: overflow\ndata: {"seq":${evt.seq}}\n\n`);
      expect((await reader.read()).done).toBe(true);
    }
    await reader.cancel();
  }
});

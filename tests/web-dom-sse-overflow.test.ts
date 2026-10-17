// The HTTP consumers reach React through their web dependencies; keep this integration in the web test layer.
import { expect, test } from "bun:test";

const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

test("chat and collaboration consume preceding events, cancel overflow streams, and finish without waiting for EOF", async () => {
  const { setAppConfigForTest } = await import("../web/lib/app-config");
  // Literal runtime loads expose dependencies to CI without pulling web JSX into the backend typecheck.
  const { openAgentEventStream } = require("@/lib/api/stream") as {
    openAgentEventStream(agent: string, opts: { lang: "zh" }): Promise<ReadableStream<Uint8Array>>;
  };
  const { followEventStream } = require("@/lib/api/ledger") as {
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

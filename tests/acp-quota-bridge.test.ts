import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

// Run in a child so startQuotaWall's process-wide subscription cannot affect other tests.
// Production parsing, watcher events, quota-wall cancellation and ask storage remain real.
async function bridgeProbe() {
  const { classifyPromptError, failureEntry } = await import("../src/lib/acp/failures.ts");
  const { RpcError } = await import("../src/lib/acp/rpc.ts");
  const { onAcpFrame } = await import("../src/bridge/acp-link.ts");
  const { noteAcpChannel } = await import("../src/bridge/acp-state.ts");
  const { startWatching, stopWatching } = await import("../src/bridge/jsonl-watcher.ts");
  const { subscribeEvents } = await import("../src/bridge/event-bus.ts");
  const { setExtensionSocket } = await import("../src/bridge/pi-abort.ts");
  const { HeldQueue } = await import("../src/bridge/held-queue.ts");
  const { startQuotaWall, trackResumePlan, resumeStillWanted } = await import("../src/bridge/quota-wall-wiring.ts");
  const { setAsksForTest, askDb, onAsk } = await import("../src/bridge/asks.ts");
  const { listAsks } = await import("../src/lib/ledger-asks.ts");
  const { isLimitHitText } = await import("../src/lib/quota-wall-text.ts");
  const held = new HeldQueue(null), sent: unknown[] = [], events: any[] = [];
  const ws = { send: (data: string) => { sent.push(JSON.parse(data)); } };
  const agents = ["quota", "nonquota"].map((s) => ({ name: `agent-acp-${s}`, channelId: `local-acp-${s}`, status: "active", projectId: "p" }));
  setAsksForTest({ path: `${process.env.CLAUDESTRA_STATE_DIR}/asks.db`, registry: agents as never, ownerChats: [] });
  setExtensionSocket(() => ws, { deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never,
    hold: () => { throw new Error("unexpected undelivered echo"); } });
  const nativeTimer = globalThis.setInterval;
  // No background polling: the test drives only the real event subscriber synchronously.
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  startQuotaWall({ held, calls: { values: () => [] }, clients: new Map(), controlChannelId: "",
    deliver: async () => { throw new Error("unexpected automatic delivery"); }, flush: async () => {},
    markAgentSource: () => {}, escalate: async () => {} } as never);
  globalThis.setInterval = nativeTimer;
  subscribeEvents({}, (e) => { if (e.type === "assistant_text") events.push(e); });
  const configOptions = [{ id: "model", name: "Model", type: "select", currentValue: "current",
    options: [{ value: "current", name: "current" }, { value: "other", name: "other" }] }];
  const out: any[] = [];
  for (const [i, a] of agents.entries()) {
    noteAcpChannel(a.channelId, "acp");
    await startWatching(a.name, "/unused", "fixture", a.channelId, {} as never, { runtime: "codex", transport: "acp" });
    const oldPlan = { from: { kind: "bridge", label: "api-error-resume" }, to: { kind: "local", channelId: a.channelId, ws },
      intent: "notification", content: "continue", meta: { messageId: a.name, triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: a.name } } as const;
    held.holdEnv(oldPlan as never);
    trackResumePlan(a.channelId, a.name);
    const message = i === 0 ? "Quota depleted" : "You've hit your usage limit.";
    const classified = classifyPromptError(new RpcError(-32603, message, { message, codexErrorInfo: i === 0 ? "usageLimitExceeded" : "other" }), a.name);
    const failure = classified.kind === "error" ? { ...classified, retry: false } : classified;
    const entry = failureEntry(failure, new Date().toISOString())!;
    const before = resumeStillWanted(oldPlan as never);
    const asks: unknown[] = [];
    const unsubAsk = onAsk((ask) => { if (ask.fromChannelId === a.channelId) asks.push(ask); });
    await onAcpFrame({ type: "acp_entries", channelId: a.channelId, entries: [entry] }, ws, {} as never);
    // Also prove explicit false wins when the body itself exactly matches the legacy quota regex.
    if (i === 1) await onAcpFrame({ type: "acp_entries", channelId: a.channelId,
      entries: [{ ...entry, message: { content: [{ type: "text", text: message }] } }] }, ws, {} as never);
    await onAcpFrame({ type: "acp_failure", channelId: a.channelId, failure, configOptions }, ws, {} as never);
    // The injected registry is promise-based; drain its continuations before inspecting the real ledger.
    for (let n = 0; n < 20; n++) await Promise.resolve();
    out.push({ kind: failure.kind, entry, textMatches: isLimitHitText(message), before,
      stillWanted: resumeStillWanted(oldPlan as never), held: held.get(a.channelId)?.length ?? 0,
      events: events.filter((e) => e.chatId === a.channelId), asks,
      storedAsks: listAsks(askDb(), { project: "p" }).filter((ask) => ask.fromChannelId === a.channelId) });
    unsubAsk();
    stopWatching(a.name);
  }
  return { out, sent };
}

test("usageLimitExceeded / Quota depleted crosses ACP watcher, cancels old resume and opens an unselected quota ask", async () => {
  const state = mkdtempSync(join(tmpdir(), "acp-quota-bridge-"));
  try {
    const child = Bun.spawn([process.execPath, "--preload", "./preload.ts", "-e", `console.log("PROBE=" + JSON.stringify(await (${bridgeProbe.toString()})()));`], {
      cwd: import.meta.dir, env: testChildEnv({ CLAUDESTRA_STATE_DIR: state }), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout.split("\n").find((s) => s.startsWith("PROBE="))!.slice(6));
    const [quota, other] = result.out;
    expect(quota).toMatchObject({ kind: "quota", textMatches: false, before: true, stillWanted: false, held: 0, entry: { rateLimited: true } });
    expect(quota.events[0].data).toMatchObject({ text: "Quota depleted", rateLimited: true });
    expect(quota.storedAsks).toHaveLength(1);
    const ask = quota.storedAsks[0];
    expect(ask).toMatchObject({ state: "open", extra: { quota: true, acp: true, raw: "Quota depleted" } });
    expect(ask.answer).toBeNull();
    expect(ask.options[0].buttons[0]).toMatchObject({ id: "acp_quota_0", label: "等重置" });
    expect(ask.options[0].buttons.every((b: any) => !b.selected && !b.default)).toBe(true);
    expect(result.sent).toEqual([]); // No model switch, answer or automatic choice was sent.
    expect(other).toMatchObject({ kind: "error", textMatches: true, before: true, stillWanted: true, held: 1, entry: { rateLimited: false } });
    expect(other.events).toHaveLength(2);
    expect(other.events.every((e: any) => e.data.rateLimited !== true)).toBe(true);
    expect(other.storedAsks).toEqual([]);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}, 10_000);

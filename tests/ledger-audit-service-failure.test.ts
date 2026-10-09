import { describe, expect, test, spyOn } from "bun:test";
import { ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";

const good = () => ({ ok: true, projects: [], pending: [] });
function harness(over: Partial<LedgerAuditDeps> = {}) {
  let response: unknown = { ok: false, error: "Bearer secret-token\nfull command output" };
  const sent: Envelope[] = [], held: Envelope[] = [], calls: string[][] = [], sources: string[] = [];
  const d: LedgerAuditDeps = {
    clients: new Map([["pm-channel", { ws: {} as never, channelId: "pm-channel" }]]),
    deliver: async (env) => { sent.push(env); return { outcome: { kind: "sent" } }; },
    hold: (env) => { held.push(env); },
    lastMessageSource: { set: (ch) => { sources.push(ch); } },
    channelOf: (to) => to === "on-duty-pm" ? "pm-channel" : undefined,
    busy: async () => false,
    failureTargets: () => [{ project: "project-a", to: "on-duty-pm" }],
    runManager: async (...args) => { calls.push(args); return response; },
    ...over,
  };
  return { d, sent, held, calls, sources, respond: (r: unknown) => { response = r; }, tick: ledgerAuditTicker(d) };
}

// All traffic is captured here; no bridge or production transport is connected.
describe("real ledgerAuditTicker consecutive full-round failures", () => {
  test("first two silent, third alerts PM once; persistent failure keeps one notice", async () => {
    const h = harness();
    await h.tick(); await h.tick();
    expect(h.sent).toHaveLength(0);
    await h.tick();
    expect(h.sent).toHaveLength(1);
    for (let i = 0; i < 12; i++) await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.calls.every((a) => a.join(" ") === "ledger audit --json")).toBe(true);
    expect(h.sent[0]).toMatchObject({ to: { agentName: "on-duty-pm" }, intent: "notification", meta: { waitForIdle: true } });
    expect(String(h.sent[0].content)).toContain("ledger-audit-failure");
    expect(String(h.sent[0].content)).toContain("manager_failed");
    expect(String(h.sent[0].content)).not.toContain("secret-token");
    expect(String(h.sent[0].content)).not.toContain("full command output");
  });

  test("complete zero-findings success resets streak; new incident has a new message", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick();
    h.respond(good()); await h.tick();
    h.respond({ ok: false });
    await h.tick(); await h.tick();
    expect(h.sent).toHaveLength(1);
    await h.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0].meta.messageId).not.toBe(h.sent[1].meta.messageId);
  });

  test("success before threshold resets; ordinary zero findings do not count", async () => {
    const h = harness();
    await h.tick(); await h.tick();
    h.respond(good());
    for (let i = 0; i < 5; i++) await h.tick();
    h.respond({ ok: false }); await h.tick(); await h.tick();
    expect(h.sent).toHaveLength(0);
    await h.tick(); expect(h.sent).toHaveLength(1);
  });

  test.each([undefined, {}, { outcome: {} }, { outcome: { kind: "error" } }, { outcome: { kind: "dropped" } },
    { outcome: { kind: "read" } }])("failed/unknown receipt retries same message with bounded backoff: %j", async (receipt) => {
    const attempts: Envelope[] = [];
    let accept = false;
    const h = harness({ deliver: async (env) => { attempts.push(env); return accept ? { outcome: { kind: "sent" } } : receipt; } });
    for (let i = 0; i < 7; i++) await h.tick();
    expect(attempts).toHaveLength(3); // attempts on rounds 3, 4, 6
    expect(new Set(attempts.map((env) => env.meta.messageId)).size).toBe(1);
    expect(new Set(attempts.map((env) => env.meta.threadId)).size).toBe(1);
    accept = true;
    for (let i = 0; i < 20; i++) await h.tick();
    expect(attempts).toHaveLength(4); // round 10 accepted; no more sends
  });

  test("transport exception retries; accepted hold keeps single envelope and receipt", async () => {
    let throws = true;
    const attempts: Envelope[] = [];
    const h = harness({ busy: async () => false, deliver: async (env) => {
      attempts.push(env); if (throws) throw new Error("transport secret"); return { outcome: { kind: "sent" } };
    } });
    for (let i = 0; i < 3; i++) await h.tick();
    throws = false;
    h.d.busy = async () => true;
    for (let i = 0; i < 12; i++) await h.tick();
    expect(attempts).toHaveLength(1); expect(h.held).toHaveLength(1);
    expect(h.held[0].meta.messageId).toBe(attempts[0].meta.messageId);
    expect(h.held[0].meta.threadId).toBe(attempts[0].meta.threadId);
    expect(h.calls.some((a) => a.includes("--ack"))).toBe(false);
  });

  test("hold exception is not accepted; queued notice does not change owner source", async () => {
    const h = harness({ busy: async () => true, hold: () => { throw new Error("queue unavailable"); } });
    for (let i = 0; i < 3; i++) await h.tick();
    h.d.hold = (env) => { h.held.push(env); };
    for (let i = 0; i < 10; i++) await h.tick();
    expect(h.held).toHaveLength(1); expect(h.sources).toEqual([]); expect(h.sent).toEqual([]);
  });

  test("offline target retries later; recipients resolve on current round", async () => {
    const h = harness({ channelOf: () => undefined });
    for (let i = 0; i < 3; i++) await h.tick();
    h.d.channelOf = () => "pm-channel";
    h.d.failureTargets = () => [{ project: "project-a", to: "replacement-pm" }];
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toMatchObject({ agentName: "replacement-pm" });
  });

  test("concurrent reentry is skipped and cannot advance failure streak", async () => {
    let release!: (value: unknown) => void;
    const h = harness({ runManager: async () => new Promise((resolve) => { release = resolve; }) });
    const first = h.tick();
    await Promise.all([h.tick(), h.tick(), h.tick()]);
    expect(h.sent).toHaveLength(0);
    release({ ok: false }); await first;
    h.d.runManager = async () => ({ ok: false });
    await h.tick(); expect(h.sent).toHaveLength(0);
    await h.tick(); expect(h.sent).toHaveLength(1);
  });

  test.each([undefined, { ok: "true", projects: [], pending: [] }, { ok: true },
    { ok: true, projects: [], pending: null }, { ok: true, projects: [null], pending: [] },
    { ok: true, projects: [], pending: [{}] }])("invalid manager response is a failure, not empty findings: %j", async (response) => {
    const h = harness(); h.respond(response);
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(String(h.sent[0].content)).toContain("invalid_response");
  });

  test("manager throws count; ack failure prevents reset until full success", async () => {
    const h = harness({ runManager: async () => { throw new Error("command secret"); } });
    await h.tick(); await h.tick();
    h.d.runManager = async (...args) => args.includes("--ack") ? { ok: false } : {
      ok: true, projects: [], pending: [{ key: "key-a", project: "project-a", notify: "on-duty-pm", rule: "pm_held", detail: "detail", suggestion: "check_inbox" }],
    };
    await h.tick();
    expect(h.sent).toHaveLength(2); // normal finding plus failure escalation
    expect(String(h.sent[1].content)).toContain("round_failed");
    h.d.runManager = async () => good(); await h.tick();
    h.d.runManager = async () => ({ ok: false });
    await h.tick(); await h.tick(); expect(h.sent).toHaveLength(2);
    await h.tick(); expect(h.sent).toHaveLength(3);
  });

  test("target read failure stays diagnostic and retries without master fallback", async () => {
    const logs: unknown[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => { logs.push(args.join(" ")); });
    try {
      const h = harness({ failureTargets: () => { throw new Error("cannot read roles"); } });
      for (let i = 0; i < 4; i++) await h.tick();
      expect(h.sent).toEqual([]);
      expect(logs.some((m) => String(m).includes("cannot read roles"))).toBe(true);
      h.d.failureTargets = () => [{ project: "project-a", to: "on-duty-pm" }];
      await h.tick(); await h.tick(); expect(h.sent).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  test("multiple projects each register once, one offline PM does not block others", async () => {
    const h = harness({ failureTargets: () => [{ project: "project-a", to: "on-duty-pm" }, { project: "project-b", to: "offline-pm" }] });
    for (let i = 0; i < 8; i++) await h.tick();
    expect(h.sent).toHaveLength(1);
    h.d.channelOf = () => "pm-channel";
    for (let i = 0; i < 10; i++) await h.tick();
    expect(h.sent).toHaveLength(2);
    expect(String(h.sent[1].content)).toContain("project-b");
  });

  test("partial targets notify verified project; empty targets never count as notified", async () => {
    const logs: unknown[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => { logs.push(args.join(" ")); });
    try {
      const h = harness({ failureTargets: () => [] });
      for (let i = 0; i < 5; i++) await h.tick();
      expect(h.sent).toEqual([]);
      expect(logs.length).toBeGreaterThan(0);
      h.d.failureTargets = () => [{ project: "project-b", to: "on-duty-pm" }];
      await h.tick(); await h.tick();
      expect(h.sent).toHaveLength(1);
      expect(String(h.sent[0].content)).toContain("project-b");
      h.d.failureTargets = () => [{ project: "project-a", to: "on-duty-pm" }, { project: "project-b", to: "on-duty-pm" }];
      for (let i = 0; i < 4; i++) await h.tick();
      expect(h.sent).toHaveLength(2);
      expect(String(h.sent[1].content)).toContain("project-a");
      expect(h.sent[0].meta.messageId).not.toBe(h.sent[1].meta.messageId);
    } finally { spy.mockRestore(); }
  });

  test("concurrent reentry with partial targets does not duplicate the verified notice", async () => {
    let release!: (value: unknown) => void;
    const h = harness({ failureTargets: () => [{ project: "project-b", to: "on-duty-pm" }] });
    h.d.runManager = async () => ({ ok: false });
    await h.tick(); await h.tick();
    h.d.runManager = async () => new Promise((resolve) => { release = resolve; });
    const third = h.tick();
    await Promise.all([h.tick(), h.tick()]);
    release({ ok: false }); await third;
    expect(h.sent).toHaveLength(1);
  });
});


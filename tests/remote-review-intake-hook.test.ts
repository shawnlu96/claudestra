// RRL-1 验收线 2/3：bridge 钩子只拦三条全中的推送；任一不中（含出错）返回 null = 照原路投给 PM，收件目录不落文件。
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { renderRedeliveryPush } from "../src/lib/peer-pr-retry.js";
import { join } from "node:path";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { createTask } from "../src/lib/ledger-write.js";
import { inInbox, listInbox, readInbox, writeInbox } from "../src/lib/remote-review-inbox.js";
import { interceptRemoteReview, type IntakeDeps, type IntakeInput } from "../src/bridge/remote-review-intake.js";
import { handoffConfig, INJECT, P1_TEXT, PEER, PM, PR, pushText, remoteFixture } from "./helpers/remote-review-fixture.js";

let fx: ReturnType<typeof remoteFixture>;
afterEach(() => fx?.cleanup());

function harness(over: Partial<IntakeDeps> = {}) {
  const mirrored: string[] = [];
  const deps: IntakeDeps = { config: () => handoffConfig(), db: () => fx.db, stash: (e, k) => writeInbox(e, k, fx.inbox), waiting: (k) => inInbox(k, fx.inbox),
    now: () => 1_700_000_000_000, ...over };
  const call = (input: Partial<IntakeInput> = {}) => interceptRemoteReview({ peer: PEER, agent: PM, text: P1_TEXT, attachments: 0, ...input },
    async (line) => { mirrored.push(line); }, deps);
  return { call, mirrored };
}

describe("RRL-1 hook: not ours → null, nothing stashed", () => {
  test("[验收线 2] no peer / another peer / no handoffPeer / bad text / attachments / addressee not the PM", async () => {
    fx = remoteFixture();
    const h = harness();
    expect(await h.call({ peer: undefined })).toBeNull();
    expect(await h.call({ peer: "Mallory" })).toBeNull();
    expect(await h.call({ text: P1_TEXT.replace("head：", "head:") })).toBeNull();
    expect(await h.call({ text: "PR #1600 看一下" })).toBeNull();
    expect(await h.call({ attachments: 1 })).toBeNull();
    expect(await h.call({ agent: "agent-task-one" })).toBeNull();
    expect(await harness({ config: () => handoffConfig(null) }).call()).toBeNull();
    expect(await harness({ db: () => null }).call()).toBeNull();
    expect(listInbox(fx.inbox)).toEqual([]);
    expect(h.mirrored).toEqual([]);
  });

  test("[验收线 2] no card with that repo+PR, or two of them", async () => {
    fx = remoteFixture();
    fx.db.query("UPDATE tasks SET pr = NULL WHERE id = 'T1'").run();
    expect(await harness().call()).toBeNull();
    fx.db.query("UPDATE tasks SET pr = ? WHERE id = 'T1'").run(`https://github.com/owner/repo/pull/${PR}`);
    createTask(fx.db, fx.at("owner"), { project: "p", id: "T2", title: "T2 same PR", kind: "code" });
    fx.db.query("UPDATE tasks SET pr = ? WHERE id = 'T2'").run(`https://github.com/owner/repo/pull/${PR}`);
    expect(await harness().call()).toBeNull();
    expect(listInbox(fx.inbox)).toEqual([]);
  });

  test("[验收线 2] any error on the way falls back to the normal delivery", async () => {
    fx = remoteFixture();
    expect(await harness({ stash: () => { throw new Error("disk full"); } }).call()).toBeNull();
    expect(await harness({ config: () => { throw new Error("bad scheduler.json"); } }).call()).toBeNull();
  });
});

describe("RRL-1 hook: ours → 202, stashed raw, one mirror line", () => {
  test("[验收线 3] the raw text goes to the inbox for T1; the mirror line is built from parsed fields only", async () => {
    fx = remoteFixture();
    const h = harness();
    const res = await h.call();
    expect(res!.status).toBe(202);
    expect(await res!.json()).toEqual({ ok: true, accepted: true, intake: "remote_review", reportId: "PR1600-r1" });
    const [file] = listInbox(fx.inbox);
    expect(readInbox(file!, fx.inbox)).toMatchObject({ peer: PEER, agent: PM, taskId: "T1", text: P1_TEXT });
    expect((readFileSync(file!).length)).toBeGreaterThan(0);
    expect(h.mirrored.length).toBe(1);
    expect(h.mirrored[0]).toContain("T1 PR1600-r1");
    expect(h.mirrored[0]).not.toContain(INJECT);
  });

  test("[验收线 3] a failing mirror does not undo the intake", async () => {
    fx = remoteFixture();
    const deps: IntakeDeps = { config: () => handoffConfig(), db: () => fx.db, stash: (e, k) => writeInbox(e, k, fx.inbox), waiting: (k) => inInbox(k, fx.inbox),
      now: () => 1_700_000_000_000 };
    const res = await interceptRemoteReview({ peer: PEER, agent: PM, text: P1_TEXT, attachments: 0 }, async () => { throw new Error("discord down"); }, deps);
    expect(res!.status).toBe(202);
    expect(listInbox(fx.inbox).length).toBe(1);
  });
});

describe("RRL-1 hook: duplicate-http-ack (review finding r1)", () => {
  test("[验收线 4] the same report id + head again answers duplicate while waiting, after booking, and as a redelivery", async () => {
    fx = remoteFixture();
    const h = harness();
    expect(await (await h.call())!.json()).not.toHaveProperty("duplicate");
    const second = await h.call();
    expect(second!.status).toBe(202);
    expect(await second!.json()).toEqual({ ok: true, accepted: true, duplicate: true, intake: "remote_review", reportId: "PR1600-r1" });
    expect(listInbox(fx.inbox).length).toBe(1);
    expect(h.mirrored.length).toBe(1);
    // booked by the scheduler: the file is gone, the ledger event answers
    expect(await fx.cli("scheduler", "T1", "--inbox", listInbox(fx.inbox)[0]!)).toMatchObject({ ok: true, duplicate: false });
    rmSync(listInbox(fx.inbox)[0]!);
    expect(await (await h.call())!.json()).toMatchObject({ duplicate: true });
    expect(await (await h.call({ text: renderRedeliveryPush(P1_TEXT, 1, { stage: "build" })! }))!.json()).toMatchObject({ duplicate: true });
    expect(listInbox(fx.inbox)).toEqual([]);
    expect(h.mirrored.length).toBe(1);
    // another round is not a duplicate
    expect(await (await h.call({ text: pushText({ verdict: "changes", p1: 1, round: 2 }) }))!.json()).not.toHaveProperty("duplicate");
  });

  test("[PM 裁定 13] an old-format redelivered P1 is stashed for the record but goes to PM the normal way; a new-format one is taken", async () => {
    fx = remoteFixture();
    const h = harness();
    const legacy = renderRedeliveryPush(P1_TEXT, 1, { stage: "build" }, true)!;
    expect(await h.call({ text: legacy })).toBeNull();
    expect(listInbox(fx.inbox).length).toBe(1);
    expect(readInbox(listInbox(fx.inbox)[0]!, fx.inbox).text).toBe(legacy);
    expect(h.mirrored).toEqual([]);
    // the original of the same report id + head after it is a duplicate (booked once)
    expect(await (await h.call())!.json()).toMatchObject({ duplicate: true });
    expect(listInbox(fx.inbox).length).toBe(1);
    const next = await h.call({ text: renderRedeliveryPush(pushText({ verdict: "changes", p1: 1, round: 2 }), 2, { stage: "build" })! });
    expect(next!.status).toBe(202);
    expect(listInbox(fx.inbox).length).toBe(2);
  });

  test("[r4] ambiguous-retry-swallowed: every copy of an old-format redelivered P1 goes to PM (a failed delivery retried is not swallowed), stashed once", async () => {
    fx = remoteFixture();
    const h = harness();
    const legacy = renderRedeliveryPush(P1_TEXT, 1, { stage: "build" }, true)!;
    expect(await h.call({ text: legacy })).toBeNull(); // PM delivery fails → the route answers 502 → the sender retries the same text
    expect(await h.call({ text: legacy })).toBeNull();
    expect(listInbox(fx.inbox).length).toBe(1);
    expect(await fx.cli("scheduler", "T1", "--inbox", listInbox(fx.inbox)[0]!)).toMatchObject({ ok: true, duplicate: false });
    rmSync(listInbox(fx.inbox)[0]!);
    expect(await h.call({ text: legacy })).toBeNull(); // booked: still to PM, nothing stashed again
    expect(listInbox(fx.inbox)).toEqual([]);
    expect(h.mirrored).toEqual([]);
  });
});

describe("RRL-1 wiring", () => {
  test("[验收线 3] the messages route asks the hook before any delivery to PM (and before ask / slash handling)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "bridge", "api-messages.ts"), "utf8");
    const route = src;
    const hook = route.indexOf("await interceptRemoteReview("), deliver = route.indexOf("await deps.deliver(env)");
    expect(hook).toBeGreaterThan(0);
    expect(hook).toBeLessThan(route.indexOf("answerFromChat("));
    expect(hook).toBeLessThan(deliver);
    expect(route.slice(hook, hook + 400)).toContain("if (remote) return remote;");
  });

  test("[验收线 12] scheduler.json: handoffPeer is optional and must be a peer name", () => {
    const base = { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/tmp/r" };
    const parse = (p: Record<string, unknown>) => parseSchedulerConfig({ enabled: true, projects: { p: { ...base, ...p } } }).projects.p!;
    expect(parse({}).handoffPeer).toBeUndefined();
    expect(parse({ handoffPeer: "Shawn" }).handoffPeer).toBe("Shawn");
    expect(() => parse({ handoffPeer: "a b" })).toThrow(/handoffPeer/);
    expect(() => parse({ handoffPeer: 3 })).toThrow(/handoffPeer/);
  });
});

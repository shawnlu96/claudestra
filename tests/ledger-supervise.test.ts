/**
 * i28-S1 `ledger scheduler-supervise`：只给调度服务写，按 故障键+动作+阶段 去重，字段不对一律拒；
 * 以及监护在处置时 bridge 开出的失败卡不推 owner（ask-runtime 的 quiet → blocking=false → askPushDecision none）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { askPushDecision } from "../src/lib/ask-push.js";
import { listAsks } from "../src/lib/ledger-asks.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { openRuntimeAsk, resetRuntimeAsksForTest } from "../src/bridge/ask-runtime.js";
import { setAsksForTest } from "../src/bridge/asks.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const REC = { agent: "agent-task-one", project: "p", target: "T1", sessionId: "s-one", fault: "dead", faultKey: "restart:agent-task-one:after0",
  workKey: "order:i1", step: "restart", phase: "claim", attempt: 1, limit: 2 };

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

describe("ledger scheduler-supervise", () => {
  test("调度服务写一条 note（data.op=supervise）；同一去重键第二次是 duplicate", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const first = await f.cli("scheduler", "scheduler-supervise", "--data", JSON.stringify(REC));
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(await f.cli("scheduler", "scheduler-supervise", "--data", JSON.stringify(REC))).toMatchObject({ ok: true, duplicate: true });
    const ev = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "supervise");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "note", actor: "scheduler", data: { fault: "dead", step: "restart", phase: "claim" } });
    expect(ev[0].text).toContain("监护：agent-task-one dead，重启（第 1/2 次）");
  });

  test("别的身份不能写；坏 JSON、坏字段拒", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    expect(await f.cli("pm", "scheduler-supervise", "--data", JSON.stringify(REC))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("agent-task-one", "scheduler-supervise", "--data", JSON.stringify(REC))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("scheduler", "scheduler-supervise", "--data", "{oops")).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.cli("scheduler", "scheduler-supervise", "--data", JSON.stringify({ ...REC, step: "nuke" }))).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.cli("scheduler", "scheduler-supervise", "--data", JSON.stringify({ ...REC, target: "T404" }))).toMatchObject({ ok: false });
  });
});

describe("监护在处置时的失败卡不推 owner", () => {
  test("quiet → blocking=false → 不推；不 quiet 照旧 blocking", async () => {
    const f = autoFixture();
    const agents = [{ name: "agent-rv-t1", channelId: "ch-rv", projectId: "p", status: "active" }];
    setAsksForTest({ path: join(f.dir, "ledger.sqlite"), registry: agents as never, ownerChats: [] });
    resetRuntimeAsksForTest();
    cleanup.push(() => { setAsksForTest(undefined); resetRuntimeAsksForTest(); f.close(); });
    await openRuntimeAsk({ source: "codex", channelId: "ch-rv", agentName: "agent-rv-t1", kind: "owner_action", title: "Codex 回合失败", context: "flagged",
      options: [], failure: "error", instance: "air:1", quiet: true });
    const quiet = listAsks(f.db, { fromAgent: "agent-rv-t1" })[0];
    expect(quiet.blocking).toBe(false);
    expect(askPushDecision(quiet, "away")).toBe("none");
    await openRuntimeAsk({ source: "codex", channelId: "ch-rv", agentName: "agent-rv-t1", kind: "owner_action", title: "Codex 回合失败", context: "flagged",
      options: [], failure: "error", instance: "air:2" });
    const loud = listAsks(f.db, { fromAgent: "agent-rv-t1", states: ["open"] })[0];
    expect(loud.blocking).toBe(true);
    expect(askPushDecision(loud, "away")).toBe("push");
  });
});

/**
 * 编排班子的事件路由：规则（src/lib/team-route.ts）+ 轮询与游标（src/bridge/team-router.ts 的 teamRouterTicker）。
 * 有 / 没有调度助理、review 转执行者 / PM、硬规则升级、收件人是写入者本人不发、同一事件只通知一次、bridge 重启后不重发。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { teamRouterTicker } from "../src/bridge/team-router.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, deliver, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { routeEvents, type RouteNotice } from "../src/lib/team-route.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let db: Database;
let path: string;
const owner = (now = 1) => ({ actor: "owner", now });

function team(dispatcher: string | null): void {
  setMeta(db, owner(), { project: "p", key: "pms", value: dispatcher ? ["agent-pm", dispatcher] : ["agent-pm"] });
  setMeta(db, owner(), { project: "p", key: "team", value: { dispatcher, audit: true } });
}

/** T1 推到 build，停在执行者手里 */
function toBuild(): void {
  moveStage(db, owner(), { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, owner(), { taskId: "T1", from: "restate", to: "build" });
}

function route(afterSeq = 0): RouteNotice[] {
  return routeEvents(listEvents(db, { afterSeq }), {
    task: (id) => getTask(db, id),
    team: (p) => ({ pms: getMeta(db, p).pms, team: getMeta(db, p).team }),
    managerCmd: "bun manager.ts",
  });
}

beforeEach(() => {
  path = tempLedgerPath("team-route-");
  db = openLedger(path);
  createTask(db, owner(), { project: "p", id: "T1", title: "路由", kind: "code", agent: "agent-exec" });
});

describe("routeEvents", () => {
  test("没开班子：一条都不发", () => {
    toBuild();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", headSHA: "abc123", moveFrom: "build" });
    expect(route()).toEqual([]);
  });

  test("有调度助理：交付通知调度助理，带现成的 dispatch 命令", () => {
    team("agent-disp");
    toBuild();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", headSHA: "abc123", evidence: "/w/REPORT.md", text: "做完", moveFrom: "build" });
    const n = route();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ to: "agent-disp", kind: "deliver", taskId: "T1", project: "p" });
    expect(n[0].text).toContain("T1「路由」第 1 轮交付 @abc123（agent-exec）");
    expect(n[0].text).toContain("证据：/w/REPORT.md");
    expect(n[0].text).toContain("下一步：bun manager.ts ledger dispatch T1");
    expect(n[0].messageId).toBe(`ledger-${n[0].seq}-agent-disp`);
  });

  test("没配调度助理：交付通知 PM，并注明", () => {
    team(null);
    toBuild();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", moveFrom: "build" });
    const n = route();
    expect(n.map((x) => x.to)).toEqual(["agent-pm"]);
    expect(n[0].text).toContain("没配调度助理");
  });

  test("开班子之前的事件不补发", () => {
    toBuild();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", moveFrom: "build" });
    team("agent-disp");
    expect(route()).toEqual([]);
  });

  test("review 推到 fix → 执行者（md 路径 + 要点）；推到 merge → PM；收件人是写入者本人不发", () => {
    team("agent-disp");
    toBuild();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", moveFrom: "build" });
    const cut = listEvents(db).at(-1)?.seq ?? 0;
    recordReview(db, { actor: "agent-disp", now: 3 }, {
      taskId: "T1", reviewer: "regular", verdict: "changes", p0: 0, p1: 1, p2: 2, path: "/r/T1-r1.md", text: "修 a.ts 越权", move: { from: "review", to: "fix" },
    });
    let n = route(cut);
    expect(n.map((x) => [x.to, x.kind])).toEqual([["agent-exec", "review-fix"]]);
    expect(n[0].text).toContain("结论：/r/T1-r1.md");
    expect(n[0].text).toContain("要点：修 a.ts 越权");
    expect(n[0].text).toContain("ledger deliver T1 --from fix");
    const cut2 = listEvents(db).at(-1)?.seq ?? 0;
    deliver(db, { actor: "agent-exec", now: 4 }, { taskId: "T1", moveFrom: "fix" });
    recordReview(db, { actor: "agent-disp", now: 5 }, { taskId: "T1", reviewer: "adversarial", verdict: "pass", p0: 0, p1: 0, p2: 0, move: { from: "review", to: "merge" } });
    n = route(cut2);
    expect(n.map((x) => [x.to, x.kind])).toEqual([["agent-disp", "deliver"], ["agent-pm", "review-pm"]]);
    expect(n[1].text).toContain("可以合并");
    // PM 自己记的结论不通知 PM
    const cut3 = listEvents(db).at(-1)?.seq ?? 0;
    appendEvent(db, { actor: "agent-pm", now: 6 }, { project: "p", target: "T1", kind: "escalate", text: "自己升级给自己", data: { to: "pm" } });
    expect(route(cut3)).toEqual([]);
  });

  test("硬规则：出 P0、第 3 轮还不通过都另外通知 PM", () => {
    team("agent-disp");
    toBuild();
    let cut = 0;
    for (let r = 1; r <= 3; r++) {
      deliver(db, { actor: "agent-exec", now: 10 * r }, { taskId: "T1", moveFrom: r === 1 ? "build" : "fix" });
      cut = listEvents(db).at(-1)?.seq ?? 0;
      recordReview(db, { actor: "agent-disp", now: 10 * r + 1 }, {
        taskId: "T1", reviewer: "regular", verdict: "changes", p0: r === 1 ? 1 : 0, p1: 1, p2: 0, move: { from: "review", to: "fix" },
      });
      const kinds = route(cut).map((x) => `${x.to}:${x.kind}`);
      if (r === 1) expect(kinds).toEqual(["agent-exec:review-fix", "agent-pm:hard-rule"]);
      if (r === 2) expect(kinds).toEqual(["agent-exec:review-fix"]);
      if (r === 3) expect(kinds).toEqual(["agent-exec:review-fix", "agent-pm:hard-rule"]);
    }
    expect(route(cut).at(-1)?.text).toContain("第 3 轮还不通过");
  });

  test("escalate（含项目级）通知 PM", () => {
    team("agent-disp");
    appendEvent(db, { actor: "agent-disp", now: 2 }, { project: "p", target: "T1", kind: "escalate", text: "执行者要改规格", data: { to: "pm" } });
    appendEvent(db, { actor: "agent-disp", now: 3 }, { project: "p", target: "", kind: "escalate", text: "T1 和 T2 冲突", data: { to: "owner" } });
    const n = route();
    expect(n.map((x) => [x.to, x.kind, x.taskId])).toEqual([["agent-pm", "escalate", "T1"], ["agent-pm", "escalate", ""]]);
    expect(n[1].text).toContain("项目级（需要 owner 拍板）：T1 和 T2 冲突");
  });
});

describe("teamRouterTicker：游标与重启", () => {
  function ticker(cursorPath: string, sent: RouteNotice[], channels: Record<string, string> = { "agent-disp": "c-disp", "agent-pm": "c-pm", "agent-exec": "c-exec" }) {
    const logs: string[] = [];
    const tick = teamRouterTicker({
      reader: new LedgerReader(path),
      cursorPath,
      channelOf: (a) => channels[a] ?? null,
      send: async (n) => void sent.push(n),
      log: (m) => void logs.push(m),
    });
    return { tick, logs };
  }

  test("首次运行不补发历史；新事件只通知一次；重启（新 ticker + 同一游标文件）不重发，停机期间的事件照发", async () => {
    team("agent-disp");
    toBuild();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", headSHA: "old", moveFrom: "build" });
    const cursorPath = join(mkdtempSync(join(tmpdir(), "team-router-")), "cursor.json");
    const sent: RouteNotice[] = [];
    const a = ticker(cursorPath, sent);
    await a.tick();
    expect(sent).toEqual([]); // 游标从当前最大 seq 起

    recordReview(db, { actor: "agent-disp", now: 3 }, { taskId: "T1", reviewer: "regular", verdict: "changes", p0: 0, p1: 1, p2: 0, move: { from: "review", to: "fix" } });
    await a.tick();
    await a.tick();
    expect(sent.map((n) => n.kind)).toEqual(["review-fix"]);

    // bridge 停机期间执行者交付；重启后新 ticker 读同一游标
    deliver(db, { actor: "agent-exec", now: 4 }, { taskId: "T1", headSHA: "new", moveFrom: "fix" });
    const b = ticker(cursorPath, sent);
    await b.tick();
    await b.tick();
    expect(sent.map((n) => n.kind)).toEqual(["review-fix", "deliver"]);
    const c = ticker(cursorPath, sent);
    await c.tick();
    expect(sent).toHaveLength(2);
  });

  test("游标先于投递落盘：投递抛错时这条不会在下一轮重发", async () => {
    team("agent-disp");
    toBuild();
    const cursorPath = join(mkdtempSync(join(tmpdir(), "team-router-")), "cursor.json");
    let calls = 0;
    const logs: string[] = [];
    const tick = teamRouterTicker({
      reader: new LedgerReader(path), cursorPath, channelOf: () => "c",
      send: async () => {
        calls++;
        throw new Error("ws 断了");
      },
      log: (m) => void logs.push(m),
    });
    await tick();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", moveFrom: "build" });
    await tick();
    await tick();
    expect(calls).toBe(1);
    expect(logs.some((l) => l.includes("ws 断了"))).toBe(true);
  });

  test("收件人不在 registry：打日志、不投；库被换成更短的一份：从当前位置起算", async () => {
    team("agent-disp");
    toBuild();
    const cursorPath = join(mkdtempSync(join(tmpdir(), "team-router-")), "cursor.json");
    const sent: RouteNotice[] = [];
    const t = ticker(cursorPath, sent, {});
    await t.tick();
    deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", moveFrom: "build" });
    await t.tick();
    expect(sent).toEqual([]);
    expect(t.logs.some((l) => l.includes("agent-disp 不在 registry"))).toBe(true);

    writeFileSync(cursorPath, JSON.stringify({ seq: 10_000 }));
    appendEvent(db, { actor: "owner", now: 3 }, { project: "p", target: "T1", kind: "note", text: "触发 data_version" });
    const t2 = ticker(cursorPath, sent);
    await t2.tick();
    expect(t2.logs.some((l) => l.includes("台账库比游标短"))).toBe(true);
    expect(sent).toEqual([]);
    closeLedger(path);
  });
});

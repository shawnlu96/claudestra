/**
 * human 节点接进「待你处理」（bridge/human-node.ts initHumanNode）：进 build 的 human 任务当场开 assigned ask；合并过的另一台设备看得见、
 * 答得了；作答经卡片端点 → onAssignedAnswer → 写台账、给 PM 发固定模板；同一条 ask 再答是 409，不重复通知；PM 不在线不投。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { setAsksForTest, setOnAssignedAnswer, type AsksDeps } from "../src/bridge/asks.js";
import { initHumanNode } from "../src/bridge/human-node.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import type { Envelope } from "../src/bridge/router.js";
import { setTalkForTest, talkDb } from "../src/bridge/talk.js";
import { humanAssignee, setAskAssigneesOf } from "../src/lib/ask-access.js";
import { listAsks, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { ensureLocalPerson, mergePeople } from "../src/lib/talk-people.js";
import { guest, owner } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const ws = { tag: "ws" } as never;
const PM = { actor: "agent-pm" };
const AA = guest("aa");
const A2 = guest("a2");
const BB = guest("bb");

let dir = "";
let path = "";
let db: Database;
let sent: Envelope[] = [];
let clients: AsksDeps["clients"];
let stop = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "human-wiring-"));
  path = tempLedgerPath("human-wiring-");
  db = openLedger(path);
  sent = [];
  clients = new Map([["222", { ws }]]);
  const registry = [{ name: "agent-pm", channelId: "222", status: "active", projectId: "p" } as RegistryAgent];
  const deps: AsksDeps = { clients, controlChannelId: "999", deliver: async (env) => (sent.push(env), { envelope: env, outcome: { kind: "sent" } }), hold: () => {} };
  setAsksForTest({ path, deps, registry, ownerChats: ["api:owner:self"] });
  setTalkForTest({ dbPath: join(dir, "talk.sqlite"), attDir: join(dir, "att"), fp: () => "aaaa-bbbb", principals: async () => ({ principals: [owner(), AA, A2, BB] }) });
  for (const p of ["guest:aa", "guest:a2", "guest:bb"]) ensureLocalPerson(talkDb(), p);
  mergePeople(talkDb(), "local:guest:a2", "local:guest:aa");
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, PM, { project: "p", id: "T1", title: "登录页改文案", kind: "code", assigneeKind: "human", assignee: "local:guest:aa", pm: "agent-pm" });
  moveStage(db, PM, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, PM, { taskId: "T1", from: "restate", to: "build" });
  stop = initHumanNode();
});
afterEach(() => {
  stop();
  setOnAssignedAnswer(null);
  setAskAssigneesOf((id) => [humanAssignee(id)]);
  setAsksForTest(undefined);
  setTalkForTest(undefined);
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

const theAsk = (): Ask => listAsks(db, { assignee: "local:guest:aa" })[0];
const rows = async (who: Principal) =>
  ((await (await handleAsksApi(new Request("http://x/api/v1/asks"), "/asks", who))!.json()) as { asks: (Ask & { canAnswer: boolean })[] }).asks;
const card = (who: Principal, button: string, text = "") => answerFromCard("p", theAsk().id, { choices: [`[button:${button}]`], text }, who);

describe("接进待你处理", () => {
  test("起来就给进 build 的 human 任务开一条：指给任务上的人、卡活、能写字、带两个按钮", () => {
    expect(listAsks(db, {})).toHaveLength(1);
    expect(theAsk()).toMatchObject({ kind: "assigned", source: "system", taskId: "T1", project: "p", assignee: "local:guest:aa", dedupKey: "assign:T1:0:1", blocking: true, allowText: true });
  });

  test("合并过的另一台设备看得见、答得了；别的 guest 看不见", async () => {
    expect((await rows(A2)).map((a) => [a.taskId, a.canAnswer])).toEqual([["T1", true]]);
    expect(await rows(BB)).toEqual([]);
    expect((await card(BB, "assign_done")).status).toBe(404);
  });

  test("另一台设备点完成：推到 review，PM 收一条固定模板（不含说明）；再点一次 409，不重复通知", async () => {
    expect((await card(A2, "assign_done", "改好了，别给 PM 看")).status).toBe(202);
    expect(getTask(db, "T1")).toMatchObject({ stage: "review", round: 1 });
    expect(sent.map((e) => [e.to.kind === "local" ? e.to.channelId : "", e.content])).toEqual([["222", "[台账] T1 指派给 local:guest:aa 的事项已完成，已推到 review。"]]);
    expect((await card(AA, "assign_done")).status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  test("做不了：阶段不动，PM 收「做不了」模板，只发一次", async () => {
    expect((await card(AA, "assign_cant", "缺设计稿")).status).toBe(202);
    expect(getTask(db, "T1")!.stage).toBe("build");
    expect(sent.map((e) => e.content)).toEqual(["[台账] T1 指派给 local:guest:aa 的事项做不了，原因记在台账里。"]);
    expect((await card(AA, "assign_cant")).status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  test("PM 不在线：台账照写，不投、不改投大总管", async () => {
    clients.delete("222");
    expect((await card(AA, "assign_done")).status).toBe(202);
    expect(getTask(db, "T1")!.stage).toBe("review");
    expect(sent).toEqual([]);
  });
});

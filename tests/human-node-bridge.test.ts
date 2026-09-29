/**
 * human 节点在 bridge 这边（src/bridge/human-node.ts）：扫台账开指派 ask（按 dedupKey 只开一次）；作答先判门（不算数抛 AskRejected、整笔不记），
 * 「完成」同事务写交付并推 review、「做不了」要写原因；给 PM 的通知是固定模板、不带人写的字；开了班子的「完成」不再通知；
 * 作答人按 talk 的 people 表认（合并后的设备算同一人）。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AskRejected } from "../src/bridge/asks.js";
import { assignTick, noticeAssignedAnswer, prepareAssignedAnswer, startHumanNode, type AssignedAnswer, type AssignedAsk, type HumanNodeDeps } from "../src/bridge/human-node.js";
import { setTalkForTest, talkDb } from "../src/bridge/talk.js";
import { HUMAN_NODE_CREATOR, type AskPlan } from "../src/lib/human-node.js";
import { reopenAssignment } from "../src/lib/ledger-human.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import { ensureLocalPerson, mergePeople } from "../src/lib/talk-people.js";

const FP = "aaaa-bbbb-cccc-dddd";
const at = "2026-09-29T00:00:00Z";
const P = "p";
const PM = { actor: "agent-pm" };
const guest = (hex: string, name: string): Principal => ({ id: `guest:${hex}`, role: "external", name, agents: [], createdAt: at });
const OWNER: Principal = { id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], createdAt: at };
const SHA_MINE = "1".repeat(64);
const SHA_OTHERS = "2".repeat(64);
const KEY = "assign:T1:0:1:local:guest:aa";

let dir: string;
let db: Database;
let opened: { task: string; plan: AskPlan }[];
let notices: { pm: string | null; text: string; askId: string }[];
let cancelled: string[];

const deps = (over: Partial<HumanNodeDeps> = {}): HumanNodeDeps => ({
  db: () => db,
  openAsk: (task: LedgerTask, plan: AskPlan) => void opened.push({ task: task.id, plan }),
  cancelAsk: (id) => void cancelled.push(id),
  notifyPm: async (task, text, askId) => void notices.push({ pm: task.pm, text, askId }),
  ...over,
});
const ask = (id: string, dedupKey = KEY): AssignedAsk => ({ id, project: P, taskId: "T1", kind: "assigned", createdBy: HUMAN_NODE_CREATOR, dedupKey });
/** 照「待你处理」作答的顺序走一遍：判门 →（和答案同一事务）写台账 → 落库后通知；返回通知了没有 */
async function answerIt(a: AssignedAsk, ans: AssignedAnswer, d = deps()): Promise<boolean> {
  const write = await prepareAssignedAnswer(d, a, ans);
  write?.();
  return noticeAssignedAnswer(d, a, ans);
}
/** 被拒时的状态码与 code；没被拒返回 null */
async function rejected(run: () => Promise<unknown>): Promise<[number, string] | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (e instanceof AskRejected) return [e.status, e.code];
    throw e;
  }
}
const answer = (button: string, principal: string, over: Partial<AssignedAnswer> = {}): AssignedAnswer => ({
  choices: [`[button:${button}]`], text: "改好了，别让 PM 看到这句", principal, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "human-node-"));
  setTalkForTest({
    dbPath: join(dir, "talk.sqlite"), attDir: join(dir, "att"), fp: () => FP, ownerNickname: () => "阿明",
    principals: async () => ({ principals: [OWNER, guest("aa", "小王"), guest("a2", "小王的平板"), guest("bb", "老李")] }),
  });
  const t = talkDb();
  for (const p of ["guest:aa", "guest:a2", "guest:bb"]) ensureLocalPerson(t, p);
  mergePeople(t, "local:guest:a2", "local:guest:aa");
  t.prepare("INSERT INTO atts (sha256, mime, bytes, createdAt) VALUES (?, 'image/png', 10, 0), (?, 'image/png', 10, 0)").run(SHA_MINE, SHA_OTHERS);
  t.prepare("INSERT INTO att_uploads (sha256, uploader, createdAt) VALUES (?, ?, 0), (?, ?, 0)").run(SHA_MINE, `${FP}/guest:a2`, SHA_OTHERS, `${FP}/guest:bb`);
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, PM, { project: P, id: "T1", title: "登录页改文案", kind: "code", assigneeKind: "human", assignee: "local:guest:aa", pm: "agent-pm" });
  createTask(db, PM, { project: P, id: "T2", title: "还在写规格", kind: "code", assigneeKind: "human", assignee: "local:guest:bb" });
  createTask(db, PM, { project: P, id: "T3", title: "agent 的活", kind: "ops", agent: "agent-x" });
  moveStage(db, PM, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, PM, { taskId: "T1", from: "restate", to: "build" });
  moveStage(db, PM, { taskId: "T3", from: "spec", to: "build" });
  opened = [];
  notices = [];
  cancelled = [];
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  setTalkForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("开指派 ask", () => {
  test("只给进入 build / fix 的 human 任务开；同一个 key 本进程只开一次；重开后按新序号再开", () => {
    const seen = new Set<string>();
    expect(assignTick(deps(), seen)).toBe(1);
    expect(opened.map((o) => [o.task, o.plan.dedupKey, o.plan.assignee])).toEqual([["T1", KEY, "local:guest:aa"]]);
    expect(assignTick(deps(), seen)).toBe(0);
    reopenAssignment(db, PM, "T1");
    expect(assignTick(deps(), seen)).toBe(1);
    expect(opened.at(-1)!.plan.dedupKey).toBe("assign:T1:0:2:local:guest:aa");
  });
  test("起扫描时当场扫一遍（bridge 重启后不等下一个周期）；返回的函数停掉定时器", () => {
    const stop = startHumanNode(deps());
    expect(opened.map((o) => o.plan.dedupKey)).toEqual([KEY]);
    stop();
  });
  test("开失败不记为已开，下一轮重试；库还没有就什么都不做", () => {
    const seen = new Set<string>();
    expect(assignTick(deps({ openAsk: () => { throw new Error("asks 表还是旧版"); } }), seen)).toBe(0);
    expect(assignTick(deps(), seen)).toBe(1);
    expect(assignTick(deps({ db: () => null }), new Set())).toBe(0);
  });
});

describe("作答", () => {
  test("合并后的另一台设备点完成：写交付推 review，actor 是规范 person；只挂作答人自己能用的图；PM 收固定模板，不含说明原文", async () => {
    expect(await answerIt(ask("a1"), answer("assign_done", "guest:a2", { atts: [{ kind: "talk", ref: SHA_MINE }, { kind: "talk", ref: SHA_OTHERS }] }))).toBe(true);
    expect(getTask(db, "T1")).toMatchObject({ stage: "review", round: 1 });
    const ev = listEvents(db, { target: "T1" }).find((e) => e.kind === "deliver")!;
    expect(ev).toMatchObject({ actor: "local:guest:aa", text: "T1 人工交付：完成", data: { note: "改好了，别让 PM 看到这句", atts: [SHA_MINE], external: true } });
    expect(talkDb().prepare("SELECT sha256 FROM att_refs WHERE refKind = 'ask' AND refId = 'a1'").all()).toEqual([{ sha256: SHA_MINE }]);
    expect(notices).toEqual([{ pm: "agent-pm", text: "[台账] T1 指派给 local:guest:aa 的事项已完成，已推到 review。", askId: "a1" }]);
    expect(JSON.stringify(notices)).not.toContain("别让 PM 看到");
  });
  test("交付过之后再答同一条：已过时，409 并撤下，不再写、不再通知", async () => {
    await answerIt(ask("a1"), answer("assign_done", "guest:aa"));
    expect(await rejected(() => answerIt(ask("a1"), answer("assign_done", "guest:a2")))).toEqual([409, "assign_stale"]);
    expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "deliver")).toHaveLength(1);
    expect([notices.length, cancelled]).toEqual([1, ["a1"]]);
  });
  test("做不了：写了原因才算；不写交付、不推阶段，PM 收「做不了」模板；Discord 上点的按 owner 算", async () => {
    expect(await rejected(() => answerIt(ask("a1"), answer("assign_cant", "guest:aa", { text: "  " })))).toEqual([400, "reason_required"]);
    expect(await answerIt(ask("a1"), answer("assign_cant", "discord:123", { text: "缺设计稿" }))).toBe(true);
    expect(getTask(db, "T1")!.stage).toBe("build");
    expect(listEvents(db, { target: "T1" }).some((e) => e.kind === "deliver")).toBe(false);
    expect(notices.map((n) => n.text)).toEqual(["[台账] T1 指派给 local:guest:aa 的事项做不了，原因记在台账里。"]);
  });
  test("不算数的整笔拒掉、不写不发：别的 guest 403；过时的 ask、项目对不上 409 并撤下；认不出的凭据 503；没点按钮 400", async () => {
    const write = await prepareAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:bb"));
    expect(await rejected(async () => write?.())).toEqual([403, "assign_forbidden"]);
    expect(await rejected(() => answerIt(ask("a2", "assign:T1:0:2:local:guest:aa"), answer("assign_done", "guest:aa")))).toEqual([409, "assign_stale"]);
    expect(await rejected(() => answerIt({ ...ask("a6"), project: "q" }, answer("assign_done", "guest:aa")))).toEqual([409, "assign_stale"]);
    expect(await rejected(() => answerIt(ask("a3"), answer("assign_cant", "token:tok_int")))).toEqual([503, "answerer_unknown"]);
    expect(await rejected(() => answerIt(ask("a4"), { choices: [], text: "", principal: "guest:aa" }))).toEqual([400, "assign_choice"]);
    expect(cancelled).toEqual(["a2", "a6"]);
    expect(getTask(db, "T1")!.stage).toBe("build");
    expect(notices).toEqual([]);
  });
  test("实例密钥取不到（认不出人）：503，不写", async () => {
    expect(await rejected(() => answerIt(ask("a1"), answer("assign_done", "guest:aa"), deps({ answerer: async () => null })))).toEqual([503, "answerer_unknown"]);
    expect(getTask(db, "T1")!.stage).toBe("build");
  });
  test("判门之后、写之前被推了阶段：写的那一步再判一次，拒掉（调用方整笔回滚）", async () => {
    const write = (await prepareAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:aa")))!;
    moveStage(db, PM, { taskId: "T1", from: "build", to: "blocked" });
    expect(await rejected(async () => write())).toEqual([409, "assign_conflict"]);
    expect(listEvents(db, { target: "T1" }).some((e) => e.kind === "deliver")).toBe(false);
  });
  test("不是 human 节点开的指派（手工开的）：不判门、不写、不通知，照「待你处理」的老规矩只记账", async () => {
    const manual = { ...ask("m1"), createdBy: "owner:self" };
    expect(await prepareAssignedAnswer(deps(), manual, answer("assign_done", "guest:aa"))).toBeUndefined();
    expect(await noticeAssignedAnswer(deps(), manual, answer("assign_done", "guest:aa"))).toBe(false);
    expect([getTask(db, "T1")!.stage, notices]).toEqual(["build", []]);
  });
  test("图超过交付上限：截到 9 张照样交付", async () => {
    const shas = [..."3456789abcde"].map((c) => c.repeat(64));
    for (const sha of shas) {
      talkDb().prepare("INSERT INTO atts (sha256, mime, bytes, createdAt) VALUES (?, 'image/png', 10, 0)").run(sha);
      talkDb().prepare("INSERT INTO att_uploads (sha256, uploader, createdAt) VALUES (?, ?, 0)").run(sha, `${FP}/guest:aa`);
    }
    expect(await answerIt(ask("a1"), answer("assign_done", "guest:aa", { atts: shas.map((ref) => ({ kind: "talk", ref })) }))).toBe(true);
    expect(listEvents(db, { target: "T1" }).find((e) => e.kind === "deliver")!.data.atts).toEqual(shas.slice(0, 9));
  });
  const teamOn = () => db.prepare("INSERT INTO meta (project, key, value) VALUES (?, 'team', ?)").run(P, JSON.stringify({ dispatcher: null, audit: true, sinceSeq: 1 }));
  test("开了班子：完成只留一条交付事件给班子路由，这里不发", async () => {
    teamOn();
    expect(await answerIt(ask("a1"), answer("assign_done", "guest:aa"))).toBe(false);
    expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "deliver")).toHaveLength(1);
    expect(notices).toEqual([]);
  });
  test("开了班子：做不了不写交付、班子路由收不到，这里照样发", async () => {
    teamOn();
    await answerIt(ask("a1"), answer("assign_done", "guest:aa"));
    moveStage(db, PM, { taskId: "T1", from: "review", to: "fix" });
    expect(await answerIt(ask("a5", "assign:T1:1:2:local:guest:aa"), answer("assign_cant", "owner:self", { text: "做不了" }))).toBe(true);
    expect(notices.map((n) => n.askId)).toEqual(["a5"]);
  });
});

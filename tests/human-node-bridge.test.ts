/**
 * human 节点在 bridge 这边（src/bridge/human-node.ts）：扫台账开指派 ask（按 dedupKey 只开一次）；作答「完成」写交付并推 review、
 * 「做不了」只通知；给 PM 的通知是固定模板、不带人写的字；开了班子的「完成」不再通知；作答人按 talk 的 people 表认（合并后的设备算同一人）。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assignTick, handleAssignedAnswer, startHumanNode, type AssignedAnswer, type HumanNodeDeps } from "../src/bridge/human-node.js";
import { setTalkForTest, talkDb } from "../src/bridge/talk.js";
import type { AskPlan } from "../src/lib/human-node.js";
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

let dir: string;
let db: Database;
let opened: { task: string; plan: AskPlan }[];
let notices: { pm: string | null; text: string; askId: string }[];

const deps = (over: Partial<HumanNodeDeps> = {}): HumanNodeDeps => ({
  db: () => db,
  openAsk: (task: LedgerTask, plan: AskPlan) => void opened.push({ task: task.id, plan }),
  notifyPm: async (task, text, askId) => void notices.push({ pm: task.pm, text, askId }),
  ...over,
});
const ask = (id: string, dedupKey = "assign:T1:0:1") => ({ id, project: P, taskId: "T1", kind: "assigned", dedupKey });
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
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  setTalkForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("开指派 ask", () => {
  test("只给进入 build / fix 的 human 任务开；同一个 key 本进程只开一次；重开后按新 attempt 再开", () => {
    const seen = new Set<string>();
    expect(assignTick(deps(), seen)).toBe(1);
    expect(opened.map((o) => [o.task, o.plan.dedupKey, o.plan.assignee])).toEqual([["T1", "assign:T1:0:1", "local:guest:aa"]]);
    expect(assignTick(deps(), seen)).toBe(0);
    reopenAssignment(db, PM, "T1");
    expect(assignTick(deps(), seen)).toBe(1);
    expect(opened.at(-1)!.plan.dedupKey).toBe("assign:T1:0:2");
  });
  test("起扫描时当场扫一遍（bridge 重启后不等下一个周期）；返回的函数停掉定时器", () => {
    const stop = startHumanNode(deps());
    expect(opened.map((o) => o.plan.dedupKey)).toEqual(["assign:T1:0:1"]);
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
    const r = await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:a2", { atts: [{ kind: "talk", ref: SHA_MINE }, { kind: "talk", ref: SHA_OTHERS }] }));
    expect(r).toEqual({ ok: true, result: "done", notified: true });
    expect(getTask(db, "T1")).toMatchObject({ stage: "review", round: 1 });
    const ev = listEvents(db, { target: "T1" }).find((e) => e.kind === "deliver")!;
    expect(ev).toMatchObject({ actor: "local:guest:aa", text: "T1 人工交付：完成", data: { note: "改好了，别让 PM 看到这句", atts: [SHA_MINE], external: true } });
    expect(talkDb().prepare("SELECT sha256 FROM att_refs WHERE refKind = 'ask' AND refId = 'a1'").all()).toEqual([{ sha256: SHA_MINE }]);
    expect(notices).toEqual([{ pm: "agent-pm", text: "[台账] T1 指派给 local:guest:aa 的事项已完成，已推到 review。", askId: "a1" }]);
    expect(JSON.stringify(notices)).not.toContain("别让 PM 看到");
  });
  test("同一条 ask 的钩子再来一次：不重复写、不重复通知", async () => {
    await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:aa"));
    expect(await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:aa"))).toEqual({ ok: true, result: "done", notified: false });
    expect(notices).toHaveLength(1);
  });
  test("做不了：不写交付、不推阶段，PM 收「做不了」模板；Discord 上点的按 owner 算", async () => {
    expect(await handleAssignedAnswer(deps(), ask("a1"), answer("assign_cant", "discord:123"))).toMatchObject({ ok: true, result: "cant" });
    expect(getTask(db, "T1")!.stage).toBe("build");
    expect(listEvents(db, { target: "T1" }).some((e) => e.kind === "deliver")).toBe(false);
    expect(notices.map((n) => n.text)).toEqual(["[台账] T1 指派给 local:guest:aa 的事项做不了，原因记在台账里。"]);
  });
  test("不算数的作答只记日志：别的 guest、过时的 ask、认不出的凭据、没点按钮、ask 和任务不在同一个项目", async () => {
    expect(await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:bb"))).toMatchObject({ ok: false });
    expect(await handleAssignedAnswer(deps(), ask("a2", "assign:T1:0:2"), answer("assign_done", "guest:aa"))).toMatchObject({ ok: false });
    expect(await handleAssignedAnswer(deps(), ask("a3"), answer("assign_cant", "token:tok_int"))).toMatchObject({ ok: false });
    expect(await handleAssignedAnswer(deps(), ask("a4"), { choices: [], text: "", principal: "guest:aa" })).toMatchObject({ ok: false });
    expect(await handleAssignedAnswer(deps(), { ...ask("a6"), project: "q" }, answer("assign_done", "guest:aa"))).toMatchObject({ ok: false });
    expect(getTask(db, "T1")!.stage).toBe("build");
    expect(notices).toEqual([]);
  });
  test("图超过交付上限：截到 9 张照样交付，不让已记下的作答卡在 build", async () => {
    const shas = [..."3456789abcde"].map((c) => c.repeat(64));
    for (const sha of shas) {
      talkDb().prepare("INSERT INTO atts (sha256, mime, bytes, createdAt) VALUES (?, 'image/png', 10, 0)").run(sha);
      talkDb().prepare("INSERT INTO att_uploads (sha256, uploader, createdAt) VALUES (?, ?, 0)").run(sha, `${FP}/guest:aa`);
    }
    expect(await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:aa", { atts: shas.map((ref) => ({ kind: "talk", ref })) }))).toMatchObject({ ok: true });
    expect(listEvents(db, { target: "T1" }).find((e) => e.kind === "deliver")!.data.atts).toEqual(shas.slice(0, 9));
  });
  const teamOn = () => db.prepare("INSERT INTO meta (project, key, value) VALUES (?, 'team', ?)").run(P, JSON.stringify({ dispatcher: null, audit: true, sinceSeq: 1 }));
  test("开了班子：完成只留一条交付事件给班子路由，这里一次都不发，钩子重放也不发", async () => {
    teamOn();
    expect(await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:aa"))).toEqual({ ok: true, result: "done", notified: false });
    expect(await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:a2"))).toEqual({ ok: true, result: "done", notified: false });
    expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "deliver")).toHaveLength(1);
    expect(notices).toEqual([]);
  });
  test("开了班子：做不了不写交付、班子路由收不到，这里照样发", async () => {
    teamOn();
    await handleAssignedAnswer(deps(), ask("a1"), answer("assign_done", "guest:aa"));
    moveStage(db, PM, { taskId: "T1", from: "review", to: "fix" });
    expect(await handleAssignedAnswer(deps(), ask("a5", "assign:T1:1:1"), answer("assign_cant", "owner:self"))).toMatchObject({ ok: true, notified: true });
    expect(notices.map((n) => n.askId)).toEqual(["a5"]);
  });
});

/**
 * i28-A2 台账写入：收卡一个事务（重复 = duplicate，别的卡引用 = conflict，满 maxOpen = conflict，任何一步拒绝整体回滚）、
 * 只有调度身份 / 真 PM 能跑、asPm 与收卡专用 setWorkflow 只认 peer 卡、漂移在结论前不动、推送记录的幂等键、非 peer 卡行为不变。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { PEER_PR_CONFIG_PATH } from "../src/lib/peer-pr-config.ts";
import type { PeerPrGithub, PrState } from "../src/lib/peer-pr-github.ts";
import { intakeGithub } from "../src/manager/ledger-peer-pr-cmds.ts";
import { peerPrHeadMissing, peerPrHold, peerPrRepoDir } from "../src/lib/peer-pr-hold.ts";
import { getWorkflow } from "../src/lib/ledger-scheduler.ts";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.ts";
import { getTask, listTasks } from "../src/lib/ledger-store.ts";
import { createTask, moveStage } from "../src/lib/ledger-write.ts";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.ts";
import { poolTarget } from "../src/lib/scheduler-pool-plan.ts";
import type { PlannerSnapshot } from "../src/lib/scheduler-plan.ts";
import { statePath } from "../src/lib/paths.ts";
import { autoFixture } from "./scheduler-auto-helpers.ts";

const H1 = "a1".repeat(20), H2 = "b2".repeat(20);
const FP = "0a1b-2c3d-4e5f-6a7b";

/** GitHub as the intake CLI reads it: per-PR overrides on an open, same-repo, non-draft PR by a configured author. */
const views = new Map<number, Partial<PrState>>();
const gh: PeerPrGithub = {
  repo: async () => "o/r", listOpen: async () => [], files: async () => [{ path: "src/bridge.ts" }], body: async () => "b", fetchHead: async () => null,
  view: async (_r, n) => ({ state: "OPEN", url: `https://github.com/o/r/pull/${n}`, login: "He-Dev", title: "t", head: H1, base: "main",
    branch: "fix/x", crossRepo: false, headOwner: "o", draft: false, ...views.get(n) }),
};
const realGithub = intakeGithub.make;

beforeAll(() => {
  intakeGithub.make = () => gh;
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: statePath() } } }));
  writeFileSync(PEER_PR_CONFIG_PATH, JSON.stringify({ enabled: true, project: "p", fromNumber: 400, maxOpen: 2, replyTo: "agent-pm@me",
    peers: [{ peer: "he", fp: FP, agent: "agent-x", githubLogins: ["he-dev"], authorFamily: "codex" }] }));
});
afterAll(() => {
  intakeGithub.make = realGithub;
  rmSync(SCHEDULER_CONFIG_PATH, { force: true });
  rmSync(PEER_PR_CONFIG_PATH, { force: true });
});

const intakeArgs = (n: number, head = H1) => ["peer-pr-intake", "--project", "p", "--number", String(n), "--head", head];

describe("peer-pr-intake", () => {
  test("一个事务：security v2 auto、spec→restate→build→review、assignee 是 peer agent、执行者推成 delegate", async () => {
    const f = autoFixture();
    const r = await f.cli("scheduler", ...intakeArgs(401));
    expect(r).toMatchObject({ ok: true, task: { id: "PR401", stage: "review", round: 1 }, duplicate: false });
    const t = getTask(f.db, "PR401")!;
    expect(t).toMatchObject({ assigneeKind: "peer_agent", assignee: `${FP}/agent-x`, pm: "pm", headSHA: H1, pr: "https://github.com/o/r/pull/401" });
    expect(t.extra).toMatchObject({ delegate: "agent-x@he", peerPr: { peer: "he", login: "he-dev", surface: "security" } });
    expect(getWorkflow(f.db, "PR401")).toMatchObject({ template: "security", templateVersion: 2, mode: "auto", authorFamily: "codex" });
    expect(await f.cli("scheduler", ...intakeArgs(401))).toMatchObject({ ok: true, duplicate: true });
    f.close();
  });

  test("拒：别的身份、作者不在配置、base 不是 main、小于 fromNumber、maxOpen 满了；拒了不留半张卡", async () => {
    const f = autoFixture();
    expect(await f.cli("agent-task-one", ...intakeArgs(401))).toMatchObject({ ok: false, code: "forbidden" });
    for (const over of [{ login: "stranger" }, { base: "feat/x" }, { url: "https://github.com/o/r/pull/402" }]) {
      views.set(401, over);
      expect(await f.cli("scheduler", ...intakeArgs(401))).toMatchObject({ ok: false, code: "invalid" });
    }
    views.clear();
    expect(await f.cli("scheduler", ...intakeArgs(399))).toMatchObject({ ok: false, code: "invalid" });
    expect(getTask(f.db, "PR401")).toBeNull();
    await f.cli("scheduler", ...intakeArgs(401));
    await f.cli("scheduler", ...intakeArgs(402));
    expect(await f.cli("scheduler", ...intakeArgs(403))).toMatchObject({ ok: false, code: "conflict" });
    expect(listTasks(f.db, "p").map((t) => t.id).sort()).toEqual(["PR401", "PR402", "T1"]);
    f.close();
  });

  test("事实只认 GitHub：别的仓库、fork / 别人的 head 仓库、draft、已关、head 已变一律拒，不留卡也不留工作流", async () => {
    const f = autoFixture();
    const cases: Partial<PrState>[] = [{ url: "https://github.com/foreign/unrelated/pull/401" }, { crossRepo: true, headOwner: "fork" },
      { headOwner: "someone" }, { headOwner: null }, { draft: true }, { state: "CLOSED" }, { state: "MERGED" }, { head: H2 }];
    for (const over of cases) {
      views.set(401, over);
      expect(await f.cli("scheduler", ...intakeArgs(401))).toMatchObject({ ok: false, code: "invalid" });
      expect(await f.cli("pm", ...intakeArgs(401))).toMatchObject({ ok: false, code: "invalid" });
    }
    views.clear();
    expect(getTask(f.db, "PR401")).toBeNull();
    expect(getWorkflow(f.db, "PR401")).toBeNull();
    expect(await f.cli("scheduler", ...intakeArgs(401))).toMatchObject({ ok: true, surface: "security", task: { id: "PR401" } });
    f.close();
  });

  test("真 PM 也能手动收；台账里已有别的卡引用同一个 PR = conflict", async () => {
    const f = autoFixture();
    createTask(f.db, f.at("pm"), { project: "p", id: "T410", title: "手工卡", kind: "code", pr: "https://github.com/o/r/pull/411" });
    expect(await f.cli("pm", ...intakeArgs(411))).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.cli("pm", ...intakeArgs(412))).toMatchObject({ ok: true });
    f.close();
  });
});

describe("peer-pr-observe", () => {
  test("review 里结论没出不动；fix 里新 head = 以 peer 身份 deliver 进下一轮", async () => {
    const f = autoFixture();
    await f.cli("scheduler", ...intakeArgs(401));
    expect(await f.cli("scheduler", "peer-pr-observe", "PR401", "--head", H2)).toMatchObject({ ok: true, moved: false });
    expect(await f.cli("scheduler", "peer-pr-observe", "PR401", "--head", H1)).toMatchObject({ moved: false });
    moveStage(f.db, f.at("pm"), { taskId: "PR401", from: "review", to: "fix", text: "P1" });
    const r = await f.cli("scheduler", "peer-pr-observe", "PR401", "--head", H2);
    expect(r).toMatchObject({ ok: true, moved: true, task: { stage: "review", round: 2 } });
    expect(getTask(f.db, "PR401")!.headSHA).toBe(H2);
    expect(await f.cli("scheduler", "peer-pr-observe", "T1", "--head", H2)).toMatchObject({ ok: false, code: "invalid" });
    f.close();
  });
});

describe("peer-pr-push-record", () => {
  test("终态一个 key 只记一次；queued / notice 各自幂等；非 peer 卡拒", async () => {
    const f = autoFixture();
    await f.cli("scheduler", ...intakeArgs(401));
    const rec = (result: string, key = "review:9") => f.cli("scheduler", "peer-pr-push-record", "PR401", "--key", key, "--result", result, "--text", "x");
    expect(await rec("claimed")).toMatchObject({ ok: true, duplicate: false });
    expect(await rec("failed")).toMatchObject({ ok: true, duplicate: false });
    expect(await rec("sent")).toMatchObject({ duplicate: false });
    expect(await rec("refused")).toMatchObject({ duplicate: true });
    expect(await rec("notice", "late:x")).toMatchObject({ duplicate: false });
    expect(await rec("notice", "late:x")).toMatchObject({ duplicate: true });
    expect(await rec("bogus")).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.cli("scheduler", "peer-pr-push-record", "T1", "--key", "k", "--result", "sent", "--text", "x")).toMatchObject({ ok: false });
    expect(await f.cli("scheduler", "peer-pr-push-record", "-", "--project", "p", "--key", "cross:9", "--result", "notice", "--text", "x"))
      .toMatchObject({ ok: true });
    f.close();
  });
});

describe("钩子不碰非 peer 卡", () => {
  test("asPm 与收卡专用 setWorkflow 只认 peer 卡", () => {
    const f = autoFixture();
    expect(() => moveStage(f.db, f.at("agent-task-one"), { taskId: "T1", from: "spec", to: "restate", asPm: true })).toThrow();
    expect(() => setWorkflow(f.db, f.at("agent-task-one"), { taskId: "T1", taskRev: getTask(f.db, "T1")!.rev, template: "security", templateVersion: 2,
      mode: "auto", authorFamily: "claude", fallback: "x" }, true)).toThrow();
    f.close();
  });

  test("hold / repoDir / head 检查：非 peer 卡一律 null", async () => {
    const f = autoFixture();
    const t1 = getTask(f.db, "T1")!;
    expect(peerPrHold(f.db, t1)).toBeNull();
    expect(peerPrRepoDir(t1)).toBeNull();
    const git = async () => ({ code: 1, out: "" });
    expect(await peerPrHeadMissing(t1, H1, git)).toBeNull();
    await f.cli("scheduler", ...intakeArgs(401));
    const pr = getTask(f.db, "PR401")!;
    expect(peerPrRepoDir(pr)).toBe(statePath());
    expect(await peerPrHeadMissing(pr, H1, git)).toContain("不在本地仓库");
    expect(await peerPrHeadMissing(pr, H1, async () => ({ code: 0, out: "" }))).toBeNull();
    moveStage(f.db, f.at("pm"), { taskId: "PR401", from: "review", to: "fix", text: "P1" });
    expect(peerPrHold(f.db, getTask(f.db, "PR401")!)).toContain("fix");
    f.close();
  });
});

describe("peer 卡不挂池", () => {
  test("收进来的卡是 security 模板：池子开着、有空位也不派给池（W5 合并后复跑本条）", async () => {
    const f = autoFixture();
    await f.cli("scheduler", ...intakeArgs(401));
    const pool = { remote: { mode: "always", roles: ["review"] }, repo: "o/r", peers: [{ peer: "x", open: 0, maxOpen: 2 }], lastPeer: null, localReviewers: 0 };
    const snap = (workflow: unknown) => ({ task: getTask(f.db, "PR401")!, workflow, reviewer: null, intents: [], maxWorkers: 2, pool }) as unknown as PlannerSnapshot;
    const wf = getWorkflow(f.db, "PR401")!;
    expect(poolTarget(snap(wf), 0)).toBeNull();
    expect(poolTarget(snap({ ...wf, authorFamily: "claude" }), 0)).toBeNull();
    expect(poolTarget(snap({ ...wf, template: "code", authorFamily: "claude" }), 0)).not.toBeNull(); // the same snapshot as a code card would pool
    f.close();
  });
});

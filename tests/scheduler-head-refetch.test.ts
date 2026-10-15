/**
 * SELFHEAL1 验收线 4：PR head 本地缺 → 先有界 fetch refs/pull/N/head；取不到 → 撤这次派审、wait 并按 1/2/4…/30 分钟退避，
 * 连续 6 小时才退人工；退避只从台账读，重启后节奏延续。验收线 6：off 与改前一致。真台账 + 真 CLI（autoFixture），假时钟。
 */
import { describe, expect, test } from "bun:test";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { peerPrHeadMissing } from "../src/lib/peer-pr-hold.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { fetchHeadVia } from "../src/lib/scheduler-head-refetch-git.js";
import { headRefetch, headRefetchHold, refetchAttempts, refetchBackoffMs, REFETCH_GIVE_UP_MS } from "../src/lib/scheduler-head-refetch.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { prepareReviewHead } from "../src/lib/scheduler-review-head.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const MIN = 60_000;
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
const MISSING = `PR head ${H1.slice(0, 12)} 不在本地仓库（peer tick 还没取到，重取也没取到：refs/pull/7/head：x），不派审，交 PM`;

describe("共用的有界 fetch", () => {
  test("peerPrHeadMissing 判缺之前先取 refs/pull/<PR号>/head；取到就不缺，取不到原因里带重取结果；不给 net 照旧不取", async () => {
    const task = { id: "PR7", project: "p", assigneeKind: "peer_agent", assignee: "fp/agent-x",
      extra: { peerPr: { peer: "team", fp: "fp", agent: "agent-x", login: "x", url: "https://github.com/o/r/pull/7", base: "main", number: 7 } } } as unknown as LedgerTask;
    const read = () => ({ projects: { p: { repoDir: "/repo" } } }) as unknown as SchedulerConfig;
    let here = false;
    const calls: string[][] = [];
    const git = async (a: string[]) => ({ code: here ? 0 : 1, out: "" });
    const net = async (a: string[]) => { calls.push(a); here = true; return { code: 0, out: "" }; };
    expect(await peerPrHeadMissing(task, H1, git, read)).toContain("不在本地仓库");
    expect(calls).toEqual([]);
    expect(await peerPrHeadMissing(task, H1, git, read, net, policy("on"))).toBeNull();
    expect(calls).toEqual([["-C", "/repo", "fetch", "--no-tags", "-q", "origin", "refs/pull/7/head"]]);
    here = false;
    const down = async () => ({ code: 128, out: "fatal: couldn't find remote ref" });
    expect(await peerPrHeadMissing(task, H1, git, read, down, policy("on"))).toContain("重取也没取到：refs/pull/7/head：fatal");
  });

  test("off / observe：生产调用照样传 net，也不取（与改前一致：缺就交 PM）；策略每次现读", async () => {
    const task = { id: "PR7", project: "p", assigneeKind: "peer_agent", assignee: "fp/agent-x",
      extra: { peerPr: { peer: "team", fp: "fp", agent: "agent-x", login: "x", url: "https://github.com/o/r/pull/7", base: "main", number: 7 } } } as unknown as LedgerTask;
    const read = () => ({ projects: { p: { repoDir: "/repo" } } }) as unknown as SchedulerConfig;
    const calls: string[][] = [];
    let reads = 0;
    const git = async () => ({ code: 1, out: "" });
    const net = async (a: string[]) => { calls.push(a); return { code: 0, out: "" }; };
    for (const m of ["off", "observe"] as const) {
      const port: RecoveryPolicyPort = () => { reads++; return policy(m)("p", "selfHealBeforeManual"); };
      expect(await peerPrHeadMissing(task, H1, git, read, net, port)).toBe(`PR head ${H1.slice(0, 12)} 不在本地仓库（peer tick 还没取到），不派审，交 PM`);
    }
    expect(calls).toEqual([]);
    expect(reads).toBe(2);
  });

  test("fetchHeadVia：取到但不含该 commit 也算没取到", async () => {
    expect(await fetchHeadVia(async () => ({ code: 0, out: "" }), "/r", ["refs/pull/1/head"], async () => false))
      .toEqual(["refs/pull/1/head：取到了但不含该 commit（引用已移动？）"]);
  });

  test("退避 1、2、4、8… 分钟，最多 30 分钟", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => refetchBackoffMs(n) / MIN)).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });
});

describe("[验收线 4] 派审时 head 不在本地", () => {
  async function atReviewDispatch(mode: RecoveryMode) {
    const f = autoFixture();
    f.tickDeps.recoveryPolicy = policy(mode);
    await toBuild(f);
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    await f.tick(); // reviewer session
    f.refusePin(MISSING);
    return f;
  }
  const notes = (f: ReturnType<typeof autoFixture>) => refetchAttempts(listEvents(f.db, { project: "p", target: "T1" }), H1);

  test("off：与改前一致，直接退人工、不记重取", async () => {
    const f = await atReviewDispatch("off");
    try {
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("不在本地仓库") });
      expect(notes(f)).toEqual([]);
    } finally { f.close(); }
  });

  test("observe：照旧退人工，另记一条『本会自救』观察", async () => {
    const f = await atReviewDispatch("observe");
    try {
      expect(await f.tick()).toMatchObject({ step: "manual" });
      const obs = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe" && e.data.kind === "head_refetch");
      expect(obs).toHaveLength(1);
      expect(obs[0]!.text).toContain("本会 自救：PR head");
    } finally { f.close(); }
  });

  test("on：撤掉这次派审、卡留在 auto 等；按台账退避；连续 6 小时才退人工；换 head 从头算", async () => {
    const f = await atReviewDispatch("on");
    try {
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("PR head 还没取到，下一轮重取（第 1 次") });
      expect(getWorkflow(f.db, "T1")!.mode).toBe("auto");
      expect(f.intents().at(-1)).toMatchObject({ action: "review", status: "cancelled" });
      const first = notes(f)[0]!;
      expect(first.data).toMatchObject({ mode: "on", attempt: 1, head: H1 });
      // the hold is read from the ledger only: a fresh process sees the same rhythm
      expect(headRefetchHold(f.db, f.task(), first.ts + 30_000, policy("on"))).toContain("已取 1 次");
      expect(headRefetchHold(f.db, f.task(), first.ts + MIN, policy("on"))).toBeNull();
      expect(headRefetchHold(f.db, { ...f.task(), headSHA: "f".repeat(40) }, first.ts, policy("on"))).toBeNull();

      f.advance(MIN + 1);
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("第 2 次") });
      const second = notes(f)[1]!;
      expect(headRefetchHold(f.db, f.task(), second.ts + MIN, policy("on"))).toContain("已取 2 次"); // 2 minutes after the second miss
      expect(headRefetchHold(f.db, f.task(), second.ts + 2 * MIN, policy("on"))).toBeNull();

      f.advance(REFETCH_GIVE_UP_MS);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("连续 6 小时取不到") });
      expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
    } finally { f.close(); }
  });

  test("on 退避中切回 off / observe：下一轮立即不再按旧记录扣卡，退避只在 on 下生效", async () => {
    const f = await atReviewDispatch("on");
    try {
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      const first = notes(f)[0]!;
      expect(headRefetchHold(f.db, f.task(), first.ts + 30_000, policy("on"))).toContain("已取 1 次");
      expect(headRefetchHold(f.db, f.task(), first.ts + 30_000, policy("off"))).toBeNull();
      expect(headRefetchHold(f.db, f.task(), first.ts + 30_000, policy("observe"))).toBeNull();
      f.advance(31_000); // past the 30s dispatch backoff, still inside the 1-minute refetch backoff
      expect(await f.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("PR head 还没取到，下一轮重取") }); // the tick reads its policy
      f.tickDeps.recoveryPolicy = policy("off"); // rollback mid-backoff: the old manual path, right away
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("不在本地仓库") });
      expect(notes(f)).toHaveLength(1);
    } finally { f.close(); }
  });

  test("取到了（重取成功）就照常派审", async () => {
    const f = await atReviewDispatch("on");
    try {
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      f.refusePin(null);
      f.advance(MIN + 1);
      expect(await f.tick()).toMatchObject({ step: "sent" });
    } finally { f.close(); }
  });

  test("别的派审拒绝原因（如审查目录被改过）照旧退人工", async () => {
    const f = await atReviewDispatch("on");
    try {
      f.refusePin("审查 worktree 有已跟踪文件被改过（审查员不该改被审代码），不取远端、不覆盖：M x");
      expect(await f.tick()).toMatchObject({ step: "manual" });
      expect(notes(f)).toEqual([]);
    } finally { f.close(); }
  });
});

describe("[验收线 4] peer PR 首次派审（还没有审查 session，走 createReviewer → prepareReviewHead）", () => {
  const peer = { id: "PR7", project: "p", stage: "review", round: 1, headSHA: H1, assigneeKind: "peer_agent", assignee: "fp/agent-x",
    extra: { peerPr: { peer: "team", fp: "fp", agent: "agent-x", login: "x", url: "https://github.com/o/r/pull/7", base: "main", number: 7 } } } as unknown as LedgerTask;
  const readConfig = () => ({ projects: { p: { repoDir: "/repo" } } }) as unknown as SchedulerConfig;
  const card = (db: ReturnType<typeof autoFixture>["db"]) => ({ db, task: peer,
    deps: { manager: async () => ({ ok: true }), now: () => Date.now(), recoveryPolicy: policy("on") } });

  test("建审查目录前先取 refs/pull/<PR号>/head；取到就照常建（返回 null）", async () => {
    const f = autoFixture();
    try {
      let here = false;
      const calls: string[][] = [];
      const env = { db: f.db, readConfig, recoveryPolicy: policy("on"),
        git: async () => ({ code: here ? 0 : 1, out: "" }),
        net: async (a: string[]) => { calls.push(a); here = true; return { code: 0, out: "" }; } };
      expect(await prepareReviewHead(env, peer, H1, "/repo", false)).toBeNull(); // 改前：直接 null、不取，建 worktree 时才在缺 commit 上失败
      expect(calls).toEqual([["-C", "/repo", "fetch", "--no-tags", "-q", "origin", "refs/pull/7/head"]]);
    } finally { f.close(); }
  });

  test("取不到 → 返回已分类的缺 head 原因，headRefetch 认得、转成 wait 退避（不再是通用的『建审查 worktree 失败』直接退人工）", async () => {
    const f = autoFixture();
    try {
      const env = { db: f.db, readConfig, recoveryPolicy: policy("on"), git: async () => ({ code: 1, out: "" }),
        net: async () => ({ code: 128, out: "fatal: couldn't find remote ref" }) };
      const reason = await prepareReviewHead(env, peer, H1, "/repo", false);
      expect(reason).toContain(`PR head ${H1.slice(0, 12)} 不在本地仓库`);
      expect(reason).toContain("重取也没取到：refs/pull/7/head：fatal");
      expect(await headRefetch(card(f.db), reason!)).toMatchObject({ wait: expect.stringContaining("PR head 还没取到，下一轮重取（第 1 次") });
    } finally { f.close(); }
  });

  test("off：首次派审也不取，原因照旧是缺 head（交 PM）", async () => {
    const f = autoFixture();
    try {
      const calls: string[][] = [];
      const env = { db: f.db, readConfig, recoveryPolicy: policy("off"), git: async () => ({ code: 1, out: "" }),
        net: async (a: string[]) => { calls.push(a); return { code: 0, out: "" }; } };
      expect(await prepareReviewHead(env, peer, H1, "/repo", false)).toBe(`PR head ${H1.slice(0, 12)} 不在本地仓库（peer tick 还没取到），不派审，交 PM`);
      expect(calls).toEqual([]);
    } finally { f.close(); }
  });
});

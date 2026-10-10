/**
 * i28-PUB1 A 侧：出借开工单推上去了、交付却一直停在 publishing 时由借入方接管。beatLend 记 phase 起点（since）；
 * 调度步骤（lendTakeoverStep）只在 publishing ≥5 分钟、远端 head 是订单起点的严格后代、连续两轮同一个 head 时动：没有开着的 PR 就代开一次，
 * 再经 `ledger lend-takeover`（调度身份，进程内 runLedger）把交付记上——卡进 review、出借单 done（作者家族按出借单）、B 迟到的交付被拒。
 * 反例：已有 PR 就用它、修复单 / 不到 5 分钟 / 不是严格后代 / head 两轮不同 / 单已不归出借方 → 不开、不接管。gh 与远端 head 都是假的。
 * 建审查目录的回退（lendReviewDir）在末尾。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { getLendOrder, listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { beatLend } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { lendTakeoverStep, TAKEOVER_AFTER_MS, type GhAnswer, type TakeoverGh } from "../src/lib/lend-pr-takeover.js";
import { lendReviewDir } from "../src/lib/lend-pr-takeover-review.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { runLedger } from "../src/manager/ledger.js";
import { takeoverDeps } from "../src/manager/ledger-lend-takeover-cmds.js";

const P = "claude-orchestrator";
const BASE = "b".repeat(40);
const H2 = "c".repeat(40);
const H3 = "d".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const MIN = 60_000;
let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
const dir = mkdtempSync(join(tmpdir(), "lend-takeover-test-"));
const key = instanceKeySync(dir);
const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];

const remoteHead = async (_repo: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" };
const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow, notifyPm: async () => {},
    result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead, peerFp: async (peer: string) => (peer === "mate" ? FP : null) },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const deliverBody = (orderId: string, head: string) => ({ v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "sess-1", family: "codex" },
  deliver: { v: 1, orderId, head, evidence: BR, summary: "实现了 x", selfCheck: "逐条对了" } });

/** 假 gh：远端 head 跟着 remote 走；compare 默认 ahead；openPr / createPr 可设 */
function fakeGh(o: { compare?: string; open?: number | null } = {}) {
  const log = { created: [] as { title: string; body: string; base: string; branch: string }[], compared: [] as string[] };
  const gh: TakeoverGh = {
    head: remoteHead,
    compare: async (_r, base, head): Promise<GhAnswer<string>> => (log.compared.push(`${base.slice(0, 1)}...${head.slice(0, 1)}`), { ok: true, value: o.compare ?? "ahead" }),
    openPr: async (): Promise<GhAnswer<number | null>> => ({ ok: true, value: o.open ?? null }),
    createPr: async (p): Promise<GhAnswer<number>> => (log.created.push(p), { ok: true, value: 377 }),
  };
  return { gh, log };
}

const seen = new Map<string, string>();
const step = (gh: TakeoverGh) => lendTakeoverStep(db, { gh, now: () => now, seen, manager: (...a: string[]) => run(a.slice(1), "scheduler") });

/** 挂开工单 → mate 领走；返回单号 */
async function claimed(): Promise<string> {
  const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  expect(await call("claim", { v: 1, orderId, worker: "agent-lend-0123456789" })).toMatchObject({ ok: true });
  return orderId;
}

const beat = (orderId: string, phase = "publishing") =>
  beatLend(db, { actor: "owner", now }, "mate", { v: 1, orders: [{ orderId, gen: 1, phase, lastActivityAt: 0, excerpt: "开 PR 失败：HTTP 502", ended: null }] } as never, new Map());
const beatOf = (orderId: string) => JSON.parse((db.query("SELECT beat FROM lend_orders WHERE orderId = ?").get(orderId) as { beat: string }).beat);

/** 卡住的单：领走、推上 H2、心跳停在 publishing 已 6 分钟（中间心跳照常续租） */
async function stuck(head = H2): Promise<string> {
  const id = await claimed();
  remote[BR] = { ok: true, head };
  beat(id);
  now += 3 * MIN;
  beat(id);
  now += 3 * MIN;
  beat(id);
  return id;
}

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  remote = { main: { ok: true, head: BASE } };
  seen.clear();
  takeoverDeps.make = () => ({ remoteHead, uiPort: () => ({
    mode: () => ({ mode: "off" }), observe: () => { throw new Error("off must not observe"); },
    get roots(): never { throw new Error("off must not read artifact roots"); },
  }) });
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
});
afterEach(() => closeLedger(":memory:"));

describe("UI 接管交付闸", () => {
  const policyPath = join(dir, "ui-policy.json");
  const configure = (mode: string, template = "ui") => {
    writeFileSync(policyPath, JSON.stringify({ projects: { [P]: { keys: { uiDelivery: mode } } } }));
    db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES ('T9', ?, ?, 3, 'manual', 'codex', '', 1, 1, 1)`, [P, template]);
    takeoverDeps.make = () => ({ remoteHead,
      uiPort: (peer: { peer: string; worker: string; orderId: string }) => uiDeliverPort({ peer, root: join(dir, "artifacts"), policyPath, now }) });
  };
  const snapshot = () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]));
  };
  test("takeover-bypass: on UI 无截图拒绝且逐表零业务写", async () => {
    configure("on");
    const id = await stuck();
    const before = snapshot();
    expect(await run(["lend-takeover", id, "--head", H2, "--pr", "5"], "scheduler"))
      .toMatchObject({ ok: false, code: "invalid" });
    expect(snapshot()).toBe(before);
  });
  for (const mode of ["observe", "off", "on"]) {
    test(`${mode}: ${mode === "on" ? "非UI" : "UI"} 保持接管与重放`, async () => {
      configure(mode, mode === "on" ? "code" : "ui");
      const id = await stuck();
      const args = ["lend-takeover", id, "--head", H2, "--pr", "5"];
      expect(await run(args, "scheduler")).toMatchObject({ ok: true, duplicate: false });
      expect(getTask(db, "T9")).toMatchObject({ stage: "review", headSHA: H2 });
      expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
      const observed = listEvents(db, { target: "T9" }).filter((e) => JSON.stringify(e.data).includes("uiDelivery"));
      expect(observed).toHaveLength(mode === "observe" ? 1 : 0);
      const before = snapshot();
      expect(await run(args, "scheduler")).toMatchObject({ ok: true, duplicate: true });
      expect(snapshot()).toBe(before);
    });
  }
});

describe("beat 记 phase 起点", () => {
  test("phase 不变 since 沿用，换了 phase 从那一刻重算", async () => {
    const id = await claimed();
    beat(id, "working");
    now += MIN;
    beat(id);
    const since = beatOf(id).since;
    expect(since).toBe(now);
    now += 2 * MIN;
    beat(id);
    expect(beatOf(id)).toMatchObject({ phase: "publishing", since });
    expect(beatOf(id).excerpt).toContain("HTTP 502");
    now += MIN;
    beat(id, "working");
    expect(beatOf(id).since).toBe(now);
  });
});

describe("接管：条件全满足", () => {
  test("连续两轮同一 head → 代开一次 PR、记交付：卡进 review、出借单 done、作者家族按出借单、写租约保留；下一轮不再动", async () => {
    const id = await stuck();
    const { gh, log } = fakeGh();
    expect((await step(gh)).failed).toEqual([]);
    expect(log.created).toEqual([]); // 第一次看到这个 head：等一轮
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    expect((await step(gh)).failed).toEqual([]);
    expect(log.created).toHaveLength(1);
    expect(log.created[0]).toMatchObject({ base: "main", branch: BR, title: "T9：出借实现（第 0 轮）" });
    expect(log.created[0]!.body).toContain("出借方开 PR 未成功，借入方代开");
    expect(log.compared).toEqual(["b...c"]);
    const t = getTask(db, "T9")!;
    expect(t).toMatchObject({ stage: "review", branch: BR, headSHA: H2, pr: `https://github.com/${REPO}/pull/377` });
    const o = getLendOrder(db, id)!;
    expect(o.status).toBe("done");
    const deliver = listEvents(db, { target: "T9" }).filter((e) => e.kind === "deliver");
    expect(deliver).toHaveLength(1);
    expect(deliver[0]!.text).toContain("出借方交付通道失败，借入方按已推送分支接管");
    expect(o.eventSeq).toBe(deliver[0]!.seq);
    expect(remoteHeadFamily(db, t)).toBe("codex");
    expect(getWriteLease(db, "T9")).toMatchObject({ peer: "mate", state: "held" });
    const notes = listEvents(db, { target: "T9" }).filter((e) => e.kind === "note" && (e.data.lend as { op?: string } | undefined)?.op === "takeover");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.dedupKey).toBe(`lend-takeover:${id}`);
    now += MIN;
    await step(gh);
    await step(gh);
    expect(log.created).toHaveLength(1);
    expect(listEvents(db, { target: "T9" }).filter((e) => e.kind === "deliver")).toHaveLength(1);
  });

  test("B 迟到的交付被拒（这一单已撤销）、续租回 done；同一接管重放幂等", async () => {
    const id = await stuck();
    const { gh } = fakeGh();
    await step(gh);
    await step(gh);
    const late = await call("write", deliverBody(id, H2));
    expect(late).toMatchObject({ ok: false });
    expect(String(late.error)).toContain("已撤销");
    const renew = await call("lease", { v: 1, orderId: id, gen: 1, action: "renew", reason: null, detail: null });
    expect(renew).toMatchObject({ ok: false });
    const again = await run(["lend-takeover", id, "--head", H2, "--pr", "377"], "scheduler");
    expect(again).toMatchObject({ ok: true, duplicate: true });
  });

  test("分支上已有开着的 PR（PM / B 开的）→ 用它，不再开", async () => {
    await stuck();
    const { gh, log } = fakeGh({ open: 363 });
    await step(gh);
    await step(gh);
    expect(log.created).toEqual([]);
    expect(getTask(db, "T9")).toMatchObject({ stage: "review", pr: `https://github.com/${REPO}/pull/363` });
  });
});

describe("接管：反例（不开 PR、不接管）", () => {
  const untouched = (id: string, log: ReturnType<typeof fakeGh>["log"]) => {
    expect(log.created).toEqual([]);
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    expect(getTask(db, "T9")!.stage).toBe("build");
  };

  test("publishing 不到 5 分钟", async () => {
    const id = await claimed();
    remote[BR] = { ok: true, head: H2 };
    beat(id);
    now += TAKEOVER_AFTER_MS - 1;
    beat(id);
    const { gh, log } = fakeGh();
    for (let i = 0; i < 3; i++) await step(gh);
    untouched(id, log);
  });

  test("心跳不在 publishing（还在写）", async () => {
    const id = await claimed();
    remote[BR] = { ok: true, head: H2 };
    beat(id, "working");
    now += 10 * MIN;
    beat(id, "working");
    const { gh, log } = fakeGh();
    for (let i = 0; i < 3; i++) await step(gh);
    untouched(id, log);
  });

  test("远端 head 不是订单起点的严格后代（分叉 / 改写）", async () => {
    const id = await stuck();
    const { gh, log } = fakeGh({ compare: "diverged" });
    for (let i = 0; i < 3; i++) await step(gh);
    untouched(id, log);
  });

  test("远端分支还停在订单起点（没有新提交）", async () => {
    const id = await stuck(BASE);
    const { gh, log } = fakeGh();
    for (let i = 0; i < 3; i++) await step(gh);
    untouched(id, log);
    expect(log.compared).toEqual([]);
  });

  test("两轮看到的 head 不同（B 还在推）→ 这轮不接管，下一轮同一个才接", async () => {
    const id = await stuck();
    const { gh, log } = fakeGh();
    await step(gh);
    remote[BR] = { ok: true, head: H3 };
    await step(gh);
    untouched(id, log);
    await step(gh);
    expect(getTask(db, "T9")).toMatchObject({ stage: "review", headSHA: H3 });
  });

  test("单已不归出借方（PM 撤单）→ 不接管；CLI 直接调也拒", async () => {
    const id = await stuck();
    const { gh, log } = fakeGh();
    await step(gh);
    expect(await run(["lend-cancel", "T9", "--reason", "PM 撤"])).toMatchObject({ ok: true });
    await step(gh);
    expect(log.created).toEqual([]);
    expect(getTask(db, "T9")!.stage).toBe("build");
    expect(await run(["lend-takeover", id, "--head", H2, "--pr", "5"], "scheduler")).toMatchObject({ ok: false, code: "conflict" });
  });

  test("修复单（订单本来带 PR 号）不在接管范围", async () => {
    const id = await stuck();
    db.run("UPDATE lend_orders SET pr = 7 WHERE orderId = ?", [id]);
    const { gh, log } = fakeGh();
    for (let i = 0; i < 3; i++) await step(gh);
    untouched(id, log);
    expect(await run(["lend-takeover", id, "--head", H2, "--pr", "7"], "scheduler")).toMatchObject({ ok: false, code: "invalid" });
  });

  test("查 GitHub 期间 PM 撤了单 → 不代开 PR（开 PR 前重读台账）", async () => {
    const id = await stuck();
    const { gh, log } = fakeGh();
    await step(gh);
    gh.openPr = async () => {
      expect(await run(["lend-cancel", "T9", "--reason", "PM 撤"])).toMatchObject({ ok: true });
      return { ok: true, value: null };
    };
    expect((await step(gh)).failed).toEqual([]);
    expect(log.created).toEqual([]);
    expect(getLendOrder(db, id)!.status).toBe("cancelled");
    expect(getTask(db, "T9")!.stage).toBe("build");
  });

  test("CLI 查远端期间出借单租约到期 → 按实时钟拒，不记交付", async () => {
    const id = await stuck();
    const until = getLendOrder(db, id)!.leaseUntil!;
    takeoverDeps.make = () => ({ remoteHead: async (r, b) => ((now = until + 1), remoteHead(r, b)) });
    expect(await run(["lend-takeover", id, "--head", H2, "--pr", "5"], "scheduler")).toMatchObject({ ok: false, code: "conflict" });
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    expect(getTask(db, "T9")!.stage).toBe("build");
    expect(listEvents(db, { target: "T9" }).filter((e) => e.kind === "deliver")).toEqual([]);
  });

  test("CLI 查远端期间调度服务失租 → 事务里写之前再核，lease-lost、什么都不写", async () => {
    const id = await stuck();
    let owned = true;
    takeoverDeps.make = () => ({ remoteHead: async (r, b) => ((owned = false), remoteHead(r, b)) });
    const assertLease = () => {
      if (!owned) throw new SchedulerLeaseLost("服务租约已被接走");
    };
    const before = listEvents(db, { target: "T9" }).length;
    const out = (await runLedger(["lend-takeover", id, "--head", H2, "--pr", "5"], { ...deps("scheduler"), assertLease })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: false, code: "lease-lost" });
    expect(getLendOrder(db, id)!.status).toBe("claimed");
    expect(getTask(db, "T9")).toMatchObject({ stage: "build", branch: null });
    expect(listEvents(db, { target: "T9" })).toHaveLength(before);
  });

  test("CLI 自己核远端：调用方给的 head 和远端对不上就拒；非调度身份要真 PM", async () => {
    const id = await stuck();
    expect(await run(["lend-takeover", id, "--head", H3, "--pr", "5"], "scheduler")).toMatchObject({ ok: false, code: "conflict" });
    expect(await run(["lend-takeover", id, "--head", H2, "--pr", "5"], "agent-dev")).toMatchObject({ ok: false, code: "forbidden" });
    expect(listLendOrders(db, "T9")[0]!.status).toBe("claimed");
  });
});

describe("建审查目录的回退（lendReviewDir）", () => {
  const cfg = (repoDir = "/repos/claudestra") => () => ({ projects: { [P]: { repoDir } } }) as unknown as SchedulerConfig;
  test("出借方写的卡：退到项目 repoDir；head 不在本机先拉出借分支再核", async () => {
    await stuck();
    const { gh } = fakeGh();
    await step(gh);
    await step(gh);
    const calls: string[] = [];
    let fetched = false;
    const git = async (args: string[]) => {
      calls.push(args.slice(2).join(" "));
      if (args[2] === "fetch") fetched = true;
      return { code: args[2] === "cat-file" && !fetched ? 1 : 0, out: "" };
    };
    expect(await lendReviewDir(db, getTask(db, "T9")!, git, cfg())).toBe("/repos/claudestra");
    expect(calls).toEqual([`cat-file -e ${H2}^{commit}`, `fetch --no-tags -q origin refs/heads/${BR}`, `cat-file -e ${H2}^{commit}`]);
  });

  test("本机执行者写的卡不回退（照旧交 PM）", async () => {
    db.run(`UPDATE tasks SET headSHA = '${H2}', branch = 'feat/x' WHERE id = 'T9'`);
    const git = async () => ({ code: 0, out: "" });
    expect(await lendReviewDir(db, getTask(db, "T9")!, git, cfg())).toBeNull();
  });
});

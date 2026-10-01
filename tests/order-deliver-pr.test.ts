/** i28-M8 deliver 按分支查 PR、自动登记完整 PR URL：gh 输出严格解析、挑 PR 的每种拒绝、同一事务写 task.pr / 不覆盖别的完整 URL */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.ts";
import { setMeta } from "../src/lib/ledger-write.ts";
import { deliverOrder, type RemoteHead } from "../src/lib/order-deliver.ts";
import { deliverPrPatch, findPrRows, fullPrUrl, parseGhPrList, pickPr, prConflict, type PrRow, type PrRows } from "../src/lib/order-deliver-pr.ts";
import type { LedgerRun } from "../src/lib/order-ledger-exit.ts";
import type { VerifiedCall } from "../src/lib/order-tool-route.ts";
import type { BoundedResult } from "../src/lib/run-bounded.ts";
import type { Registry } from "../src/manager/core.ts";
import { runLedger } from "../src/manager/ledger.ts";

const PROJ = "p1";
const LEAD = "agent-lead";
const DEV = "agent-task-m8";
const SHA = "c".repeat(40);
const SHA_B = "d".repeat(40);
const URL1 = "https://github.com/o/r/pull/7";
const URL2 = "https://github.com/o/r/pull/8";
const row = (o: Partial<PrRow> = {}): PrRow => ({ url: URL1, headRefOid: SHA, baseRefName: "main", isCrossRepository: false, ...o });
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });

describe("parseGhPrList：严格解析", () => {
  test("正常数组 → rows；空数组 → 空 rows", () => {
    expect(parseGhPrList(ok(JSON.stringify([row()])))).toEqual({ ok: true, rows: [row()] });
    expect(parseGhPrList(ok("[]"))).toEqual({ ok: true, rows: [] });
  });

  test("超时 / 非零退出 / 不是 JSON / 不是数组 / 字段缺 / 多字段 / 类型不对 / 有一行坏 → 失败", () => {
    const bad: BoundedResult[] = [
      { code: null, stdout: "", stderr: "", timedOut: true },
      { code: 1, stdout: "", stderr: "no git remotes found", timedOut: false },
      ok("not json"), ok("{}"), ok("null"),
      ok(JSON.stringify([{ url: URL1, headRefOid: SHA, baseRefName: "main" }])),
      ok(JSON.stringify([{ ...row(), title: "x" }])),
      ok(JSON.stringify([{ ...row(), isCrossRepository: "false" }])),
      ok(JSON.stringify([{ ...row(), headRefOid: 1 }])),
      ok(JSON.stringify([row(), null])),
    ];
    for (const r of bad) expect(parseGhPrList(r).ok).toBe(false);
  });
});

describe("findPrRows：argv 与参数注入", () => {
  test("在 cwd 跑 gh pr list --head <branch> --state open，关交互、15 秒超时", async () => {
    const seen: { argv: string[]; o: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number } }[] = [];
    const r = await findPrRows("/w", "feat/x", async (argv, o) => (seen.push({ argv, o }), ok("[]")));
    expect(r).toEqual({ ok: true, rows: [] });
    expect(seen[0].argv).toEqual(["gh", "pr", "list", "--head", "feat/x", "--state", "open", "--json", "url,headRefOid,baseRefName,isCrossRepository"]);
    expect(seen[0].o).toMatchObject({ cwd: "/w", timeoutMs: 15_000 });
    expect(seen[0].o.env?.GH_PROMPT_DISABLED).toBe("1");
  });

  test("没有 cwd、分支名像选项 / 带 .. / 带空白或 shell 字符 → 拒，不跑 gh", async () => {
    let ran = 0;
    const run = async () => (ran++, ok("[]"));
    expect((await findPrRows(undefined, "feat/x", run)).ok).toBe(false);
    for (const b of ["--repo=evil/x", "-x", "a..b", "a b", "a;rm", "$(x)", ""]) expect((await findPrRows("/w", b, run)).ok).toBe(false);
    expect(ran).toBe(0);
  });
});

describe("pickPr / fullPrUrl / prConflict", () => {
  test("恰好一个、同仓、base main、head 一致 → 通过，URL 去掉末尾斜杠", () => {
    expect(pickPr([row()], "feat/x", SHA)).toEqual({ ok: true, url: URL1 });
    expect(pickPr([row({ url: `${URL1}/` })], "feat/x", SHA)).toEqual({ ok: true, url: URL1 });
  });

  test("0 个 / 多个 / 跨仓 / base 不对 / head 不一致 / URL 不完整 → 各自的拒绝码", () => {
    expect(pickPr([], "feat/x", SHA)).toMatchObject({ ok: false, code: "pr_missing" });
    expect(pickPr([], "feat/x", SHA)).toMatchObject({ error: expect.stringContaining("先开 PR") });
    expect(pickPr([row(), row({ url: URL2 })], "feat/x", SHA)).toMatchObject({ ok: false, code: "pr_ambiguous" });
    expect(pickPr([row({ isCrossRepository: true })], "feat/x", SHA)).toMatchObject({ ok: false, code: "pr_invalid" });
    expect(pickPr([row({ baseRefName: "dev" })], "feat/x", SHA)).toMatchObject({ ok: false, code: "pr_invalid" });
    expect(pickPr([row({ headRefOid: SHA_B })], "feat/x", SHA)).toMatchObject({ ok: false, code: "pr_head_mismatch" });
    for (const url of ["306", "#306", "http://github.com/o/r/pull/7", "https://github.com/o/r/pull/7?x", "https://evil.com/o/r/pull/7", "https://github.com/o/../pull/7", "https://github.com/o/r/pull/0"]) {
      expect(pickPr([row({ url })], "feat/x", SHA)).toMatchObject({ ok: false, code: "pr_invalid" });
    }
  });

  test("只有已有的完整 URL 和查到的不同才算冲突", () => {
    expect(fullPrUrl(`${URL1}/`)).toBe(URL1);
    expect(fullPrUrl("306")).toBeNull();
    expect(prConflict(null, URL1)).toBe(false);
    expect(prConflict("306", URL1)).toBe(false);
    expect(prConflict(`${URL1}/`, URL1)).toBe(false);
    expect(prConflict(URL2, URL1)).toBe(true);
  });

  test("deliverPrPatch：不带 → 不动；非完整 → invalid；空 / 非完整的旧值 → 写；相同 → 不动；不同 → conflict", () => {
    const t = (pr: string | null) => ({ id: "M8", pr });
    expect(deliverPrPatch(t(null), undefined)).toEqual({});
    expect(() => deliverPrPatch(t(null), "306")).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(deliverPrPatch(t(null), URL1)).toEqual({ pr: URL1 });
    expect(deliverPrPatch(t("#7"), `${URL1}/`)).toEqual({ pr: URL1 });
    expect(deliverPrPatch(t(URL1), URL1)).toEqual({});
    expect(() => deliverPrPatch(t(URL2), URL1)).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

// ── deliverOrder 与 CLI：内存台账，写入走进程内的真实 ledger CLI ──

let db: Database;
const writes: string[][] = [];
const channels: Record<string, string> = { "c-lead": LEAD, "c-dev": DEV };
const ledger = (actor: string, ...args: string[]) => {
  const reg = { socket: "", agents: { [LEAD]: { status: "active", projectId: PROJ }, [DEV]: { status: "active", projectId: PROJ } } } as unknown as Registry;
  return runLedger(args, { db, actor, actorProject: PROJ, projectIds: [PROJ], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<
    Record<string, any>
  >;
};
const viaCli: LedgerRun = (args, ch) => (writes.push(args), ledger(channels[ch] ?? "unknown", ...args.slice(1)));
const me: VerifiedCall = { agent: DEV, sessionId: "s1", family: "claude-code", channelId: "c-dev" };
const order = { v: 1, orderId: "M8:write:r0", head: SHA, evidence: "docs/tasks/M8.report.md", summary: "交付", selfCheck: "过" };
const prs = (rows: PrRow[] | null) => async (): Promise<PrRows> => (rows ? { ok: true, rows } : { ok: false, error: "gh pr list 超时" });
const at = async (): Promise<RemoteHead> => ({ ok: true, head: SHA });
const card = () => getTask(db, "M8")!;
const setPr = (pr: string) => ledger(LEAD, "task-set", "M8", "--rev", String(card().rev), "--pr", pr);

beforeEach(async () => {
  writes.length = 0;
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: 1 }, { project: PROJ, key: "pms", value: [LEAD] });
  await ledger(LEAD, "item-new", "i9", "--title", "底座");
  expect(await ledger(LEAD, "task-new", "M8", "--title", "登记 PR", "--kind", "code", "--item", "i9", "--agent", "task-m8", "--branch", "feat/m8")).toMatchObject({ ok: true });
  await ledger(DEV, "stage", "M8", "--from", "spec", "--to", "restate");
  await ledger(LEAD, "stage", "M8", "--from", "restate", "--to", "build");
});
afterEach(() => closeLedger(":memory:"));

describe("deliverOrder 查 PR", () => {
  test("成功：完整 URL 与 head 同一笔写进台账，阶段到 review", async () => {
    expect(await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: prs([row()]) })).toMatchObject({ ok: true, stage: "review" });
    expect(card()).toMatchObject({ stage: "review", headSHA: SHA, pr: URL1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`--pr=${URL1}`);
  });

  test("每种拒绝：gh 失败 / 0 个 / 多个 / 跨仓 / base 不对 / head 不一致 / URL 不完整 → 拒，台账一个字都不写", async () => {
    const before = listEvents(db, { project: PROJ, target: "M8" }).length;
    const cases: [PrRow[] | null, string][] = [
      [null, "pr_unverifiable"], [[], "pr_missing"], [[row(), row({ url: URL2 })], "pr_ambiguous"], [[row({ isCrossRepository: true })], "pr_invalid"],
      [[row({ baseRefName: "release" })], "pr_invalid"], [[row({ headRefOid: SHA_B })], "pr_head_mismatch"], [[row({ url: "306" })], "pr_invalid"],
    ];
    for (const [rows, code] of cases) expect(await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: prs(rows) })).toMatchObject({ ok: false, code });
    expect(writes).toEqual([]);
    expect(listEvents(db, { project: PROJ, target: "M8" }).length).toBe(before);
    expect(card()).toMatchObject({ stage: "build", headSHA: null, pr: null });
  });

  test("远端 head 不一致时不查 PR（顺序：head 核对在前）", async () => {
    let asked = 0;
    const findPr = async (): Promise<PrRows> => (asked++, { ok: true, rows: [row()] });
    expect(await deliverOrder(me, order, { db, run: viaCli, remoteHead: async () => ({ ok: true, head: SHA_B }), findPr })).toMatchObject({ code: "head_mismatch" });
    expect(asked).toBe(0);
  });

  test("卡上是非完整的旧值（306）→ 换成完整 URL", async () => {
    await setPr("306");
    expect(await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: prs([row()]) })).toMatchObject({ ok: true });
    expect(card()).toMatchObject({ stage: "review", pr: URL1 });
  });

  test("卡上已是同一个完整 URL → 交付通过，pr 不变", async () => {
    await setPr(URL1);
    expect(await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: prs([row({ url: `${URL1}/` })]) })).toMatchObject({ ok: true });
    expect(card()).toMatchObject({ stage: "review", pr: URL1 });
  });

  test("卡上已是另一个完整 URL → pr_mismatch，不覆盖、不写", async () => {
    await setPr(URL2);
    writes.length = 0;
    expect(await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: prs([row()]) })).toMatchObject({ ok: false, code: "pr_mismatch" });
    expect(writes).toEqual([]);
    expect(card()).toMatchObject({ stage: "build", pr: URL2, headSHA: null });
  });

  test("查 PR 之后、写入之前 PM 填了另一个完整 URL → CLI 在事务里拒，不覆盖", async () => {
    const racing = async (): Promise<PrRows> => (await setPr(URL2), { ok: true, rows: [row()] });
    expect(await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: racing })).toMatchObject({ ok: false, code: "conflict" });
    expect(card()).toMatchObject({ stage: "build", pr: URL2, headSHA: null });
  });

  test("同一单 + head 重试回放不受影响：第二次 gh 查不到也按第一次的结果返回", async () => {
    const first = await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: prs([row()]) });
    const again = await deliverOrder(me, order, { db, run: viaCli, remoteHead: at, findPr: prs([]) });
    expect(again as object).toEqual({ ...(first as object), duplicate: true });
    expect(writes).toHaveLength(1);
  });
});

describe("ledger deliver --pr（CLI 事务）", () => {
  test("不带 --pr 和以前一样：不碰 task.pr", async () => {
    await setPr("306");
    expect(await ledger(DEV, "deliver", "M8", "--from", "build", "--head", SHA)).toMatchObject({ ok: true });
    expect(card()).toMatchObject({ stage: "review", pr: "306" });
  });

  test("--pr 不是完整 URL → invalid；卡上已是另一个完整 URL → conflict；都不写", async () => {
    expect(await ledger(DEV, "deliver", "M8", "--from", "build", "--head", SHA, "--pr", "306")).toMatchObject({ ok: false, code: "invalid" });
    await setPr(URL2);
    expect(await ledger(DEV, "deliver", "M8", "--from", "build", "--head", SHA, "--pr", URL1)).toMatchObject({ ok: false, code: "conflict" });
    expect(card()).toMatchObject({ stage: "build", pr: URL2, headSHA: null });
    expect(listEvents(db, { project: PROJ, target: "M8" }).filter((e) => e.kind === "deliver")).toEqual([]);
  });
});

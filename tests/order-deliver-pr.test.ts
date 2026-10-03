/** i28-M8 deliver 按分支查 PR、自动登记完整 PR URL：gh 输出严格解析、挑 PR 的每种拒绝、同一事务写 task.pr / 不覆盖别的完整 URL */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.ts";
import { setMeta } from "../src/lib/ledger-write.ts";
import { deliverOrder, type RemoteHead } from "../src/lib/order-deliver.ts";
import { deliverPrPatch, findPrRows, fullPrUrl, parseGhPrList, parseOriginRepo, pickPr, prConflict, prInRepo, type PrRow, type PrRows } from "../src/lib/order-deliver-pr.ts";
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

type RunOpts = { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number };
const fail = (code: number | null, timedOut = false): BoundedResult => ({ code, stdout: "", stderr: "fatal: x", timedOut });
/** 注入的 runner：git 给 origin，gh 给 PR 列表；记下每次调用 */
function fakeRun(origin: BoundedResult | string, gh: BoundedResult | string = "[]") {
  const seen: { argv: string[]; o: RunOpts }[] = [];
  const run = async (argv: string[], o: RunOpts): Promise<BoundedResult> => {
    seen.push({ argv, o });
    const r = argv[0] === "git" ? origin : gh;
    return typeof r === "string" ? ok(r) : r;
  };
  return { run, seen };
}

describe("findPrRows：argv 与参数注入", () => {
  test("先在 cwd 认 origin，再在 cwd 跑 gh pr list --repo <origin> --head <branch> --state open，关交互、15 秒超时", async () => {
    const { run, seen } = fakeRun("https://github.com/o/r.git\n");
    const r = await findPrRows("/w", "feat/x", run);
    expect(r).toEqual({ ok: true, rows: [] });
    expect(seen.length).toBe(2);
    expect(seen[0].argv).toEqual(["git", "remote", "get-url", "origin"]);
    expect(seen[0].o).toMatchObject({ cwd: "/w", timeoutMs: 15_000 });
    expect(seen[1].argv).toEqual(["gh", "pr", "list", "--repo", "o/r", "--head", "feat/x", "--state", "open", "--json", "url,headRefOid,baseRefName,isCrossRepository"]);
    expect(seen[1].o).toMatchObject({ cwd: "/w", timeoutMs: 15_000 });
    expect(seen[1].o.env?.GH_PROMPT_DISABLED).toBe("1");
  });

  test("没有 cwd、分支名像选项 / 带 .. / 带空白或 shell 字符 → 拒，git 和 gh 都不跑", async () => {
    let ran = 0;
    const run = async () => (ran++, ok("[]"));
    expect((await findPrRows(undefined, "feat/x", run)).ok).toBe(false);
    for (const b of ["--repo=evil/x", "-x", "a..b", "a b", "a;rm", "$(x)", ""]) expect((await findPrRows("/w", b, run)).ok).toBe(false);
    expect(ran).toBe(0);
  });
});

describe("findPrRows：只认 origin 仓（i28-M8b）", () => {
  test("parseOriginRepo：https / ssh、带不带 .git 都认；别的写法一律 null", () => {
    expect(parseOriginRepo("https://github.com/o/r")).toBe("o/r");
    expect(parseOriginRepo("https://github.com/Shawn-Lu96/Claude.Stra.git\n")).toBe("Shawn-Lu96/Claude.Stra");
    expect(parseOriginRepo("git@github.com:o/r.git")).toBe("o/r");
    expect(parseOriginRepo("git@github.com:O/My-Repo")).toBe("O/My-Repo");
    const bad = [
      "", "https://gitlab.com/o/r.git", "git@gitlab.com:o/r.git", "https://github.com.evil.com/o/r", "https://evil.com/github.com/o/r",
      "ssh://git@github.com/o/r.git", "https://user@github.com/o/r", "http://github.com/o/r", "https://github.com/o", "https://github.com/o/r/x",
      "https://github.com/-o/r", "https://github.com/o/..", "https://github.com/o/.", "git@github.com:o", "/local/path/r.git", "https://github.com/o/r\nhttps://github.com/a/b",
    ];
    for (const u of bad) expect(parseOriginRepo(u)).toBeNull();
  });

  test("ssh 写法的 origin 同样带 --repo；origin 与 PR URL 大小写不同照常通过", async () => {
    const rows = [row({ url: "https://github.com/O/R/pull/7" })];
    const { run, seen } = fakeRun("git@github.com:o/r.git", JSON.stringify(rows));
    expect(await findPrRows("/w", "feat/x", run)).toEqual({ ok: true, rows });
    expect(seen[1].argv.slice(3, 5)).toEqual(["--repo", "o/r"]);
  });

  test("GH_REPO=other/repo 继承下来也被去掉，只用显式 --repo <origin>", async () => {
    const prev = process.env.GH_REPO;
    process.env.GH_REPO = "other/repo";
    try {
      const { run, seen } = fakeRun("https://github.com/o/r");
      expect((await findPrRows("/w", "feat/x", run)).ok).toBe(true);
      const gh = seen.find((c) => c.argv[0] === "gh")!;
      expect(gh.o.env).toBeDefined();
      expect("GH_REPO" in gh.o.env!).toBe(false);
      expect(gh.argv[gh.argv.indexOf("--repo") + 1]).toBe("o/r");
      expect(gh.argv).not.toContain("other/repo");
    } finally {
      if (prev === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = prev;
    }
  });

  test("origin 认不出（非 GitHub / 格式坏 / git 失败 / 超时）→ ok:false 带原因，不跑 gh", async () => {
    for (const origin of ["https://gitlab.com/o/r.git", "not a url", "", fail(128), fail(null, true)]) {
      const { run, seen } = fakeRun(origin);
      const r = await findPrRows("/w", "feat/x", run);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/origin/);
      expect(seen.map((c) => c.argv[0])).toEqual(["git"]);
    }
  });

  test("gh 返回别仓的 PR → 整次拒「PR 不在 origin 仓」；混着一行 origin 的也拒", async () => {
    const other = row({ url: "https://github.com/other/repo/pull/7" });
    for (const rows of [[other], [row(), other], [row({ url: "https://github.com/o/r2/pull/7" })], [row({ url: "https://github.com/o/r/issues/7" })]]) {
      const { run } = fakeRun("https://github.com/o/r.git", JSON.stringify(rows));
      const r = await findPrRows("/w", "feat/x", run);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("PR 不在 origin 仓 o/r");
    }
  });

  test("gh 失败照旧 ok:false（origin 校验不吞掉 gh 的错误）", async () => {
    const { run } = fakeRun("https://github.com/o/r", fail(1));
    expect((await findPrRows("/w", "feat/x", run)).ok).toBe(false);
  });

  test("prInRepo：只认完整 PR URL，owner/repo 不分大小写", () => {
    expect(prInRepo("https://github.com/o/r/pull/7/", "O/R")).toBe(true);
    expect(prInRepo("https://github.com/o/r/pull/7", "o/r2")).toBe(false);
    expect(prInRepo("https://github.com/o/r/pull/0", "o/r")).toBe(false);
    expect(prInRepo("306", "o/r")).toBe(false);
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
    const badUrls = ["306", "#306", "http://github.com/o/r/pull/7", "https://github.com/o/r/pull/7?x", "https://evil.com/o/r/pull/7"];
    for (const url of [...badUrls, "https://github.com/o/../pull/7", "https://github.com/o/r/pull/0"]) {
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

/**
 * merge-arch-CIPRECHK1 · 交付前预检本体（src/lib/ci-deliver-precheck.ts）与真实端口（ci-deliver-precheck-run.ts）：
 * 阈值与降级回执、失败清单、绑定变化作废、相同绑定复用；真 git 临时仓库上的选集与 CI 合并提交口径一致（分叉时在合并树里跑、冲突拒交）；
 * 登记检查（ci-impact-registration-check.ts）按交付树自己的登记表；后台预检的事实键核对与写前核租。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseSync } from "oxc-parser";
import { buildGraph, oxcScanner, type OxcParseSync } from "../src/lib/ci-impact-graph.js";
import { DEFAULT_IMPACT_INPUTS } from "../src/lib/ci-impact-inputs.js";
import { registrationProblems } from "../src/lib/ci-impact-registration-check.js";
import { parseNameStatus, selectImpactedTests } from "../src/lib/ci-impact-select.js";
import { describeReceipt, type Inspection, type PrecheckPort, type PrecheckReceipt } from "../src/lib/ci-deliver-precheck.js";
import { JOB_LOCK_STALE_MS, planRun, PRECHECK_MAX_TESTS, realJobFacts, realPrecheckPort, runJob, runPrecheck } from "../src/lib/ci-deliver-precheck-run.js";
import { statePath } from "../src/lib/paths.js";

const H = "a".repeat(40);
/** 临时仓库里放一份本仓的登记表：选测与登记检查按交付树自己的这份走（CI 读的也是检出树的那份） */
const REAL_INPUTS = readFileSync(join(import.meta.dir, "..", "src", "lib", "ci-impact-inputs.ts"), "utf8");
const scan = oxcScanner(parseSync as unknown as OxcParseSync);
const tests = (n: number) => Array.from({ length: n }, (_, i) => `tests/t${String(i).padStart(3, "0")}.test.ts`);
const ins = (o: Partial<Inspection> = {}, b: Partial<Inspection["binding"]> = {}): Inspection => ({
  binding: { repo: "r", base: "b".repeat(40), mergeBase: "c".repeat(40), head: H, status: "", untracked: "", selection: "s", ...b },
  run: "selected", tests: ["tests/a.test.ts"], reasons: [], changedTests: ["tests/a.test.ts"], registration: [], ...o,
});

function fakePort(seq: Awaited<ReturnType<PrecheckPort["inspect"]>>[], code = 0) {
  const runs: string[][] = [], store = new Map<string, PrecheckReceipt>(), merges: unknown[] = [];
  let i = 0;
  const port: PrecheckPort = {
    inspect: async () => seq[Math.min(i++, seq.length - 1)]!,
    runTests: async (_w, files, merge) => { runs.push(files); merges.push(merge); return { code, tail: code ? "(fail) tests/a.test.ts > x" : "" }; },
    recall: (k) => store.get(k) ?? null,
    remember: (k, r) => store.set(k, r),
    background: async () => ({ error: "同步入口不走后台" }),
  };
  return { port, runs, store, merges, reset: () => { i = 0; } };
}

describe("[验收线 2] 阈值 50：有界选集照跑，超阈值或 all 只跑改动测试并写明降级", () => {
  test("50 个以内跑选集；51 个降级；all 降级；降级只跑改动测试", () => {
    expect(PRECHECK_MAX_TESTS).toBe(50);
    expect(planRun(ins({ tests: tests(50) }))).toEqual({ scope: "selected", files: tests(50), selected: 50, degradeReasons: [] });
    const over = planRun(ins({ tests: tests(51), changedTests: ["tests/t001.test.ts"] }));
    expect(over).toMatchObject({ scope: "degraded", files: ["tests/t001.test.ts"], selected: 51 });
    expect(over.degradeReasons.join("；")).toContain("超过阈值 50");
    const all = planRun(ins({ run: "all", tests: tests(900), reasons: ["全量触发：bun.lock（锁文件）"], changedTests: [] }));
    expect(all).toMatchObject({ scope: "degraded", files: [], selected: "all" });
    expect(all.degradeReasons.join("；")).toContain("全量触发：bun.lock");
    expect(all.degradeReasons.join("；")).toContain("不算完整相关测试通过");
  });

  test("head 未合入 base（合并树里才有的测试）：阈值内照跑完整选集，交给端口在合并树里跑，不降级", async () => {
    const merge = { tree: "d".repeat(40), base: "b".repeat(40), head: H };
    const i = ins({ tests: ["tests/a.test.ts", "tests/m.test.ts"], merge });
    expect(planRun(i)).toEqual({ scope: "selected", files: ["tests/a.test.ts", "tests/m.test.ts"], selected: 2, degradeReasons: [] });
    const f = fakePort([i]);
    expect(await runPrecheck("/w", H, f.port)).toMatchObject({ ok: true, scope: "selected", ran: ["tests/a.test.ts", "tests/m.test.ts"] });
    expect(f.merges).toEqual([merge]);
  });

  test("降级回执写原选集规模与原因，不说成完整通过", async () => {
    const f = fakePort([ins({ tests: tests(80), changedTests: ["tests/t002.test.ts"] })]);
    const r = await runPrecheck("/w", H, f.port);
    expect(r).toMatchObject({ ok: true, scope: "degraded", selected: 80, ran: ["tests/t002.test.ts"] });
    expect(f.runs).toEqual([["tests/t002.test.ts"]]);
    expect(describeReceipt(r, "p")).toMatch(/降级（原选集 80）.*超过阈值 50.*实跑 1 个/);
  });

  test("降级后没有改动测试：只做登记检查，不起测试进程（绝不变成不带文件的全量）", async () => {
    const f = fakePort([ins({ run: "all", tests: tests(3), reasons: ["x"], changedTests: [] })]);
    expect(await runPrecheck("/w", H, f.port)).toMatchObject({ ok: true, ran: [] });
    expect(f.runs).toEqual([]);
  });
});

describe("[验收线 1] 失败清单：登记遗漏、相关测试失败、无法执行都拦住", () => {
  test("登记遗漏与测试失败一起列出", async () => {
    const f = fakePort([ins({ registration: ["未登记的非字面量动态加载：src/lib/dyn.ts"] })], 1);
    const r = await runPrecheck("/w", H, f.port);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(["登记检查：未登记的非字面量动态加载：src/lib/dyn.ts", expect.stringContaining("相关测试失败（退出码 1，1 个文件）")]);
    const text = describeReceipt(r, "p");
    expect(text).toContain("未写交付");
    expect(text).toContain("ledger scheduler-recovery p off --key ciDeliverPrecheck");
    expect(text).toContain("(fail) tests/a.test.ts");
  });

  test("无法执行、HEAD 不是交付 head、工作区不干净：不跑测试直接失败；不适用的仓库放行", async () => {
    for (const [seq, want] of [[{ error: "git rev-parse：not a git repository" }, "无法执行预检"], [ins({}, { head: "f".repeat(40) }), "不是交付 head"],
      [ins({}, { status: " M src/x.ts\0" }), "未提交"]] as const) {
      const f = fakePort([seq]);
      const r = await runPrecheck("/w", H, f.port);
      expect([r.ok, r.failures.join("")]).toEqual([false, expect.stringContaining(want)]);
      expect(f.runs).toEqual([]);
    }
    const skip = await runPrecheck("/w", H, fakePort([{ skip: "别的项目" }]).port);
    expect(skip).toMatchObject({ ok: true, skipped: "别的项目", ran: [] });
    expect(describeReceipt(skip, "p")).toBe("交付前预检不适用：别的项目");
    expect((await runPrecheck("/w", H.slice(0, 12), fakePort([ins()]).port)).ok).toBe(true); // 短 SHA 按前缀认
  });
});

describe("[验收线 4] 绑定：跑完再核一次，变了就作废；相同绑定的通过结果复用", () => {
  test("head / base / 工作区 / 选测图摘要任何一项在跑测试期间变了：拒绝使用结果、不记缓存", async () => {
    for (const [k, v] of [["head", "e".repeat(40)], ["base", "d".repeat(40)], ["status", " M x\0"], ["untracked", "1:ab"], ["selection", "s2"], ["repo", "r2"]] as const) {
      const f = fakePort([ins(), ins({}, { [k]: v })]);
      const r = await runPrecheck("/w", H, f.port);
      expect([k, r.ok, r.failures.some((x) => x.includes("结果作废"))]).toEqual([k, false, true]);
      expect(f.store.size).toBe(0);
    }
  });

  test("同一绑定第二次直接复用（不重跑测试）；绑定一变（新 head）就重跑", async () => {
    const f = fakePort([ins()]);
    expect(await runPrecheck("/w", H, f.port)).toMatchObject({ ok: true, reused: false });
    f.reset();
    expect(await runPrecheck("/w", H, f.port)).toMatchObject({ ok: true, reused: true });
    expect(f.runs.length).toBe(1);
    const H2 = "9".repeat(40), g = fakePort([ins({}, { head: H2 })]);
    for (const [k, r] of f.store) g.store.set(k, r);
    expect(await runPrecheck("/w", H2, g.port)).toMatchObject({ ok: true, reused: false });
    expect(g.runs.length).toBe(1);
  });

  test("失败的结果不复用：修好之前每次都重跑", async () => {
    const f = fakePort([ins()], 1);
    await runPrecheck("/w", H, f.port);
    f.reset();
    await runPrecheck("/w", H, f.port);
    expect(f.runs.length).toBe(2);
  });
});

describe("登记检查（与 tests/ci-impact-io-map.test.ts 共用同一实现）", () => {
  const side = (files: Record<string, string>) => ({ paths: Object.keys(files).sort(), graph: buildGraph({ paths: Object.keys(files), read: (p) => files[p]! }, scan, []) });
  const repo = (dyn: string) => side({ "src/lib/dyn.ts": dyn, "tests/dyn.test.ts": `import "../src/lib/dyn.js";`, "tests/other.test.ts": `export {};` });

  test("[先红后绿] 测试走得到的非字面量动态加载没登记 → 列出；登记后 → 空", () => {
    const r = repo(`export const load = (n: string) => import(n);`);
    expect(registrationProblems(r)).toEqual(["未登记的非字面量动态加载：src/lib/dyn.ts"]);
    const inputs = { ...DEFAULT_IMPACT_INPUTS, implicit: [...DEFAULT_IMPACT_INPUTS.implicit, { module: "src/lib/dyn.ts", deps: [], why: "测" }] };
    expect(registrationProblems(r, inputs)).toEqual([]);
    expect(registrationProblems(repo(`import { readFileSync } from "node:fs"; export const r = () => readFileSync("x");`))).toEqual([]); // 普通 io 由读取图管，不算登记问题
    expect(registrationProblems(repo(`import "./missing.js";`))).toEqual(["未知本地依赖：src/lib/dyn.ts → ./missing.js"]);
  });
});

describe("[验收线 2] 真实端口：真 git 临时仓库，选集与相同 base/head 的 CI（合并提交口径）一致", () => {
  let root: string, repo: string;
  const sh = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const put = (p: string, text: string) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), text); };
  const env: Record<string, string | undefined> = {};
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ci-deliver-precheck-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    put("tsconfig.json", "{}");
    put("scripts/ci-related-plan.ts", "export {};\n");
    put("src/lib/ci-impact-inputs.ts", REAL_INPUTS);
    put("src/x.ts", "export const x = 1;\n");
    put("src/y.ts", "export const y = 1;\n");
    put("src/gone.ts", "export const g = 1;\n");
    put("tests/x.test.ts", `import { x } from "../src/x.js";\n`);
    put("tests/y.test.ts", `import { y } from "../src/y.js";\n`);
    put("tests/gone.test.ts", `export {};\n`);
    // 假的测试入口：记下收到的参数与在哪棵树里跑（合并树才有 docs/n.md）；工作副本的 fail.flag 或 PRECHK_MODE=fail 失败、
    // untrack / commit 在跑的时候给工作副本加未跟踪文件 / 提交一次（模拟执行期间工作区 / head 变了）
    put("scripts/test.ts", `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      const REPO = ${JSON.stringify(repo)};
      appendFileSync(${JSON.stringify(join(root, "runs"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
      appendFileSync(${JSON.stringify(join(root, "trees"))}, (existsSync("docs/n.md") ? "merged" : "head") + "\\n");
      if (process.env.PRECHK_MODE === "fail" || existsSync(REPO + "/fail.flag")) { console.error("(fail) tests/x.test.ts > boom"); process.exit(1); }
      if (process.env.PRECHK_MODE === "untrack") writeFileSync(REPO + "/during.txt", "x");
      if (process.env.PRECHK_MODE === "commit") Bun.spawnSync(["git", "-C", REPO, "commit", "-q", "--allow-empty", "-m", "during"], { env: process.env });\n`);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "base");
    sh(repo, "checkout", "-q", "-b", "feat");
    put("src/x.ts", "export const x = 2;\n");
    put("tests/new.test.ts", `import { y } from "../src/y.js";\n`);
    sh(repo, "rm", "-q", "src/gone.ts", "tests/gone.test.ts");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "feat");
    sh(repo, "checkout", "-q", "main");
    put("docs/n.md", "# 之后 main 上的无关改动\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "main moves");
    sh(repo, "checkout", "-q", "feat");
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "PRECHK_MODE"]) env[k] = process.env[k];
    Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" });
  });
  afterEach(() => { delete process.env.PRECHK_MODE; });
  afterAll(() => {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  });
  const trees = () => readFileSync(join(root, "trees"), "utf8").trim().split("\n");
  const worktrees = () => sh(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
  const runs = () => { try { return readFileSync(join(root, "runs"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } };

  /** CI 的口径（scripts/ci-related-plan.ts prSelect + responsibilityOf）：PR 合并提交，diff HEAD^1..HEAD，base 侧是 HEAD^1 的树 */
  function ciSelection(name = "ci"): string[] {
    const ci = join(root, name);
    sh(root, "clone", "-q", repo, ci);
    sh(ci, "checkout", "-q", "main");
    sh(ci, "merge", "-q", "--no-ff", "-m", "merge", "origin/feat");
    const at = (rev: string) => {
      const paths = sh(ci, "ls-tree", "-r", "--name-only", rev).split("\n").filter(Boolean);
      const read = (p: string) => sh(ci, "show", `${rev}:${p}`);
      return { paths, graph: buildGraph({ paths, read }, scan, []) };
    };
    const d = parseNameStatus(sh(ci, "diff", "-z", "--name-status", "-M", "HEAD^1", "HEAD"));
    const head = at("HEAD"), base = at("HEAD^1");
    const sel = selectImpactedTests({ mode: "on", changes: d.changes, badChanges: d.bad, headPaths: head.paths, load: () => ({ base, head }) });
    expect(sel.run).toBe("selected");
    return sel.tests;
  }

  test("选集 = CI 合并提交口径的选集；改动测试、删除走 base 图；跑的是 ./ 前缀的文件", async () => {
    const port = realPrecheckPort(), i = await port.inspect(repo);
    if (!("binding" in i)) throw new Error(JSON.stringify(i));
    expect(i).toMatchObject({ run: "selected", changedTests: ["tests/new.test.ts"], registration: [], binding: { head: sh(repo, "rev-parse", "HEAD"), status: "" } });
    expect(i.binding.mergeBase).toBe(sh(repo, "merge-base", "main", "feat"));
    expect(i.tests).toEqual(["tests/new.test.ts", "tests/x.test.ts"]);
    expect(i.tests).toEqual(ciSelection());
    const r = await runPrecheck(repo, i.binding.head, realPrecheckPort());
    expect(r).toMatchObject({ ok: true, scope: "selected", ran: ["tests/new.test.ts", "tests/x.test.ts"] });
    expect(runs().at(-1)).toEqual(["./tests/new.test.ts", "./tests/x.test.ts"]);
    expect(trees().at(-1)).toBe("merged"); // main 有 head 没有的提交：在 CI 的合并树里跑，临时检出跑完就删
    expect(worktrees()).toBe(1);
    // 同一绑定再交一次：复用，不再起测试
    const n = runs().length;
    expect(await runPrecheck(repo, i.binding.head, realPrecheckPort())).toMatchObject({ ok: true, reused: true });
    expect(runs().length).toBe(n);
  }, 60_000);

  test("bridge 入口的后台预检：第一次起后台进程并报「还在跑」，跑完后同一份事实取回通过回执；同时只起一个", async () => {
    sh(repo, "commit", "-q", "--allow-empty", "-m", "bridge head");
    const head = sh(repo, "rev-parse", "HEAD"), port = realPrecheckPort(), n = runs().length;
    expect(await port.background(repo, head)).toEqual({ state: "running" });
    expect(await port.background(repo, head)).toEqual({ state: "running" });
    let got = await port.background(repo, head);
    for (const end = Date.now() + 45_000; "state" in got && got.state === "running" && Date.now() < end; await Bun.sleep(100)) got = await port.background(repo, head);
    expect(got).toMatchObject({ state: "done", receipt: { ok: true, scope: "selected", ran: ["tests/new.test.ts", "tests/x.test.ts"] } });
    expect(runs().length).toBe(n + 1);
    expect(await port.background(repo, head)).toMatchObject({ state: "done", receipt: { ok: true } }); // 通过的结果复用
  }, 60_000);

  test("[验收线 1] 相关测试失败：失败清单带输出尾部", async () => {
    sh(repo, "commit", "-q", "--allow-empty", "-m", "new head");
    process.env.PRECHK_MODE = "fail";
    const r = await runPrecheck(repo, sh(repo, "rev-parse", "HEAD"), realPrecheckPort());
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toContain("(fail) tests/x.test.ts > boom");
  }, 60_000);

  test("[验收线 4] 执行期间 head 变了：结果作废；已跟踪文件没提交：不跑", async () => {
    sh(repo, "commit", "-q", "--allow-empty", "-m", "another head");
    process.env.PRECHK_MODE = "commit";
    const r = await runPrecheck(repo, sh(repo, "rev-parse", "HEAD"), realPrecheckPort());
    expect(r.ok).toBe(false);
    expect(r.failures).toContain("预检期间head变了，结果作废，重新交付");
    delete process.env.PRECHK_MODE;
    put("src/x.ts", "export const x = 3;\n");
    const n = runs().length;
    const dirty = await runPrecheck(repo, sh(repo, "rev-parse", "HEAD"), realPrecheckPort());
    expect(dirty.failures).toEqual(["工作副本有未提交的已跟踪改动：先提交干净再交付"]);
    expect(runs().length).toBe(n);
    sh(repo, "checkout", "--", "src/x.ts");
  }, 60_000);

  test("[验收线 4][先红后绿] 未跟踪文件进绑定：首次通过后新增会让测试失败的未跟踪文件，不复用旧结果、重跑并拦住；删掉后复用原通过结果", async () => {
    sh(repo, "commit", "-q", "--allow-empty", "-m", "untracked head");
    const head = sh(repo, "rev-parse", "HEAD"), n = runs().length;
    expect(await runPrecheck(repo, head, realPrecheckPort())).toMatchObject({ ok: true, reused: false });
    writeFileSync(join(repo, "fail.flag"), "1");
    const r = await runPrecheck(repo, head, realPrecheckPort());
    expect(r).toMatchObject({ ok: false, reused: false });
    expect(r.failures.join("\n")).toContain("(fail) tests/x.test.ts > boom");
    expect(runs().length).toBe(n + 2);
    rmSync(join(repo, "fail.flag"));
    expect(await runPrecheck(repo, head, realPrecheckPort())).toMatchObject({ ok: true, reused: true });
    expect(runs().length).toBe(n + 2);
  }, 60_000);

  test("[验收线 4] 执行期间新增未跟踪文件：结束复核发现，结果作废", async () => {
    sh(repo, "commit", "-q", "--allow-empty", "-m", "untracked during");
    process.env.PRECHK_MODE = "untrack";
    try {
      const r = await runPrecheck(repo, sh(repo, "rev-parse", "HEAD"), realPrecheckPort());
      expect(r.ok).toBe(false);
      expect(r.failures).toContain("预检期间未跟踪文件变了，结果作废，重新交付");
    } finally { rmSync(join(repo, "during.txt"), { force: true }); }
  }, 60_000);

  test("[验收线 1] 出借写单副本只有 refs/remotes/origin/HEAD（没有 origin/main、main）：按它求 diff，不报找不到 main", async () => {
    const w = join(root, "lendlike");
    mkdirSync(w);
    sh(w, "init", "-q", "-b", "unborn");
    sh(w, "fetch", "-q", "--no-tags", repo, "feat:refs/heads/lend/T1-ab", "main:refs/remotes/origin/HEAD");
    sh(w, "checkout", "-q", "-f", "lend/T1-ab");
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "origin/main"], { cwd: w }).exitCode).not.toBe(0);
    const i = await realPrecheckPort().inspect(w);
    if (!("binding" in i)) throw new Error(JSON.stringify(i));
    expect(i.binding.base).toBe(sh(repo, "rev-parse", "main"));
    expect(i.tests).toContain("tests/x.test.ts");
  }, 60_000);

  test("[验收线 4][先红后绿] 后台预检的事实键：排队时是 A、实际跑的是 B，B 的回执不写进 A 的键；A 再交付取回的是 A 自己的结果", async () => {
    sh(repo, "commit", "-q", "--allow-empty", "-m", "bg drift");
    const head = sh(repo, "rev-parse", "HEAD"), flag = join(repo, "fail.flag"), port = realPrecheckPort();
    const jobJson = (k: string) => statePath("ci-deliver-precheck", "jobs", `${k}.json`);
    writeFileSync(flag, "1");
    const keyA = realJobFacts(repo, head).current()!;
    try {
      rmSync(flag); // 开跑前就成了 B：不跑
      let started = 0;
      expect(await runJob(repo, head, keyA, async () => { started++; return runPrecheck(repo, head, realPrecheckPort()); })).toBe(false);
      expect(started).toBe(0);
      writeFileSync(flag, "1"); // 开跑后才成了 B：跑的是 B（通过），不能记在 A 名下
      expect(await runJob(repo, head, keyA, async () => { rmSync(flag); return runPrecheck(repo, head, realPrecheckPort()); })).toBe(false);
      expect(existsSync(jobJson(keyA))).toBe(false);
      // 取回时也核：A 的键下放一份绑定 B 的通过回执，A 状态交付不认它，重跑出 A 自己的失败
      const b = await runPrecheck(repo, head, realPrecheckPort());
      expect(b).toMatchObject({ ok: true });
      writeFileSync(flag, "1");
      mkdirSync(dirname(jobJson(keyA)), { recursive: true });
      writeFileSync(jobJson(keyA), JSON.stringify(b));
      let got = await port.background(repo, head);
      expect(got).toEqual({ state: "running" });
      for (const end = Date.now() + 45_000; "state" in got && got.state === "running" && Date.now() < end; await Bun.sleep(100)) got = await port.background(repo, head);
      expect(got).toMatchObject({ state: "done", receipt: { ok: false } });
      expect("state" in got && got.state === "done" && got.receipt.failures.join("\n")).toContain("(fail) tests/x.test.ts > boom");
    } finally { rmSync(flag, { force: true }); }
  }, 90_000);

  test("[验收线 1][先红后绿] 登记表取交付树自己的：交付树删了某个动态加载模块的登记 → 拦住；新增动态加载并在交付树登记 → 放行", async () => {
    const branch = (name: string, edit: () => void) => {
      sh(repo, "checkout", "-q", "-b", name, "feat");
      edit();
      sh(repo, "add", "-A");
      sh(repo, "commit", "-q", "-m", name);
    };
    const line = `  ext("src/lib/pi-env-snapshot.ts", "动态 import 的是 Pi 包名"),\n`;
    expect(REAL_INPUTS).toContain(line);
    try {
      branch("reg-drop", () => {
        put("src/lib/pi-env-snapshot.ts", "export const load = (n: string) => import(n);\n");
        put("tests/pi.test.ts", `import { load } from "../src/lib/pi-env-snapshot.js";\n`);
        put("src/lib/ci-impact-inputs.ts", REAL_INPUTS.replace(line, ""));
      });
      const drop = await realPrecheckPort().inspect(repo);
      if (!("binding" in drop)) throw new Error(JSON.stringify(drop));
      expect(drop.registration).toContain("未登记的非字面量动态加载：src/lib/pi-env-snapshot.ts");
      expect(await runPrecheck(repo, drop.binding.head, realPrecheckPort())).toMatchObject({ ok: false, failures: expect.arrayContaining(["登记检查：未登记的非字面量动态加载：src/lib/pi-env-snapshot.ts"]) });
      sh(repo, "checkout", "-q", "feat");
      branch("reg-add", () => {
        put("src/lib/dyn-new.ts", "export const load = (n: string) => import(n);\n");
        put("tests/dyn-new.test.ts", `import { load } from "../src/lib/dyn-new.js";\n`);
        put("src/lib/ci-impact-inputs.ts", REAL_INPUTS.replace(line, `  ext("src/lib/dyn-new.ts", "测：交付树里登记的新动态加载"),\n${line}`));
      });
      const add = await realPrecheckPort().inspect(repo);
      if (!("binding" in add)) throw new Error(JSON.stringify(add));
      expect(add.registration).toEqual([]);
    } finally { sh(repo, "checkout", "-q", "feat"); }
  }, 90_000);

  test("[验收线 2][先红后绿] main 自分叉后新增依赖改动模块的测试：选集按 CI 合并树算出它，并在合并树里照跑完整选集（不降级、不零测试放行）", async () => {
    sh(repo, "checkout", "-q", "main");
    put("tests/new-main.test.ts", `import { x } from "../src/x.js";\n`);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "main adds a test on x");
    sh(repo, "checkout", "-q", "feat");
    const i = await realPrecheckPort().inspect(repo);
    if (!("binding" in i)) throw new Error(JSON.stringify(i));
    expect(i.tests).toEqual(ciSelection("ci-diverged"));
    expect(i.tests).toContain("tests/new-main.test.ts");
    const r = await runPrecheck(repo, i.binding.head, realPrecheckPort());
    expect(r).toMatchObject({ ok: true, scope: "selected", selected: i.tests.length, ran: i.tests, degradeReasons: [] });
    expect(runs().at(-1)).toEqual(i.tests.map((t) => `./${t}`));
    expect(trees().at(-1)).toBe("merged");
    expect(worktrees()).toBe(1);
  }, 60_000);

  test("[验收线 2][先红后绿] head 与 base 合并有冲突（CI 同样合不出）：无法执行，拒交，不降级放行", async () => {
    sh(repo, "checkout", "-q", "main");
    put("src/y.ts", "export const y = 'main';\n");
    sh(repo, "commit", "-q", "-am", "main edits y");
    sh(repo, "checkout", "-q", "-b", "conf", "feat");
    put("src/y.ts", "export const y = 'conf';\n");
    sh(repo, "commit", "-q", "-am", "conf edits y");
    try {
      const n = runs().length;
      const r = await runPrecheck(repo, sh(repo, "rev-parse", "HEAD"), realPrecheckPort());
      expect(r.ok).toBe(false);
      expect(r.failures.join("")).toContain("合并有冲突");
      expect(runs().length).toBe(n);
    } finally { sh(repo, "checkout", "-q", "feat"); }
  }, 60_000);
});

describe("[验收线 4] 后台预检的锁（file-lock.ts）：同一份事实只跑一次", () => {
  const key = () => Bun.hash(String(Math.random())).toString(16).padStart(16, "0").repeat(4).slice(0, 64);
  /** 锁的用例不碰 git：事实固定就是这个键 */
  const same = (k: string) => ({ current: () => k, keyOf: () => k });
  const ok: PrecheckReceipt = { ok: true, scope: "selected", selected: 1, ran: ["tests/a.test.ts"], degradeReasons: [], failures: [], key: "k", reused: false };

  test("[先红后绿] 两个后台进程在同一窗口抢同一份事实：预检本体只跑一次；跑完后再来的看到结果不重跑", async () => {
    const k = key();
    let started = 0, go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    const slow = async () => { started++; await gate; return ok; };
    const first = runJob("/w", "h", k, slow, same(k));
    await Bun.sleep(20);
    expect(await runJob("/w", "h", k, slow, same(k))).toBe(false); // 第一个在持锁跑：抢不到直接退出
    go();
    expect(await first).toBe(true);
    expect(await runJob("/w", "h", k, slow, same(k))).toBe(false); // 结果已在：抢到锁也不重跑
    expect(started).toBe(1);
    rmSync(statePath("ci-deliver-precheck", "jobs", `${k}.json`), { force: true });
  });

  test("刚建、还没写 owner 的锁（初始化窗口）不当死锁回收；过期（持有者没续租）才回收", async () => {
    const k = key(), lock = statePath("ci-deliver-precheck", "jobs", `${k}.lock`);
    mkdirSync(lock, { recursive: true });
    let started = 0;
    expect(await runJob("/w", "h", k, async () => { started++; return ok; }, same(k))).toBe(false);
    expect(started).toBe(0);
    const old = new Date(Date.now() - JOB_LOCK_STALE_MS - 5_000);
    utimesSync(lock, old, old);
    expect(await runJob("/w", "h", k, async () => { started++; return ok; }, same(k))).toBe(true);
    expect(started).toBe(1);
    rmSync(statePath("ci-deliver-precheck", "jobs", `${k}.json`), { force: true });
  });

  test("[先红后绿] 写回执前核租：跑的期间锁过期被新持有者回收并写了失败回执，失租的旧持有者恢复后不覆盖", async () => {
    const k = key(), lock = statePath("ci-deliver-precheck", "jobs", `${k}.lock`), out = statePath("ci-deliver-precheck", "jobs", `${k}.json`);
    const bad: PrecheckReceipt = { ...ok, ok: false, failures: ["新持有者：相关测试失败"] };
    const first = runJob("/w", "h", k, async () => {
      const old = new Date(Date.now() - JOB_LOCK_STALE_MS - 5_000);
      utimesSync(lock, old, old); // 旧持有者被暂停超过租期
      expect(await runJob("/w", "h", k, async () => bad, same(k))).toBe(true);
      return ok;
    }, same(k));
    expect(await first).toBe(false);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ ok: false, failures: ["新持有者：相关测试失败"] });
    rmSync(out, { force: true });
  });

  test("事实键对不上（开跑前已变 / 回执绑的是别的事实）：不写", async () => {
    const k = key(), out = statePath("ci-deliver-precheck", "jobs", `${k}.json`);
    expect(await runJob("/w", "h", k, async () => ok, { current: () => "other", keyOf: () => k })).toBe(false);
    expect(await runJob("/w", "h", k, async () => ({ ...ok, facts: "b" }), { current: () => k, keyOf: () => "other" })).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});

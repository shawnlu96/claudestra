/**
 * merge-arch-CIPRECHK1 · 交付前预检本体（src/lib/ci-deliver-precheck.ts）与真实端口（ci-deliver-precheck-run.ts）：
 * 阈值与降级回执、失败清单、绑定变化作废、相同绑定复用；真 git 临时仓库上的选集与 CI 合并提交口径一致；登记检查（ci-impact-registration-check.ts）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseSync } from "oxc-parser";
import { buildGraph, oxcScanner, type OxcParseSync } from "../src/lib/ci-impact-graph.js";
import { DEFAULT_IMPACT_INPUTS } from "../src/lib/ci-impact-inputs.js";
import { registrationProblems } from "../src/lib/ci-impact-registration-check.js";
import { parseNameStatus, selectImpactedTests } from "../src/lib/ci-impact-select.js";
import { describeReceipt, type Inspection, type PrecheckPort, type PrecheckReceipt } from "../src/lib/ci-deliver-precheck.js";
import { planRun, PRECHECK_MAX_TESTS, realPrecheckPort, runPrecheck } from "../src/lib/ci-deliver-precheck-run.js";

const H = "a".repeat(40);
const scan = oxcScanner(parseSync as unknown as OxcParseSync);
const tests = (n: number) => Array.from({ length: n }, (_, i) => `tests/t${String(i).padStart(3, "0")}.test.ts`);
const ins = (o: Partial<Inspection> = {}, b: Partial<Inspection["binding"]> = {}): Inspection => ({
  binding: { repo: "r", base: "b".repeat(40), mergeBase: "c".repeat(40), head: H, status: "", selection: "s", ...b },
  run: "selected", tests: ["tests/a.test.ts"], reasons: [], changedTests: ["tests/a.test.ts"], registration: [], ...o,
});

function fakePort(seq: Awaited<ReturnType<PrecheckPort["inspect"]>>[], code = 0) {
  const runs: string[][] = [], store = new Map<string, PrecheckReceipt>();
  let i = 0;
  const port: PrecheckPort = {
    inspect: async () => seq[Math.min(i++, seq.length - 1)]!,
    runTests: async (_w, files) => { runs.push(files); return { code, tail: code ? "(fail) tests/a.test.ts > x" : "" }; },
    recall: (k) => store.get(k) ?? null,
    remember: (k, r) => store.set(k, r),
    background: async () => ({ error: "同步入口不走后台" }),
  };
  return { port, runs, store, reset: () => { i = 0; } };
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
    for (const [k, v] of [["head", "e".repeat(40)], ["base", "d".repeat(40)], ["status", " M x\0"], ["selection", "s2"], ["repo", "r2"]] as const) {
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
    put("src/x.ts", "export const x = 1;\n");
    put("src/y.ts", "export const y = 1;\n");
    put("src/gone.ts", "export const g = 1;\n");
    put("tests/x.test.ts", `import { x } from "../src/x.js";\n`);
    put("tests/y.test.ts", `import { y } from "../src/y.js";\n`);
    put("tests/gone.test.ts", `export {};\n`);
    // 假的测试入口：记下收到的参数；PRECHK_MODE=fail 失败、commit 在跑的时候提交一次（模拟执行期间 head 变了）
    put("scripts/test.ts", `import { appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(join(root, "runs"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
      if (process.env.PRECHK_MODE === "fail") { console.error("(fail) tests/x.test.ts > boom"); process.exit(1); }
      if (process.env.PRECHK_MODE === "commit") Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "during"], { env: process.env });\n`);
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
  const runs = () => { try { return readFileSync(join(root, "runs"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } };

  /** CI 的口径（scripts/ci-related-plan.ts prSelect + responsibilityOf）：PR 合并提交，diff HEAD^1..HEAD，base 侧是 HEAD^1 的树 */
  function ciSelection(): string[] {
    const ci = join(root, "ci");
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
});

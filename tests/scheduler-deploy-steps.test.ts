import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsRelay, runDeploySteps, type StepsInput } from "../src/lib/scheduler-deploy-steps.js";
import { runDeployJob } from "../src/lib/scheduler-deploy-worker.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const SHA = "d".repeat(40);
const LABELS = ["x.fake.bridge", "x.fake.cron", "x.fake.launcher", "x.fake.scheduler"];
const base: StepsInput = { repoDir: "/repo", mergeSha: SHA, relayArgv: null, restartLabels: LABELS, env: {}, uid: 501, deadline: Date.now() + 3_600_000 };

/** Fake git / bun / launchctl: `diff` is what both diffs list; `fail` names argv words that exit 1. */
function fake(o: { diff?: string; fail?: string[]; branch?: string; dirty?: boolean } = {}) {
  const calls: string[][] = [];
  const run: typeof runBounded = async (argv) => {
    calls.push(argv);
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: code ? "boom" : "", timedOut: false });
    if (o.fail?.some((w) => argv.includes(w))) return out("", 1);
    if (argv.includes("--abbrev-ref")) return out(o.branch ?? "main");
    if (argv.includes("--porcelain")) return out(o.dirty ? " M src/x.ts" : "");
    if (argv.includes("rev-parse")) return out(SHA);
    if (argv.includes("diff")) return out(o.diff ?? "src/lib/scheduler-pass.ts\n");
    return out("");
  };
  const ran = (word: string) => calls.filter((a) => a.includes(word));
  return { run, calls, ran };
}

describe("T68g deploy steps", () => {
  test("P1: no web / relay change → the relay is not deployed; four daemons restarted", async () => {
    const f = fake();
    const o = await runDeploySteps({ ...base, relayArgv: ["/bin/relay-deploy"] }, f.run, () => true);
    expect(o).toMatchObject({ ok: true, relay: "not_needed" });
    expect(f.ran("/bin/relay-deploy")).toHaveLength(0);
    expect(f.ran("kickstart").map((a) => a.at(-1))).toEqual(LABELS.map((l) => `gui/501/${l}`));
    expect(f.ran("web-release")).toHaveLength(1);
  });

  test("web or relay change → relay runs; not configured → reported, never guessed", async () => {
    expect(needsRelay(["web/app/page.tsx"])).toBe(true);
    expect(needsRelay(["src/relay.ts", "x"])).toBe(true);
    expect(needsRelay(["src/lib/relay-client.ts"])).toBe(true);
    expect(needsRelay(["src/lib/relaying.ts", "docs/web/x.md"])).toBe(false);
    const f = fake({ diff: "web/app/page.tsx\n" });
    expect((await runDeploySteps({ ...base, relayArgv: ["/bin/relay-deploy"] }, f.run, () => true)).relay).toBe("ran");
    expect((await runDeploySteps(base, fake({ diff: "web/x.tsx\n" }).run, () => true)).relay).toBe("not_configured");
  });

  test("the main tree is refused when it is not on main, dirty, or origin/main lacks the merge", async () => {
    expect(await runDeploySteps(base, fake({ branch: "feat/x" }).run, () => true)).toMatchObject({ ok: false, summary: expect.stringMatching(/main/) });
    expect(await runDeploySteps(base, fake({ dirty: true }).run, () => true)).toMatchObject({ ok: false, summary: expect.stringMatching(/未提交/) });
    const f = fake({ fail: ["--is-ancestor"] });
    expect(await runDeploySteps(base, f.run, () => true)).toMatchObject({ ok: false, summary: expect.stringMatching(/不含合并提交/) });
    expect(f.ran("merge")).toHaveLength(0);
  });

  test("P1: a lost lease stops before the next step; nothing after it runs", async () => {
    const f = fake();
    let steps = 0;
    const o = await runDeploySteps(base, f.run, () => ++steps <= 6, Date.now);
    expect(o).toMatchObject({ ok: false, summary: expect.stringMatching(/租约已失/) });
    expect(f.ran("web-release")).toHaveLength(0);
    expect(f.ran("kickstart")).toHaveLength(0);
  });

  test("one daemon failing to restart does not skip the others; the deploy is reported failed", async () => {
    const f = fake({ fail: ["gui/501/x.fake.cron"] });
    const o = await runDeploySteps(base, f.run, () => true);
    expect(f.ran("kickstart")).toHaveLength(4);
    expect(o).toMatchObject({ ok: false, summary: expect.stringMatching(/x\.fake\.cron/) });
  });
});

describe("merge-arch-GATE1: a request with deploySha deploys exactly that commit", () => {
  const PIN = "e".repeat(40), LATER = "f".repeat(40);
  /** A main tree at `at`; origin/main is LATER; `not` lists the "<a> in <b>" ancestry answers that are no. */
  function repo(at: string, not: string[] = []) {
    const calls: string[][] = [], r = { calls, at };
    const run: typeof runBounded = async (argv) => {
      calls.push(argv);
      const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "", timedOut: false });
      if (argv.includes("--abbrev-ref")) return out("main");
      if (argv.includes("--is-ancestor")) return out("", not.includes(`${argv.at(-2)} in ${argv.at(-1)}`) ? 1 : 0);
      if (argv.includes("--ff-only")) { r.at = argv.at(-1) === "origin/main" ? LATER : argv.at(-1)!; return out(""); }
      return out(argv.includes("rev-parse") ? r.at : "");
    };
    return { r, run, ran: (word: string) => calls.filter((a) => a.includes(word)) };
  }

  test("without deploySha every command is what it always was: fast-forward to origin/main, one ancestry check", async () => {
    const plain = fake(), again = fake();
    await runDeploySteps(base, plain.run, () => true);
    await runDeploySteps({ ...base, deploySha: undefined }, again.run, () => true);
    expect(again.calls).toEqual(plain.calls);
    expect(plain.ran("--ff-only").map((a) => a.at(-1))).toEqual(["origin/main"]);
    expect(plain.ran("--is-ancestor")).toEqual([["git", "-C", "/repo", "merge-base", "--is-ancestor", SHA, "origin/main"]]);
  });

  test("origin/main moved past the proven commit: the tree is fast-forwarded to deploySha, not to origin/main", async () => {
    const x = repo(SHA);
    expect(await runDeploySteps({ ...base, deploySha: PIN }, x.run, () => true)).toMatchObject({ ok: true, head: PIN, summary: expect.stringContaining(PIN.slice(0, 12)) });
    expect(x.ran("--ff-only").map((a) => a.at(-1))).toEqual([PIN]);
    expect(x.ran("--is-ancestor").map((a) => `${a.at(-2)} in ${a.at(-1)}`)).toEqual([`${SHA} in origin/main`, `${PIN} in origin/main`, `${SHA} in ${PIN}`, `${SHA} in ${PIN}`]);
  });

  const refusals: [string, string, string[], RegExp][] = [
    ["deploySha is not on origin/main (or cannot be read)", SHA, [`${PIN} in origin/main`], /不在 origin\/main 上（或取不到），不部署/],
    ["deploySha does not contain the merge", SHA, [`${SHA} in ${PIN}`], /不含合并提交，不部署/],
    ["the tree is already past deploySha (never moved back)", LATER, [`${LATER} in ${PIN}`], /已不在固定的部署提交 e{12} 之前，不回退，不部署/],
  ];
  for (const [name, at, not, why] of refusals) {
    test(`${name}: this deploy is refused before anything changes — no fast-forward, no release, no restart, no retry`, async () => {
      const x = repo(at, not);
      expect(await runDeploySteps({ ...base, deploySha: PIN }, x.run, () => true)).toMatchObject({ ok: false, summary: expect.stringMatching(why) });
      expect([x.ran("--ff-only"), x.ran("web-release"), x.ran("kickstart"), x.r.at, x.ran("fetch").length]).toEqual([[], [], [], at, 1]);
    });
  }

  test("a fast-forward that did not end on deploySha stops before the release", async () => {
    const x = repo(SHA), stuck: typeof runBounded = async (argv, o) => (argv.includes("--ff-only") ? { code: 0, stdout: "", stderr: "", timedOut: false } : x.run(argv, o));
    expect(await runDeploySteps({ ...base, deploySha: PIN }, stuck, () => true)).toMatchObject({ ok: false, summary: expect.stringMatching(/不是固定的部署提交/) });
    expect(x.ran("web-release")).toEqual([]);
  });
});

describe("T68g deploy worker", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  function request() {
    const dir = mkdtempSync(join(tmpdir(), "t68g-worker-")); roots.push(dir);
    const path = join(dir, "request.json");
    writeJsonAtomicSync(path, { intentId: "m9", mergeSha: SHA, taskId: "T9", prRef: "https://github.com/a/b/pull/7",
      label: `com.claudestra.scheduler.deploy.${"a".repeat(32)}`, repoDir: "/repo", relayArgv: null, restartLabels: LABELS,
      timeoutMs: 600_000, createdAt: Date.now(), env: {} });
    return { dir, path, result: () => JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) };
  }
  const lease = (held: () => boolean, log: string[]) => ({ path: "/l", token: "t", held, release: () => log.push("release") });

  test("P1 overlap: no maintenance lease (an update is running) → nothing runs, result says so", async () => {
    const r = request(), f = fake();
    await runDeployJob(r.path, { run: f.run, acquire: async () => null });
    expect(f.calls).toHaveLength(0);
    expect(r.result()).toMatchObject({ ok: false, summary: expect.stringMatching(/维护租约/) });
  });

  test("result.json is written before the lease is let go; a second launch never reruns", async () => {
    const r = request(), f = fake(), log: string[] = [];
    const held = () => { log.push(existsSync(join(r.dir, "result.json")) ? "held-after" : "held"); return true; };
    await runDeployJob(r.path, { run: f.run, acquire: async () => { log.push("acquire"); return lease(held, log); } });
    expect(r.result()).toMatchObject({ ok: true, intentId: "m9", mergeSha: SHA });
    expect(log.at(-1)).toBe("release");
    expect(JSON.parse(readFileSync(join(r.dir, "lease.json"), "utf8"))).toMatchObject({ path: "/l", token: "t" });
    const again = fake();
    expect(await runDeployJob(r.path, { run: again.run, acquire: async () => lease(() => true, []) })).toBeNull();
    expect(again.calls).toHaveLength(0);
  });

  test("a launch whose started marker already exists does nothing even without a result", async () => {
    const r = request(), f = fake();
    mkdirSync(join(r.dir, "started"));
    expect(await runDeployJob(r.path, { run: f.run, acquire: async () => lease(() => true, []) })).toBeNull();
    expect(existsSync(join(r.dir, "result.json"))).toBe(false);
  });
});

describe("T68g deploy worker, booted out", () => {
  test("P1 killed mid-deploy: SIGTERM leaves a result and frees the lease before exiting, the running step dies with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t68g-sigterm-"));
    try {
      const path = join(dir, "request.json"), lockDir = join(dir, "lock");
      writeJsonAtomicSync(path, { intentId: "m9", mergeSha: SHA, taskId: "T9", prRef: "https://github.com/a/b/pull/7",
        label: `com.claudestra.scheduler.deploy.${"a".repeat(32)}`, repoDir: dir, relayArgv: null, restartLabels: LABELS,
        timeoutMs: 600_000, createdAt: Date.now(), env: {} });
      const src = `const { runDeployJob } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/scheduler-deploy-worker.ts"))});
        const { acquireLock } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/file-lock.ts"))});
        const { runBounded } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/run-bounded.ts"))});
        const acquire = async () => Object.assign(await acquireLock(${JSON.stringify(lockDir)}, 0), { path: ${JSON.stringify(lockDir)} });
        const run = (argv, o) => argv.includes("--abbrev-ref") ? runBounded(["/bin/sh", "-c", "echo $$ > ${dir}/step.pid; exec sleep 60"], o) : runBounded(argv, o);
        await runDeployJob(${JSON.stringify(path)}, { acquire, run });`;
      const child = Bun.spawn(["bun", "-e", src], { stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 100 && !existsSync(join(dir, "step.pid")); i++) await Bun.sleep(50);
      const stepPid = Number(readFileSync(join(dir, "step.pid"), "utf8"));
      expect(existsSync(lockDir)).toBe(true);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toMatchObject({ ok: false, summary: expect.stringMatching(/SIGTERM/) });
      expect(existsSync(lockDir)).toBe(false);
      await Bun.sleep(100);
      expect(() => process.kill(stepPid, 0)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

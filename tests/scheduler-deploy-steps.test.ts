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
    await runDeployJob(r.path, { run: f.run, acquire: async () => { log.push("acquire"); return lease(() => { log.push(existsSync(join(r.dir, "result.json")) ? "held-after" : "held"); return true; }, log); } });
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

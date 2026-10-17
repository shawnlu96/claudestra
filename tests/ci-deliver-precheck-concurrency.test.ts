/**
 * merge-arch-CIPRECHK1 · 预检与全量测试闸（FULLGATE1，src/lib/full-test-gate.ts）混跑：预检的测试经被检副本的 scripts/test.ts 进同一道闸，
 * 只带文件（闸按 focused 放行，不占也不另计全量名额），永远起不出不带文件的全量。临时仓库的 scripts/test.ts 调真实的 runFullTestGate，
 * bun test 换成假的子进程（等 go-<名> 才退出）；闸目录是临时的，不碰宿主闸。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTestArgs } from "../src/lib/full-test-gate-args.js";
import { writeGatePolicy } from "../src/lib/full-test-gate-policy.js";
import { readPermitEntries } from "../src/lib/full-test-gate.js";
import { type Inspection, runPrecheck } from "../src/lib/ci-deliver-precheck.js";
import { realPrecheckPort } from "../src/lib/ci-deliver-precheck-run.js";

const ROOT = join(import.meta.dir, "..");
let root: string, repo: string, gate: string;
const kids: ReturnType<typeof Bun.spawn>[] = [];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "precheck-gate-"));
  repo = join(root, "repo");
  gate = join(root, "gate");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeGatePolicy(gate, { mode: "on", max: 2, source: "precheck-concurrency-test" });
  writeFileSync(join(root, "fake.ts"), `
    import { appendFileSync, existsSync } from "node:fs";
    const name = process.env.HOLD || "pre";
    const log = (what) => appendFileSync(${JSON.stringify(join(root, "events"))}, JSON.stringify({ what, name, args: process.argv.slice(2),
      permit: process.env.CLAUDESTRA_FULL_TEST_PERMIT ?? null, at: Date.now() }) + "\\n");
    log("start");
    process.on("SIGTERM", () => { log("term"); process.exit(143); });
    if (process.env.KILLSELF) process.kill(process.pid, "SIGKILL");
    while (process.env.HOLD && !existsSync(${JSON.stringify(root)} + "/go-" + name)) {
      if (!existsSync(${JSON.stringify(root)})) process.exit(0);
      await Bun.sleep(20);
    }
    log("end");
  `);
  writeFileSync(join(repo, "scripts", "test.ts"), `
    import { runFullTestGate } from ${JSON.stringify(join(ROOT, "src/lib/full-test-gate.ts"))};
    const args = process.argv.slice(2);
    process.exit(await runFullTestGate({ args, command: [process.execPath, ${JSON.stringify(join(root, "fake.ts"))}, ...args], env: process.env,
      dir: process.env.PRECHK_GATE_DIR, pollMs: 50, drainMs: 2000 }));
  `);
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  git("init", "-q", "-b", "main");
  for (const k of ["PRECHK_GATE_DIR", "CI", "GITHUB_ACTIONS", "KILLSELF"]) saved[k] = process.env[k];
  Object.assign(process.env, { PRECHK_GATE_DIR: gate, CI: "", GITHUB_ACTIONS: "" });
});
afterAll(() => {
  for (const k of kids) k.kill("SIGKILL");
  for (const n of ["a", "b", "c"]) writeFileSync(join(root, `go-${n}`), "");
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

type Ev = { what: string; name: string; args: string[]; permit: string | null; at: number };
const events = (): Ev[] => existsSync(join(root, "events"))
  ? readFileSync(join(root, "events"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev) : [];
const until = async (ok: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(25)) if (Date.now() > end) throw new Error(`等不到：${JSON.stringify(events())}`);
};
/** 一个全量申请者：不带文件跑同一个 scripts/test.ts */
function full(name: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOLD: name };
  delete env.CLAUDESTRA_FULL_TEST_PERMIT;
  const k = Bun.spawn([process.execPath, "scripts/test.ts"], { cwd: repo, env, stdout: "ignore", stderr: "ignore" });
  kids.push(k);
  return k;
}
const active = () => (readPermitEntries(gate) ?? []).filter((e) => e.status === "active").length;
/** 时间线上同时在跑的全量（start 到 end / term）峰值 */
function peakFull(): number {
  let cur = 0, peak = 0;
  for (const e of events().filter((x) => x.name !== "pre").sort((x, y) => x.at - y.at)) {
    cur += e.what === "start" ? 1 : -1;
    peak = Math.max(peak, cur);
  }
  return peak;
}

describe("[验收线 3] 与全量测试闸混跑：全量最多 2 个，预检不占名额、不绕过", () => {
  test("两个全量占满、第三个排队时，预检照常只带文件跑完，名额与队列不变；取消一个全量后排队者才起；峰值始终 ≤ 2", async () => {
    const a = full("a");
    full("b");
    await until(() => events().filter((e) => e.what === "start").length === 2 && active() === 2);
    full("c");
    await until(() => (readPermitEntries(gate) ?? []).some((e) => e.status === "waiting"));
    const before = readPermitEntries(gate)!.map((e) => `${e.id}:${e.status}`).sort();

    const port = realPrecheckPort(), files = ["tests/x.test.ts", "tests/y.test.ts"];
    expect(await port.runTests(repo, files)).toEqual({ code: 0, tail: "" });
    const pre = events().filter((e) => e.name === "pre");
    expect(pre.map((e) => [e.what, e.args, e.permit])).toEqual([["start", ["./tests/x.test.ts", "./tests/y.test.ts"], "focused"], ["end", ["./tests/x.test.ts", "./tests/y.test.ts"], "focused"]]);
    expect(classifyTestArgs(pre[0]!.args).kind).toBe("focused");
    expect(readPermitEntries(gate)!.map((e) => `${e.id}:${e.status}`).sort()).toEqual(before);
    expect(events().filter((e) => e.name === "c")).toEqual([]);

    a.kill("SIGTERM"); // 取消一个持有者：它的名额释放后排队的 c 才起
    await until(() => events().some((e) => e.name === "c" && e.what === "start"));
    expect(events().some((e) => e.name === "a" && e.what === "term")).toBe(true);
    for (const n of ["b", "c"]) writeFileSync(join(root, `go-${n}`), "");
    await until(() => active() === 0);
    expect(peakFull()).toBeLessThanOrEqual(2);
  }, 60_000);

  test("预检永远不起不带文件的运行（那会是全量）；降级后没有改动测试就不起测试进程", async () => {
    const port = realPrecheckPort();
    await expect(port.runTests(repo, [])).rejects.toThrow("不带文件");
    const n = events().length;
    const ins: Inspection = { binding: { repo: "r", base: "b", mergeBase: "b", head: "a".repeat(40), status: "", selection: "s" }, run: "all", tests: [],
      reasons: ["全量触发：bun.lock（锁文件）"], changedTests: [], registration: [] };
    const r = await runPrecheck(repo, "a".repeat(40), { ...port, inspect: async () => ins, recall: () => null, remember: () => {} });
    expect(r).toMatchObject({ ok: true, scope: "degraded", ran: [] });
    expect(events().length).toBe(n);
  });

  test("预检的测试进程异常退出：算失败，不留名额", async () => {
    process.env.KILLSELF = "1";
    try {
      const r = await realPrecheckPort().runTests(repo, ["tests/x.test.ts"]);
      expect(r.code).not.toBe(0);
    } finally { delete process.env.KILLSELF; }
    expect(active()).toBe(0);
    expect((readPermitEntries(gate) ?? []).length).toBe(0);
  });
});

/**
 * hardening-CRONRUN1 [验收线 3]：最终停止带预期会话，走真实端口。
 * 子进程跑真实入口 src/cron.ts（临时 HOME）；PATH 里的 bun 是假 manager，但它的 remove / kill 就是真的 runRemove / runKill
 * （src/manager/agent-kill.ts + agent-remove-guard.ts，守卫从 cron 发来的 argv 原样解析），只把 registry / tmux / 频道换成
 * 一份落在临时目录的内存世界（tests/resumable-world.ts）。cron 这边不替 manager 比会话：比对发生在 manager 的保护区里。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cronRunKey, type CronRunRecord } from "../src/lib/cron-run-state";
import { testChildEnv } from "./test-env.ts";

const ROOT = join(import.meta.dir, "..");
const MINUTE = 60_000;

/** 假 manager 的本体：list 回放世界（第 swap.afterList 次回放完把同名 agent 换成新会话），remove / kill 在这个世界上跑真实实现 */
const FAKE_MANAGER = `
import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { runKill, runRemove } from ${JSON.stringify(join(ROOT, "src/manager/agent-kill.ts"))};
import { lifecycleRemoveOption } from ${JSON.stringify(join(ROOT, "src/manager/agent-remove-guard.ts"))};
import { makeWorld } from ${JSON.stringify(join(ROOT, "tests/resumable-world.ts"))};
const home = process.env.HOME, path = home + "/world.json";
const world = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("/src/manager.ts")) + 1);
const [cmd, raw, ...rest] = args;
const save = () => writeFileSync(path, JSON.stringify(world));
if (cmd === "list") {
  console.log(JSON.stringify({ ok: true, agents: Object.entries(world.agents).map(([name, a]) => ({ name, sessionId: a.sessionId })) }));
  world.lists = (world.lists ?? 0) + 1;
  if (world.swap && world.lists === world.swap.afterList) world.agents[world.swap.agent].sessionId = world.swap.sessionId;
  save();
} else if (cmd === "remove" || cmd === "kill") {
  const name = raw.startsWith("agent-") ? raw : "agent-" + raw;
  const before = structuredClone(world);
  const w = makeWorld({ reg: { socket: "s", agents: world.agents }, windows: world.windows });
  const guard = lifecycleRemoveOption(rest).lifecycle;
  const facts = {
    lock: () => () => {}, dropSettings: () => {},
    replan: async () => { throw new Error("合成世界没有生命周期台账"); },
    commit: async (mutate) => { const reg = await w.deps.loadRegistry(); const why = mutate(reg); if (!why) await w.deps.saveRegistry(reg); return why; },
  };
  const result = cmd === "kill" ? await runKill(name, w.deps) : await runRemove(name, w.deps, guard ? { lifecycle: { guard: guard.guard, facts } } : {});
  for (const win of before.windows) if (!w.st.windows.includes(win)) appendFileSync(home + "/closed.log", win + " " + before.agents[win]?.sessionId + "\\n");
  world.agents = w.st.reg.agents; world.windows = w.st.windows;
  save();
  console.log(JSON.stringify(result));
} else console.log(JSON.stringify({ ok: false, error: "fake" }));
`;

describe("真实入口 src/cron.ts → 真实 manager remove 守卫（子进程，临时 HOME，合成世界）", () => {
  let home = "";
  let env: Record<string, string> = {};
  const state = (n: string) => join(home, ".claude-orchestrator", n);
  const text = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const lines = (p: string) => text(join(home, p)).split("\n").filter(Boolean);
  const world = () => JSON.parse(text(join(home, "world.json"))) as { agents: Record<string, { sessionId: string }>; windows: string[]; lists?: number };
  const runs = () => (JSON.parse(text(state("cron-runs.json"))) as { runs: CronRunRecord[] }).runs;
  const agent = (sessionId: string) => ({ project: "p", purpose: "cron: nightly", created: "c", status: "active", notes: "", sessionId, cwd: "/nowhere" });
  /** 一条过了截止时间、身份是 S1 的重启记录 */
  const seed = (agents: Record<string, unknown>, swap?: { afterList: number; agent: string; sessionId: string }) => {
    const past = (min: number) => new Date(Date.now() - min * MINUTE).toISOString();
    const rec: CronRunRecord = {
      key: cronRunKey("nightly", 1), jobId: "nightly", jobName: "nightly", epochMinute: 1, historyId: "h1", owner: "999999.old.daemon",
      startedAt: past(50), deadlineAt: past(10), status: "running",
      temp: { agentName: "cron-nightly-orig", createAttemptedAt: past(50), sessionId: "S1", confirmedAt: past(49), promptAttemptedAt: past(49), supervision: "supervising" },
    };
    writeFileSync(state("cron-runs.json"), JSON.stringify({ version: 1, runs: [rec] }));
    writeFileSync(join(home, "world.json"), JSON.stringify({ agents, windows: Object.keys(agents), ...(swap ? { swap } : {}) }));
  };
  const recover = () => {
    const script = join(home, "recover.ts");
    writeFileSync(script, `const cron = await import(${JSON.stringify(join(ROOT, "src/cron.ts"))});\nconsole.log("RECOVERED=" + JSON.stringify(await cron.recoverCronRunsOnce()));\n`);
    return Bun.spawnSync([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cron-stop-"));
    const bin = join(home, "fakebin");
    mkdirSync(bin);
    mkdirSync(join(home, ".claude-orchestrator"));
    writeFileSync(join(home, "fake-manager.ts"), FAKE_MANAGER);
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "tmux.log")}'\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "bun.log")}'\nexec '${process.execPath}' '${join(home, "fake-manager.ts")}' "$@"\n`, { mode: 0o755 });
    env = testChildEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "rt"), CONTROL_CHANNEL_ID: "", LANG: "C" });
    return () => rmSync(home, { recursive: true, force: true });
  });

  test("[验收线 3] list 之后、停之前同名 agent 换成新会话：manager 按预期会话拒，新会话的窗口不关、条目不动，记录标待核", () => {
    // 恢复这一轮查两次 list（监督一次、停之前一次），两次看到的都是 S1；第二次查完才换成 S2，cron 这边已经没有机会再看
    seed({ "agent-cron-nightly-orig": agent("S1"), "agent-cc": agent("S1") }, { afterList: 2, agent: "agent-cron-nightly-orig", sessionId: "S2" });
    const r = recover();
    expect([r.exitCode, r.stdout.toString().trim(), world().lists]).toEqual([0, 'RECOVERED={"scanned":1,"failed":0}', 2]);
    expect(lines("closed.log")).toEqual([]); // 旧接线（manager kill <名字>）：["agent-cron-nightly-orig S2"]，新会话被停
    // cron 发出去的最终停止带着预期会话，不再是只认名字的 kill
    const stops = lines("bun.log").filter((l) => !l.endsWith(" list")).map((l) => l.replace(/^.*manager\.ts /, ""));
    expect(stops).toEqual(['remove cron-nightly-orig --lifecycle-guard {"sessionOnly":true,"sessionId":"S1"}']);
    expect([world().windows, world().agents["agent-cron-nightly-orig"].sessionId]).toEqual([["agent-cron-nightly-orig", "agent-cc"], "S2"]);
    expect(runs().map((x) => [x.status, x.temp?.supervision, x.temp?.cleanupError])).toEqual([["timeout", "needs-review", "同名 agent 的会话已变（现在是 S2）"]]);
    // 下一轮不再碰它
    expect(recover().exitCode).toBe(0);
    expect([lines("closed.log"), world().windows.length, lines("bun.log").filter((l) => !l.endsWith(" list")).length]).toEqual([[], 2, 1]);
  }, 60_000);

  test("[验收线 3] 会话没变：同一条真实端口收掉原会话（关窗、删条目），别的 agent 不动，记录清理完成", () => {
    seed({ "agent-cron-nightly-orig": agent("S1"), "agent-cc": agent("S1") });
    const r = recover();
    expect([r.exitCode, r.stdout.toString().trim()]).toEqual([0, 'RECOVERED={"scanned":1,"failed":0}']);
    expect(lines("closed.log")).toEqual(["agent-cron-nightly-orig S1"]);
    expect([world().windows, Object.keys(world().agents)]).toEqual([["agent-cc"], ["agent-cc"]]);
    expect(runs().map((x) => [x.status, x.temp?.supervision])).toEqual([["timeout", "cleaned"]]);
    expect(lines("bun.log").some((l) => / kill /.test(l))).toBe(false);
  }, 60_000);
});

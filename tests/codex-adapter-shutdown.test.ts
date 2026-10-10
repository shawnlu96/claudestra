// 统一受控收尾（I12、B57）：先用假进程树测步骤和时限，再起真适配器进程（main.ts）+ 假 codex app-server 子进程测 R8、R9、R22(a)、R23。
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter } from "../src/lib/acp/adapter-proc.ts";
import { CODEX_ACP_ADAPTER_MAIN } from "../src/lib/acp/codex-adapter/main.ts";
import type { Survivor } from "../src/lib/acp/codex-adapter/proc-tree.ts";
import { createShutdown, type Tree } from "../src/lib/acp/codex-adapter/shutdown.ts";
import type { FatalCause } from "../src/lib/acp/codex-adapter/turns.ts";
import { FailureDedup, type AcpFailure } from "../src/lib/acp/failures.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import type { SteerResult } from "../src/lib/acp/turn.ts";
import { testChildEnv } from "./test-env.ts";

/** 假进程树：aliveFor = 还要几次 kill 才死（Infinity = 杀不死） */
function fakeTree(aliveFor = 0, left: Survivor[] = []) {
  const steps: string[] = [];
  let kills = 0;
  const tree: Tree = {
    scan: async (full) => void steps.push(full ? "scan(full)" : "scan"),
    alive: () => kills < aliveFor,
    kill: (sig) => void (steps.push(sig), kills++),
    survivors: async () => (steps.push("survivors"), left),
  };
  return { tree, steps };
}

function run(o: { aliveFor?: number; left?: Survivor[]; appExits?: boolean; cause?: FatalCause; signal?: boolean }) {
  const t = fakeTree(o.aliveFor, o.left);
  const t0 = Date.now();
  const at: Record<string, number> = {};
  const mark = (s: string) => (t.steps.push(s), (at[s] = Date.now() - t0));
  let exited!: (code: number) => void;
  const exit = new Promise<number>((r) => (exited = r));
  const results: [FatalCause, string][] = [];
  const trigger = createShutdown({
    stop: () => void mark("stop"), closeAppStdin: () => void mark("closeStdin"),
    appExited: o.appExits ? Promise.resolve(0) : new Promise(() => {}), tree: t.tree,
    writeResults: (c, tail) => void (mark("results"), results.push([c, tail])), report: () => void mark("report"),
    flush: async () => void mark("flush"), exit: (code) => (mark("exit"), exited(code)), log: () => {},
    timings: { graceMs: 80, killMs: 160, fastKillMs: 50, drainMs: 30 },
  });
  trigger(o.cause ?? { kind: "stop", why: "stdin 关闭" }, { signal: o.signal });
  return { steps: t.steps, at, exit, results, trigger };
}

describe("收尾步骤（假进程树）", () => {
  test("EOF、app-server 自己退了、没有存活：停收 → 扫 → 关 stdin → 再扫 → 报存活 → 写结果 → 排空 → 退出码 0", async () => {
    const r = run({ appExits: true });
    expect(await r.exit).toBe(0);
    expect(r.steps).toEqual(["stop", "scan", "closeStdin", "scan", "survivors", "results", "flush", "exit"]);
    expect(r.results[0]![1]).toBe("");
  });

  test("app-server 卡死：0.8s 档 SIGTERM、1.6s 档 SIGKILL，杀完才写结果，卡上列出仍存活的进程；协议错误退出码 1", async () => {
    const left: Survivor[] = [{ pid: 42, ppid: 1, pgid: 42, exe: "daemon", role: "app", source: "env" }];
    const r = run({ aliveFor: Infinity, left, cause: { kind: "protocol", why: "坏行" } });
    expect(await r.exit).toBe(1);
    expect(r.steps).toEqual(["stop", "scan", "closeStdin", "scan", "SIGTERM", "scan", "SIGKILL", "survivors", "report", "results", "flush", "exit"]);
    expect(r.at.results!).toBeGreaterThanOrEqual(160);
    expect(r.results[0]![1]).toBe("；还有 1 个相关进程在运行（pid 42）");
  });

  test("信号快路径：扫完立即 SIGTERM，0.5s 档 SIGKILL，再写结果", async () => {
    const r = run({ aliveFor: Infinity, signal: true });
    expect(await r.exit).toBe(0);
    expect(r.steps.slice(0, 5)).toEqual(["stop", "scan", "closeStdin", "SIGTERM", "scan"]);
    expect(r.at.results!).toBeLessThan(160);
  });

  test("只收尾一次：第二个原因只记日志", async () => {
    const r = run({ appExits: true });
    r.trigger({ kind: "exit", why: "又来一次" });
    expect(await r.exit).toBe(0);
    expect(r.steps.filter((s) => s === "stop")).toHaveLength(1);
  });
});

describe("真适配器进程（main.ts + 假 codex app-server）", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-shutdown-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const codex = join(dir, "fake-codex");
  // 假 app-server：FAKE_MODE=crash 回合开始后崩溃；FAKE_STUBBORN=1 不理 EOF 和 SIGTERM 并带一个自成一组的子进程（像 MCP server）
  writeFileSync(codex, `#!${process.execPath}
if (process.argv[2] !== "app-server") process.exit(2);
const stubborn = process.env.FAKE_STUBBORN === "1";
if (stubborn) {
  process.on("SIGTERM", () => {});
  const c = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM',()=>{}); await Bun.sleep(60000)"], { detached: true, stdin: "ignore", stdout: "ignore" });
  console.error("child " + c.pid);
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const R = { initialize: { userAgent: "fake" }, "account/read": { account: {}, requiresOpenaiAuth: false }, "config/read": { config: {} },
  "model/list": { data: [], nextCursor: null }, "thread/start": { thread: { id: "th" }, model: "m", modelProvider: "fake", reasoningEffort: null } };
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === undefined) continue;
    if (R[m.method]) { send({ id: m.id, result: R[m.method] }); continue; }
    if (m.method === "turn/start") {
      send({ id: m.id, result: { turn: { id: "T1", items: [], status: "inProgress" } } });
      send({ method: "turn/started", params: { threadId: "th", turn: { id: "T1", items: [], status: "inProgress" } } });
      if (process.env.FAKE_MODE === "crash") setTimeout(() => process.exit(3), 20);
    }
  }
});
process.stdin.on("end", () => { if (!stubborn) process.exit(0); });
await Bun.sleep(600000);
`);
  chmodSync(codex, 0o755);
  const alive = (pid: number) => {
    const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    return r.exitCode === 0 && !String(r.stdout).trim().startsWith("Z");
  };

  async function start(extra: Record<string, string> = {}) {
    const logs: string[] = [];
    const env = testChildEnv({ CODEX_PATH: codex, INITIAL_AGENT_MODE: "agent-full-access", CODEX_CONFIG: "{}", ...extra });
    const proc = spawnAdapter([process.execPath, CODEX_ACP_ADAPTER_MAIN], env, dir, (m) => void logs.push(m), "cx");
    const session = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: (m) => void logs.push(m) });
    await session.initialize();
    await session.create(dir);
    const pidOf = (re: RegExp) => Number(logs.map((l) => re.exec(l)?.[1]).find(Boolean));
    return { proc, session, logs, pidOf };
  }

  test("R9 回合中途宿主关 stdin：适配器自己在 3s 内以码 0 退出（不靠宿主补 SIGTERM），app-server 进程组清空", async () => {
    const a = await start();
    void a.session.prompt("跑着");
    await Bun.sleep(100);
    const t0 = Date.now();
    a.proc.stop();
    expect(await a.proc.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
  }, 30_000);

  test("R8 R23 回合中 app-server 崩溃：那一轮按 transport_lost 失败恰好 1 张卡，适配器以码 1 退出", async () => {
    const a = await start({ FAKE_MODE: "crash" });
    const cards: AcpFailure[] = [];
    const dedup = new FailureDedup();
    const r = await a.session.prompt("跑着");
    if (r.kind === "failed" && dedup.admit(r.failure)) cards.push(r.failure);
    expect(cards).toEqual([expect.objectContaining({ kind: "error", key: "air:T1:error", retry: true, newSession: true })]);
    expect(cards[0]!.message).toContain("连接断了");
    expect(await a.proc.exited).toBe(1);
  }, 30_000);

  test("R23 steer 另起的回合中 app-server 崩溃：done 以信封里的失败收尾（air 键），只算一张卡", async () => {
    const a = await start({ FAKE_MODE: "crash" });
    const r = (await a.session.steer("插话")) as Extract<SteerResult, { outcome: "startedNewTurn" }>;
    expect(r.outcome).toBe("startedNewTurn");
    const done = await r.done;
    expect(done).toMatchObject({ kind: "failed", failure: { key: "air:T1:error", retry: true } });
    expect(await a.proc.exited).toBe(1);
  }, 30_000);

  test("R22(a) 顽固的 app-server（不理 EOF 和 SIGTERM、带自成一组的子进程）：EOF 后 3s 内以码 0 退出，app-server 和子进程都没了", async () => {
    const a = await start({ FAKE_STUBBORN: "1" });
    const child = a.pidOf(/child (\d+)/);
    expect(child).toBeGreaterThan(0);
    await Bun.sleep(2_200); // 等一次定期扫描把子进程登记下来（每 2s）
    const t0 = Date.now();
    a.proc.stop();
    expect(await a.proc.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
    for (let i = 0; i < 60 && alive(child); i++) await Bun.sleep(50);
    expect(alive(child)).toBe(false);
  }, 30_000);
});

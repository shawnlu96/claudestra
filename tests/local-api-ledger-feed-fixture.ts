/**
 * local-api-ledger 的 SSE 段：每个场景在独立子进程里跑（env -i + testChildEnv，临时 HOME / STATE / RUNTIME / TMP，bun --no-env-file），
 * ledger-feed 与 event-bus 的模块级状态每次都是新的；库是子进程临时目录里的真实文件，写者是另一个进程（runLedgerScript）。
 * 证据不靠等时长：子进程在 import ledger-feed 之前给 setInterval 包一层（照常调度、原样调用回调，不改轮询也不伪发事件），
 * 记下之后新建的定时器和每一轮的完成数——「没起轮询」= 订阅后没有新定时器；「轮询已覆盖写入」= 有一轮在写入落盘之后才开始并跑完。
 * 订阅都是真的 subscribeEvents + sseEventAllow，ledger 事件经真 emit 到 event-bus（同步分发给所有订阅者）；另有一条不经 sseEventAllow 的
 * 总线旁听（emitted），看轮询实际发了什么——第一条能读的连接是先建过滤器（起轮询、首轮 tick）再订阅的，首轮误发只有旁听看得到。
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import { runLedgerScript, seedLedger, tempLedgerPath } from "./ledger-test-helpers.js";
import { testChildEnv } from "./test-env.js";

export type FeedConn = { name: string; principal: Principal };
/**
 * e2e：conns 全部订阅好后写一条 p 的事件；lazy：先只订 denied、写 p，再订 reader、写 q；
 * agent：只建过滤器，看各 agent 的 assistant_text 放不放行。
 */
export type FeedScenario =
  | { kind: "e2e"; conns: FeedConn[] }
  | { kind: "lazy"; denied: FeedConn[]; reader: FeedConn }
  | { kind: "agent"; conns: FeedConn[]; agents: string[] };
/** got：每条连接收到的 ledger 事件 data；emitted：总线上实际发出的；timers：对应阶段新起的轮询定时器个数 */
export type E2eResult = { got: Record<string, unknown[]>; emitted: unknown[]; timers: number };
export type LazyResult = { deniedTimers: number; readerTimers: number; got: Record<string, unknown[]>; emitted: unknown[] };
export type AgentResult = Record<string, boolean[]>;

const RESULT = "FEED-RESULT ";

/** 父进程侧：起子进程跑一个场景，返回它的结果；子进程非 0 退出带上 stderr 抛错 */
export async function runFeedScenario<T>(scenario: FeedScenario): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ledger-feed-sse-"));
  for (const d of ["home", "state", "run", "tmp"]) mkdirSync(join(dir, d));
  const env = testChildEnv({ HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), CLAUDESTRA_STATE_DIR: join(dir, "state"), CLAUDESTRA_RUNTIME_DIR: join(dir, "run") });
  const child = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", import.meta.path, JSON.stringify(scenario)],
    { cwd: dir, env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const line = out.split("\n").find((l) => l.startsWith(RESULT));
  if (code !== 0 || !line) throw new Error(`feed fixture ${scenario.kind} exited ${code}:\n${err}\n${out}`);
  return JSON.parse(line.slice(RESULT.length)) as T;
}

/** 子进程侧：包 setInterval 的观测器。arm 之后新建的定时器计数，回调每跑完一轮 finished+1 并叫醒等待者 */
function installTickProbe() {
  const real = globalThis.setInterval;
  const s = { armed: false, timers: 0, finished: 0, waiters: [] as (() => void)[] };
  globalThis.setInterval = ((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (!s.armed) return real(cb, ms, ...rest);
    s.timers++;
    return real((...a: unknown[]) => {
      try {
        cb(...a);
      } finally {
        s.finished++;
        for (const w of s.waiters.splice(0)) w();
      }
    }, ms, ...rest);
  }) as typeof setInterval;
  /** 等到一轮在 mark（写入落盘时的完成数）之后开始并跑完；没有轮询定时器直接抛，不空等 */
  async function tickAfter(mark: number): Promise<void> {
    if (!s.timers) throw new Error("没有轮询定时器：等不到覆盖写入的那一轮");
    while (s.finished <= mark) await new Promise<void>((r) => s.waiters.push(r));
  }
  return { s, tickAfter };
}

async function runChild(scenario: FeedScenario): Promise<unknown> {
  const path = tempLedgerPath();
  seedLedger(path);
  const probe = installTickProbe();
  const { setLedgerFeedForTest, sseEventAllow } = await import("../src/bridge/ledger-feed.js");
  const { subscribeEvents } = await import("../src/bridge/event-bus.js");
  setLedgerFeedForTest({ path }); // 不给 emit = 真发到 event-bus
  probe.s.armed = true;
  if (scenario.kind === "agent") {
    const ev = (agent: string) => ({ seq: 1, ts: "2026-09-28T00:00:00Z", agent, chatId: "c", type: "assistant_text", data: {} });
    return Object.fromEntries(scenario.conns.map((c) => [c.name, scenario.agents.map((a) => sseEventAllow(c.principal)(ev(a)))]));
  }
  const got: Record<string, unknown[]> = {};
  const emitted: unknown[] = [];
  subscribeEvents({}, (e) => void (e.type === "ledger" && emitted.push(e.data)));
  const subscribe = (c: FeedConn) => {
    const list: unknown[] = (got[c.name] = []);
    subscribeEvents({ allow: sseEventAllow(c.principal) }, (e) => void (e.type === "ledger" && list.push(e.data)));
  };
  /** 写者进程写一条事件；返回落盘时的轮询完成数，给 tickAfter 当界 */
  const write = async (project: string) => {
    await runLedgerScript(path, `appendEvent(openLedger(path), { actor: "owner" }, { project: ${JSON.stringify(project)}, target: "", kind: "note", text: "x" });`);
    return probe.s.finished;
  };
  if (scenario.kind === "e2e") {
    scenario.conns.forEach(subscribe);
    await probe.tickAfter(await write("p"));
    return { got, emitted, timers: probe.s.timers } satisfies E2eResult;
  }
  scenario.denied.forEach(subscribe);
  await write("p");
  const deniedTimers = probe.s.timers;
  subscribe(scenario.reader); // 第一条能读的连接：起轮询并先记游标，之后的写入才发
  await probe.tickAfter(await write("q"));
  return { deniedTimers, readerTimers: probe.s.timers - deniedTimers, got, emitted } satisfies LazyResult;
}

if (import.meta.main) {
  const result = await runChild(JSON.parse(process.argv[2]!) as FeedScenario);
  console.log(RESULT + JSON.stringify(result));
  process.exit(0);
}

/**
 * BGP1：会话轮转（原生 /clear 等）前在跑的后台 subagent / shell，轮转后面板继续跟到真实结局。
 * 实报 2026-10-06：/clear 后 CC 把 4 个在跑 subagent 的后续写进新会话目录的同名 agent-<id>.jsonl（新目录没有 meta.json），
 * watcher 只跟旧路径 → 面板「静默」到 30 分钟收成「无动静」；新会话首扫把新文件当存量吞掉。
 * shell 的输出目录跟着 CC 进程走：轮转后新开的 shell 仍写进旧会话的 tasks/，只按 registry 的 sessionId 列目录会漏掉。
 * 隔离：HOME / shell 任务根都是本文件的临时目录。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { activeBgTasksFor, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus";
import { projectJsonlPath, subagentsDir } from "../src/lib/jsonl-cost";
import { ShellResults } from "../src/lib/bg-shell-results";

const MIN = 60_000;
let root = "";
let oldHome: string | undefined;
let clock = 1_800_000_000_000;
const events: BridgeEvent[] = [];
let unsub = () => {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bg-rotate-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  unsub = subscribeEvents({ allow: (e) => e.agent.startsWith("rot-") }, (e) => events.push(e));
});
afterAll(() => {
  unsub();
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

/** 一个 agent 的夹具：sessionId 可轮转；shell 任务根按 <root>/tmp/<name>/<会话>/tasks 排（slug = name，与生产 /tmp/claude-<uid>/<slug>/<会话>/tasks 同形） */
function fixture(name: string, o: { cwd?: string; session?: string } = {}) {
  const agent = { name: `rot-${name}`, channelId: `local-${name}`, cwd: o.cwd ?? join(root, "proj", name), sessionId: o.session ?? `${name}-A` };
  const tmpRoot = join(root, "tmp", name);
  const tasks = (sid: string) => join(tmpRoot, sid, "tasks");
  const jsonl = (sid = agent.sessionId) => projectJsonlPath(agent.cwd, sid);
  const sub = (id: string, sid = agent.sessionId) => join(subagentsDir(agent.cwd, sid), `agent-${id}.jsonl`);
  const enter = (sid: string) => {
    mkdirSync(join(jsonl(sid), ".."), { recursive: true });
    writeFileSync(jsonl(sid), "", { flag: "a" });
    mkdirSync(subagentsDir(agent.cwd, sid), { recursive: true });
  };
  enter(agent.sessionId);
  const poll = (advanceMs = 0) => {
    clock += advanceMs;
    return pollBgActivitiesForTest({ now: () => clock, agents: async () => [agent], shellDir: (_c, sid) => tasks(sid) });
  };
  /** registry 跟上轮转（原生 /clear 后 Stop 自愈 / clear 端点改写 sessionId） */
  const rotate = (sid: string) => {
    enter(sid);
    agent.sessionId = sid;
  };
  /** CC 在主会话 jsonl 里落的后台 shell 启动结果（带结构化 backgroundTaskId 与输出路径） */
  const launched = (id: string, outPath: string, sid = agent.sessionId) => {
    const text = `Command running in background with ID: ${id}. Output is being written to: ${outPath}. You will be notified when it completes.`;
    const line = { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text }] }] }, toolUseResult: { backgroundTaskId: id } };
    appendFileSync(jsonl(sid), JSON.stringify(line) + "\n");
  };
  const of = (id: string) => events.filter((e) => e.agent === agent.name && (e.data as { id?: string }).id === id);
  const typed = (id: string, type: string) => of(id).filter((e) => e.type === type);
  const active = (id: string) => activeBgTasksFor(agent.name).some((t) => t.id === id && !t.end);
  return { agent, tasks, jsonl, sub, poll, rotate, enter, launched, of, typed, active };
}

const rec = (type: string, content: unknown[], extra: Record<string, unknown> = {}, agentId?: string) =>
  JSON.stringify({ type, timestamp: new Date(clock).toISOString(), ...(agentId ? { agentId } : {}), message: { role: type, content, ...extra } }) + "\n";
const ask = (text: string, agentId?: string) => rec("user", [{ type: "text", text }], {}, agentId);
const toolResult = (agentId: string) => rec("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], {}, agentId);
const working = (id: string, agentId?: string) =>
  rec("assistant", [{ type: "tool_use", name: "Bash", input: { command: `bun test ${id}` } }], { id, stop_reason: "tool_use" }, agentId);
const answer = (id: string, text: string, agentId?: string) => rec("assistant", [{ type: "text", text }], { id, stop_reason: "end_turn" }, agentId);
const setMtime = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);
const statusOf = (e: BridgeEvent) => (e.data as { status: string }).status;

describe("bg-activity-watcher · 会话轮转后在跑的 subagent 按身份换绑到新文件", () => {
  test("复现：轮转后同 id 文件出现在新会话目录并写出答复 → 原卡收成 done；不开第二张卡，旧那份不再报「无动静」", async () => {
    const f = fixture("clear");
    await f.poll();
    writeFileSync(f.sub("x1").replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ description: "修 peer 取 files 404", agentType: "general-purpose" }));
    writeFileSync(f.sub("x1"), ask("task", "x1") + working("m1", "x1"));
    const t0 = clock;
    await f.poll(10_000);
    expect(f.typed("agent-x1", "bg_task_started")).toHaveLength(1);
    f.rotate("clear-B");
    clock += 7 * MIN; // registry 晚 7 分钟才跟上（实报 03:34 → 03:41）
    writeFileSync(f.sub("x1"), toolResult("x1") + working("m2", "x1")); // CC 接着写：首条是在途工具的结果
    await f.poll(10_000);
    expect(f.typed("agent-x1", "bg_task_started")).toHaveLength(1);
    expect(f.active("agent-x1")).toBe(true);
    const snap = activeBgTasksFor(f.agent.name).find((t) => t.id === "agent-x1")!;
    expect(snap.title).toBe("🤖 修 peer 取 files 404"); // 新目录没有 meta.json：标题仍是原描述
    expect(snap.startedAt).toBe(t0 + 10_000);
    appendFileSync(f.sub("x1"), answer("m3", "PR opened, all green", "x1"));
    await f.poll(10_000);
    expect(f.typed("agent-x1", "bg_task_completed").map(statusOf)).toEqual(["done"]);
    expect(f.of("agent-x1").flatMap((e) => (e.data as { items?: string[] }).items ?? []).some((l) => l.includes("all green"))).toBe(true);
    await f.poll(31 * MIN);
    await f.poll(10_000);
    expect(f.typed("agent-x1", "bg_task_completed").map(statusOf)).toEqual(["done"]);
    expect(f.typed("agent-x1", "bg_task_started")).toHaveLength(1);
  });

  test("轮转前最后几笔写在旧文件里：换绑时先读完，再接着读新文件", async () => {
    const f = fixture("tail");
    await f.poll();
    writeFileSync(f.sub("x2"), ask("task", "x2") + working("m1", "x2"));
    await f.poll(10_000);
    appendFileSync(f.sub("x2"), rec("assistant", [{ type: "text", text: "last words in the old file" }], { id: "m1b" }, "x2"));
    f.rotate("tail-B");
    writeFileSync(f.sub("x2"), toolResult("x2") + answer("m2", "done in the new file", "x2"));
    await f.poll(10_000);
    const lines = f.of("agent-x2").flatMap((e) => (e.data as { items?: string[] }).items ?? []);
    expect(lines.some((l) => l.includes("last words in the old file"))).toBe(true);
    expect(lines.some((l) => l.includes("done in the new file"))).toBe(true);
    expect(f.typed("agent-x2", "bg_task_completed").map(statusOf)).toEqual(["done"]);
  });

  test("新会话目录里不与活跃活动同 id 的存量照样吞掉、不回放；31 个在跑的仍受洪水闸，换绑那个不计入", async () => {
    const f = fixture("stock");
    await f.poll();
    writeFileSync(f.sub("live"), ask("task", "live") + working("m1", "live"));
    await f.poll(10_000);
    f.rotate("stock-B");
    writeFileSync(f.sub("old"), ask("go", "old") + working("o1", "old"));
    setMtime(f.sub("old"), clock - 60 * MIN);
    writeFileSync(f.sub("fin"), ask("go", "fin") + answer("f1", "finished long ago", "fin"));
    const flood = Array.from({ length: 31 }, (_, i) => `fl${i}`);
    for (const id of flood) {
      writeFileSync(f.sub(id), ask("go", id) + working(id, id));
      setMtime(f.sub(id), clock - 10_000); // 刚写过、没收尾 = 首轮分拣算「在跑」，才轮得到洪水闸
    }
    writeFileSync(f.sub("live"), toolResult("live") + working("m2", "live"));
    await f.poll(10_000);
    for (const id of ["old", "fin", ...flood]) expect(f.of(`agent-${id}`)).toEqual([]);
    expect(f.active("agent-live")).toBe(true);
    appendFileSync(f.sub("live"), answer("m3", "ok", "live"));
    await f.poll(10_000);
    expect(f.typed("agent-live", "bg_task_completed").map(statusOf)).toEqual(["done"]);
    expect(f.typed("agent-live", "bg_task_started")).toHaveLength(1);
  });
});

describe("bg-activity-watcher · 换绑不认错", () => {
  test("新文件首条记录的 agentId 对不上 → 不换绑，原活动照旧跟旧文件", async () => {
    const f = fixture("mismatch");
    await f.poll();
    writeFileSync(f.sub("y1"), ask("task", "y1") + working("m1", "y1"));
    await f.poll(10_000);
    f.rotate("mismatch-B");
    writeFileSync(f.sub("y1"), toolResult("someone-else") + answer("m2", "not mine", "someone-else"));
    setMtime(f.sub("y1"), clock - 60 * MIN);
    await f.poll(10_000);
    expect(f.typed("agent-y1", "bg_task_completed")).toEqual([]);
    appendFileSync(f.sub("y1", "mismatch-A"), answer("m3", "real answer in the old file", "y1"));
    await f.poll(10_000);
    expect(f.typed("agent-y1", "bg_task_completed").map(statusOf)).toEqual(["done"]);
    const lines = f.of("agent-y1").flatMap((e) => (e.data as { items?: string[] }).items ?? []);
    expect(lines.some((l) => l.includes("not mine"))).toBe(false);
  });

  test("同 cwd 的另一个 agent 会话目录里有同 id 文件 → 不换走本 agent 的活动", async () => {
    const cwd = join(root, "proj", "shared");
    const p = fixture("ownerP", { cwd, session: "P-1" });
    const q = fixture("ownerQ", { cwd, session: "Q-1" });
    await p.poll();
    await q.poll();
    writeFileSync(p.sub("z1"), ask("task", "z1") + working("m1", "z1"));
    await p.poll(10_000);
    p.rotate("P-2"); // P 轮转了，但续写还没出现
    writeFileSync(q.sub("z1"), toolResult("z1") + answer("m2", "Q's file", "z1"));
    await q.poll(10_000);
    await p.poll(0);
    expect(p.active("agent-z1")).toBe(true);
    expect(p.typed("agent-z1", "bg_task_completed")).toEqual([]);
    writeFileSync(p.sub("z1"), toolResult("z1") + answer("m3", "P's own answer", "z1"));
    await p.poll(10_000);
    expect(p.typed("agent-z1", "bg_task_completed").map(statusOf)).toEqual(["done"]);
    const lines = p.of("agent-z1").flatMap((e) => (e.data as { items?: string[] }).items ?? []);
    expect(lines.some((l) => l.includes("P's own answer"))).toBe(true);
    expect(lines.some((l) => l.includes("Q's file"))).toBe(false);
  });

  test("新会话目录里是整份拷贝（首条早于旧文件最后一条）→ 不当续写换绑，不重放历史", async () => {
    const f = fixture("copy");
    await f.poll();
    writeFileSync(f.sub("c1"), ask("task", "c1") + working("m1", "c1"));
    await f.poll(10_000);
    appendFileSync(f.sub("c1"), toolResult("c1") + working("m2", "c1"));
    await f.poll(10_000);
    f.rotate("copy-B");
    copyFileSync(f.sub("c1", "copy-A"), f.sub("c1"));
    setMtime(f.sub("c1"), clock - 60 * MIN);
    await f.poll(10_000);
    appendFileSync(f.sub("c1", "copy-A"), answer("m3", "answer in the old file", "c1"));
    await f.poll(10_000);
    expect(f.typed("agent-c1", "bg_task_completed").map(statusOf)).toEqual(["done"]);
    const tools = f.of("agent-c1").flatMap((e) => (e.data as { items?: string[] }).items ?? []).filter((l) => l.includes("🔧"));
    expect(tools).toHaveLength(2);
  });

  test("新文件首行还没写完 → 这一轮先不动（不当新卡、不当存量），写完后换绑", async () => {
    const f = fixture("half");
    await f.poll();
    writeFileSync(f.sub("h1"), ask("task", "h1") + working("m1", "h1"));
    await f.poll(10_000);
    f.rotate("half-B");
    const first = toolResult("h1");
    writeFileSync(f.sub("h1"), first.slice(0, 20));
    await f.poll(10_000);
    expect(f.typed("agent-h1", "bg_task_started")).toHaveLength(1);
    appendFileSync(f.sub("h1"), first.slice(20) + answer("m2", "finished", "h1"));
    await f.poll(10_000);
    expect(f.typed("agent-h1", "bg_task_started")).toHaveLength(1);
    expect(f.typed("agent-h1", "bg_task_completed").map(statusOf)).toEqual(["done"]);
  });
});

describe("bg-activity-watcher · 轮转后新开的 shell 写在旧会话的 tasks/", () => {
  test("bridge 一直在跑：轮转后主会话新开的 shell 按 CC 报的目录跟上并收尾；轮转前在跑的 shell 不被重复开卡", async () => {
    const f = fixture("shell-live");
    mkdirSync(f.tasks("shell-live-A"), { recursive: true });
    writeFileSync(join(f.tasks("shell-live-A"), "stock.output"), "[exited with code 0]\n");
    await f.poll();
    const s0 = join(f.tasks("shell-live-A"), "s0.output");
    writeFileSync(s0, "running\n");
    f.launched("s0", s0);
    await f.poll(10_000);
    expect(f.typed("s0", "bg_task_started")).toHaveLength(1);
    f.rotate("shell-live-B");
    const s2 = join(f.tasks("shell-live-A"), "s2.output");
    writeFileSync(s2, "second\n");
    setMtime(s2, clock); // 轮转后新会话首轮：shell 按首轮分拣，刚建的文件算「在跑」
    f.launched("s2", "/private" + s2); // CC 报的是 realpath（macOS 的 /private/var/…）
    appendFileSync(s0, "still going\n");
    setMtime(s0, clock); // 刚写过：同一个文件换个路径写法就会被当新文件再开一张卡
    await f.poll(10_000);
    expect(f.typed("s2", "bg_task_started")).toHaveLength(1);
    expect(f.typed("s0", "bg_task_started")).toHaveLength(1);
    expect(f.of("stock")).toEqual([]);
    appendFileSync(s2, "[exited with code 0]\n");
    appendFileSync(s0, "[exited with code 3]\n");
    await f.poll(10_000);
    expect(f.typed("s2", "bg_task_completed")[0]?.data).toMatchObject({ status: "done", exitCode: 0 });
    expect(f.typed("s0", "bg_task_completed")[0]?.data).toMatchObject({ status: "done", exitCode: 3 });
  });

  test("registry 滞后：/clear 后新会话里开的 shell 先因确认读的是旧会话 jsonl 被跳过，registry 跟上后按 CC 的启动结果接回并收尾", async () => {
    const f = fixture("shell-lag");
    mkdirSync(f.tasks("shell-lag-A"), { recursive: true });
    await f.poll();
    f.enter("shell-lag-B"); // CC 已轮转到 B，registry 还指着 A（Stop 自愈要等旧 jsonl 静默 3 分钟）
    const lag = join(f.tasks("shell-lag-A"), "lag1.output");
    writeFileSync(lag, "working\n");
    f.launched("lag1", lag, "shell-lag-B");
    await f.poll(10_000);
    await f.poll(70_000); // 超过真 bg 确认超时：当前台瞬时文件跳过
    expect(f.of("lag1")).toEqual([]);
    f.rotate("shell-lag-B");
    await f.poll(10_000);
    expect(f.typed("lag1", "bg_task_started")).toHaveLength(1);
    // 开始时刻取自输出文件建出的时刻，不是迟到确认那一刻（夹具时钟比真实文件时间晚得多）
    expect((f.typed("lag1", "bg_task_started")[0].data as { progress: { startedTs: number } }).progress.startedTs).toBeLessThan(clock - 10 * MIN);
    appendFileSync(lag, "[exited with code 0]\n");
    await f.poll(10_000);
    expect(f.typed("lag1", "bg_task_completed")[0]?.data).toMatchObject({ status: "done", exitCode: 0 });
  });

  test("轮转前开始、轮转后才结束的 shell：结局记进当前会话，刷新快照里能看到（不是只写进旧会话的结果）", async () => {
    const f = fixture("shell-scope");
    mkdirSync(f.tasks("shell-scope-A"), { recursive: true });
    await f.poll();
    const s0 = join(f.tasks("shell-scope-A"), "keep1.output");
    writeFileSync(s0, "running\n");
    f.launched("keep1", s0);
    await f.poll(10_000);
    expect(f.typed("keep1", "bg_task_started")).toHaveLength(1);
    f.rotate("shell-scope-B");
    await f.poll(10_000);
    appendFileSync(s0, "[exited with code 0]\n");
    await f.poll(10_000);
    expect(f.typed("keep1", "bg_task_completed")[0]?.data).toMatchObject({ status: "done", exitCode: 0 });
    const snap = activeBgTasksFor(f.agent.name).find((t) => t.id === "keep1");
    expect(snap?.end).toMatchObject({ status: "done", exitCode: 0 });
  });

  test("bridge 重启：当前会话记成 unknown、输出在旧会话 tasks/ 且没被报过 → 按 id 在同根的会话目录里找回，按末行更正", async () => {
    const f = fixture("shell-find", { session: "shell-find-B" });
    const dirA = f.tasks("shell-find-A");
    mkdirSync(dirA, { recursive: true });
    const out = join(dirA, "lost1.output");
    writeFileSync(out, "work\n[exited with code 0]\n");
    await new ShellResults().remember({ agentName: f.agent.name, sessionId: f.agent.sessionId, id: "lost1", startedAt: clock - 20 * MIN, lastGrowth: clock - 5 * MIN, exitCode: null });
    await f.poll(); // 冷启动：这个 agent-session 首次被扫到
    expect(f.typed("lost1", "bg_task_completed")[0]?.data).toMatchObject({ status: "done", exitCode: 0 });
    expect(activeBgTasksFor(f.agent.name).find((t) => t.id === "lost1")?.end).toMatchObject({ status: "done", exitCode: 0 });
    expect(f.typed("lost1", "bg_task_started")).toEqual([]);
  });

  test("bridge 重启后才见到新会话：CC 报过的旧 tasks 目录按首轮分拣——在跑的开流，40 个旧文件不回放、不冲洪水闸", async () => {
    const f = fixture("shell-cold", { session: "shell-cold-B" });
    const dirA = f.tasks("shell-cold-A");
    mkdirSync(dirA, { recursive: true });
    for (let i = 0; i < 40; i++) {
      const p = join(dirA, `old${i}.output`);
      writeFileSync(p, "x\n");
      setMtime(p, clock - 60 * MIN);
    }
    const run = join(dirA, "run1.output");
    writeFileSync(run, "working\n");
    setMtime(run, clock - 5_000);
    f.launched("run1", run);
    await f.poll();
    expect(f.typed("run1", "bg_task_started")).toHaveLength(1);
    for (let i = 0; i < 40; i++) expect(f.of(`old${i}`)).toEqual([]);
    appendFileSync(run, "[exited with code 0]\n");
    await f.poll(10_000);
    expect(f.typed("run1", "bg_task_completed")[0]?.data).toMatchObject({ status: "done", exitCode: 0 });
  });

  test("只认 CC 落的结构化启动结果：正文里引用的同款句子不会让别的会话目录被列进来", async () => {
    const f = fixture("shell-fake");
    await f.poll();
    const dirZ = f.tasks("someone-else");
    mkdirSync(dirZ, { recursive: true });
    const zz = join(dirZ, "zz.output");
    writeFileSync(zz, "not ours\n");
    setMtime(zz, clock); // 刚写过：目录一旦被误列进来就会开卡
    const quoted = `Command running in background with ID: zz. Output is being written to: ${zz}.`;
    appendFileSync(f.jsonl(), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: quoted }] } }) + "\n");
    await f.poll(10_000);
    await f.poll(2 * MIN);
    expect(f.of("zz")).toEqual([]);
  });
});

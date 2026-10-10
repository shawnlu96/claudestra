/**
 * bg-shell-state-FIX：后台 shell 的 bridge 收尾链路（真实文件 + 可控时钟 + 真 tick / event-bus）。
 * 实报：`bun test > log 2>&1` 跑在后台，3 分钟输出不增长被判结束，实际 12 分钟才结束。
 * 旧红：main 上第 3 分钟那轮 poll 就 finalize（bg_task_completed status=idle）并移出活跃跟踪。
 * 新绿：静默 3/4/12 分钟都还在跟踪；只有完整到达的独立末行 [exited with code N] 收尾一次；文件消失 = unknown。
 * 隔离：HOME / shell 任务目录都是本文件的临时目录，不碰真实 ~/.claude 或 /tmp/claude-<uid>。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { activeBgTasksFor, hasActiveBgActivities, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher";
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
  root = mkdtempSync(join(tmpdir(), "bg-shell-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  unsub = subscribeEvents({ allow: (e) => e.agent.startsWith("shellfix-") }, (e) => events.push(e));
});
afterAll(() => {
  unsub();
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

/** 一个 agent-session 的夹具：主会话 jsonl（真 bg 确认）+ tasks/ 目录 */
function fixture(name: string) {
  const agent = { name: `shellfix-${name}`, channelId: `local-${name}`, cwd: join(root, "proj", name), sessionId: `sess-${name}` };
  const tasks = join(root, "tasks", name);
  mkdirSync(tasks, { recursive: true });
  const jsonl = projectJsonlPath(agent.cwd, agent.sessionId);
  mkdirSync(join(jsonl, ".."), { recursive: true });
  writeFileSync(jsonl, "");
  const poll = (advanceMs = 0) => {
    clock += advanceMs;
    return pollBgActivitiesForTest({ now: () => clock, agents: async () => [agent], shellDir: () => tasks });
  };
  const confirmBg = (id: string) => {
    const result = { type: "tool_result", content: `Command running in background with ID: ${id}` };
    appendFileSync(jsonl, JSON.stringify({ type: "user", message: { content: [result] } }) + "\n");
  };
  const out = (id: string) => join(tasks, `${id}.output`);
  const subs = subagentsDir(agent.cwd, agent.sessionId);
  mkdirSync(subs, { recursive: true });
  const sub = (id: string) => join(subs, `agent-${id}.jsonl`);
  const of = (id: string) => events.filter((e) => e.agent === agent.name && (e.data as { id?: string }).id === id);
  const completed = (id: string) => of(id).filter((e) => e.type === "bg_task_completed");
  /** 仍在跟踪（快照里近期已收尾的 shell 带 end，不算） */
  const active = (id: string) => activeBgTasksFor(agent.name).some((t) => t.id === id && !t.end);
  return { agent, tasks, poll, confirmBg, out, sub, of, completed, active };
}

describe("bg-activity-watcher · 后台 shell", () => {
  test("复现：重定向日志静默 3/4/12 分钟都不收尾，真实退出行到达才收尾一次（非 0 也带退出码）", async () => {
    const f = fixture("silent");
    await f.poll(); // 首轮 baseline
    writeFileSync(f.out("b1"), "$ bun test > /tmp/x.log 2>&1\n");
    f.confirmBg("b1");
    await f.poll(10_000);
    expect(f.active("b1")).toBe(true);
    expect(f.of("b1").find((e) => e.type === "bg_task_started")?.data).toMatchObject({ kind: "shell", progress: { startedTs: clock } });

    for (const at of [3, 4, 12]) {
      while (clock < 1_800_000_000_000 + at * MIN + 20_000) await f.poll(10_000);
      expect(f.completed("b1")).toEqual([]);
      expect(f.active("b1")).toBe(true);
      expect(hasActiveBgActivities(f.agent.name)).toBe(true);
    }
    const snap = activeBgTasksFor(f.agent.name).find((t) => t.id === "b1")!;
    expect((snap.progress as { lastTs: number }).lastTs).toBeLessThan(clock - 11 * MIN); // 快照带最后输出时刻（前端「已多久无输出」）

    appendFileSync(f.out("b1"), "late line\n[exited with co"); // 退出行分块到达
    await f.poll(10_000);
    expect(f.completed("b1")).toEqual([]);
    appendFileSync(f.out("b1"), "de 1]\r\n");
    await f.poll(10_000);
    await f.poll(10_000); // 重复 poll 不重复收尾
    expect(f.completed("b1")).toHaveLength(1);
    expect(f.completed("b1")[0].data).toMatchObject({ kind: "shell", status: "done", exitCode: 1 });
    expect(f.active("b1")).toBe(false);
    // 收尾前最后一条 update 的末行就是退出行（web 端据此拿退出码）
    const lastUpdate = f.of("b1").filter((e) => e.type === "bg_task_update").pop()!;
    expect((lastUpdate.data as { items: string[] }).items.at(-1)).toBe("[exited with code 1]");
  });

  test("日志里提到相似字符串 / 退出行后面还有输出 → 不收尾；没补换行的退出行等下一轮不增长再收", async () => {
    const f = fixture("mention");
    await f.poll();
    writeFileSync(f.out("m1"), "echo '[exited with code 0]'\n[exited with code 0]\nstill running\n[exited with code 0");
    f.confirmBg("m1");
    await f.poll(10_000);
    await f.poll(10_000);
    await f.poll(5 * MIN);
    expect(f.completed("m1")).toEqual([]);
    expect(f.active("m1")).toBe(true);

    appendFileSync(f.out("m1"), "]\n[exited with code 0]");
    await f.poll(10_000); // 本轮有增长：残尾可能还会长，先不认
    expect(f.completed("m1")).toEqual([]);
    await f.poll(10_000);
    expect(f.completed("m1")).toHaveLength(1);
    expect(f.completed("m1")[0].data).toMatchObject({ status: "done", exitCode: 0 });
  });

  test("输出文件被清理：宽限期内只算还没出现、照旧跟踪；一直不出现才收尾 unknown（不是 done / 成功），exitCode null", async () => {
    const f = fixture("gone");
    await f.poll();
    writeFileSync(f.out("g1"), "working\n");
    f.confirmBg("g1");
    await f.poll(10_000);
    unlinkSync(f.out("g1"));
    await f.poll(10_000);
    await f.poll(10_000);
    expect(f.completed("g1")).toEqual([]);
    expect(f.active("g1")).toBe(true);
    await f.poll(MIN);
    expect(f.completed("g1")).toHaveLength(1);
    expect(f.completed("g1")[0].data).toMatchObject({ status: "unknown", exitCode: null });
    // 刷新后快照仍带着「状态未知」的结局（不是消失、不是成功）
    expect(activeBgTasksFor(f.agent.name).find((t) => t.id === "g1")).toMatchObject({ kind: "shell", end: { status: "unknown", exitCode: null } });
    await f.poll(10 * MIN);
    expect(f.completed("g1")).toHaveLength(1);
  });

  test("刚启动输出文件就不见了（磁盘满时还没建出来）：宽限期内又出现、只有退出行 → 照常收尾 done exit 0", async () => {
    const f = fixture("late");
    await f.poll();
    writeFileSync(f.out("l1"), "");
    f.confirmBg("l1");
    await f.poll(10_000);
    unlinkSync(f.out("l1"));
    await f.poll(10_000);
    expect(f.completed("l1")).toEqual([]);
    writeFileSync(f.out("l1"), "\n[exited with code 0]\n");
    await f.poll(10_000);
    expect(f.completed("l1")).toHaveLength(1);
    expect(f.completed("l1")[0].data).toMatchObject({ status: "done", exitCode: 0 });
  });

  test("已判 unknown 之后输出文件才出现、末尾是退出行 → 重新跟上并更正为 done exit 0（快照同步更正）", async () => {
    const f = fixture("revive");
    await f.poll();
    writeFileSync(f.out("v1"), "");
    f.confirmBg("v1");
    await f.poll(10_000);
    unlinkSync(f.out("v1"));
    await f.poll(10_000);
    await f.poll(2 * MIN);
    const statuses = () => f.completed("v1").map((e) => (e.data as { status: string }).status);
    expect(statuses()).toEqual(["unknown"]);
    writeFileSync(f.out("v1"), "\n[exited with code 0]\n");
    await f.poll(10_000);
    expect(statuses()).toEqual(["unknown", "done"]);
    expect(f.completed("v1")[1].data).toMatchObject({ status: "done", exitCode: 0 });
    const snaps = activeBgTasksFor(f.agent.name).filter((t) => t.id === "v1");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ end: { status: "done", exitCode: 0 } });
  });

  test("批量恢复：已确认的 31 个 shell 全部消失超过宽限期后同时重现 → 按原身份接着跟、全部更正为 done，不计入洪水闸；真正的新文件照旧受闸", async () => {
    const f = fixture("bulk");
    await f.poll();
    const ids = Array.from({ length: 31 }, (_, i) => `bulk${i}`);
    for (const batch of [ids.slice(0, 16), ids.slice(16)]) { // 分两批起：单轮新增都不超过洪水闸
      for (const id of batch) {
        writeFileSync(f.out(id), "working\n");
        f.confirmBg(id);
      }
      await f.poll(10_000);
    }
    expect(ids.every((id) => f.active(id))).toBe(true);
    for (const id of ids) unlinkSync(f.out(id));
    await f.poll(10_000);
    await f.poll(2 * MIN);
    const statuses = (id: string) => f.completed(id).map((e) => (e.data as { status: string }).status);
    expect(ids.map(statuses)).toEqual(ids.map(() => ["unknown"]));

    // 31 个恢复 + 20 个真新文件同一轮出现：恢复不算新文件，20 个新文件不触发洪水闸
    const fresh = Array.from({ length: 20 }, (_, i) => `fresh${i}`);
    for (const id of ids) writeFileSync(f.out(id), "\n[exited with code 0]\n");
    for (const id of fresh) {
      writeFileSync(f.out(id), "serving\n");
      f.confirmBg(id);
    }
    await f.poll(10_000);
    expect(ids.map(statuses)).toEqual(ids.map(() => ["unknown", "done"]));
    for (const id of ids) expect(f.completed(id)[1].data).toMatchObject({ exitCode: 0 });
    expect(fresh.every((id) => f.active(id))).toBe(true);
    const ended = activeBgTasksFor(f.agent.name).filter((t) => t.end);
    expect(ended).toHaveLength(8);
    expect(ended.every((t) => (t.end as { status: string }).status === "done")).toBe(true);

    // 真正的存量洪水（单轮 31 个新文件）照旧按存量处理，不开流
    const stock = Array.from({ length: 31 }, (_, i) => `stock${i}`);
    for (const id of stock) {
      writeFileSync(f.out(id), "old\n");
      f.confirmBg(id);
    }
    await f.poll(10_000);
    await f.poll(10_000);
    for (const id of stock) expect(f.of(id)).toEqual([]);
  });

  test("消失后同名 .output 换成软链（后台 subagent 的对话记录）→ 不恢复、不收尾，原任务保持 unknown", async () => {
    const f = fixture("relink");
    await f.poll();
    writeFileSync(f.out("s1"), "working\n");
    f.confirmBg("s1");
    await f.poll(10_000);
    unlinkSync(f.out("s1"));
    await f.poll(10_000);
    await f.poll(2 * MIN);
    const statuses = () => f.completed("s1").map((e) => (e.data as { status: string }).status);
    expect(statuses()).toEqual(["unknown"]);
    writeFileSync(join(f.tasks, "agent-s1.jsonl"), '{"type":"assistant"}\n[killed]\n');
    symlinkSync(join(f.tasks, "agent-s1.jsonl"), f.out("s1"));
    await f.poll(10_000);
    await f.poll(10_000);
    expect(statuses()).toEqual(["unknown"]);
    expect(f.of("s1").filter((e) => e.type === "bg_task_started")).toHaveLength(1);
    expect(f.active("s1")).toBe(false);
    expect(activeBgTasksFor(f.agent.name).find((t) => t.id === "s1")).toMatchObject({ end: { status: "unknown", exitCode: null } });
  });

  test("被结束：末行独立 [killed]（前面可有 SIGTERM 行）→ status stopped、exitCode null，快照还原成已停止；输出里提到 [killed] 不算", async () => {
    const f = fixture("killed");
    await f.poll();
    writeFileSync(f.out("k1"), "serving\n");
    writeFileSync(f.out("k2"), "x\n");
    f.confirmBg("k1");
    f.confirmBg("k2");
    await f.poll(10_000);
    appendFileSync(f.out("k1"), "SIGTERM (Polite quit request)\n\n[killed]\n");
    appendFileSync(f.out("k2"), "echo [killed]\n[killed]\nstill running\n");
    await f.poll(10_000);
    await f.poll(10_000);
    expect(f.completed("k1")).toHaveLength(1);
    expect(f.completed("k1")[0].data).toMatchObject({ kind: "shell", status: "stopped", exitCode: null });
    const lastUpdate = f.of("k1").filter((e) => e.type === "bg_task_update").pop()!;
    expect((lastUpdate.data as { items: string[] }).items.at(-1)).toBe("[killed]");
    expect(activeBgTasksFor(f.agent.name).find((t) => t.id === "k1")).toMatchObject({ end: { status: "stopped", exitCode: null }, lines: ["[killed]"] });
    expect(f.completed("k2")).toEqual([]);
    expect(f.active("k2")).toBe(true);
  });

  test("已确认的退出结果留在快照里（刷新 / 新连接据此还原），按 agent 封顶 8 个、31 分钟后仍保留", async () => {
    const f = fixture("ended");
    await f.poll();
    writeFileSync(f.out("e1"), "boom\n[exited with code 3]\n");
    f.confirmBg("e1");
    await f.poll(10_000);
    await f.poll(10_000);
    expect(f.completed("e1")).toHaveLength(1);
    expect(hasActiveBgActivities(f.agent.name)).toBe(false); // bgPending 不受影响：已结束的不算活跃
    const snap = activeBgTasksFor(f.agent.name).find((t) => t.id === "e1")!;
    expect(snap).toMatchObject({ kind: "shell", end: { status: "done", exitCode: 3 } });
    expect(snap.lines.at(-1)).toBe("[exited with code 3]");
    for (let i = 0; i < 9; i++) {
      writeFileSync(f.out(`n${i}`), "[exited with code 0]\n");
      f.confirmBg(`n${i}`);
    }
    await f.poll(10_000);
    const ids = activeBgTasksFor(f.agent.name).map((t) => t.id);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain("e1");
    clock += 31 * MIN;
    expect(activeBgTasksFor(f.agent.name).map((t) => t.id)).toEqual(ids);
  });

  test("读失败 → 进度带 unreadable 发给前端 / 进快照（不收尾、不推进），读通后恢复并补上漏掉的输出", async () => {
    const f = fixture("eacces");
    await f.poll();
    writeFileSync(f.out("r1"), "start\n");
    f.confirmBg("r1");
    await f.poll(10_000);
    await f.poll(10_000);
    appendFileSync(f.out("r1"), "more\n");
    chmodSync(f.out("r1"), 0o000);
    try {
      await f.poll(10_000);
      const upd = f.of("r1").filter((e) => e.type === "bg_task_update").pop()!;
      expect(upd.data).toMatchObject({ items: [], progress: { unreadable: true } });
      for (let i = 0; i < 6 * 12; i++) await f.poll(10_000); // 12 分钟读不到：仍在跟踪、状态未知，不收尾
      expect(f.completed("r1")).toEqual([]);
      expect(activeBgTasksFor(f.agent.name).find((t) => t.id === "r1")?.progress).toMatchObject({ unreadable: true });
      expect(f.of("r1").filter((e) => (e.data as { progress?: { unreadable?: boolean } }).progress?.unreadable)).toHaveLength(1); // 只在切换时发
    } finally {
      chmodSync(f.out("r1"), 0o644);
    }
    await f.poll(10_000);
    const snap = activeBgTasksFor(f.agent.name).find((t) => t.id === "r1")!;
    expect(snap.progress).not.toHaveProperty("unreadable");
    appendFileSync(f.out("r1"), "[exited with code 0]\n");
    await f.poll(10_000);
    expect(f.completed("r1")).toHaveLength(1);
    const items = f.of("r1").flatMap((e) => (e.data as { items?: string[] }).items ?? []);
    expect(items).toEqual(["start", "more", "[exited with code 0]"]);
  });

  test("读不到但没新字节（stat 仍成功）不会被误报恢复", async () => {
    const f = fixture("eacces2");
    await f.poll();
    writeFileSync(f.out("r2"), "a\n");
    f.confirmBg("r2");
    await f.poll(10_000);
    appendFileSync(f.out("r2"), "b\n");
    chmodSync(f.out("r2"), 0o000);
    try {
      await f.poll(10_000); // 读失败 → unreadable
      await f.poll(10_000); // 没新字节：要真确认可读才清
      await f.poll(10_000);
      expect(activeBgTasksFor(f.agent.name).find((t) => t.id === "r2")?.progress).toMatchObject({ unreadable: true });
    } finally {
      chmodSync(f.out("r2"), 0o644);
    }
  });

  test("保留：首轮 baseline 不开流、前台瞬时 .output 不开卡、subagent 软链不当 shell", async () => {
    const f = fixture("guards");
    writeFileSync(f.out("old"), "pre-existing\n");
    f.confirmBg("old");
    await f.poll(); // baseline
    writeFileSync(f.out("fg"), "foreground\n"); // 主 jsonl 里没有 → 前台瞬时文件
    writeFileSync(join(f.tasks, "target.jsonl"), "{}\n");
    symlinkSync(join(f.tasks, "target.jsonl"), f.out("lnk"));
    f.confirmBg("lnk");
    await f.poll(10_000);
    await f.poll(2 * MIN); // 超过确认超时
    for (const id of ["old", "fg", "lnk"]) expect(f.of(id)).toEqual([]);
  });
});

/** bridge 重启前留下的 unknown 记录：与 watcher 首次跟踪时写的是同一份持久化（这个 agent-session 还没被扫过 = 冷启动） */
const persistUnknown = (f: ReturnType<typeof fixture>, id: string, startedAt: number) =>
  new ShellResults().remember({ agentName: f.agent.name, sessionId: f.agent.sessionId, id, startedAt, lastGrowth: startedAt, exitCode: null });

describe("bg-activity-watcher · 重启前结局记成 unknown 的 shell", () => {
  test("冷启动：输出已以 [exited with code 0] 写完 → 首轮更正为 done exit 0，时长截到文件最后写入；不发开始事件、不当新任务", async () => {
    const f = fixture("resume-done");
    const end = Math.floor(Date.now() / 1000) * 1000;
    await persistUnknown(f, "r1", end - 14 * MIN);
    writeFileSync(f.out("r1"), "building\n[exited with code 0]\n");
    utimesSync(f.out("r1"), end / 1000, end / 1000);
    await f.poll();
    expect(f.completed("r1")).toHaveLength(1);
    expect(f.completed("r1")[0].data).toMatchObject({ status: "done", exitCode: 0, durationMs: 14 * MIN, threadId: null });
    expect(f.of("r1").filter((e) => e.type === "bg_task_started")).toEqual([]);
    expect(activeBgTasksFor(f.agent.name).find((t) => t.id === "r1")).toMatchObject({ startedAt: end - 14 * MIN, end: { status: "done", exitCode: 0 } });
    await f.poll(10_000);
    expect(f.completed("r1")).toHaveLength(1);
  });

  test("重启时还在跑：接着跟（不建子区、只发进度把卡拉回跟踪），之后真实退出行到达才收尾", async () => {
    const f = fixture("resume-run");
    await persistUnknown(f, "r2", clock - 5 * MIN);
    writeFileSync(f.out("r2"), "still compiling\n");
    await f.poll();
    expect(f.completed("r2")).toEqual([]);
    expect(f.active("r2")).toBe(true);
    expect(f.of("r2").filter((e) => e.type === "bg_task_started")).toEqual([]);
    expect(f.of("r2").find((e) => e.type === "bg_task_update")?.data).toMatchObject({ items: [], threadId: null, progress: { startedTs: clock - 5 * MIN } });
    await f.poll(10 * MIN);
    expect(f.completed("r2")).toEqual([]);
    appendFileSync(f.out("r2"), "[exited with code 2]\n");
    await f.poll(10_000);
    expect(f.completed("r2")).toHaveLength(1);
    expect(f.completed("r2")[0].data).toMatchObject({ status: "done", exitCode: 2 });
  });

  test("文件不在 / 换成软链 → 保持 unknown、不发任何事件；末行 [killed] → 更正为已停止", async () => {
    const f = fixture("resume-skip");
    for (const id of ["gone", "lnk", "k1"]) await persistUnknown(f, id, clock - MIN);
    writeFileSync(join(f.tasks, "agent-lnk.jsonl"), '{"type":"assistant"}\n[killed]\n');
    symlinkSync(join(f.tasks, "agent-lnk.jsonl"), f.out("lnk"));
    writeFileSync(f.out("k1"), "SIGTERM (Polite quit request)\n\n[killed]\n");
    await f.poll();
    await f.poll(10_000);
    expect(f.of("gone")).toEqual([]);
    expect(f.of("lnk")).toEqual([]);
    expect(f.completed("k1")[0]?.data).toMatchObject({ status: "stopped", exitCode: null });
    const end = (id: string) => activeBgTasksFor(f.agent.name).find((t) => t.id === id)?.end;
    expect([end("gone"), end("lnk"), end("k1")]).toMatchObject([{ status: "unknown" }, { status: "unknown" }, { status: "stopped" }]);
  });
});

/** subagent 记录：user 提问 / 在跑工具 / 交回答复（end_turn），时间戳取可控时钟 */
const rec = (type: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, timestamp: new Date(clock).toISOString(), message: { role: type, content, ...extra } }) + "\n";
const ask = (text: string) => rec("user", [{ type: "text", text }]);
const working = (id: string) => rec("assistant", [{ type: "tool_use", name: "Bash", input: { command: `bun test ${id}` } }], { id, stop_reason: "tool_use" });
const answer = (id: string, text: string) => rec("assistant", [{ type: "text", text }], { id, stop_reason: "end_turn" });
const setMtime = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);
const started = (f: ReturnType<typeof fixture>, id: string) => f.of(id).filter((e) => e.type === "bg_task_started");
const items = (f: ReturnType<typeof fixture>, id: string) => f.of(id).flatMap((e) => (e.data as { items?: string[] }).items ?? []);

describe("bg-activity-watcher · 重启首轮只吞不活跃的文件、续跑的 subagent 按身份接回", () => {
  test("冷启动：刚写过、还在跑的 subagent / shell 照常开流；mtime 很早的旧记录、刚交完答复的记录仍当存量", async () => {
    const f = fixture("cold-sub");
    writeFileSync(f.sub("live1"), ask("go") + working("m1"));
    writeFileSync(f.sub("old1"), ask("go") + working("m2"));
    writeFileSync(f.sub("fin1"), ask("go") + answer("m3", "final answer of fin1"));
    writeFileSync(f.out("s1"), "running\n");
    f.confirmBg("s1");
    setMtime(f.sub("live1"), clock - 30_000);
    setMtime(f.sub("old1"), clock - 60 * MIN);
    setMtime(f.sub("fin1"), clock - 30_000);
    setMtime(f.out("s1"), clock - 10_000);
    await f.poll(); // 这个 agent-session 首次被扫到 = bridge 重启后的首轮
    expect(started(f, "agent-live1")).toHaveLength(1);
    expect(f.active("agent-live1")).toBe(true);
    expect(f.active("s1")).toBe(true);
    expect(f.of("agent-old1")).toEqual([]);
    expect(f.of("agent-fin1")).toEqual([]);
  });

  test("冷启动：还没收尾、只是静默了几分钟（在想 / 在跑长工具）的 subagent 照常开流；之后只追加最终答复也能收成 done", async () => {
    const f = fixture("cold-quiet");
    writeFileSync(f.sub("q1"), ask("go") + rec("assistant", [{ type: "thinking", thinking: "…" }], { id: "m1" }));
    setMtime(f.sub("q1"), clock - 3 * MIN);
    await f.poll();
    expect(started(f, "agent-q1")).toHaveLength(1);
    appendFileSync(f.sub("q1"), answer("m1", "final answer after a long think"));
    await f.poll(10_000);
    expect(f.completed("agent-q1").map((e) => (e.data as { status: string }).status)).toEqual(["done"]);
  });

  test("当存量的旧记录被续跑（长出 user 记录）→ 按身份接回，只推续跑部分；只多了 attachment 不算续跑", async () => {
    const f = fixture("wake-old");
    writeFileSync(f.sub("w1"), ask("first run") + answer("m1", "answer of the first run"));
    setMtime(f.sub("w1"), clock - 60 * MIN);
    await f.poll();
    expect(f.of("agent-w1")).toEqual([]);
    appendFileSync(f.sub("w1"), JSON.stringify({ type: "attachment", timestamp: new Date(clock).toISOString() }) + "\n");
    await f.poll(10_000);
    expect(f.of("agent-w1")).toEqual([]);
    appendFileSync(f.sub("w1"), ask("continue please") + working("m2"));
    await f.poll(10_000);
    expect(started(f, "agent-w1")).toHaveLength(1);
    expect(f.active("agent-w1")).toBe(true);
    appendFileSync(f.sub("w1"), answer("m3", "answer of the second run"));
    await f.poll(10_000);
    expect(f.completed("agent-w1")).toHaveLength(1);
    expect(f.completed("agent-w1")[0].data).toMatchObject({ status: "done" });
    expect(items(f, "agent-w1").some((l) => l.includes("second run"))).toBe(true);
    expect(items(f, "agent-w1").some((l) => l.includes("first run"))).toBe(false);
  });

  test("已收尾的 subagent 被 SendMessage 续跑 → 重新开始跟踪、交回答复后再收尾一次", async () => {
    const f = fixture("wake-ended");
    await f.poll();
    writeFileSync(f.sub("e1"), ask("task") + answer("m1", "first answer"));
    await f.poll(10_000);
    expect(f.completed("agent-e1")).toHaveLength(1);
    appendFileSync(f.sub("e1"), ask("follow-up") + working("m2"));
    await f.poll(10_000);
    expect(started(f, "agent-e1")).toHaveLength(2);
    expect(f.active("agent-e1")).toBe(true);
    appendFileSync(f.sub("e1"), answer("m3", "second answer"));
    await f.poll(10_000);
    expect(f.completed("agent-e1")).toHaveLength(2);
  });

  test("上一轮被停过的 subagent 续跑：meta 里旧的 stoppedByUser 不让它一接回就收尾，交回答复才 done", async () => {
    const f = fixture("wake-stopped");
    await f.poll();
    writeFileSync(f.sub("st1"), ask("task") + working("m1"));
    await f.poll(10_000);
    writeFileSync(f.sub("st1").replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ description: "review", stoppedByUser: true }));
    appendFileSync(f.sub("st1"), ask("[Request interrupted by user for tool use]"));
    await f.poll(10_000);
    expect(f.completed("agent-st1").map((e) => (e.data as { status: string }).status)).toEqual(["stopped"]);
    appendFileSync(f.sub("st1"), ask("please continue") + working("m2"));
    await f.poll(10_000);
    await f.poll(10_000);
    expect(f.active("agent-st1")).toBe(true);
    appendFileSync(f.sub("st1"), answer("m3", "finished after the stop"));
    await f.poll(10_000);
    expect(f.completed("agent-st1").map((e) => (e.data as { status: string }).status)).toEqual(["stopped", "done"]);
  });

  test("冷启动时一次冒出 31 个在跑的记录 → 照样受洪水闸按存量处理；其中一个之后被续跑仍能接回", async () => {
    const f = fixture("cold-flood");
    const ids = Array.from({ length: 31 }, (_, i) => `fl${i}`);
    for (const id of ids) {
      writeFileSync(f.sub(id), ask("go") + working(id));
      setMtime(f.sub(id), clock - 10_000);
    }
    await f.poll();
    for (const id of ids) expect(f.of(`agent-${id}`)).toEqual([]);
    appendFileSync(f.sub("fl7"), ask("continue") + working("fl7b"));
    await f.poll(10_000);
    expect(started(f, "agent-fl7")).toHaveLength(1);
    expect(ids.filter((id) => id !== "fl7").every((id) => f.of(`agent-${id}`).length === 0)).toBe(true);
  });
});

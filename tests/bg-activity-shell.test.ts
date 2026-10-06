/**
 * bg-shell-state-FIX：后台 shell 的 bridge 收尾链路（真实文件 + 可控时钟 + 真 tick / event-bus）。
 * 实报：`bun test > log 2>&1` 跑在后台，3 分钟输出不增长被判结束，实际 12 分钟才结束。
 * 旧红：main 上第 3 分钟那轮 poll 就 finalize（bg_task_completed status=idle）并移出活跃跟踪。
 * 新绿：静默 3/4/12 分钟都还在跟踪；只有完整到达的独立末行 [exited with code N] 收尾一次；文件消失 = unknown。
 * 隔离：HOME / shell 任务目录都是本文件的临时目录，不碰真实 ~/.claude 或 /tmp/claude-<uid>。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { activeBgTasksFor, hasActiveBgActivities, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus";
import { projectJsonlPath } from "../src/lib/jsonl-cost";

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
  const of = (id: string) => events.filter((e) => e.agent === agent.name && (e.data as { id?: string }).id === id);
  const completed = (id: string) => of(id).filter((e) => e.type === "bg_task_completed");
  /** 仍在跟踪（快照里近期已收尾的 shell 带 end，不算） */
  const active = (id: string) => activeBgTasksFor(agent.name).some((t) => t.id === id && !t.end);
  return { agent, tasks, poll, confirmBg, out, of, completed, active };
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

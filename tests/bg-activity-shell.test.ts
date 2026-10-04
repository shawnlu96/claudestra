/**
 * bg-shell-state-FIX：后台 shell 的 bridge 收尾链路（真实文件 + 可控时钟 + 真 tick / event-bus）。
 * 实报：`bun test > log 2>&1` 跑在后台，3 分钟输出不增长被判结束，实际 12 分钟才结束。
 * 旧红：main 上第 3 分钟那轮 poll 就 finalize（bg_task_completed status=idle）并移出活跃跟踪。
 * 新绿：静默 3/4/12 分钟都还在跟踪；只有完整到达的独立末行 [exited with code N] 收尾一次；文件消失 = unknown。
 * 隔离：HOME / shell 任务目录都是本文件的临时目录，不碰真实 ~/.claude 或 /tmp/claude-<uid>。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "fs";
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
  const active = (id: string) => activeBgTasksFor(agent.name).some((t) => t.id === id);
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

  test("输出文件被清理 → status unknown（不是 done / 成功），exitCode null", async () => {
    const f = fixture("gone");
    await f.poll();
    writeFileSync(f.out("g1"), "working\n");
    f.confirmBg("g1");
    await f.poll(10_000);
    unlinkSync(f.out("g1"));
    await f.poll(10_000);
    expect(f.completed("g1")).toHaveLength(1);
    expect(f.completed("g1")[0].data).toMatchObject({ status: "unknown", exitCode: null });
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

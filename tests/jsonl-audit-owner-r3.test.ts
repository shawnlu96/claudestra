/**
 * hardening-JWATCH1 第 3 轮审查补测：bg shell 安装在结果落盘（ShellResults.remember）的 await 上时可信改名，
 * 放行后的开始事件也归新名，不出现「started 旧名、update/completed 新名」。
 * 临时目录合成会话 + 测试状态目录（tests/preload.ts），不访问任何服务。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeBgTasksFor, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher.ts";
import { subscribeEvents } from "../src/bridge/event-bus.ts";
import { syncWatcherOwners } from "../src/bridge/watcher-ownership.ts";
import { ShellResults } from "../src/lib/bg-shell-results.ts";
import { projectJsonlPath } from "../src/lib/jsonl-cost.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe("[验收线 2] bg shell 结果落盘在途时可信改名：开始事件与后续事件都归新名", () => {
  test("remember 闸口里 rescan A→B 完成后放行：started/update/completed 全标 B，A 下无结果", async () => {
    const root = mkdtempSync(join(tmpdir(), "jwatch-r3-bg-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const CH = "local-jwatch-r3-remember";
    const old = { name: "agent-jwr3-bg-old", channelId: CH, cwd: join(root, "proj"), sessionId: "sid-r3-bg" };
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const realRemember = ShellResults.prototype.remember;
    const rem = spyOn(ShellResults.prototype, "remember").mockImplementation(async function (this: ShellResults, ...args: Parameters<ShellResults["remember"]>) {
      if (args[0].agentName === old.name && args[0].exitCode === null) { reached.resolve(); await gate.promise; }
      return realRemember.apply(this, args);
    });
    cleanups.push(() => rem.mockRestore());
    const events: Array<[string, string]> = [];
    cleanups.push(subscribeEvents({ allow: (e) => e.chatId === CH }, (e) => { if (e.type.startsWith("bg_task_")) events.push([e.agent, e.type]); }));
    const main = projectJsonlPath(old.cwd, old.sessionId);
    mkdirSync(join(main, ".."), { recursive: true });
    writeFileSync(main, "Command running in background with ID: shr3\n");
    mkdirSync(join(root, "tasks"));
    let current = old;
    const poll = () => pollBgActivitiesForTest({ now: () => Date.now(), agents: async () => [current], shellDir: () => join(root, "tasks") });
    await poll();
    writeFileSync(join(root, "tasks", "shr3.output"), "running\n");
    const ticking = poll();
    await reached.promise;
    current = { ...old, name: "agent-jwr3-bg-new" };
    await syncWatcherOwners([{ ...current, status: "active" }]);
    gate.resolve();
    await ticking;
    writeFileSync(join(root, "tasks", "shr3.output"), "running\n[exited with code 0]\n");
    await poll();
    await poll();
    expect(events.map(([, t]) => t)).toContain("bg_task_started");
    expect(events.filter(([agent]) => agent !== current.name)).toEqual([]);
    expect(activeBgTasksFor(old.name)).toEqual([]);
    expect(activeBgTasksFor(current.name).map((t) => t.id)).toEqual(["shr3"]);
  });
});

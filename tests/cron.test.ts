/**
 * Cron Framework Tests
 *
 * 测试 cron 表达式解析、匹配、下次触发时间计算、
 * 以及 job store 的 CRUD 操作。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";
import {
  parseCronExpression,
  cronMatches,
  nextCronTime,
  loadJobs,
  saveJobs,
  type CronJob,
} from "../src/cron.js";

// 仓库根目录 — 不依赖固定磁盘路径，测试在任何 clone 位置都能跑
const REPO_ROOT = resolve(import.meta.dir, "..");

// ============================================================
// Cron Expression Parser Tests
// ============================================================

describe("parseCronExpression", () => {
  test("解析简单的全星号表达式", () => {
    const cron = parseCronExpression("* * * * *");
    expect(cron.minute.values.size).toBe(60);  // 0-59
    expect(cron.hour.values.size).toBe(24);    // 0-23
    expect(cron.dayOfMonth.values.size).toBe(31); // 1-31
    expect(cron.month.values.size).toBe(12);    // 1-12
    expect(cron.dayOfWeek.values.size).toBe(7);  // 0-6
  });

  test("解析固定值", () => {
    const cron = parseCronExpression("30 9 * * *");
    expect(cron.minute.values).toEqual(new Set([30]));
    expect(cron.hour.values).toEqual(new Set([9]));
  });

  test("解析逗号分隔的列表", () => {
    const cron = parseCronExpression("0,15,30,45 * * * *");
    expect(cron.minute.values).toEqual(new Set([0, 15, 30, 45]));
  });

  test("解析范围", () => {
    const cron = parseCronExpression("* 9-17 * * *");
    expect(cron.hour.values).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
  });

  test("解析步进", () => {
    const cron = parseCronExpression("*/15 * * * *");
    expect(cron.minute.values).toEqual(new Set([0, 15, 30, 45]));
  });

  test("解析范围+步进", () => {
    const cron = parseCronExpression("* 8-18/2 * * *");
    expect(cron.hour.values).toEqual(new Set([8, 10, 12, 14, 16, 18]));
  });

  test("解析工作日 (1-5)", () => {
    const cron = parseCronExpression("0 9 * * 1-5");
    expect(cron.dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test("解析 @hourly 别名", () => {
    const cron = parseCronExpression("@hourly");
    expect(cron.minute.values).toEqual(new Set([0]));
    expect(cron.hour.values.size).toBe(24);
  });

  test("解析 @daily 别名", () => {
    const cron = parseCronExpression("@daily");
    expect(cron.minute.values).toEqual(new Set([0]));
    expect(cron.hour.values).toEqual(new Set([0]));
  });

  test("解析 @weekly 别名", () => {
    const cron = parseCronExpression("@weekly");
    expect(cron.minute.values).toEqual(new Set([0]));
    expect(cron.hour.values).toEqual(new Set([0]));
    expect(cron.dayOfWeek.values).toEqual(new Set([0]));
  });

  test("解析 @monthly 别名", () => {
    const cron = parseCronExpression("@monthly");
    expect(cron.dayOfMonth.values).toEqual(new Set([1]));
  });

  test("解析 @yearly 别名", () => {
    const cron = parseCronExpression("@yearly");
    expect(cron.month.values).toEqual(new Set([1]));
    expect(cron.dayOfMonth.values).toEqual(new Set([1]));
  });

  test("无效表达式应抛出错误", () => {
    expect(() => parseCronExpression("")).toThrow();
    expect(() => parseCronExpression("* *")).toThrow();
    expect(() => parseCronExpression("* * * *")).toThrow(); // 4 fields
    expect(() => parseCronExpression("* * * * * *")).toThrow(); // 6 fields
  });

  test("复杂组合表达式", () => {
    const cron = parseCronExpression("0,30 9-17 1,15 1-6 1-5");
    expect(cron.minute.values).toEqual(new Set([0, 30]));
    expect(cron.hour.values).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
    expect(cron.dayOfMonth.values).toEqual(new Set([1, 15]));
    expect(cron.month.values).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(cron.dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
  });
});

// ============================================================
// Cron Matching Tests
// ============================================================

describe("cronMatches", () => {
  test("每分钟匹配任何时间", () => {
    expect(cronMatches("* * * * *", new Date(2026, 0, 1, 12, 30))).toBe(true);
    expect(cronMatches("* * * * *", new Date(2026, 5, 15, 0, 0))).toBe(true);
  });

  test("特定时间匹配", () => {
    // 2026-01-01 09:30 是周四 (day 4)
    expect(cronMatches("30 9 * * *", new Date(2026, 0, 1, 9, 30))).toBe(true);
    expect(cronMatches("30 9 * * *", new Date(2026, 0, 1, 9, 31))).toBe(false);
    expect(cronMatches("30 9 * * *", new Date(2026, 0, 1, 10, 30))).toBe(false);
  });

  test("工作日匹配", () => {
    // 2026-03-30 是周一 (day 1)
    expect(cronMatches("0 9 * * 1-5", new Date(2026, 2, 30, 9, 0))).toBe(true);
    // 2026-03-29 是周日 (day 0)
    expect(cronMatches("0 9 * * 1-5", new Date(2026, 2, 29, 9, 0))).toBe(false);
  });

  test("特定月份日期匹配", () => {
    expect(cronMatches("0 0 1 * *", new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(cronMatches("0 0 1 * *", new Date(2026, 0, 2, 0, 0))).toBe(false);
  });

  test("每 15 分钟匹配", () => {
    expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 12, 15))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 12, 30))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 12, 45))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 12, 10))).toBe(false);
  });

  test("周末匹配", () => {
    // 2026-03-28 是周六 (day 6)
    expect(cronMatches("0 10 * * 0,6", new Date(2026, 2, 28, 10, 0))).toBe(true);
    // 2026-03-29 是周日 (day 0)
    expect(cronMatches("0 10 * * 0,6", new Date(2026, 2, 29, 10, 0))).toBe(true);
    // 2026-03-30 是周一 (day 1)
    expect(cronMatches("0 10 * * 0,6", new Date(2026, 2, 30, 10, 0))).toBe(false);
  });
});

// ============================================================
// Next Cron Time Tests
// ============================================================

describe("nextCronTime", () => {
  test("每分钟 - 下一分钟触发", () => {
    const from = new Date(2026, 0, 1, 12, 30, 0);
    const next = nextCronTime("* * * * *", from);
    expect(next.getMinutes()).toBe(31);
    expect(next.getHours()).toBe(12);
  });

  test("每天 09:30 - 今天已过则明天", () => {
    // from 是 12:00，09:30 已过
    const from = new Date(2026, 0, 1, 12, 0, 0);
    const next = nextCronTime("30 9 * * *", from);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  test("每天 09:30 - 今天未过则今天", () => {
    const from = new Date(2026, 0, 1, 8, 0, 0);
    const next = nextCronTime("30 9 * * *", from);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  test("每小时整点", () => {
    const from = new Date(2026, 0, 1, 12, 30, 0);
    const next = nextCronTime("0 * * * *", from);
    expect(next.getHours()).toBe(13);
    expect(next.getMinutes()).toBe(0);
  });

  test("工作日 - 跳过周末", () => {
    // 2026-03-28 周六 09:00
    const from = new Date(2026, 2, 28, 9, 0, 0);
    const next = nextCronTime("0 9 * * 1-5", from);
    // 应该跳到 3月30日 周一
    expect(next.getDate()).toBe(30);
    expect(next.getDay()).toBe(1); // 周一
  });

  test("@hourly 别名", () => {
    const from = new Date(2026, 0, 1, 12, 30, 0);
    const next = nextCronTime("@hourly", from);
    expect(next.getHours()).toBe(13);
    expect(next.getMinutes()).toBe(0);
  });

  test("@daily 别名", () => {
    const from = new Date(2026, 0, 1, 12, 0, 0);
    const next = nextCronTime("@daily", from);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });

  test("每月1号", () => {
    const from = new Date(2026, 0, 15, 0, 0, 0);
    const next = nextCronTime("0 0 1 * *", from);
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(1);
  });

  test("秒数始终为 0", () => {
    const from = new Date(2026, 0, 1, 12, 30, 45);
    const next = nextCronTime("* * * * *", from);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });
});

// ============================================================
// Job Store Tests
// ============================================================

describe("Job Store", () => {
  let originalJobs: CronJob[] = [];

  beforeEach(async () => {
    // 保存原始 jobs，测试后恢复
    originalJobs = await loadJobs();
  });

  afterEach(async () => {
    // 恢复原始 jobs
    await saveJobs(originalJobs);
  });

  test("loadJobs 返回数组", async () => {
    const jobs = await loadJobs();
    expect(Array.isArray(jobs)).toBe(true);
  });

  test("saveJobs + loadJobs 往返测试", async () => {
    const testJobs: CronJob[] = [
      {
        id: "test_1",
        name: "test-job-1",
        schedule: "0 9 * * *",
        prompt: "Run tests",
        dir: "/tmp/test",
        enabled: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: "test_2",
        name: "test-job-2",
        schedule: "*/30 * * * *",
        prompt: "Check health",
        dir: "/tmp/test2",
        enabled: false,
        lastRun: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];

    await saveJobs(testJobs);
    const loaded = await loadJobs();
    expect(loaded.length).toBe(2);
    expect(loaded[0].name).toBe("test-job-1");
    expect(loaded[1].name).toBe("test-job-2");
    expect(loaded[0].enabled).toBe(true);
    expect(loaded[1].enabled).toBe(false);
  });

  test("saveJobs 覆盖已有数据", async () => {
    await saveJobs([{
      id: "old",
      name: "old-job",
      schedule: "* * * * *",
      prompt: "old",
      dir: "/tmp",
      enabled: true,
      createdAt: new Date().toISOString(),
    }]);

    await saveJobs([{
      id: "new",
      name: "new-job",
      schedule: "0 0 * * *",
      prompt: "new",
      dir: "/tmp",
      enabled: false,
      createdAt: new Date().toISOString(),
    }]);

    const loaded = await loadJobs();
    expect(loaded.length).toBe(1);
    expect(loaded[0].name).toBe("new-job");
  });
});

// ============================================================
// Edge Cases
// ============================================================

describe("Edge Cases", () => {
  test("cron 表达式边界值", () => {
    // minute=0, hour=0, dom=1, month=1, dow=* → Jan 1st midnight
    expect(cronMatches("0 0 1 1 *", new Date(2026, 0, 1, 0, 0))).toBe(true);
    // minute=59, hour=23 → 23:59
    expect(cronMatches("59 23 * * *", new Date(2026, 0, 1, 23, 59))).toBe(true);
    // dom AND dow 同时指定（AND 语义）
    // 2026-12-26 是周六 (day 6)，dom=26
    expect(cronMatches("59 23 26 12 6", new Date(2026, 11, 26, 23, 59))).toBe(true);
  });

  test("步进不整除的情况", () => {
    // */7 分钟 → 0, 7, 14, 21, 28, 35, 42, 49, 56
    const cron = parseCronExpression("*/7 * * * *");
    expect(cron.minute.values).toEqual(new Set([0, 7, 14, 21, 28, 35, 42, 49, 56]));
  });

  test("nextCronTime 不会返回 from 时间本身", () => {
    const from = new Date(2026, 0, 1, 9, 30, 0);
    const next = nextCronTime("30 9 * * *", from);
    // from 精确匹配，但 nextCronTime 应该跳到下一个匹配（+1分钟开始找）
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test("月末跨月计算", () => {
    // 从 1月31日开始找 "0 0 1 * *"（每月1号）
    const from = new Date(2026, 0, 31, 12, 0, 0);
    const next = nextCronTime("0 0 1 * *", from);
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(1);
  });

  test("年末跨年计算", () => {
    // 从 12月31日找 "0 0 1 1 *"（每年1月1日）
    const from = new Date(2026, 11, 31, 12, 0, 0);
    const next = nextCronTime("0 0 1 1 *", from);
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
  });
});

// ============================================================
// Manager CLI Integration Tests (dry run)
// ============================================================

describe("Manager CLI cron commands", () => {
  test("cron-add 应该输出 JSON", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-add"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out.trim());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("用法");
  });

  test("cron-list 应该返回 jobs 数组", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-list"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out.trim());
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.jobs)).toBe(true);
  });

  test("cron-remove 无参数应报错", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-remove"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out.trim());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("用法");
  });

  test("cron-toggle 无参数应报错", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-toggle"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out.trim());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("用法");
  });

  test("cron-history 应该返回 records 数组", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-history"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out.trim());
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.records)).toBe(true);
  });
});

// ============================================================
// Full CRUD Integration Test
// ============================================================

describe("Cron CRUD via manager CLI", () => {
  const testJobName = `test-job-${Date.now()}`;

  afterEach(async () => {
    // Clean up test job if it exists
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-remove", testJobName],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    await proc.exited;
  });

  test("完整的 add → list → toggle → remove 流程", async () => {
    // 1. Add
    const addProc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-add", testJobName, "0 9 * * *", "/tmp", "echo hello"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const addOut = JSON.parse((await new Response(addProc.stdout).text()).trim());
    await addProc.exited;
    expect(addOut.ok).toBe(true);
    expect(addOut.job.name).toBe(testJobName);

    // 2. List — should contain the new job
    const listProc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-list"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const listOut = JSON.parse((await new Response(listProc.stdout).text()).trim());
    await listProc.exited;
    expect(listOut.ok).toBe(true);
    const found = listOut.jobs.find((j: any) => j.name === testJobName);
    expect(found).toBeTruthy();
    expect(found.enabled).toBe(true);

    // 3. Toggle — disable
    const toggleProc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-toggle", testJobName],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const toggleOut = JSON.parse((await new Response(toggleProc.stdout).text()).trim());
    await toggleProc.exited;
    expect(toggleOut.ok).toBe(true);
    expect(toggleOut.enabled).toBe(false);

    // 4. Toggle again — re-enable
    const toggle2Proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-toggle", testJobName],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const toggle2Out = JSON.parse((await new Response(toggle2Proc.stdout).text()).trim());
    await toggle2Proc.exited;
    expect(toggle2Out.ok).toBe(true);
    expect(toggle2Out.enabled).toBe(true);

    // 5. Remove
    const removeProc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-remove", testJobName],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const removeOut = JSON.parse((await new Response(removeProc.stdout).text()).trim());
    await removeProc.exited;
    expect(removeOut.ok).toBe(true);
    expect(removeOut.removed).toBe(testJobName);

    // 6. Verify removal
    const list2Proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-list"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const list2Out = JSON.parse((await new Response(list2Proc.stdout).text()).trim());
    await list2Proc.exited;
    const notFound = list2Out.jobs.find((j: any) => j.name === testJobName);
    expect(notFound).toBeUndefined();
  });

  test("添加同名任务应该失败", async () => {
    // Add first
    const add1 = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-add", testJobName, "0 9 * * *", "/tmp", "test"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    await add1.exited;

    // Add duplicate
    const add2 = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-add", testJobName, "0 10 * * *", "/tmp", "test2"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = JSON.parse((await new Response(add2.stdout).text()).trim());
    await add2.exited;
    expect(out.ok).toBe(false);
    expect(out.error).toContain("同名");
  });

  test("删除不存在的任务应该失败", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-remove", "nonexistent-job-12345"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    await proc.exited;
    expect(out.ok).toBe(false);
    expect(out.error).toContain("找不到");
  });

  test("无效的 cron 表达式应该被拒绝", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/manager.ts", "cron-add", "bad-cron", "invalid", "/tmp", "test"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
    );
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    await proc.exited;
    expect(out.ok).toBe(false);
    expect(out.error).toContain("无效");
  });
});

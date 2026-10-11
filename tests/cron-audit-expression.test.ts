/**
 * hardening-CRONVAL1：cron 表达式拒零步长、nextRun 按 epoch 分钟走（审计 a15 A15-01 / A15-03）。
 *
 * 只传合成表达式和合成 jobs 台账；会死循环的输入、和时区相关的断言都放进带超时的子进程
 * （固定 TZ、临时状态目录、死端口 bridge），不读本机的 cron.json、不建任何定时任务。
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import * as cronExpression from "../src/lib/cron-expression.ts";
import { cronMatches, dueCronJobs, nextCronTime, parseCronExpression } from "../src/lib/cron-expression.ts";
import { testChildEnv } from "./test-env.ts";

// 第 3 轮新增的导出；按命名空间取，旧 head 上是 undefined（复现测试因此红在真实启动段，而不是红在 import）
const splitCronJobRows = (cronExpression as Record<string, unknown>).splitCronJobRows as typeof import("../src/lib/cron-expression.ts").splitCronJobRows;
const REPO_ROOT = resolve(import.meta.dir, "..");
const STATE = mkdtempSync(join(tmpdir(), "cron-audit-state-"));
afterAll(() => rmSync(STATE, { recursive: true, force: true }));

/** 旧解析器在这两种写法上 `i += 0` 永不前进 */
const ZERO_STEP = ["*/0 * * * *", "0 1-5/0 * * *"];
/** 子进程的墙钟上限：正常是几十毫秒，旧实现只会撞上它 */
const BOUND_MS = 10_000;
// 一个用例最多串三个子进程；runner 默认的 5s 会抢在子进程超时之前把用例判死，看不出是谁卡住
setDefaultTimeout(60_000);

interface Probe {
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], env: Record<string, string | undefined> = {}): Probe {
  const r = Bun.spawnSync(cmd, {
    cwd: REPO_ROOT,
    env: testChildEnv({ CLAUDESTRA_STATE_DIR: STATE, ...env }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: BOUND_MS,
  });
  return {
    timedOut: r.exitedDueToTimeout === true || r.signalCode != null,
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** 在子进程里跑一段脚本（已 import 好纯模块为 C），脚本把结果 JSON 打到 stdout */
function probe<T>(body: string, env: Record<string, string | undefined> = {}): { p: Probe; out: T | null } {
  const code = `import * as C from "./src/lib/cron-expression.ts";\n${body}`;
  const p = run(["bun", "-e", code], env);
  let out: T | null = null;
  try {
    out = JSON.parse(p.stdout.trim()) as T;
  } catch {
    out = null;
  }
  return { p, out };
}

// ============================================================
// [验收线 1] 零步长：纯解析器 / manager 校验入口 / daemon 的逐条匹配
// ============================================================

describe("[验收线 1] 零步长快速拒", () => {
  test.each(ZERO_STEP)("纯解析器：%s 在有界子进程里抛错而不是转死", (expr) => {
    const { p, out } = probe<Record<string, string | null>>(`
      const expr = ${JSON.stringify(expr)};
      const caught = (fn) => { try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : "non-error"; } };
      console.log(JSON.stringify({
        parse: caught(() => C.parseCronExpression(expr)),
        match: caught(() => C.cronMatches(expr, new Date(0))),
        next: caught(() => C.nextCronTime(expr, new Date(0))),
      }));
    `);
    expect(p.timedOut).toBe(false);
    expect(p.exitCode).toBe(0);
    for (const k of ["parse", "match", "next"]) {
      expect(out?.[k]).toContain("无效的 cron 表达式");
      expect(out?.[k]).toContain("步长");
    }
  });

  test.each(ZERO_STEP)("manager cron-add：%s 被校验入口拒掉，不落盘", (expr) => {
    const p = run(["bun", "src/manager.ts", "cron-add", "audit-zero-step", expr, "/tmp", "echo synthetic"]);
    expect(p.timedOut).toBe(false);
    const result = JSON.parse(p.stdout.trim());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("步长");
    expect(existsSync(join(STATE, "cron.json"))).toBe(false);
  });

  test("manager cron-edit：零步长的新 schedule 被拒，原任务不变", () => {
    const state = mkdtempSync(join(tmpdir(), "cron-audit-edit-"));
    try {
      const env = { CLAUDESTRA_STATE_DIR: state };
      const add = run(["bun", "src/manager.ts", "cron-add", "audit-edit", "0 9 * * *", "/tmp", "echo synthetic"], env);
      expect(JSON.parse(add.stdout.trim()).ok).toBe(true);
      for (const expr of ZERO_STEP) {
        const p = run(["bun", "src/manager.ts", "cron-edit", "audit-edit", "--schedule", expr], env);
        expect(p.timedOut).toBe(false);
        const result = JSON.parse(p.stdout.trim());
        expect(result.ok).toBe(false);
        expect(result.error).toContain("步长");
      }
      const jobs = JSON.parse(readFileSync(join(state, "cron.json"), "utf8"));
      expect(jobs.map((j: { schedule: string }) => j.schedule)).toEqual(["0 9 * * *"]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("daemon：合成 jobs 里的坏记录只进 errors，前后合法任务照常到点", () => {
    const state = mkdtempSync(join(tmpdir(), "cron-audit-daemon-"));
    try {
      const job = (name: string, schedule: unknown, enabled = true) => ({
        id: `id-${name}`, name, schedule, prompt: "synthetic", dir: "/tmp", enabled, createdAt: "2026-01-01T00:00:00.000Z",
      });
      writeFileSync(join(state, "cron.json"), JSON.stringify([
        job("ok-before", "* * * * *"),
        job("bad-star-step", ZERO_STEP[0]),
        job("bad-range-step", ZERO_STEP[1]),
        job("bad-not-string", 42),
        job("bad-missing", undefined),
        job("bad-disabled", ZERO_STEP[0], false),
        job("not-due", "0 0 1 1 *"),
        job("ok-after", "*/5 * * * *"),
      ]));
      // 与 daemon 同一条读盘路径（lib/state-file 的宽容读 + statePath），只是不加载 src/cron.ts 入口
      const { p, out } = probe<{ due: string[]; errors: string[]; messages: string[] }>(`
        import { statePath } from "./src/lib/paths.ts";
        import { readJsonLenient } from "./src/lib/state-file.ts";
        const jobs = await readJsonLenient(statePath("cron.json"), [], { validate: Array.isArray, who: "cron" });
        const r = C.dueCronJobs(jobs, new Date("2026-06-15T12:30:20.000Z"));
        console.log(JSON.stringify({
          due: r.due.map((j) => j.name),
          errors: r.errors.map((e) => e.job.name),
          messages: r.errors.map((e) => e.error.message),
        }));
      `, { CLAUDESTRA_STATE_DIR: state, TZ: "UTC" });
      expect(p.timedOut).toBe(false);
      expect(p.exitCode).toBe(0);
      expect(out?.due).toEqual(["ok-before", "ok-after"]);
      expect(out?.errors).toEqual(["bad-star-step", "bad-range-step", "bad-not-string", "bad-missing"]);
      for (const m of out?.messages ?? []) expect(m).toContain("无效的 cron 表达式");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("daemon：不是对象的记录（null / 数字 / 字符串 / 数组）只进 errors，前后合法任务照常到点", () => {
    const rows = [
      { name: "ok-before", enabled: true, schedule: "* * * * *" },
      null,
      42,
      "* * * * *",
      [{ enabled: true, schedule: "* * * * *" }],
      { name: 7, enabled: true, schedule: ZERO_STEP[0] },
      { name: "ok-after", enabled: true, schedule: "*/5 * * * *" },
    ] as unknown as { name: string; enabled: boolean; schedule: string }[];
    const r = dueCronJobs(rows, new Date(2026, 5, 15, 12, 30, 20));
    expect(r.due.map((j) => j.name)).toEqual(["ok-before", "ok-after"]);
    expect(r.errors.map((e) => e.label)).toEqual(["第 2 条记录", "第 3 条记录", "第 4 条记录", "第 5 条记录", "第 6 条记录"]);
    expect(r.errors.slice(0, 4).map((e) => e.error.message)).toEqual(Array(4).fill("任务记录不是对象"));
    expect(r.errors[4].error.message).toContain("无效的 cron 表达式");
  });

  test("daemon：真实 tick 热加载 [合法, null, 合法]，两条合法任务都派发，日志路径不抛", async () => {
    // src/cron.ts 是入口（import 即启动 daemon），所以只把 tick 的源码抠出来，注入合成 loadJobs 和只记调用的 executeJob
    const entry = readFileSync(join(REPO_ROOT, "src/cron.ts"), "utf8");
    const source = entry.match(/^async function tick\(\): Promise<void> \{\n[\s\S]*?\n\}\n/m)?.[0];
    expect(source).toBeDefined();
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`let lastTickMinute = -1;\n${source}\nexport { tick };`)
      .replace(/export\s*\{\s*tick\s*\};?/, "return tick;");
    const executed: string[] = [];
    const logged: string[] = [];
    const jobs = [
      { id: "a", name: "before", enabled: true, schedule: "* * * * *" },
      null,
      { id: "b", name: "after", enabled: true, schedule: "* * * * *" },
    ];
    const tick = new Function("loadJobs", "dueCronJobs", "executeJob", "console", js)(
      async () => jobs,
      dueCronJobs,
      async (job: { name: string }) => { executed.push(job.name); },
      { error: (...args: unknown[]) => logged.push(args.map(String).join(" ")) },
    ) as () => Promise<void>;
    await tick();
    expect(executed).toEqual(["before", "after"]);
    expect(logged).toEqual(["cron 任务记录错误: 第 2 条记录 — 任务记录不是对象"]);
  });

  test("daemon：真实 main 启动段冷启动读到 [合法, null, 合法]，不抛，两条合法任务都补上 nextRun 并列出", async () => {
    // 冷启动 / 重启走的是 main 里「初始化 nextRun + 列任务」这段，在首次 tick 之前；抠出真实源码，注入合成 loadJobs 和只记调用的 saveJobs
    const entry = readFileSync(join(REPO_ROOT, "src/cron.ts"), "utf8");
    const source = entry.match(/\n  \/\/ 初始化 nextRun\n[\s\S]*?\n(?=  \/\/ 监听配置文件变更)/)?.[0];
    expect(source).toBeDefined();
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function startup() {${source}}\nexport { startup };`)
      .replace(/export\s*\{\s*startup\s*\};?/, "return startup;");
    const jobs = [
      { id: "a", name: "before", enabled: true, schedule: "* * * * *", dir: "/synthetic/a" },
      null,
      { id: "z", name: "zero-step", enabled: true, schedule: ZERO_STEP[0], dir: "/synthetic/z" },
      { id: "b", name: "after", enabled: true, schedule: "* * * * *", dir: "/synthetic/b" },
    ] as unknown as { name: string; enabled: boolean; schedule: string; nextRun?: string }[];
    const saved: unknown[][] = [];
    const out: string[] = [];
    const err: string[] = [];
    const line = (sink: string[]) => (...args: unknown[]) => { sink.push(args.map(String).join(" ")); };
    const startup = new Function("loadJobs", "saveJobs", "nextCronTime", "splitCronJobRows", "console", js)(
      async () => jobs,
      async (rows: unknown[]) => { saved.push(rows); },
      nextCronTime,
      splitCronJobRows,
      { log: line(out), error: line(err) },
    ) as () => Promise<void>;
    await startup(); // 旧实现在这里抛 null is not an object (evaluating 'job.enabled')，入口捕获后退出进程
    expect(typeof jobs[0].nextRun).toBe("string");
    expect(typeof jobs[3].nextRun).toBe("string");
    expect(jobs[2].nextRun).toBeUndefined(); // 坏表达式照旧只是不补 nextRun
    expect(saved).toEqual([jobs]); // 回写的是原数组：坏行原样留着，不替用户删
    expect(jobs[1]).toBeNull();
    expect(err).toEqual(["cron 任务记录错误: 第 2 条记录 — 任务记录不是对象（已跳过，其余任务照常调度）"]);
    const listed = out.join("\n");
    expect(listed).toContain("已加载 3 个任务");
    for (const name of ["before", "zero-step", "after"]) expect(listed).toContain(`✅ ${name} — `);
  });

  test("splitCronJobRows：非对象记录按位置报出，合法记录保持原引用和顺序", () => {
    const a = { name: "a", enabled: true, schedule: "* * * * *" };
    const b = { name: "b", enabled: false, schedule: "* * * * *" };
    const r = splitCronJobRows([a, null, 42, "x", [a], undefined, b] as unknown as (typeof a)[]);
    expect(r.rows).toEqual([a, b]);
    expect(r.rows[0]).toBe(a);
    expect(r.errors.map((e) => e.label)).toEqual(["第 2 条记录", "第 3 条记录", "第 4 条记录", "第 5 条记录", "第 6 条记录"]);
    expect(r.errors.every((e) => e.error.message === "任务记录不是对象")).toBe(true);
  });

  test("daemon 入口用的就是这套纯函数（再导出 + tick 走 dueCronJobs）", () => {
    const entry = readFileSync(join(REPO_ROOT, "src/cron.ts"), "utf8");
    expect(entry).toContain('export { parseCronExpression, cronMatches, nextCronTime } from "./lib/cron-expression.js";');
    expect(entry).toContain("dueCronJobs(await loadJobs(), now)");
    expect(entry).not.toMatch(/function parseCronField|function nextCronTime|function cronMatches/);
  });
});

// ============================================================
// [验收线 2] 解析：正常写法照旧，非法写法在进循环前就拒
// ============================================================

describe("[验收线 2] 字段校验", () => {
  const minute = (expr: string) => [...parseCronExpression(expr).minute.values].sort((a, b) => a - b);

  test("步长 / 范围 / 列表及其组合", () => {
    expect(minute("*/15 * * * *")).toEqual([0, 15, 30, 45]);
    expect(minute("10-20/5 * * * *")).toEqual([10, 15, 20]);
    expect(minute("0,15,30,45 * * * *")).toEqual([0, 15, 30, 45]);
    expect(minute("1,10-12,*/30 * * * *")).toEqual([0, 1, 10, 11, 12, 30]);
    expect(minute("*/1 * * * *")).toHaveLength(60);
    expect(minute("*/59 * * * *")).toEqual([0, 59]);
    expect(minute("*/90 * * * *")).toEqual([0]); // 步长超过跨度：只剩起点，集合非空
    expect(minute("7-7 * * * *")).toEqual([7]);
    expect(minute("05 * * * *")).toEqual([5]);
    const all = parseCronExpression("0-59 0-23 1-31 1-12 0-6");
    expect([all.minute, all.hour, all.dayOfMonth, all.month, all.dayOfWeek].map((f) => f.values.size)).toEqual([60, 24, 31, 12, 7]);
    expect(parseCronExpression("  0   9 * *  1-5 ").dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test.each([
    ["60 * * * *", "分"], ["* 24 * * *", "时"], ["* * 0 * *", "日"], ["* * 32 * *", "日"],
    ["* * * 0 *", "月"], ["* * * 13 *", "月"], ["* * * * 7", "周"], ["10-70 * * * *", "分"],
    ["* 0-24 * * *", "时"], ["* * * * 1-7", "周"], ["* * 0-5 * *", "日"], ["0,61 * * * *", "分"],
  ])("超范围：%s", (expr, label) => {
    expect(() => parseCronExpression(expr)).toThrow(`${label}字段`);
  });

  test.each([
    "5-1 * * * *", "a * * * *", "MON * * * *", "5abc * * * *", "1e1 * * * *", "0x10 * * * *", "-1 * * * *",
    "1- * * * *", "-5 * * * *", "1-2-3 * * * *", "1,,2 * * * *", ", * * * *", "1, * * * *", "** * * * *",
    "*/ * * * *", "/5 * * * *", "*/x * * * *", "*/-1 * * * *", "*/1.5 * * * *", "*/5/2 * * * *", "1.5 * * * *",
    "*/99999999999999999999 * * * *", "99999999999999999999 * * * *", "@every5m", "",
  ])("写法非法：%j", (expr) => {
    expect(() => parseCronExpression(expr)).toThrow("无效的 cron 表达式");
    expect(() => cronMatches(expr, new Date(0))).toThrow("无效的 cron 表达式");
    expect(() => nextCronTime(expr, new Date(0))).toThrow("无效的 cron 表达式");
  });

  test("不是字符串的 schedule、超长正文也是标准 Error，报错里不回显整段正文", () => {
    for (const bad of [undefined, null, 42, {}, ["* * * * *"]]) {
      expect(() => parseCronExpression(bad as unknown as string)).toThrow(Error);
    }
    const huge = `${"1,".repeat(200_000)}99 * * * *`;
    const started = performance.now();
    let message = "";
    try {
      parseCronExpression(huge);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("无效的 cron 表达式");
    expect(message.length).toBeLessThan(400);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("起点不是有效时间时 nextCronTime 抛错", () => {
    expect(() => nextCronTime("* * * * *", new Date(Number.NaN))).toThrow(Error);
  });

  test("日 / 周同时指定仍是 AND（既有组合规则不改）", () => {
    // 2026-06-13 是周六
    expect(dueCronJobs([{ enabled: true, schedule: "0 0 13 6 6" }], new Date(2026, 5, 13, 0, 0)).due).toHaveLength(1);
    expect(cronMatches("0 0 13 6 5", new Date(2026, 5, 13, 0, 0))).toBe(false);
    expect(cronMatches("0 0 14 6 6", new Date(2026, 5, 13, 0, 0))).toBe(false);
  });
});

// ============================================================
// [验收线 2] nextRun 时间线：固定 TZ 子进程
// ============================================================

/**
 * 子进程里的公共片段。walk：从 fromIso 起反复 nextCronTime，收集 untilIso 之前的触发点；
 * ticks：同一窗口里逐个 epoch 分钟问 cronMatches（daemon 的 tick 就是这么判的）。两者必须是同一串时间。
 */
const TIMELINE = `
  const MIN = 60_000;
  const iso = (d) => d.toISOString();
  const walk = (expr, fromIso, untilIso) => {
    const out = []; let t = new Date(fromIso); const until = Date.parse(untilIso);
    for (let i = 0; i < 5000; i++) { t = C.nextCronTime(expr, t); if (t.getTime() >= until) break; out.push(iso(t)); }
    return out;
  };
  const ticks = (expr, fromIso, untilIso) => {
    const out = [];
    for (let t = Date.parse(fromIso) + MIN; t < Date.parse(untilIso); t += MIN) if (C.cronMatches(expr, new Date(t + 20_000))) out.push(iso(new Date(t)));
    return out;
  };
`;

describe("[验收线 2] nextRun 按 epoch 分钟递增", () => {
  test("America/New_York 回拨：01:59 EDT 之后每一分钟的 nextRun 都是紧接的 epoch 分钟", () => {
    // 2026-11-01 06:00Z：02:00 EDT → 01:00 EST，本地 01:00–01:59 出现两遍
    const { p, out } = probe<{ tz: string; gaps: number[]; unmatched: number; localHours: number[]; withSeconds: string }>(`${TIMELINE}
      const base = Date.parse("2026-11-01T05:59:00.000Z");
      const gaps = new Set(); let unmatched = 0; const localHours = [];
      for (let i = 0; i < 130; i++) {
        const from = new Date(base + i * MIN);
        const next = C.nextCronTime("* * * * *", from);
        gaps.add(next.getTime() - from.getTime());
        if (!C.cronMatches("* * * * *", next)) unmatched++;
        if (i % 30 === 0) localHours.push(next.getHours());
      }
      console.log(JSON.stringify({
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone, gaps: [...gaps], unmatched, localHours,
        withSeconds: iso(C.nextCronTime("* * * * *", new Date(base + 45_500))),
      }));
    `, { TZ: "America/New_York" });
    expect(p.timedOut).toBe(false);
    expect(out?.tz).toBe("America/New_York");
    expect(out?.gaps).toEqual([60_000]);
    expect(out?.unmatched).toBe(0);
    expect(out?.localHours).toEqual([1, 1, 2, 2, 3]); // 06:00Z、06:30Z 是第二遍 01 点（EST），没被跳过；07:00Z 才是 02:00
    expect(out?.withSeconds).toBe("2026-11-01T06:00:00.000Z");
  });

  test("America/New_York 回拨：重复小时里的定点任务两遍都算，且与 tick 判定是同一串时间", () => {
    const exprs = ["30 1 * * *", "*/15 1 * * *", "0 2 * * *", "59 1 * * 0", "* * * * *", "0 * 1 11 *"];
    const { p, out } = probe<{ walks: string[][]; ticks: string[][] }>(`${TIMELINE}
      const exprs = ${JSON.stringify(exprs)};
      const win = ["2026-11-01T03:00:00.000Z", "2026-11-01T09:00:00.000Z"];
      console.log(JSON.stringify({ walks: exprs.map((e) => walk(e, ...win)), ticks: exprs.map((e) => ticks(e, ...win)) }));
    `, { TZ: "America/New_York" });
    expect(p.timedOut).toBe(false);
    expect(out?.walks).toEqual(out?.ticks as string[][]);
    expect(out?.walks[0]).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]); // 01:30 EDT、01:30 EST
    expect(out?.walks[1]).toEqual([
      "2026-11-01T05:00:00.000Z", "2026-11-01T05:15:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T05:45:00.000Z",
      "2026-11-01T06:00:00.000Z", "2026-11-01T06:15:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T06:45:00.000Z",
    ]);
    expect(out?.walks[2]).toEqual(["2026-11-01T07:00:00.000Z"]); // 02:00 只有 EST 那一次
    expect(out?.walks[3]).toEqual(["2026-11-01T05:59:00.000Z", "2026-11-01T06:59:00.000Z"]);
    expect(out?.walks[4]).toHaveLength(359);
  });

  test("America/New_York 前进：不存在的 02:xx 不触发，nextRun 落到下一个真实存在的时刻", () => {
    // 2026-03-08 07:00Z：02:00 EST → 03:00 EDT
    const exprs = ["30 2 * * *", "*/20 * * * *", "0 3 * * *", "* * * * *"];
    const { p, out } = probe<{ walks: string[][]; ticks: string[][]; acrossGap: string; localHour: number; skipped: string }>(`${TIMELINE}
      const exprs = ${JSON.stringify(exprs)};
      const win = ["2026-03-08T05:00:00.000Z", "2026-03-08T09:00:00.000Z"];
      const acrossGap = C.nextCronTime("* * * * *", new Date("2026-03-08T06:59:00.000Z"));
      console.log(JSON.stringify({
        walks: exprs.map((e) => walk(e, ...win)), ticks: exprs.map((e) => ticks(e, ...win)),
        acrossGap: iso(acrossGap), localHour: acrossGap.getHours(),
        skipped: iso(C.nextCronTime("30 2 * * *", new Date("2026-03-08T06:00:00.000Z"))),
      }));
    `, { TZ: "America/New_York" });
    expect(p.timedOut).toBe(false);
    expect(out?.walks).toEqual(out?.ticks as string[][]);
    expect(out?.acrossGap).toBe("2026-03-08T07:00:00.000Z");
    expect(out?.localHour).toBe(3);
    expect(out?.walks[0]).toEqual([]);
    expect(out?.skipped).toBe("2026-03-09T06:30:00.000Z"); // 次日 02:30 EDT
    expect(out?.walks[1]).toEqual([
      "2026-03-08T05:20:00.000Z", "2026-03-08T05:40:00.000Z", "2026-03-08T06:00:00.000Z", "2026-03-08T06:20:00.000Z",
      "2026-03-08T06:40:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T07:20:00.000Z", "2026-03-08T07:40:00.000Z",
      "2026-03-08T08:00:00.000Z", "2026-03-08T08:20:00.000Z", "2026-03-08T08:40:00.000Z",
    ]);
    expect(out?.walks[2]).toEqual(["2026-03-08T07:00:00.000Z"]);
    expect(out?.walks[3]).toHaveLength(239);
  });

  test("Asia/Tokyo 常规时间：每日 / 工作日 / 月初 / 跨年", () => {
    const { p, out } = probe<Record<string, unknown>>(`${TIMELINE}
      const next = (e, from) => iso(C.nextCronTime(e, new Date(from)));
      const win = ["2026-06-14T15:00:00.000Z", "2026-06-15T15:00:00.000Z"]; // 东京 6 月 15 日（周一）整天
      const exprs = ["0 9 * * *", "*/15 9-10 * * 1-5", "30 23 15 6 *", "0 0 * * 0"];
      console.log(JSON.stringify({
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        daily: next("0 9 * * *", "2026-06-15T00:00:00.000Z"),
        sameMinute: next("0 9 * * *", "2026-06-15T00:00:30.000Z"),
        weekday: next("0 9 * * 1-5", "2026-06-12T00:00:00.000Z"),
        monthly: next("0 0 1 * *", "2026-01-31T03:00:00.000Z"),
        yearly: next("@yearly", "2026-06-15T00:00:00.000Z"),
        hourly: next("@hourly", "2026-06-15T00:30:00.000Z"),
        gaps: [...new Set(Array.from({ length: 1500 }, (_, i) => {
          const from = Date.parse("2026-06-14T15:00:00.000Z") + i * MIN;
          return C.nextCronTime("* * * * *", new Date(from)).getTime() - from;
        }))],
        same: JSON.stringify(exprs.map((e) => walk(e, ...win))) === JSON.stringify(exprs.map((e) => ticks(e, ...win))),
        counts: exprs.map((e) => walk(e, ...win).length),
      }));
    `, { TZ: "Asia/Tokyo" });
    expect(p.timedOut).toBe(false);
    expect(out).toEqual({
      tz: "Asia/Tokyo",
      daily: "2026-06-16T00:00:00.000Z", // 起点正好是 09:00 JST，不返回起点本身
      sameMinute: "2026-06-16T00:00:00.000Z",
      weekday: "2026-06-15T00:00:00.000Z", // 周五 09:00 之后 → 下周一 09:00 JST
      monthly: "2026-01-31T15:00:00.000Z", // 2 月 1 日 00:00 JST
      yearly: "2026-12-31T15:00:00.000Z",
      hourly: "2026-06-15T01:00:00.000Z",
      gaps: [60_000],
      same: true,
      counts: [1, 8, 1, 0],
    });
  });

  test("一年内没有触发点的合法表达式：有限时间内抛错", () => {
    const started = performance.now();
    expect(() => nextCronTime("0 0 31 2 *", new Date("2026-01-01T00:00:00.000Z"))).toThrow("无法计算下次触发时间");
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

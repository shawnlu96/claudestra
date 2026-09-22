import { describe, expect, test } from "bun:test";
import { sliceRunLog, isRunActive, loggedRunScript, newRunId } from "../src/lib/run-log";

// 本机 restart-all.log 的真实形状（2026-09-23）：两轮老格式 + 汇总行
const OLD_TWO_RUNS = [
  "=== 2026-09-23 01:31:53 restart-all --include-master ===",
  "[restart] agent-a 优雅退出超时",
  '{"ok":true,"results":[{"name":"agent-a","ok":true}]}',
  "=== 2026-09-23 02:44:41 restart-all --include-master ===",
  "[restart] agent-b 优雅退出超时",
  '{"ok":true,"results":[{"name":"agent-b","ok":true}]}',
].join("\n");

describe("sliceRunLog", () => {
  test("第二次点火刚开始：上一轮的汇总行不算本轮完成（D8-1 的误报）", () => {
    const text = OLD_TWO_RUNS + "\n=== run:1758600000000 2026-09-23 03:00:00 restart-all --include-master ===\n[restart] agent-a 退出中\n";
    const v = sliceRunLog(text, "1758600000000");
    expect(v.found).toBe(true);
    expect(v.done).toBe(false);
    expect(v.lines).toEqual(["[restart] agent-a 退出中"]);
    // 不带 runId = 最后一轮，同样没完成
    const last = sliceRunLog(text);
    expect(last.runId).toBe("1758600000000");
    expect(last.done).toBe(false);
  });

  test("结束行 + 结果 JSON：done、exitCode、result 都给出，且不混进输出行", () => {
    const text = [
      "=== run:100 2026-09-23 03:00:00 update ===",
      '{"ok":true,"version":"2.24.0","message":"已是最新版本 v2.24.0"}',
      "=== end run:100 exit=0 ===",
    ].join("\n");
    const v = sliceRunLog(text, "100");
    expect(v.done).toBe(true);
    expect(v.exitCode).toBe(0);
    expect(v.result?.message).toBe("已是最新版本 v2.24.0");
    expect(v.lines).toEqual(['{"ok":true,"version":"2.24.0","message":"已是最新版本 v2.24.0"}']);
  });

  test("manager 失败：ok:false 的结果行 + 非零退出码", () => {
    const text = "=== run:5 x update ===\n{\"ok\":false,\"error\":\"仓库有未提交的改动\"}\n=== end run:5 exit=1 ===";
    const v = sliceRunLog(text, "5");
    expect(v.done).toBe(true);
    expect(v.result?.ok).toBe(false);
    expect(v.result?.error).toContain("未提交");
    expect(v.exitCode).toBe(1);
  });

  test("只有结束行没有结果 JSON（manager 崩了）也算结束", () => {
    const v = sliceRunLog("=== run:7 x restart-all ===\nboom\n=== end run:7 exit=134 ===", "7");
    expect(v.done).toBe(true);
    expect(v.result).toBeNull();
    expect(v.exitCode).toBe(134);
  });

  test("查较早的一轮：只切到下一轮开始为止", () => {
    const text = "=== run:1 a update ===\nx\n=== end run:1 exit=0 ===\n=== run:2 b update ===\ny";
    expect(sliceRunLog(text, "1").lines).toEqual(["x"]);
    expect(sliceRunLog(text, "1").done).toBe(true);
    expect(sliceRunLog(text, "2").lines).toEqual(["y"]);
    expect(sliceRunLog(text, "2").done).toBe(false);
  });

  test("找不到请求的 runId：found=false，不拿别的轮次顶替", () => {
    const v = sliceRunLog(OLD_TWO_RUNS, "999");
    expect(v.found).toBe(false);
    expect(v.lines).toEqual([]);
    expect(v.done).toBe(false);
  });

  test("没有任何开始行的老日志（update.log 历史）：整段当最后一轮，runId=null", () => {
    const v = sliceRunLog("[update] 临界区完成\n{\"ok\":true}");
    expect(v.runId).toBeNull();
    expect(v.done).toBe(true);
    expect(sliceRunLog("").found).toBe(false);
  });

  test("非结果 JSON（没有 ok 字段）不算完成", () => {
    const v = sliceRunLog('=== run:3 x update ===\n{"progress":1}', "3");
    expect(v.done).toBe(false);
  });
});

describe("isRunActive", () => {
  const running = sliceRunLog("=== run:1000 x restart-all ===\nworking", "1000");
  test("未完成且未超时 = 进行中", () => {
    expect(isRunActive(running, 1000 + 60_000, 20 * 60_000)).toBe(true);
  });
  test("超过 stale 窗口 = 当作已死（外壳被杀，结束行永远不来）", () => {
    expect(isRunActive(running, 1000 + 21 * 60_000, 20 * 60_000)).toBe(false);
  });
  test("已完成 / 老格式 / 没找到 都不算进行中", () => {
    expect(isRunActive(sliceRunLog("=== run:1 x u ===\n=== end run:1 exit=0 ===", "1"), 2, 1e9)).toBe(false);
    expect(isRunActive(sliceRunLog(OLD_TWO_RUNS + "\n=== 2026 restart-all ===\nx"), 0, 1e9)).toBe(false);
    expect(isRunActive(sliceRunLog("", "1"), 0, 1e9)).toBe(false);
  });
});

describe("loggedRunScript", () => {
  test("开始行/结束行都带 runId，结束行取 manager 的退出码（不能用 exec）", () => {
    const s = loggedRunScript({ runId: "42", label: "restart-all --include-master", cmd: '"/bun" run "/r/src/manager.ts" restart', log: "/h/logs/restart-all.log" });
    expect(s).toContain('echo "=== run:42 $(date');
    expect(s).toContain("restart-all --include-master ===");
    expect(s).toContain('echo "=== end run:42 exit=$? ==="');
    expect(s).not.toContain("exec ");
    expect(s).toContain('>> "/h/logs/restart-all.log" 2>&1');
  });
  test("runId / label 带 shell 元字符直接拒", () => {
    expect(() => loggedRunScript({ runId: "1;rm", label: "x", cmd: "true", log: "/l" })).toThrow();
    expect(() => loggedRunScript({ runId: "1", label: "x$(id)", cmd: "true", log: "/l" })).toThrow();
  });
  test("newRunId 是毫秒时间戳", () => {
    expect(newRunId(1234)).toBe("1234");
  });
  test("脚本真跑一遍：写出的日志能被 sliceRunLog 切回来", async () => {
    const dir = `${process.env.TMPDIR || "/tmp"}/run-log-test-${process.pid}`;
    const log = `${dir}/x.log`;
    const s = loggedRunScript({ runId: "77", label: "update", cmd: `(echo '{"ok":true,"message":"hi"}'; exit 3)`, log });
    const p = Bun.spawn(["bash", "-c", s], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    const v = sliceRunLog(await Bun.file(log).text(), "77");
    expect(v.done).toBe(true);
    expect(v.exitCode).toBe(3);
    expect(v.result?.message).toBe("hi");
    Bun.spawnSync(["rm", "-rf", dir]);
  });
});

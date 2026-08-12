/**
 * v2.19.0 restart 结果解读单测。
 *
 * 背景（peer 2026-08-13 P0）：开机恢复波对每个 dead agent 调 restart，返回值
 * 完全不检查——9 个里挂了 3 个，日志里却是「restart 调用完成」。这里锁住
 * 「什么算失败、原因怎么取」，尤其是**失败绝不能返回空串**（空串会被调用方
 * 当成成功，等于把静默失败换个地方复发）。
 */

import { describe, test, expect } from "bun:test";
import { restartFailureReason } from "../src/lib/restart-result.js";

describe("restartFailureReason", () => {
  test("全部成功 → null", () => {
    const out = JSON.stringify({ ok: true, results: [{ name: "agent-a", ok: true }] });
    expect(restartFailureReason({ ok: true, out })).toBeNull();
  });

  test("单个失败 → 带出该项 error", () => {
    const out = JSON.stringify({
      ok: false,
      results: [{ name: "agent-a", ok: false, error: "启动超时" }],
    });
    expect(restartFailureReason({ ok: true, out })).toBe("启动超时");
  });

  test("多个失败 → 汇总所有原因，成功项不混入", () => {
    const out = JSON.stringify({
      ok: false,
      results: [
        { name: "agent-a", ok: true },
        { name: "agent-b", ok: false, error: "shell 未就绪" },
        { name: "agent-c", ok: false, error: "另一个 restart 正在进行" },
      ],
    });
    expect(restartFailureReason({ ok: true, out })).toBe("shell 未就绪; 另一个 restart 正在进行");
  });

  test("ok:false 但 results 里没有失败项 → 退回顶层 error", () => {
    const out = JSON.stringify({ ok: false, error: "registry 读取失败", results: [] });
    expect(restartFailureReason({ ok: true, out })).toBe("registry 读取失败");
  });

  test("ok:false 且什么原因都没给 → 也要有可读文本,不能是空串", () => {
    const out = JSON.stringify({ ok: false });
    expect(restartFailureReason({ ok: true, out })).toBe("未知错误");
  });

  test("失败项 error 缺失 → 占位文本,不能塌成空串", () => {
    const out = JSON.stringify({ ok: false, results: [{ name: "a", ok: false }] });
    expect(restartFailureReason({ ok: true, out })).toBe("未知错误");
  });

  test("输出不是 JSON 且退出码非 0（被超时杀掉）→ 取 stderr 末几行", () => {
    const r = restartFailureReason({ ok: false, out: "", err: "line1\nline2\nboom: killed" });
    expect(r).toBe("line1 line2 boom: killed");
  });

  test("输出不是 JSON、退出码非 0、stderr 也空 → 仍给出可读原因", () => {
    expect(restartFailureReason({ ok: false, out: "", err: "" })).toBe("restart 进程非 0 退出且无输出");
  });

  test("退出码 0 但输出不是 JSON → 按成功处理,不造假失败", () => {
    expect(restartFailureReason({ ok: true, out: "some non-json noise" })).toBeNull();
  });
});

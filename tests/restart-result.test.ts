/**
 * v2.19.0 restart 结果解读单测。
 *
 * 背景（peer 2026-08-13 P0）：开机恢复波对每个 dead agent 调 restart，返回值
 * 完全不检查——9 个里挂了 3 个，日志里却是「restart 调用完成」。这里锁住
 * 「什么算失败、原因怎么取」，尤其是**失败绝不能返回空串**（空串会被调用方
 * 当成成功，等于把静默失败换个地方复发）。
 */

import { describe, test, expect } from "bun:test";
import {
  restartFailureReason, restartFailedNames, parseManagerList, canaryPlan,
  tempAgentCleanupFailure, restartExceptionResult, readyFailureText, modelPinPlan, modelPinRefusal,
} from "../src/lib/restart-result.js";
import { managedFor } from "../src/lib/runtimes/index.js";

describe("restartFailedNames（D7-5：全量重启退出码 0 但部分失败）", () => {
  test("列出失败项的名字；退出码 0 也不能当成功", () => {
    const out = JSON.stringify({ ok: false, results: [{ name: "a", ok: true }, { name: "b", ok: false, error: "启动超时" }] });
    expect(restartFailedNames({ ok: true, out })).toEqual(["b"]);
    expect(restartFailureReason({ ok: true, out })).toBe("启动超时");
  });
  test("非 JSON / 无 results → 空", () => {
    expect(restartFailedNames({ ok: false, out: "boom" })).toEqual([]);
    expect(restartFailedNames({ ok: true, out: '{"ok":true}' })).toEqual([]);
  });
});

describe("canaryPlan：list 失败 与 没有候选 必须分开", () => {
  test("三种结果", () => {
    expect(canaryPlan({ ok: false, reason: "boom" })).toEqual({ kind: "list-failed", reason: "boom" });
    expect(canaryPlan({ ok: true, agents: [{ name: "agent-a", status: "stopped" }] })).toEqual({ kind: "no-candidate" });
    expect(canaryPlan({ ok: true, agents: [{ name: "agent-a", status: "stopped" }, { name: "agent-b", status: "active" }] })).toEqual({ kind: "canary", name: "agent-b" });
  });

  test("合成的 master 行排在最前也不能被选成金丝雀（window 0 改名 master 后的回归）", () => {
    const agents = [
      { name: "master", status: "active" },
      { name: "agent-master", status: "active" },
      { name: "agent-qingniao-backend", status: "active" },
    ];
    expect(canaryPlan({ ok: true, agents })).toEqual({ kind: "canary", name: "agent-qingniao-backend" });
  });

  test("非 agent- 前缀的行不当金丝雀；只剩大总管 = 没有候选", () => {
    const agents = [{ name: "master", status: "active" }, { name: "stray", status: "active" }];
    expect(canaryPlan({ ok: true, agents })).toEqual({ kind: "no-candidate" });
  });

  test("只选活着的 Claude Code agent：Pi / Codex / dead 行排在前面也跳过（重启波验的是新 CC）", () => {
    expect(canaryPlan({ ok: true, agents: [
      { name: "agent-pi", status: "active", runtime: "pi" },
      { name: "agent-cx", status: "active", runtime: "codex" },
      { name: "agent-broken", status: "dead" },
      { name: "agent-cc", status: "active" },
    ] })).toEqual({ kind: "canary", name: "agent-cc" });
    expect(canaryPlan({ ok: true, agents: [{ name: "agent-pi", status: "active", runtime: "pi" }] })).toEqual({ kind: "no-candidate" });
  });
});

describe("parseManagerList（D7-5：list 失败不是「零个 agent」）", () => {
  test("正常", () => {
    expect(parseManagerList({ ok: true, out: '{"ok":true,"agents":[{"name":"x"}]}' })).toEqual({ ok: true, agents: [{ name: "x" }] });
  });
  test("manager 自报失败", () => {
    expect(parseManagerList({ ok: false, out: '{"ok":false,"error":"registry 损坏"}' })).toEqual({ ok: false, reason: "registry 损坏" });
  });
  test("崩溃无输出：带 stderr 尾巴", () => {
    const r = parseManagerList({ ok: false, out: "", err: "line1\nSyntaxError: x\n" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("SyntaxError: x");
  });
  test("缺 agents 字段 / 空输出 也算失败", () => {
    expect(parseManagerList({ ok: true, out: '{"ok":true}' }).ok).toBe(false);
    expect(parseManagerList({ ok: true, out: "" }).ok).toBe(false);
  });
});

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

describe("tempAgentCleanupFailure（cron 临时 agent 收尾的 kill 结果）", () => {
  test("kill 成功不告警", () => {
    expect(tempAgentCleanupFailure({ ok: true })).toBeNull();
  });
  test("create 失败后 kill 报「不存在」= 已被 create 清掉，不告警", () => {
    expect(tempAgentCleanupFailure({ ok: false, error: "agent-cron-daily-report-mfx1a2b 不存在" })).toBeNull();
  });
  test("其它失败照常告警；没有结果也算失败", () => {
    expect(tempAgentCleanupFailure({ ok: false, error: "tmux 挂了" })).toBe("tmux 挂了");
    expect(tempAgentCleanupFailure({ ok: false, error: 'project "x" 不存在。先 project-add' })).toBe('project "x" 不存在。先 project-add');
    expect(tempAgentCleanupFailure(null)).toBe("未知");
  });
});

describe("restartExceptionResult（单个 agent 抛错不再中止整轮 restart）", () => {
  test("异常记成该 agent 的失败项，launcher 拿得到名字和原因", () => {
    const entry = restartExceptionResult("agent-codex-x", new Error("「opus」是 Claude 的模型"));
    expect(entry).toEqual({ name: "agent-codex-x", ok: false, error: "重启异常: 「opus」是 Claude 的模型" });
    const out = JSON.stringify({ ok: false, results: [{ name: "agent-a", ok: true }, entry, { name: "agent-b", ok: true }] });
    expect(restartFailedNames({ ok: true, out })).toEqual(["agent-codex-x"]);
    expect(restartFailureReason({ ok: true, out })).toContain("opus");
  });
  test("非 Error 的抛出值也有可读原因", () => {
    expect(restartExceptionResult("agent-a", "boom").error).toBe("重启异常: boom");
    expect(restartExceptionResult("agent-a", new Error("")).error).toBe("重启异常: 未知错误");
  });
});

describe("readyFailureText（就绪失败按 reason 出文案）", () => {
  test("超时仍叫超时", () => {
    expect(readyFailureText({ ready: false, reason: "timeout" })).toBe("启动超时");
    expect(readyFailureText({ ready: false, reason: "timeout", detail: "shell 未就绪" })).toBe("启动超时：shell 未就绪");
  });
  test("秒退 / 对话框 / 占用不再被说成超时，并带上 detail", () => {
    expect(readyFailureText({ ready: false, reason: "exited", detail: "Not logged in" })).toBe("进程已退出：Not logged in");
    const dialog = readyFailureText({ ready: false, reason: "blocked-dialog", detail: "Update available! Run codex update" });
    expect(dialog).toBe("被启动对话框挡住：Update available! Run codex update");
    const occ = readyFailureText({ ready: false, reason: "occupied" });
    expect(occ).toContain("会话被占用");
    expect(occ).toContain("--fork");
    expect(occ).not.toContain("超时");
  });
});

describe("modelPinPlan / modelPinRefusal（model 命令只钉 in-session 运行时）", () => {
  const enforcementOf = (rt: string | undefined) => managedFor(rt)?.control.modelEnforcement;
  test("model all 跳过 Codex / Pi / 未知运行时，也不碰非 active", () => {
    const plan = modelPinPlan(
      {
        "agent-cc": { status: "active" },
        "agent-cc2": { status: "active", runtime: "claude-code" },
        "agent-codex": { status: "active", runtime: "codex" },
        "agent-pi": { status: "active", runtime: "pi" },
        "agent-odd": { status: "active", runtime: "mystery" },
        "agent-stopped": { status: "stopped" },
      },
      enforcementOf,
    );
    expect(plan.pin).toEqual(["agent-cc", "agent-cc2"]);
    expect(plan.skipped.map((x) => x.name)).toEqual(["agent-codex", "agent-pi", "agent-odd"]);
    expect(plan.skipped[0].reason).toContain("启动参数");
    expect(plan.skipped[2].reason).toContain("不能由 Claudestra 启动");
  });
  test("单设被拒时的说明", () => {
    expect(modelPinRefusal("codex", "launch-flag")).toContain('runtime "codex"');
    expect(modelPinRefusal(undefined, undefined)).toContain('runtime "claude-code"');
  });
});

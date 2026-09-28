/**
 * 协作视图首页纯逻辑（web/features/collab/collab-model.ts、collab-action.ts）：排序、停留时长、卡住判定、一句话状态、此刻动作。
 */
import { describe, expect, test } from "bun:test";
import { actionLine, reduceAction, sayGate, shortDetail, type ActionMap } from "../web/features/collab/collab-action";
import { dwellMs, dwellText, fmtDuration, homeView, isStuck, STUCK_MS, type LedgerOverview, type LedgerTaskView, type Stage } from "../web/features/collab/collab-model";

const MIN = 60_000;
const NOW = new Date(2026, 8, 28, 18, 0).getTime();

function task(id: string, stage: Stage, over: Partial<LedgerTaskView> = {}): LedgerTaskView {
  return {
    id, itemId: null, title: `任务 ${id}`, kind: "code", stage, stageBefore: null, round: 0,
    agent: `agent-task-${id.toLowerCase()}`, pm: "agent-pm", pr: null, spec: null, model: null, extra: {},
    createdAt: NOW - 120 * MIN, updatedAt: NOW - MIN, lastEvent: null, stageSince: NOW - 5 * MIN, lastReview: null,
    metrics: { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 },
    ...over,
  };
}

function overview(tasks: LedgerTaskView[], over: Partial<LedgerOverview> = {}): LedgerOverview {
  return { exists: true, now: NOW, meta: { pms: ["agent-pm"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], tasks, ...over };
}

describe("停留时长与卡住", () => {
  test("stageSince 优先；老 bridge 没有时退到最后一条推到当前阶段的 stage 事件；都没有为 null", () => {
    expect(dwellMs(task("A", "build", { stageSince: NOW - 7 * MIN }), NOW)).toBe(7 * MIN);
    const ev = { seq: 1, ts: NOW - 3 * MIN, actor: "x", target: "B", kind: "stage", text: "", data: { from: "restate", to: "build" } };
    expect(dwellMs(task("B", "build", { stageSince: undefined, lastEvent: ev }), NOW)).toBe(3 * MIN);
    expect(dwellMs(task("C", "review", { stageSince: undefined, lastEvent: ev }), NOW)).toBeNull();
  });

  test("只有等待类阶段超过 30 分钟算卡住；开发、返工再久也不算", () => {
    const long = { stageSince: NOW - STUCK_MS - MIN };
    for (const s of ["restate", "review", "merge", "live"] as Stage[]) expect(isStuck(task("X", s, long), NOW)).toBe(true);
    for (const s of ["build", "fix", "spec"] as Stage[]) expect(isStuck(task("X", s, long), NOW)).toBe(false);
    expect(isStuck(task("X", "review", { stageSince: NOW - STUCK_MS }), NOW)).toBe(false);
  });

  test("导入推断的 stageSince 不判卡住，时长前面标 ≈", () => {
    const t = task("A", "review", { stageSince: NOW - 3 * 60 * MIN, stageSinceApprox: true });
    expect(isStuck(t, NOW)).toBe(false);
    const line = homeView(overview([t]), NOW).lines[0];
    expect(line).toMatchObject({ attention: "waiting", dwellApprox: true, reason: "" });
    expect(dwellText(line)).toBe("在此阶段 ≈3小时");
    expect(dwellText({ dwellMs: 5 * MIN, dwellApprox: false })).toBe("在此阶段 5分");
    expect(dwellText({ dwellMs: null, dwellApprox: false })).toBe("");
  });

  test("fmtDuration：分 / 小时分 / 整小时 / 不到 1 分", () => {
    expect([fmtDuration(30_000), fmtDuration(42 * MIN), fmtDuration(91 * MIN), fmtDuration(120 * MIN)]).toEqual(["不到 1分", "42分", "1小时31分", "2小时"]);
  });
});

describe("首页排序与一句话状态", () => {
  const tasks = [
    task("P", "build", { stageSince: NOW - 80 * MIN }),
    task("W", "review", { round: 2, stageSince: NOW - 7 * MIN }),
    task("M1", "merge", { stageSince: NOW - 42 * MIN }),
    task("M2", "merge", { stageSince: NOW - 10 * MIN }),
    task("F", "fix", { round: 1, stageSince: NOW - 3 * MIN, lastReview: { round: 1, verdict: "changes", p0: 0, p1: 2, p2: 1, text: "位置没恢复\n第二行", ts: NOW - 4 * MIN } }),
    task("Q", "spec", { agent: null }),
    task("D1", "done", { metrics: { ...task("x", "done").metrics, endTs: NOW - 60 * MIN } }),
    task("D0", "verified", { metrics: { ...task("x", "done").metrics, endTs: NOW - 26 * 60 * MIN } }),
    task("X", "cancelled"),
  ];
  const v = homeView(overview(tasks), NOW);

  test("出问题 → 卡住 → 等别人 → 进行中；没派人的 spec、已完成、已取消不画成线", () => {
    expect(v.lines.map((l) => [l.id, l.attention])).toEqual([["F", "problem"], ["M1", "stuck"], ["M2", "waiting"], ["W", "waiting"], ["P", "progress"]]);
  });

  test("阶段短语、原因、合并队列按进入先后排位", () => {
    const by = new Map(v.lines.map((l) => [l.id, l]));
    expect(by.get("F")!).toMatchObject({ stageLabel: "返工中 · 第 1 轮意见", reason: "位置没恢复", tone: "red", column: 3, agent: "task-f" });
    expect(by.get("M1")!).toMatchObject({ stageLabel: "等合并 · 队列第 1 位", reason: "已经等了 42分，超过 30 分钟", stuck: true });
    expect(by.get("M2")!.stageLabel).toBe("等合并 · 队列第 2 位");
    expect(by.get("W")!.stageLabel).toBe("等审查 · 第 2 轮");
    expect(by.get("P")!).toMatchObject({ stageLabel: "开发中", reason: "", tone: "neutral" });
  });

  test("一句话状态计数；今日完成只算本地今天结束的；PM 条的排队", () => {
    expect(v.headline).toEqual({ advancing: 5, problem: 1, stuck: 1, owner: 0 });
    expect(v.todayDone).toEqual(["D1"]);
    expect(v.pm).toMatchObject({ pm: "pm", reviewing: 1, queued: ["Q"], frozen: null });
  });

  test("合并队列冻结时写冻结，卡住原因带上冻结理由", () => {
    const fz = homeView(overview([task("M", "merge", { stageSince: NOW - 40 * MIN })], { meta: { pms: [], docsDir: null, queueFrozen: { frozen: true, reason: "等 T1 上线", since: 0 } } }), NOW);
    expect(fz.lines[0]).toMatchObject({ stageLabel: "合并队列冻结", reason: "已经等了 40分，超过 30 分钟（冻结：等 T1 上线）" });
    expect(fz.pm.frozen).toBe("等 T1 上线");
  });

  test("一句目标：extra.goal → 事项 oneLine → 空", () => {
    const ov = overview([task("G", "build", { extra: { goal: " 目标句 " }, itemId: "i1" }), task("H", "build", { itemId: "i1" }), task("K", "build")], {
      items: [{ id: "i1", title: "事项", oneLine: "事项一句话" }],
    });
    expect(homeView(ov, NOW).lines.map((l) => [l.id, l.goal])).toEqual([["G", "目标句"], ["H", "事项一句话"], ["K", ""]]);
  });

  test("验证失败、回滚算出问题；受阻落在进入受阻前的那一列", () => {
    const ev = (kind: string, data: Record<string, unknown>) => ({ seq: 1, ts: NOW, actor: "a", target: "", kind, text: "", data });
    const ov = overview([
      task("V", "live", { lastEvent: ev("verify", { result: "fail" }) }),
      task("R", "live", { lastEvent: ev("rollback", {}) }),
      task("B", "blocked", { stageBefore: "review", lastEvent: { ...ev("stage", { to: "blocked" }), text: "等上游修复" } }),
    ]);
    const lines = new Map(homeView(ov, NOW).lines.map((l) => [l.id, l]));
    expect(lines.get("V")!).toMatchObject({ attention: "problem", stageLabel: "线上验证失败" });
    expect(lines.get("R")!.attention).toBe("problem");
    expect(lines.get("B")!).toMatchObject({ attention: "problem", column: 3, reason: "等上游修复" });
  });

  test("空台账：没有线、计数全 0", () => {
    expect(homeView(overview([], { exists: false }), NOW)).toMatchObject({ lines: [], todayDone: [], headline: { advancing: 0, problem: 0, stuck: 0 } });
  });
});

describe("此刻动作", () => {
  test("tool_start 记工具与短 detail；tool_done 回思考中；回合结束为空闲；无关事件返回同一张表", () => {
    let m: ActionMap = new Map();
    m = reduceAction(m, { agent: "agent-task-t5", type: "tool_start", data: { name: "Edit", detail: "/Users/x/repo/web/features/chat/scroll-anchor.ts" } }, 1);
    expect(m.get("task-t5")).toEqual({ kind: "tool", tool: "Edit", detail: "scroll-anchor.ts", ts: 1 });
    m = reduceAction(m, { agent: "task-t5", type: "tool_done", data: {} }, 2);
    expect(m.get("task-t5")!.kind).toBe("thinking");
    m = reduceAction(m, { agent: "task-t5", type: "agent_status", data: { status: "done" } }, 3);
    expect(m.get("task-t5")!.kind).toBe("idle");
    expect(reduceAction(m, { agent: "task-t5", type: "assistant_text", data: {} }, 4)).toBe(m);
  });

  // detail 是 jsonl-watcher.formatToolDetail 的输出：Bash = description\n───\ncommand（没有 description 只有 command）
  const SECRETS = ["sk-ant", "ghp_", "Bearer", "/Users", "~/", ".env", "My Docs", "TOKEN=", "abc"];
  const clean = (out: string) => SECRETS.filter((x) => out.includes(x));

  test("shortDetail 不泄露 token、环境变量、绝对路径、带空格的路径（审查 #144 P1-2）", () => {
    const cases: [string, string, string][] = [
      ["Bash", 'curl -H "Authorization: Bearer sk-ant-api03-AAAABBBB" https://x', "curl"],
      ["Bash", "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh pr list", "gh"],
      ["Bash", "cat /Users/shawn/.config/mem0/.env", "cat"],
      ["Bash", "cd /Users/shawn/repos/claude-orchestrator && bun test", "bun"],
      ["Bash", "/opt/homebrew/bin/git status", "git"],
      ["Bash", "Run tests\n───\nTOKEN=abc bun test", "Run tests"],
      ["Bash", "Read /Users/shawn/.ssh/config\n───\ncat ~/.ssh/config", "Read config"],
      ["Bash", "Call API with sk-ant-api03-XXXXXXXX\n───\ncurl x", "Call API with •••"],
      ["Read", "/Users/shawn/My Docs/secret plan.md\noffset=10", "secret plan.md"],
      ["Edit", "/Users/shawn/repos/x/web/a.ts\n─── old ───\nTOKEN=abc\n─── new ───\nb", "a.ts"],
      ["Grep", '{"pattern":"foo","path":"/Users/shawn/repos"}', ""],
      ["mcp__mem0__memory_search", '{"query":"x"}', ""],
      ["bash", "ls /Users/shawn", ""],
    ];
    for (const [tool, detail, want] of cases) {
      const out = shortDetail(tool, detail);
      expect(out).toBe(want);
      expect(clean(out)).toEqual([]);
    }
  });

  test("shortDetail：description 过长按码点截 40 字，不截半个 emoji", () => {
    expect(shortDetail("Bash", `${"跑".repeat(45)}\n───\nls`)).toBe(`${"跑".repeat(40)}…`);
    expect([...shortDetail("Bash", `${"🚀".repeat(41)}\n───\nls`)].length).toBe(41);
  });

  test("MCP 工具名只留最后一段；不在白名单的工具不带 detail", () => {
    const m = reduceAction(new Map(), { agent: "a", type: "tool_start", data: { name: "mcp__mem0__memory_search", detail: '{"query":"secret"}' } }, 1);
    expect(m.get("a")).toEqual({ kind: "tool", tool: "memory_search", ts: 1 });
  });

  test("sayGate：它在干活时不许发（web 消息会先 C-c 打断它），空闲且有字才能发（审查 #144 P0）", () => {
    expect(sayGate(true, "先别动", false)).toEqual({ canSend: false, blockedByWork: true });
    expect(sayGate(false, "先别动", false)).toEqual({ canSend: true, blockedByWork: false });
    expect(sayGate(false, "   ", false).canSend).toBe(false);
    expect(sayGate(false, "先别动", true).canSend).toBe(false);
  });

  test("actionLine：工具 > 思考 > busy 兜底 > 等人 > 空闲", () => {
    expect(actionLine({ kind: "tool", tool: "Bash", detail: "ls", ts: 0 }, false, "等 PM 放行")).toEqual({ kind: "tool", text: "Bash · ls" });
    expect(actionLine(undefined, true, "等 PM 放行").kind).toBe("thinking");
    expect(actionLine({ kind: "idle", ts: 0 }, true, "等 PM 放行")).toEqual({ kind: "waiting", text: "等 PM 放行" });
    expect(actionLine(undefined, false, null)).toEqual({ kind: "idle", text: "" });
  });
});

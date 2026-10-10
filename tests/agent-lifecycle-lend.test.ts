/**
 * LIFE1 B 终态退休端口（src/lib/agent-lifecycle-lend.ts）：只认现读的 B 终态 + 精确 agent / session / gen + 严格 ESRCH 退出证明；
 * 动作只经 runLendTerminal（LIFE1 唯一 collect，archive-only，不碰磁盘 / 不 kill），runLifecycle 拒收这种动作；planner 照旧把出借
 * worker 当 foreign 保护。全是合成事实与假 manager。
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_LIFECYCLE } from "../src/lib/agent-lifecycle-config.js";
import { buildCardWorkerIndex } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, type Action, type AgentFacts } from "../src/lib/agent-lifecycle.js";
import { runLendTerminal, runLifecycle, type LendTerminalDeps } from "../src/lib/agent-lifecycle-run.js";
import { exitProblem, LEND_TERMINAL_DEFAULT, lendTerminalAction, probePid, type LendTerminalFacts } from "../src/lib/agent-lifecycle-lend.js";
import { archiveHash } from "../src/lib/lend-worker-registry-archive.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import type { LendRow } from "../src/lib/lend-journal.js";

const AGENT = workerName("o1");
const id = { orderId: "o1", agent: AGENT, sessionId: "s1", leaseGen: 3 };
const row = (o: Partial<LendRow> = {}): LendRow => ({
  orderId: "o1", peer: "A", fp: null, family: "codex", state: "cancelled", leaseGen: 3, agent: AGENT, sessionId: "s1", dir: "/clone",
  startedAt: 1_000, settle: { notify: null, removeDir: false }, payload: null, payloadSha: null, work: null, receipt: null, notices: {},
  ...o,
} as unknown as LendRow);
const facts = (o: Partial<LendTerminalFacts> = {}): LendTerminalFacts => ({
  id, row: row(), record: { sessionId: "s1", cwd: "/clone", runtime: "codex", kind: "worker", status: "stopped" }, card: undefined,
  window: "no_window", activity: { v: 1, agent: AGENT, sessionId: "s1", hostPid: 4242, busy: false, turnAt: 2_000, updateAt: 2_000, writtenAt: 2_000 },
  probe: "esrch", historyKept: false, ...o,
});
const refusal = (f: LendTerminalFacts) => { const v = lendTerminalAction(f); return "refuse" in v ? v.refuse : null; };

describe("lendTerminalAction：只认现读的精确终态事实", () => {
  test("codex 已 cancelled / released / acked(回执齐) + 退出证明 → archive-only lend_terminal 动作", () => {
    const v = lendTerminalAction(facts());
    expect(v).toEqual({ action: expect.objectContaining({ agent: AGENT, rule: "lend_terminal", taskId: null, sessionId: "s1", cwd: "/clone",
      archiveOnly: { orderId: "o1", leaseGen: 3, historyKept: false } }) });
    expect(refusal(facts({ row: row({ state: "released" }) }))).toBeNull();
    const payload = { orderId: "o1", gen: 3, session: { id: "s1" } }, sha = archiveHash(JSON.stringify(payload));
    expect(refusal(facts({ row: row({ state: "acked", payload, payloadSha: sha, receipt: { orderId: "o1", sha256: sha } } as Partial<LendRow>) }))).toBeNull();
  });

  test.each([
    ["stopped", { row: row({ state: "stopped" as LendRow["state"] }) }, "不是可归档的 B 终态"],
    ["started (live)", { row: row({ state: "started" as LendRow["state"] }) }, "不是可归档的 B 终态"],
    ["missing row", { row: null }, "不匹配"],
    ["later claim gen", { row: row({ leaseGen: 4 }) }, "不匹配"],
    ["replaced session", { record: { ...facts().record!, sessionId: "s2" } }, "已变"],
    ["active record", { record: { ...facts().record!, status: "active" } }, "未完成退役"],
    ["pending op", { record: { ...facts().record!, pending: { op: "kill" } } }, "未完成退役"],
    ["pm role", { record: { ...facts().record!, role: "pm" } }, "不是可退役 worker"],
    ["late result", { row: row({ payload: { late: true } } as Partial<LendRow>) }, "未确认结果"],
    ["settle unfinished", { row: row({ settle: { notify: "stopped", removeDir: false } } as Partial<LendRow>) }, "收尾"],
    ["local card link", { card: buildCardWorkerIndex({ registrations: [{ agent: AGENT, taskId: "T1", role: "author", sessionId: "s1" }], bound: [], executors: [] }).get(AGENT) }, "本机卡"],
    ["window running", { window: "running" as const }, "不当已退出"],
    ["window unknown", { window: "unknown" as const }, "不当已退出"],
    ["no activity", { activity: null }, "没有 ACP 活动记录"],
    ["activity of another agent", { activity: { ...facts().activity!, agent: "agent-x" } }, "不是本单"],
    ["activity before start", { activity: { ...facts().activity!, writtenAt: 999 } }, "早于本单开跑"],
    ["start unknown", { row: row({ startedAt: null }) }, "开跑时刻不明"],
    ["pid alive", { probe: "alive" as const }, "严格 ESRCH"],
    ["pid EPERM", { probe: "eperm" as const }, "严格 ESRCH"],
    ["pid unknown", { probe: "unknown" as const }, "严格 ESRCH"],
  ])("拒绝：%s", (_n, over, reason) => {
    expect(refusal(facts(over as Partial<LendTerminalFacts>))).toContain(reason);
  });

  test("Claude 家族没有退出证明端口：blocked-capability，不当已退出", () => {
    const v = lendTerminalAction(facts({ row: row({ family: "claude" }), record: { ...facts().record!, runtime: undefined } }));
    expect(v).toMatchObject({ blocked: true });
    expect("refuse" in v && v.refuse).toContain("blocked-capability");
  });

  test("exitProblem 单独：窗口消失本身不够", () => {
    expect(exitProblem({ ...facts(), activity: null })).toContain("退出无法证明");
    expect(exitProblem(facts())).toBeNull();
  });

  test("probePid：ESRCH / EPERM / 活着 / 其他错误各自归类；真进程退出后是 esrch", async () => {
    const err = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(probePid(1, err("ESRCH"))).toBe("esrch");
    expect(probePid(1, err("EPERM"))).toBe("eperm");
    expect(probePid(1, err("EINVAL"))).toBe("unknown");
    expect(probePid(process.pid)).toBe("alive");
    const p = Bun.spawn(["true"]);
    await p.exited;
    expect(probePid(p.pid)).toBe("esrch");
  });

  test("生产缺省是 observe（不执行）", () => expect(LEND_TERMINAL_DEFAULT).toBe("observe"));
});

describe("runLendTerminal：LIFE1 collect 的 archive-only 路径", () => {
  const action = (historyKept = false) => (lendTerminalAction(facts({ historyKept })) as { action: Action }).action;
  function deps(over: Partial<{ archive: Record<string, unknown>; remove: Record<string, unknown>; session: string }> = {}) {
    const calls: string[][] = [], records: unknown[] = [];
    const d: LendTerminalDeps = {
      now: () => 5, record: async (r) => void records.push(r),
      agents: async () => [{ name: AGENT, status: "stopped", sessionId: over.session ?? "s1", cwd: "/clone", pending: false, window: false }],
      manager: async (...args) => { calls.push(args); return args[0] === "archive" ? over.archive ?? { ok: true, note: "ok" } : over.remove ?? { ok: true, message: "已退役" }; },
    };
    return { d, calls, records };
  }

  test("archive → remove，各一次；记录无磁盘条目", async () => {
    const t = deps();
    expect(await runLendTerminal(action(), t.d)).toEqual({ ok: true });
    expect(t.calls).toEqual([["archive", AGENT], ["remove", AGENT]]);
    expect(t.records).toEqual([expect.objectContaining({ agent: AGENT, rule: "lend_terminal", pending: [], bytesBefore: null, bytesAfter: null })]);
  });

  test("会话归档已在：不二次归档", async () => {
    const t = deps();
    expect(await runLendTerminal(action(true), t.d)).toEqual({ ok: true });
    expect(t.calls).toEqual([["remove", AGENT]]);
  });

  test("归档没成（含「源不存在」）一律不 remove；会话已换不 remove；remove 拒绝如实返回", async () => {
    for (const archive of [{ ok: false, note: "磁盘满" }, { ok: false, error: "源 jsonl 不存在" }]) {
      const t = deps({ archive });
      expect(await runLendTerminal(action(), t.d)).toMatchObject({ error: expect.stringContaining("归档没成") });
      expect(t.calls).toEqual([["archive", AGENT]]);
    }
    const replaced = deps({ session: "s2" });
    expect(await runLendTerminal(action(), replaced.d)).toMatchObject({ error: expect.stringContaining("不是计划里的") });
    expect(replaced.calls).toEqual([]);
    const refused = deps({ remove: { ok: false, error: "archive-only 退役拒绝：窗口还在" } });
    expect(await runLendTerminal(action(), refused.d)).toEqual({ error: "archive-only 退役拒绝：窗口还在" });
    expect(refused.records).toEqual([]);
  });

  test("非 lend_terminal / 缺 archiveOnly 的动作不收", async () => {
    const t = deps();
    expect(await runLendTerminal({ ...action(), rule: "card_finished" }, t.d)).toHaveProperty("error");
    expect(await runLendTerminal({ ...action(), archiveOnly: undefined }, t.d)).toHaveProperty("error");
    expect(t.calls).toEqual([]);
  });

  test("普通 runLifecycle 拒收 archive-only 动作，不走普通 archive / remove / 磁盘", async () => {
    const calls: string[][] = [];
    const r = await runLifecycle({ actions: [action()], memory: [], cleanups: [], frozen: [], kept: [], live: 0, registerFailed: 0, swapPct: null },
      { ...DEFAULT_LIFECYCLE, mode: "on" },
      { manager: async (...a: string[]) => { calls.push(a); return { ok: true }; }, now: () => 5, cleanupStatePath: "/nonexistent/c.json" } as never);
    expect(r.failed).toEqual([{ agent: AGENT, error: "archive-only 退休只经 runLendTerminal" }]);
    expect(calls).toEqual([]);
  });
});

test("planner 照旧：出借 worker 是 foreign，即便同名关联完成的卡、swap 爆表也不计划", () => {
  const a: AgentFacts = { name: AGENT, kind: "worker", status: "stopped", sessionId: "s1", running: false, idleMs: 99 * 3_600_000, turnActive: false };
  const index = buildCardWorkerIndex({ registrations: [{ agent: AGENT, taskId: "T1", role: "author", sessionId: "s1" }], bound: [], executors: [] });
  const plan = planLifecycle({ now: 100 * 3_600_000, policy: { ...DEFAULT_LIFECYCLE }, agents: [a], index, pms: new Set(), master: new Set(), swapPct: 99,
    cards: [{ id: "T1", project: "p", stage: "done", frozen: false, stageAt: 0, reviewAt: null, agent: null }], foreign: new Set([AGENT]) });
  expect(plan.actions).toEqual([]);
  expect(plan.memory).toEqual([]);
});

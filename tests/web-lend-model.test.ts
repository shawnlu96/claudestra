/**
 * web/features/lend/lend-model.ts（i28-R7a）：表单缺省与 maxDays 上限、请求体不带角色、授权状态、
 * 借出单状态映射（收回后停止中 → 70 秒告警，journal 终态才算已停）、notices → 时间线。
 */
import { describe, expect, test } from "bun:test";
import {
  addRepos, canSubmit, dayChoices, formDefaults, grantBody, grantStatus, markStopping, mergeOrders, needsFastPoll, orderPhase, orderTitle,
  remainingMs, splitRemaining, STUCK_MS, timeline, withSnapshot, type GrantView, type OrderView,
} from "../web/features/lend/lend-model";

const T = Date.parse("2026-10-01T00:00:00Z");
const DAY = 86_400_000;
const g = (over: Partial<GrantView> = {}): GrantView => ({ peer: "team-a", repos: ["o/r"], roles: ["review"], families: { codex: 3 }, ordersPerDay: 50,
  until: new Date(T + 2 * DAY).toISOString(), grantedAt: new Date(T - DAY).toISOString(), paused: null, problem: null, ...over });
const o = (id: string, state: string, over: Partial<OrderView> = {}): OrderView => ({ orderId: id, peer: "team-a", family: "codex", state, repo: "o/r", pr: 7,
  taskId: "T1", step: "review", agent: "lend-w", startedAt: T, updatedAt: T, reason: null, notices: null, ...over });

describe("表单", () => {
  test("缺省：codex 5、每日 200、到期取最长一档（7 天），peer 取第一个", () => {
    expect(formDefaults(7, [{ name: "p1" }, { name: "p2" }])).toEqual({ peer: "p1", repos: [], codex: 5, ordersPerDay: 200, days: 7 });
  });

  test("到期档位与上限跟服务端 maxDays 走", () => {
    expect(dayChoices(7)).toEqual([1, 3, 7]);
    expect(dayChoices(3)).toEqual([1, 3]);
    expect(dayChoices(0.5)).toEqual([1]);
    expect(formDefaults(3, []).days).toBe(3);
    expect(grantBody({ ...formDefaults(7, []), days: 7 }, 3).until).toBe("3d");
  });

  test("重新授权：预填原条目的 peer / 仓库 / 名额", () => {
    const f = formDefaults(7, [{ name: "x" }], g({ paused: "旧条目", repos: ["a/b", "c/d"] }));
    expect(f).toEqual({ peer: "team-a", repos: ["a/b", "c/d"], codex: 3, ordersPerDay: 50, days: 7 });
  });

  test("请求体只有五个字段，没有 roles（write 无从带出）", () => {
    const b = grantBody({ peer: "p", repos: ["o/r"], codex: 5, ordersPerDay: 200, days: 7 }, 7);
    expect(Object.keys(b).sort()).toEqual(["codex", "ordersPerDay", "peer", "repos", "until"]);
    expect(JSON.stringify(b)).not.toMatch(/write|roles/);
  });

  test("仓库：逗号 / 空白分隔、去重；没 peer 或没仓库不能提交", () => {
    expect(addRepos(["o/r"], " a/b, o/r  c/d ")).toEqual(["o/r", "a/b", "c/d"]);
    expect(canSubmit({ peer: "", repos: ["o/r"], codex: 5, ordersPerDay: 1, days: 7 })).toBe(false);
    expect(canSubmit({ peer: "p", repos: [], codex: 5, ordersPerDay: 1, days: 7 })).toBe(false);
    expect(canSubmit({ peer: "p", repos: ["o/r"], codex: 5, ordersPerDay: 1, days: 7 })).toBe(true);
  });
});

describe("授权列表", () => {
  test("状态：暂停 > 过期 > 其它问题 > 正常", () => {
    expect(grantStatus(g(), T)).toBe("ok");
    expect(grantStatus(g({ paused: "x", problem: "暂停" }), T)).toBe("paused");
    expect(grantStatus(g({ problem: "到期" }), T + 3 * DAY)).toBe("expired");
    expect(grantStatus(g({ problem: "指纹变了" }), T)).toBe("invalid");
  });

  test("剩余时间", () => {
    expect(splitRemaining(remainingMs(g(), T + 90 * 60_000)!)).toEqual({ d: 1, h: 22, m: 30 });
    expect(remainingMs(g(), T + 9 * DAY)).toBe(0);
    expect(remainingMs(g({ until: null }), T)).toBeNull();
  });
});

describe("借出单状态", () => {
  test("没收回：asked = 等待，其余 live = 在跑；acked = 交付，其它终态 = 已停", () => {
    const none = new Map<string, number>();
    expect(orderPhase(o("a", "asked"), none, T)).toBe("waiting");
    expect(orderPhase(o("a", "started"), none, T)).toBe("running");
    expect(orderPhase(o("a", "acked"), none, T)).toBe("done");
    for (const s of ["stopped", "released", "declined", "cancelled"]) expect(orderPhase(o("a", s), none, T)).toBe("stopped");
  });

  test("收回后：这个 peer 的在跑单立刻停止中；70 秒后仍 live 换告警；journal 终态才是已停", () => {
    const snap = [o("a", "started")];
    const cur = [o("a", "started"), o("b", "claimed"), o("c", "started", { peer: "team-b" }), o("d", "acked")];
    const st = markStopping(new Map(), "team-a", snap, cur, T);
    expect([...st.keys()].sort()).toEqual(["a", "b"]);
    expect(orderPhase(cur[0], st, T)).toBe("stopping");
    expect(orderPhase(cur[0], st, T + STUCK_MS - 1)).toBe("stopping");
    expect(orderPhase(cur[0], st, T + STUCK_MS)).toBe("stuck");
    expect(orderPhase(cur[2], st, T)).toBe("running");
    expect(orderPhase(o("a", "stopped"), st, T + 1000)).toBe("stopped");
    expect(needsFastPoll(st)).toBe(true);
  });

  test("全部收回（peer=null）标所有在跑单；已在停的保留原起点", () => {
    const st = markStopping(new Map([["a", T - 5000]]), null, [], [o("a", "started"), o("c", "asked", { peer: "team-b" })], T);
    expect(st.get("a")).toBe(T - 5000);
    expect(st.get("c")).toBe(T);
  });

  test("合并：还 live 的继续停止中；列表里暂时找不到的不当已停、保留原行；进终态清标记", () => {
    const st = new Map([["a", T], ["b", T]]);
    const prev = [o("a", "started"), o("b", "started")];
    const r = mergeOrders(prev, [o("a", "started")], st);
    expect(r.orders.map((x) => [x.orderId, x.state])).toEqual([["a", "started"], ["b", "started"]]);
    expect(orderPhase(r.orders[1], r.stopping, T + 1000)).toBe("stopping");
    const r2 = mergeOrders(r.orders, [o("a", "stopped"), o("b", "released")], r.stopping);
    expect(r2.stopping.size).toBe(0);
    expect(r2.orders.map((x) => orderPhase(x, r2.stopping, T))).toEqual(["stopped", "stopped"]);
    expect(needsFastPoll(r2.stopping)).toBe(false);
  });

  test("收回快照并进列表：新单排前，同 id 用快照的行", () => {
    expect(withSnapshot([o("a", "asked"), o("z", "acked")], [o("a", "started"), o("n", "claimed")]).map((x) => [x.orderId, x.state]))
      .toEqual([["n", "claimed"], ["a", "started"], ["z", "acked"]]);
  });

  test("标题：repo#pr，缺 pr 只 repo，缺 repo 用 taskId", () => {
    expect(orderTitle(o("a", "started"))).toBe("o/r#7");
    expect(orderTitle(o("a", "started", { pr: null }))).toBe("o/r");
    expect(orderTitle(o("a", "started", { repo: null }))).toBe("T1");
  });
});

describe("notices → 时间线", () => {
  test("开跑 / 交付 / 停止；sentAt 为 null 是待补发", () => {
    expect(timeline(null)).toEqual([]);
    expect(timeline({ start: T })).toEqual([{ kind: "start", at: T, pending: false, why: null }]);
    expect(timeline({ start: T, end: { kind: "acked", why: null, sentAt: T + 5 } })[1]).toEqual({ kind: "delivered", at: T + 5, pending: false, why: null });
    expect(timeline({ end: { kind: "stopped", why: "收回", sentAt: null } })).toEqual([{ kind: "stopped", at: null, pending: true, why: "收回" }]);
  });
});

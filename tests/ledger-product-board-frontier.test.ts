/**
 * team-project-PDSTATE1：产品板 feature 的派生状态、全完成标记、前沿节点（纯函数 productFrontier）。
 * 执行者名一律用假名（peer-a / agent-x），代码和测试都不写具体人名、机器名。
 */
import { expect, test } from "bun:test";
import type { EtaNode } from "../src/lib/ledger-product-board-eta.js";
import { LOCAL_MEMBER, productFrontier, STALE_MS } from "../src/lib/ledger-product-board-frontier.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";

const HOUR = 60 * 60 * 1000, now = 1_000 * HOUR;
type CardOpts = Partial<Pick<LedgerTask, "round" | "updatedAt" | "assigneeKind" | "title">>;
const card = (id: string, stage: Stage, o: CardOpts = {}): LedgerTask =>
  ({ id, stage, project: "p", kind: "code", title: o.title ?? `卡 ${id}`, round: o.round ?? 0, updatedAt: o.updatedAt ?? now - HOUR,
    assigneeKind: o.assigneeKind ?? null } as LedgerTask);
/** bind：卡对象 = 绑卡；"missing" = 绑了卡但读不到；null = 没绑卡 */
const node = (key: string, bind: LedgerTask | "missing" | null, deps: string[] = [], oneLine = `节点 ${key}`): EtaNode => ({
  key, taskId: bind === null ? null : bind === "missing" ? `t-${key}` : bind.id, task: bind && bind !== "missing" ? bind : null,
  oneLine, deps, estimate: "", status: "planned", inheritedFrom: null,
});
const ev = (target: string, ts: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq: 1, ts, actor: "owner", project: "p", target, kind, text: "", data, dedupKey: null });
const events = (...list: LedgerEvent[]) => {
  const m = new Map<string, LedgerEvent[]>();
  for (const e of list) m.set(e.target, [...(m.get(e.target) ?? []), e]);
  return m;
};
const run = (nodes: EtaNode[] | null, o: { status?: string; cards?: LedgerTask[]; events?: Map<string, LedgerEvent[]> } = {}) =>
  productFrontier({ status: o.status ?? "active", nodes, cards: o.cards ?? [], events: o.events ?? new Map(), now });
const range = (p: string, k: number) => Array.from({ length: k }, (_, i) => `${p}${i}`);
const fresh = (id: string) => ev(id, now - HOUR, "note");
const old = (id: string) => ev(id, now - 25 * HOUR, "note");

test("七种 state 逐条命中", () => {
  const done = card("d", "verified");
  // done：status=done 时不管节点
  expect(run([node("a", card("a", "build"))], { status: "done", events: events(fresh("a")) })).toMatchObject({ state: "done", complete: false, frontier: [] });
  // run：有 active 且 24 小时内有动静
  expect(run([node("a", card("a", "build"))], { events: events(fresh("a")) }).state).toBe("run");
  // blocked
  expect(run([node("b", card("b", "blocked")), node("n", null)]).state).toBe("blocked");
  // stale：active 都超过 24 小时没动静
  expect(run([node("a", card("a", "build", { updatedAt: now - 30 * HOUR }))], { events: events(old("a")) }).state).toBe("stale");
  // ready：有不是 PAGEOK 的可开工行
  expect(run([node("d", done), node("n", null, ["d"]), node("w", null, ["n"])]).state).toBe("ready");
  // gate：没完成的行全是 PAGEOK
  expect(run([node("d", done), node("PAGEOK", null, ["d"])]).state).toBe("gate");
  // wait：一行都没有；或者只剩等远期前置的节点
  expect(run([])).toEqual({ state: "wait", complete: false, frontier: [] });
  expect(run([node("far", null, [], "（远期）以后"), node("w", null, ["far"])]).state).toBe("wait");
});

test("顺序规则：5 在跑 + 2 受阻 → run；受阻 + 只有 25 小时没动的 active → blocked", () => {
  const act = range("a", 5).map((k) => node(k, card(k, "build"))), blk = range("b", 2).map((k) => node(k, card(k, "blocked")));
  expect(run([...act, ...blk], { events: events(...range("a", 5).map(fresh)) }).state).toBe("run");
  const stale = node("a", card("a", "review", { updatedAt: now - 25 * HOUR }));
  const r = run([stale, ...blk], { events: events(old("a")) });
  expect(r.state).toBe("blocked");
  expect(r.frontier.map((f) => f.key)).toEqual(["b0", "b1", "a"]);
  // 24 小时门槛：恰好 24 小时算没动静
  expect(run([node("a", card("a", "build"))], { events: events(ev("a", now - STALE_MS, "note")) }).state).toBe("stale");
});

test("全完成：status=active 但全完成（含 1 个远期）→ done 且 complete；全是远期不算完成；只剩 PAGEOK 就绪 → gate", () => {
  const nodes = [node("a", card("a", "verified")), node("b", card("b", "cancelled")), node("far", null, [], "(远期) 以后")];
  expect(run(nodes)).toEqual({ state: "done", complete: true, frontier: [] });
  expect(run([node("f1", null, [], "（远期）x"), node("f2", card("f2", "build"), [], "（远期）y")])).toMatchObject({ complete: false, state: "wait" });
  const gate = run([node("a", card("a", "verified")), node("PAGEOK", null, ["a"])]);
  expect(gate).toMatchObject({ state: "gate", complete: false });
  expect(gate.frontier.map((f) => f.key)).toEqual(["PAGEOK"]);
  // 凭验收源完成的 PAGEOK（accepted）算完成
  expect(run([node("a", card("a", "verified")), { ...node("PAGEOK", null, ["a"]), accepted: true }])).toMatchObject({ state: "done", complete: true });
});

test("没 DAG：每张卡一行；卡全 verified → complete；有在跑的卡 → run，前沿用卡标题", () => {
  const cards = [card("c1", "verified"), card("c2", "verified")];
  expect(run(null, { cards })).toEqual({ state: "done", complete: true, frontier: [] });
  const r = run(null, { cards: [...cards, card("c3", "build", { title: "在跑的卡", round: 2 })], events: events(fresh("c3")) });
  expect(r).toMatchObject({ state: "run", complete: false });
  expect(r.frontier).toEqual([{ key: "c3", taskId: "c3", title: "在跑的卡", stage: "build", round: 2, member: null, sinceMs: now - HOUR }]);
  // 没卡的空 feature
  expect(run(null)).toEqual({ state: "wait", complete: false, frontier: [] });
});

test("前沿：12 个候选只出 6 个；active 动静新的在前，blocked 进阶段早的在前，ready 按 DAG 顺序", () => {
  const actives = ["a0", "a1", "a2"].map((k) => node(k, card(k, "build")));
  const blocked = ["b0", "b1", "b2"].map((k) => node(k, card(k, "blocked")));
  const lost = node("b3", "missing");
  const ready = range("r", 5).map((k) => node(k, null));
  const es = events(ev("a0", now - 3 * HOUR, "note"), ev("a1", now - HOUR, "note"), ev("a2", now - 2 * HOUR, "note"),
    ev("b0", now - 5 * HOUR, "stage", { to: "blocked" }), ev("b1", now - 9 * HOUR, "stage", { to: "blocked" }), ev("b2", now - 7 * HOUR, "stage", { to: "blocked" }));
  const nodes = [...ready, ...blocked, lost, ...actives];
  expect(nodes.length).toBe(12);
  const r = run(nodes, { events: es });
  expect(r.state).toBe("run");
  expect(r.frontier.map((f) => f.key)).toEqual(["a1", "a2", "a0", "b1", "b2", "b0"]);
  // state=blocked 时受阻先出，读不到的卡（sinceMs 未知）排在受阻组最后
  const rb = run([...ready, ...blocked, lost], { events: es });
  expect(rb.state).toBe("blocked");
  expect(rb.frontier.map((f) => f.key)).toEqual(["b1", "b2", "b0", "b3", "r0", "r1"]);
  // ready 组按 DAG 顺序
  expect(run(ready).frontier.map((f) => f.key)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
});

test("前沿项字段：peer 给 peer 名、本机给「本机」、最新一条派单为准；没绑卡 sinceMs / member 为 null；stage 取卡现读的值", () => {
  const assign = (id: string, ts: number, executor: string, executorKind: string) =>
    ev(id, ts, "step", { op: "assign", step: "write", round: 0, executor, executorKind });
  const nodes = [
    { ...node("peer", card("peer", "build", { round: 3, assigneeKind: "agent" })), status: "spec" as const },
    node("local", card("local", "review")), node("human", card("human", "fix")), node("back", card("back", "build")),
    node("plain", card("plain", "restate", { assigneeKind: "agent", updatedAt: now - 4 * HOUR })),
    node("nobody", card("nobody", "restate", { assigneeKind: "human" })),
  ];
  const es = events(
    ev("peer", now - 6 * HOUR, "stage", { to: "build" }), ev("peer", now - 5 * HOUR, "note"), assign("peer", now - 2 * HOUR, "agent-x@peer-a", "peer"),
    assign("local", now - HOUR, "agent-x", "agent"), assign("human", now - HOUR, "local:someone", "human"),
    assign("back", now - 3 * HOUR, "agent-y@peer-b", "peer"), assign("back", now - 2 * HOUR, "agent-y", "agent"),
  );
  const items = new Map(run(nodes, { events: es }).frontier.map((f) => [f.key, f]));
  expect(items.get("peer")).toEqual({ key: "peer", taskId: "peer", title: "卡 peer", stage: "build", round: 3, member: "peer-a", sinceMs: now - 6 * HOUR });
  expect(items.get("local")!.member).toBe(LOCAL_MEMBER);
  expect(items.get("human")!.member).toBe(LOCAL_MEMBER);
  expect(items.get("back")!.member).toBe(LOCAL_MEMBER);
  // 没有派单事件：看卡的 assigneeKind；sinceMs 没有阶段事件就用卡 updatedAt
  expect(items.get("plain")).toMatchObject({ member: LOCAL_MEMBER, sinceMs: now - 4 * HOUR });
  expect(items.get("nobody")!.member).toBeNull();
  const loose = run([node("todo", null, [], "还没开卡的节点"), node("lost", "missing", [], "卡丢了")]).frontier;
  expect(loose).toEqual([
    { key: "lost", taskId: "t-lost", title: "卡丢了", stage: null, round: 0, member: null, sinceMs: null },
    { key: "todo", taskId: null, title: "还没开卡的节点", stage: "planned", round: 0, member: null, sinceMs: null },
  ]);
});

/**
 * project-map-PDSTATE2：产品板认「已暂停」和「冻结」。冻结名单只用合成卡号，不写真实名单。
 */
import { expect, test } from "bun:test";
import type { EtaNode } from "../src/lib/ledger-product-board-eta.js";
import { countRows, productFrontier } from "../src/lib/ledger-product-board-frontier.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { productNodeCounts } from "../src/lib/product-node-counts.js";

const HOUR = 60 * 60 * 1000, now = 1_000 * HOUR;
const card = (id: string, stage: Stage, updatedAt = now - HOUR): LedgerTask =>
  ({ id, stage, project: "p", kind: "code", title: `卡 ${id}`, round: 0, updatedAt, assigneeKind: null } as LedgerTask);
const node = (key: string, bind: LedgerTask | null, deps: string[] = []): EtaNode => ({
  key, taskId: bind ? bind.id : null, task: bind, oneLine: `节点 ${key}`, deps, estimate: "", status: "planned", inheritedFrom: null,
});
const ev = (target: string, ts: number): LedgerEvent => ({ seq: 1, ts, actor: "owner", project: "p", target, kind: "note", text: "", data: {}, dedupKey: null });
const events = (...list: LedgerEvent[]) => new Map(list.map((e) => [e.target, [e]]));
const run = (nodes: EtaNode[] | null, o: { status?: string; cards?: LedgerTask[]; events?: Map<string, LedgerEvent[]>; frozen?: string[] } = {}) =>
  productFrontier({ status: o.status ?? "active", nodes, cards: o.cards ?? [], events: o.events ?? new Map(), now,
    ...(o.frozen ? { frozen: new Set(o.frozen) } : {}) });
const oldActive = (id: string) => node(id, card(id, "build", now - 25 * HOUR));
const oldEvents = (...ids: string[]) => events(...ids.map((id) => ev(id, now - 25 * HOUR)));

test("[验收线 1] status=paused：就算有 1 小时内有动静的 active 行也是 paused，前沿照给", () => {
  const r = run([node("a", card("a", "build"))], { status: "paused", events: events(ev("a", now - HOUR)) });
  expect(r.state).toBe("paused");
  expect(r.frontier.map((f) => f.key)).toEqual(["a"]);
  // 旧 active 行：main 上是 stale
  expect(run([oldActive("a")], { status: "paused", events: oldEvents("a") }).state).toBe("paused");
  // done 优先于 paused
  expect(run([node("a", card("a", "verified"))], { status: "paused" }).state).toBe("done");
});

test("[验收线 1] 冻结行不参与判状态：冻结旧 active + 没冻结的 ready → ready；+ 没冻结的 25 小时 spec 行 → stale", () => {
  const frozen = ["Tf"];
  expect(run([oldActive("Tf"), node("n", null)], { events: oldEvents("Tf"), frozen }).state).toBe("ready");
  expect(run([oldActive("Tf"), node("n", null)], { events: oldEvents("Tf") }).state).toBe("stale");
  // 没 DAG 的 feature：一张冻结的 active 卡 + 一张没冻结、25 小时没动的 spec 卡（计数仍是 ready，状态算久未动）
  const cards = [card("Tf", "build", now - 25 * HOUR), card("Ts", "spec", now - 25 * HOUR)];
  expect(run(null, { cards, frozen }).state).toBe("stale");
  expect(run(null, { cards, events: oldEvents("Tf", "Ts"), frozen }).state).toBe("stale");
  expect(run([oldActive("Tf"), node("Ts", card("Ts", "spec", now - 25 * HOUR))], { events: oldEvents("Tf", "Ts"), frozen }).state).toBe("stale");
  // 1 小时内动过的 spec 卡、没绑卡的就绪节点仍是 ready；计数不变
  expect(run(null, { cards: [cards[0]!, card("Ts", "spec")], events: oldEvents("Tf"), frozen }).state).toBe("ready");
  expect(productNodeCounts(countRows([oldActive("Tf"), node("Ts", card("Ts", "spec", now - 25 * HOUR))])).ready).toBe(1);
});

test("[验收线 1] 只剩冻结行（可以再加在等前置的行）→ frozen；没有冻结名单时同一份夹具和原来一样", () => {
  const done = node("d", card("d", "verified"));
  const only = [done, oldActive("Tf")], withWait = [done, oldActive("Tf"), node("w", null, ["Tf"])];
  expect(run(only, { events: oldEvents("Tf"), frozen: ["Tf"] }).state).toBe("frozen");
  expect(run(withWait, { events: oldEvents("Tf"), frozen: ["Tf"] }).state).toBe("frozen");
  expect(run(null, { cards: [card("Tf", "spec")], frozen: ["Tf"] }).state).toBe("frozen");
  for (const nodes of [only, withWait]) {
    expect(run(nodes, { events: oldEvents("Tf") })).toEqual(run(nodes, { events: oldEvents("Tf"), frozen: [] }));
    expect(run(nodes, { events: oldEvents("Tf") }).state).toBe("stale");
  }
  // 冻结的是已完成的卡、只剩等远期：不算 frozen
  expect(run([node("Tf", card("Tf", "verified")), node("w", null, ["x"])], { frozen: ["Tf"] }).state).toBe("wait");
  // 冻结行之外还有 PAGEOK 就绪 → gate（原规则在前）
  expect(run([done, oldActive("Tf"), node("PAGEOK", null, ["d"])], { events: oldEvents("Tf"), frozen: ["Tf"] }).state).toBe("gate");
});

test("[验收线 1] 前沿：冻结行排在全部非冻结行之后、带 frozen: true，非冻结行不带这个键；最多 6 个", () => {
  const nodes = [oldActive("Tf"), node("Tb", card("Tb", "blocked")), node("a", card("a", "build")), node("r", null)];
  const r = run(nodes, { events: events(ev("Tf", now - 25 * HOUR), ev("a", now - HOUR)), frozen: ["Tf", "Tb"] });
  expect(r.state).toBe("run");
  expect(r.frontier.map((f) => f.key)).toEqual(["a", "r", "Tf", "Tb"]);
  expect(r.frontier.map((f) => f.frozen)).toEqual([undefined, undefined, true, true]);
  expect(r.frontier.filter((f) => !f.frozen).every((f) => !("frozen" in f))).toBe(true);
  const many = Array.from({ length: 8 }, (_, i) => node(`r${i}`, null));
  const capped = run([oldActive("Tf"), ...many], { events: oldEvents("Tf"), frozen: ["Tf"] });
  expect(capped.frontier.map((f) => f.key)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  expect(run([oldActive("Tf")], { events: oldEvents("Tf") }).frontier[0]).not.toHaveProperty("frozen");
});

test("[验收线 1] counts 和不传 frozen 时逐值相等（冻结行照旧计入原来的类别）", () => {
  const nodes = [oldActive("Tf"), node("Tb", card("Tb", "blocked")), node("d", card("d", "verified")), node("w", null, ["Tf"])];
  const counts = productNodeCounts(countRows(nodes));
  expect(counts).toEqual({ total: 4, completed: 1, active: 1, ready: 0, blocked: 1, deferred: 0, waiting: 1 });
  const a = run(nodes, { events: oldEvents("Tf") }), b = run(nodes, { events: oldEvents("Tf"), frozen: ["Tf", "Tb"] });
  expect(a.complete).toBe(b.complete);
  expect(b.frontier.map((f) => f.key).sort()).toEqual(a.frontier.map((f) => f.key).sort());
});

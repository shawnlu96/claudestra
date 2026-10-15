/**
 * PMEMTUNE2 验收线 5 · 只读回放：窗口内每次写单注入（scheduler 事件 op = memory_retrieve），旧选择 = 当时实际推出的 memoryIds，
 * 新选择 = 用当时的排名事件（op = memory_rank 的 items + dropped，分数 = RRF × 旧先验）
 * 按新规则重排：
 * 乘跨卡先验（memory-feedback-prior.ts，只用注入之前别的卡的 refs）→ 去掉只靠相邻 feature 图命中的坑 → 低于最高分 RELATIVE_FLOOR 倍的不放 → 最多 4 条。
 * 排名事件只记了入选条目的路由；落选条目的图 / 文件命中按现在的台账重算（graphRoute / fileRoute），语义一路按「分数超过图 + 文件能解释的」推断。
 * 旧条目怎么用 = 注入之后本卡第一份含这些条目的 refs。只读：库以 readonly 打开，不写任何表。tests/memory-relevance-replay.test.ts。
 *
 * PM 在台账机上跑的一行命令见 docs/architecture/project-memory-relevance.md「Replay」。
 */
import { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import { feedbackPrior, marksByMemory, type RefsRow } from "./memory-feedback-prior.js";
import { cardPatterns, fileRoute, graphRoute, MEMORY_CAPS, memoryCandidates, rankOrder, RELATIVE_FLOOR, type MemoryRoute } from "./memory-retrieve.js";

const RRF_K = 60;
const ROUTES: MemoryRoute[] = ["graph", "file", "vector"];
/** 排名事件里这些落选理由的条目本来就有资格（只是被条数 / 坑位挤掉），新规则下重新竞争 */
const COMPETING = /^(超条数|让坑位)/;

interface Entry { id: string; score: number; routes: MemoryRoute[]; far: boolean }
type Use = "applied" | "irrelevant" | "wrong" | "unmarked";

interface ReplayCounts { orders: number; items: number; avgPerOrder: number; byKind: Record<string, number>; byRoute: Record<MemoryRoute, number> }
export interface ReplayResult {
  project: string;
  since: number;
  until: number;
  old: ReplayCounts;
  new: ReplayCounts;
  /** 旧选择里被标 applied 的条目，新选择里还在的比例（目标 ≥ 0.9）；没有 applied = null */
  appliedKept: { total: number; kept: number; rate: number | null };
  /** 旧选择里被标 irrelevant 的条目，新选择里拿掉的比例 */
  irrelevantRemoved: { total: number; removed: number; rate: number | null };
  /** 落选条目缺排名数据（排名事件丢了）的单，回放跳过 */
  skipped: number;
}

const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) as Record<string, unknown> : {}; } catch { return {}; } };

function counts(orders: readonly { ids: string[]; routes: Map<string, MemoryRoute[]> }[], kindOf: (id: string) => string): ReplayCounts {
  const byKind: Record<string, number> = {}, byRoute: Record<MemoryRoute, number> = { graph: 0, file: 0, vector: 0 };
  let items = 0;
  for (const o of orders) for (const id of o.ids) {
    items++;
    byKind[kindOf(id)] = (byKind[kindOf(id)] ?? 0) + 1;
    for (const r of o.routes.get(id) ?? []) byRoute[r]++;
  }
  return { orders: orders.length, items, avgPerOrder: orders.length ? Number((items / orders.length).toFixed(3)) : 0, byKind, byRoute };
}

const rate = (n: number, d: number): number | null => (d ? Number((n / d).toFixed(4)) : null);

/** 回放 [since, until) 内本项目的写单注入；库只读打开、用完关 */
export function replayRelevance(path: string, project: string, since: number, until: number): ReplayResult {
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA query_only = 1");
    const ev = (where: string, ...args: (string | number)[]) =>
      db.query(`SELECT seq, ts, target, data FROM events WHERE project = ? AND ${where} ORDER BY seq`).all(project, ...args) as { seq: number; ts: number; target: string; data: string | null }[];
    const injections = ev("kind = 'scheduler' AND json_extract(data, '$.op') = 'memory_retrieve' AND json_extract(data, '$.order') = 'write' AND ts >= ? AND ts < ?", since, until);
    const refs = ev("kind = 'memory' AND json_extract(data, '$.op') = 'refs'");
    const mems = db.query("SELECT id, kind, createdAt FROM memories WHERE project = ?").all(project) as { id: string; kind: string; createdAt: number }[];
    const kinds = new Map(mems.map((m) => [m.id, m.kind]));
    const created = new Map(mems.map((m) => [m.id, m.createdAt]));
    const kindOf = (id: string) => kinds.get(id) ?? "unknown";
    // 平局和生产 rankMemories 同序：新者优先，再按 id
    const order = (a: Entry, b: Entry) => rankOrder({ score: a.score, createdAt: created.get(a.id) ?? 0, id: a.id }, { score: b.score, createdAt: created.get(b.id) ?? 0, id: b.id });

    const oldOrders: { ids: string[]; routes: Map<string, MemoryRoute[]> }[] = [];
    const newOrders: typeof oldOrders = [];
    const appliedKept = { total: 0, kept: 0 }, irrelevantRemoved = { total: 0, removed: 0 };
    let skipped = 0;
    for (const inj of injections) {
      const d = parse(inj.data);
      const oldIds = Array.isArray(d.memoryIds) ? (d.memoryIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const rankRow = typeof d.rankingSeq === "number" ? db.query("SELECT data FROM events WHERE seq = ?").get(d.rankingSeq) as { data: string | null } | null : null;
      if (!rankRow) { skipped++; continue; }
      const rank = parse(rankRow.data);
      const items = (Array.isArray(rank.items) ? rank.items : []) as { id: string; score: number; routes?: MemoryRoute[]; why?: string }[];
      const dropped = (Array.isArray(rank.dropped) ? rank.dropped : []) as { id: string; score: number; reason?: string }[];

      // 落选条目的路由：按现在的台账重算图 / 文件，语义按分数推断
      const task = getTask(db, inj.target);
      const cands = task ? memoryCandidates(db, task) : [];
      const graph = task ? graphRoute(db, task, cands) : [];
      const file = task ? fileRoute(cands, cardPatterns(task), null) : [];
      const entries: Entry[] = items.map((it) => ({
        id: it.id, score: it.score, routes: (it.routes ?? []).filter((r) => ROUTES.includes(r)),
        far: kindOf(it.id) === "pitfall" && (it.routes ?? []).join() === "graph" && (it.why ?? "").includes("相邻 feature"),
      }));
      for (const x of dropped) {
        if (!COMPETING.test(x.reason ?? "") || entries.some((e) => e.id === x.id)) continue;
        const g = graph.findIndex((h) => h.id === x.id), f = file.findIndex((h) => h.id === x.id);
        const explained = (g >= 0 ? 1 / (RRF_K + g + 1) : 0) + (f >= 0 ? 1 / (RRF_K + f + 1) : 0);
        const routes: MemoryRoute[] = [...(g >= 0 ? ["graph" as const] : []), ...(f >= 0 ? ["file" as const] : []), ...(x.score > explained + 1e-6 ? ["vector" as const] : [])];
        entries.push({ id: x.id, score: x.score, routes, far: kindOf(x.id) === "pitfall" && routes.join() === "graph" && graph[g]?.hop === 3 });
      }

      // 新规则
      const marks = marksByMemory(refs.filter((r) => r.ts < inj.ts) as RefsRow[], inj.target);
      const rescored = entries.filter((e) => !e.far).map((e) => ({ ...e, score: e.score * feedbackPrior(marks.get(e.id) ?? [], inj.ts) }))
        .sort(order);
      const bar = (rescored[0]?.score ?? 0) * RELATIVE_FLOOR;
      const newIds = rescored.filter((e) => e.score >= bar).slice(0, MEMORY_CAPS.write.count).map((e) => e.id);
      const routes = new Map(entries.map((e) => [e.id, e.routes]));
      oldOrders.push({ ids: oldIds, routes });
      newOrders.push({ ids: newIds, routes });

      // 旧条目怎么用：注入之后本卡第一份含这些条目的 refs
      const label = refs.find((r) => r.target === inj.target && r.seq > inj.seq
        && ((parse(r.data).refs ?? []) as { id?: string }[]).some((x) => typeof x?.id === "string" && oldIds.includes(x.id)));
      const uses = new Map(((label ? parse(label.data).refs : []) as { id?: string; use?: Use }[]).map((x) => [x.id, x.use]));
      for (const id of oldIds) {
        if (uses.get(id) === "applied") { appliedKept.total++; if (newIds.includes(id)) appliedKept.kept++; }
        if (uses.get(id) === "irrelevant") { irrelevantRemoved.total++; if (!newIds.includes(id)) irrelevantRemoved.removed++; }
      }
    }
    return {
      project, since, until, old: counts(oldOrders, kindOf), new: counts(newOrders, kindOf),
      appliedKept: { ...appliedKept, rate: rate(appliedKept.kept, appliedKept.total) },
      irrelevantRemoved: { ...irrelevantRemoved, rate: rate(irrelevantRemoved.removed, irrelevantRemoved.total) },
      skipped,
    };
  } finally {
    db.close();
  }
}

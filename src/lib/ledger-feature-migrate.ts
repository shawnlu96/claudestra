import { migrateBackupPath } from "./shared-ledger-gate-backup.js";
import { requireLocalSharedLedgerPlanning } from "./shared-ledger-gate.js";
/**
 * 旧卡迁进 feature（T84 设计稿的 L3，docs/design/feature-dag.md）：按映射表建 feature、给卡挂 featureId、每个 feature 用 dag-init 建 v1。
 * 卡按此刻的 stage 分四类：已完成 / 已取消 / 待排只挂 featureId；进行中的卡连同它在同一 feature 里的已完成直接前驱进 v1，
 * 节点依赖只取 task_deps 的 blocks 边、两端都进图才连。阶段、依赖边、旧事件一律不改，写入全走 ledger-feature-write.ts。
 * 幂等靠现状判定：feature 已在就复用、已有版本就不再 dag-init、卡已挂同一个就跳过；卡挂着别的 feature = 冲突，整批不写。
 * planMigration 只读；applyMigration 先 VACUUM INTO 备份再在一个事务里重新规划并写入，任何一步失败整批回滚。
 */
import type { Database } from "bun:sqlite";
import { vacuumBackup } from "./ledger-backup.js";
import { getFeature } from "./ledger-feature.js";
import { assignFeature, createFeature, initDag } from "./ledger-feature-write.js";
import type { WriteCtx } from "./ledger-checks.js";
import { ledgerOrigin, storedOrigin } from "./ledger-origin.js";
import type { LedgerTask, Stage } from "./ledger-stages.js";
import { busyAsLedgerError, LedgerError, listDeps, listTasks } from "./ledger-store.js";

interface MigrateMapFeature {
  slug: string;
  title: string;
  words?: string;
  cards: string[];
}

export interface MigrateMap {
  project: string;
  features: MigrateMapFeature[];
  /** 明确不归任何 feature 的卡（featureId 留空，只在 dry-run 里列出来） */
  unassigned?: string[];
  /** 归类没把握的卡 → 一句说明；卡仍按 features 里的归属处理 */
  unsure?: Record<string, string>;
}

const BUCKETS = ["active", "pending", "done", "cancelled"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** 进行中 = 已开工还没做完；blocked 按进 blocked 前的阶段算（没记就当待排） */
const ACTIVE: readonly Stage[] = ["restate", "build", "review", "fix", "merge", "live"];

export function bucketOf(t: Pick<LedgerTask, "stage" | "stageBefore">): Bucket {
  const s = t.stage === "blocked" ? (t.stageBefore ?? "spec") : t.stage;
  if (s === "verified" || s === "done") return "done";
  if (s === "cancelled") return "cancelled";
  return ACTIVE.includes(s) ? "active" : "pending";
}

export interface CardRef {
  id: string;
  stage: Stage;
  title: string;
  pr: string | null;
  branch: string | null;
  /** 进 v1 的原因：自己在进行中，或是进行中节点的已完成前驱 */
  node: "active" | "predecessor" | null;
}

interface DroppedEdge {
  from: string;
  to: string;
  why: string;
}

export interface FeaturePlan {
  slug: string;
  /** 全 id；dry-run 时库里还没有本机前缀则是 `<前缀>-slug` */
  id: string;
  title: string;
  words: string;
  exists: boolean;
  /** 库里这个 feature 已有的版本号（0 = 还没建 DAG） */
  version: number;
  cards: Record<Bucket, CardRef[]>;
  /** 要建的 v1 节点；null = 不建（原因在 dagNote） */
  nodes: { taskId: string; deps: string[] }[] | null;
  dagNote: string;
  /** 要新挂 featureId 的卡（含进 v1 的） */
  toAssign: string[];
}

export interface MigrationPlan {
  project: string;
  origin: string | null;
  features: FeaturePlan[];
  /** 库里有、映射表没归到任何 feature 的卡（含 map.unassigned 与映射表里压根没出现的） */
  unassigned: CardRef[];
  unsure: { id: string; feature: string | null; note: string }[];
  /** 映射表里写了、库里没有的卡 */
  missing: string[];
  droppedEdges: DroppedEdge[];
  /** 会让整批拒绝的冲突：卡已挂别的 feature、标题被别的 feature 占了 */
  conflicts: string[];
  writes: { features: number; versions: number; cards: number };
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** 映射表的结构校验：slug / 标题唯一，同一张卡不许出现在两处（两个 feature，或 feature 与 unassigned） */
export function parseMap(raw: unknown): MigrateMap {
  const bad = (msg: string): never => {
    throw new LedgerError("invalid", `映射表不对：${msg}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("要是 JSON 对象 {project, features, unassigned?, unsure?}");
  const m = raw as Record<string, unknown>;
  if (typeof m.project !== "string" || !m.project) bad("缺 project");
  if (!Array.isArray(m.features) || m.features.length === 0) bad("features 要是非空数组");
  const strs = (v: unknown, what: string): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x) ? (v as string[]) : bad(`${what}要是任务 id 的字符串数组`);
  const owner = new Map<string, string>();
  const claim = (id: string, where: string) => {
    const prev = owner.get(id);
    if (prev) throw new LedgerError("conflict", `任务 ${id} 同时归在 ${prev} 和 ${where}：一张卡只能进一个 feature`, { task: id });
    owner.set(id, where);
  };
  const slugs = new Set<string>();
  const titles = new Set<string>();
  const features = (m.features as unknown[]).map((x, i): MigrateMapFeature => {
    const f = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    if (typeof f.slug !== "string" || !SLUG.test(f.slug)) bad(`第 ${i + 1} 个 feature 的 slug 只能是字母数字开头、≤40 位`);
    if (typeof f.title !== "string" || !f.title.trim()) bad(`feature ${String(f.slug)} 缺 title`);
    if (f.words !== undefined && typeof f.words !== "string") bad(`feature ${String(f.slug)} 的 words 要是字符串`);
    const slug = f.slug as string;
    const title = (f.title as string).trim();
    if (slugs.has(slug)) bad(`slug ${slug} 重复`);
    if (titles.has(title)) bad(`标题「${title}」重复`);
    slugs.add(slug);
    titles.add(title);
    const cards = strs(f.cards ?? [], `feature ${slug} 的 cards `);
    for (const c of cards) claim(c, `feature ${slug}`);
    return { slug, title, ...(f.words ? { words: f.words as string } : {}), cards };
  });
  const unassigned = strs(m.unassigned ?? [], "unassigned ");
  for (const c of unassigned) claim(c, "unassigned");
  const unsure = m.unsure ?? {};
  if (typeof unsure !== "object" || Array.isArray(unsure) || !Object.values(unsure).every((v) => typeof v === "string")) bad("unsure 要是 {任务 id: 说明}");
  return { project: m.project as string, features, unassigned, unsure: unsure as Record<string, string> };
}

const ref = (t: LedgerTask, node: CardRef["node"] = null): CardRef => ({ id: t.id, stage: t.stage, title: t.title, pr: t.pr, branch: t.branch, node });

/** v1 节点：进行中的卡 + 它们在同一 feature 里的已完成直接前驱；只连两端都进图的 blocks 边，其余与进行中卡相连的边记进 dropped */
function dagNodes(fp: FeaturePlan, blocks: { from: string; to: string }[], dropped: DroppedEdge[]): void {
  const mine = new Map(BUCKETS.flatMap((b) => fp.cards[b].map((c) => [c.id, b] as const)));
  const active = new Set(fp.cards.active.map((c) => c.id));
  const preds = new Set<string>();
  for (const e of blocks) {
    if (!active.has(e.to) && !active.has(e.from)) continue;
    const other = active.has(e.to) ? e.from : e.to;
    if (active.has(other)) continue;
    const b = mine.get(other);
    if (active.has(e.to) && b === "done") {
      preds.add(other);
      continue;
    }
    const why = !b ? `${other} 不在这个 feature` : b === "done" ? `${other} 是已完成的后继（只补前驱）` : b === "pending" ? `${other} 待排，不进图` : `${other} 已取消`;
    dropped.push({ ...e, why });
  }
  for (const c of fp.cards.done) if (preds.has(c.id)) c.node = "predecessor";
  const inGraph = new Set([...active, ...preds]);
  if (fp.version > 0) {
    fp.dagNote = `已有 v${fp.version}，不再建初版；新进行中的卡只挂 featureId，进图走 dag-rewrite`;
    return;
  }
  if (!active.size) {
    fp.dagNote = "没有进行中的卡，不建 DAG";
    return;
  }
  const order = [...fp.cards.active, ...fp.cards.done.filter((c) => preds.has(c.id))].map((c) => c.id);
  fp.nodes = order.map((id) => ({ taskId: id, deps: blocks.filter((e) => e.to === id && inGraph.has(e.from)).map((e) => e.from) }));
  fp.dagNote = `v1：${active.size} 个进行中${preds.size ? ` + ${preds.size} 个已完成前驱` : ""}`;
}

/** 只读规划：不写库（dry-run 与正式迁移共用；正式迁移在写事务里重算一遍，防规划后库被改） */
export function planMigration(db: Database, map: MigrateMap, origin: string | null = storedOrigin(db)): MigrationPlan {
  const all = listTasks(db, map.project);
  const tasks = new Map(all.map((t) => [t.id, t]));
  const blocks = listDeps(db, map.project).filter((d) => d.kind === "blocks").map((d) => ({ from: d.from, to: d.to }));
  const claimed = new Set<string>();
  const missing: string[] = [];
  const conflicts: string[] = [];
  const dropped: DroppedEdge[] = [];
  const features = map.features.map((f): FeaturePlan => {
    const id = `${origin ?? "<前缀>"}-${f.slug}`;
    const cur = origin ? getFeature(db, id) : null;
    const clash = db.prepare("SELECT id FROM features WHERE project = ? AND title = ? AND id <> ?").get(map.project, f.title, id) as { id: string } | null;
    if (clash) conflicts.push(`feature「${f.title}」的标题已被 ${clash.id} 占用`);
    if (cur && cur.project !== map.project) conflicts.push(`feature ${id} 在项目 ${cur.project}，映射表是 ${map.project}`);
    const fp: FeaturePlan = {
      slug: f.slug, id, title: f.title, words: f.words ?? "", exists: !!cur, version: cur?.currentVersion ?? 0,
      cards: { active: [], pending: [], done: [], cancelled: [] }, nodes: null, dagNote: "", toAssign: [],
    };
    for (const cid of f.cards) {
      const t = tasks.get(cid);
      if (!t) {
        missing.push(cid);
        continue;
      }
      claimed.add(cid);
      const b = bucketOf(t);
      fp.cards[b].push(ref(t, b === "active" ? "active" : null));
      if (t.featureId && t.featureId !== id) conflicts.push(`任务 ${cid} 已属于 feature ${t.featureId}，映射表要归到 ${id}`);
      else if (t.featureId !== id) fp.toAssign.push(cid);
    }
    dagNodes(fp, blocks, dropped);
    return fp;
  });
  for (const cid of map.unassigned ?? []) if (!tasks.has(cid)) missing.push(cid);
  const featureOf = new Map(map.features.flatMap((f) => f.cards.map((c) => [c, f.slug] as const)));
  return {
    project: map.project, origin, features,
    unassigned: all.filter((t) => !claimed.has(t.id)).map((t) => ref(t)),
    unsure: Object.entries(map.unsure ?? {}).map(([id, note]) => ({ id, feature: featureOf.get(id) ?? null, note })),
    missing, conflicts,
    // 跨 feature 的边两头各看到一次，只留第一条
    droppedEdges: dropped.filter((e, i) => dropped.findIndex((x) => x.from === e.from && x.to === e.to) === i),
    writes: {
      features: features.filter((f) => !f.exists).length,
      versions: features.filter((f) => f.nodes).length,
      cards: features.reduce((n, f) => n + f.toAssign.length, 0),
    },
  };
}

const planHasWrites = (p: MigrationPlan): boolean => p.writes.features + p.writes.versions + p.writes.cards > 0;

/**
 * 正式迁移前的备份文件：库文件旁 backups/，时间到毫秒 + 映射表摘要 + 随机段，每次有写入的尝试都是新的一份。
 * 不复用同名旧备份：失败留下的备份之后库可能又被改过，拿它回滚会丢掉那些改动（tests/ledger-feature-l3.test.ts「同一时刻重试」）。
 */
export interface ApplyResult {
  plan: MigrationPlan;
  backup: string | null;
  created: string[];
  versions: string[];
  assigned: number;
}

/**
 * 正式迁移：先备份（内存库、备份失败都不迁移），再在一个 IMMEDIATE 事务里重新规划、有冲突就拒、然后逐个 feature 写入。
 * 没有要写的东西时不备份、不写库，直接返回（重跑幂等）。写事件的 ctx 不带 dedupKey：同一个 key 给多次写入会互相当成重放。
 */
export function applyMigration(db: Database, ctx: WriteCtx, map: MigrateMap): ApplyResult {
  // 前缀还没落库时，第一次取会写 ledger_instance：放到备份之后、事务里；库里有 feature 就一定已有前缀，这里先按已存的规划
  const first = planMigration(db, map, storedOrigin(db));
  if (first.conflicts.length) throw new LedgerError("conflict", `有冲突，整批不写：${first.conflicts.join("；")}`, { conflicts: first.conflicts });
  if (!planHasWrites(first)) return { plan: first, backup: null, created: [], versions: [], assigned: 0 };
  const path = db.filename;
  if (!path || path === ":memory:") throw new LedgerError("invalid", "内存库没法先备份，不迁移");
  const now = ctx.now ?? Date.now();
  const backup = vacuumBackup(db, migrateBackupPath(path, map, now), "feature 迁移前备份失败", "未迁移，库保持原样", false);
  const w: WriteCtx = { actor: ctx.actor, now };
  return busyAsLedgerError("迁移", () => db.transaction((): ApplyResult => {
    const ro = ledgerOrigin(db);
    if (!ro) throw new LedgerError("invalid", "取不到本机前缀（状态目录的 instance-id 读写失败），不迁移");
    const plan = planMigration(db, map, ro);
    if (plan.conflicts.length) throw new LedgerError("conflict", `有冲突，整批不写：${plan.conflicts.join("；")}`, { conflicts: plan.conflicts });
    for (const f of plan.features) requireLocalSharedLedgerPlanning(f.id);
    const out: ApplyResult = { plan, backup, created: [], versions: [], assigned: 0 };
    for (const f of plan.features) {
      if (!f.exists) {
        createFeature(db, w, { project: plan.project, slug: f.slug, title: f.title, ownerWords: f.words });
        out.created.push(f.id);
      }
      if (f.nodes) {
        const rev = (getFeature(db, f.id) as { rev: number }).rev;
        initDag(db, w, { id: f.id, rev, nodes: f.nodes, reasonText: "L3 旧卡迁移：进行中的卡 + 已完成前驱" });
        out.versions.push(f.id);
      }
      const inDag = new Set(f.nodes?.map((n) => n.taskId) ?? []);
      const rest = f.toAssign.filter((id) => !inDag.has(id));
      if (rest.length) assignFeature(db, w, { id: f.id, taskIds: rest });
      out.assigned += f.toAssign.length;
    }
    return out;
  }).immediate());
}

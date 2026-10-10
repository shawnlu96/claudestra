import { scanSpecHead } from "./spec-lint-head.js";
import { activeProjectPm } from "./pm-role.js";
import { switchOff } from "./shared-ledger-gate-switch.js";
export { switchOff } from "./shared-ledger-gate-switch.js";
import { sharedLedgerPlanningReason } from "./shared-ledger-gate.js";
/**
 * 自动开卡（i28-A1）的门：判定都是纯函数或只读台账。调度服务选候选、台账 claim 事务里重核、feature-show 列「卡在哪道门」用的是同一份，
 * 三处口径分不了叉。规格卡的文件门（落盘静置、卡首的开关行与模板行）只在调度侧看，claim 事务只重核台账里的门。
 * 设计见 docs/architecture/scheduler-autostart.md；tests/scheduler-autostart-gates.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { InventoryQuota } from "./ai-quota.js";
import { featureLanes, type Lanes } from "./dag-tools-lanes.js";
import { claimDedup, openClaims } from "./ledger-autostart-grant.js";
import { effectiveNodes, getDagVersion, getFeature, getPendingProposal, projectNodes, type Feature, type NodeView } from "./ledger-feature.js";
import { cardNames } from "./ledger-card-names.js";
export { cardNames } from "./ledger-card-names.js";
import { getEventByDedup, getMeta } from "./ledger-store.js";
import { FLOW_TEMPLATES, templateFor } from "./scheduler-template.js";
import { autostartCapacity, type SlotPool } from "./scheduler-slot-hold-autostart.js";
import { noCloneReason, privateObserveNote, privatePoolMode, privateStart, repoOfGlobs } from "./card-repo.js";

export type AutostartTemplate = "code" | "ui" | "security";
/** 从基础版往上探到 templateFor 第一次给 null：scheduler-template.ts 加了新版（如 N4 的 ui / security v3），自动开卡不用改就用上最高版 */
function latestVersion(t: AutostartTemplate): number {
  let v = FLOW_TEMPLATES[t].version;
  while (templateFor(t, v + 1)) v++;
  return v;
}
/** 各模板现有的最高版本；写死数字会在模板加版后让自动开的卡停在旧版 */
export const TEMPLATE_VERSION: Record<AutostartTemplate, number> = { code: latestVersion("code"), ui: latestVersion("ui"), security: latestVersion("security") };
/** 规格卡最后修改满这么久才算定稿：防止读到写了一半的稿子 */
export const SPEC_SETTLE_MS = 60_000;
const DEFAULT_WEEKLY_LINE = 70;

interface SwitchOff { reason: string; by: string; at: number }
export interface AutostartSwitch {
  off?: SwitchOff;
  /** pm：这个 feature 的 PM（autostart-set --pm），自动开卡建卡与缺规格提醒发给它 */
  features?: Record<string, SwitchOff & { off: boolean; pm?: string }>;
  weeklyLinePct?: number;
  /** 缺规格提醒（scheduler-spec-wait.ts）：缺省 observe = 只记台账不发 */
  specWait?: "on" | "observe" | "off";
  /** 合并待 PM 处置提醒（scheduler-merge-pm-tick.ts）：独立开关，缺省 observe */
  mergePmWait?: "on" | "observe" | "off";
  /** manual 卡审查已回待 PM 处置提醒（scheduler-review-pm-tick.ts）：独立开关，缺省 observe */
  reviewPmWait?: "on" | "observe" | "off";
}

/** 台账 meta 的项目级 key `autostart`；没有 = 全开、额度线 70 */
export function readSwitch(db: Database, project: string): AutostartSwitch {
  const row = db.query("SELECT value FROM meta WHERE project = ? AND key = 'autostart'").get(project) as { value: string } | null;
  if (!row) return {};
  const v = JSON.parse(row.value) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AutostartSwitch) : {};
}

export const weeklyLine = (sw: AutostartSwitch): number => sw.weeklyLinePct ?? DEFAULT_WEEKLY_LINE;

export type TemplateDecl = { ok: true; template: AutostartTemplate; version: number } | { ok: false; error: string };
/** ownerVisual: the card changes the overall look (palette, theme tokens, redesign), so the owner sees its screenshots, not PM */
export interface SpecHead { off: boolean; template: TemplateDecl; ownerVisual: boolean }

const OFF_LINE = /^自动开卡\s*[:：]\s*关\s*$/;
const OWNER_VISUAL_LINE = /^owner\s*看截图\s*[:：]\s*是\s*$/i;

/** 卡首 = 标题（第一个 `# ` 行）之后、第一个 `## ` 之前；没有标题行就从第一行算 */
export function parseSpecHead(text: string): SpecHead {
  const { head, decls } = scanSpecHead(text);
  const off = head.some((l) => OFF_LINE.test(l));
  const ownerVisual = head.some((l) => OWNER_VISUAL_LINE.test(l));
  if (decls.length > 1) return { off, ownerVisual, template: { ok: false, error: `卡首写了 ${decls.length} 行模板声明，只能有一行` } };
  if (!decls.length) return { off, ownerVisual, template: { ok: true, template: "code", version: TEMPLATE_VERSION.code } };
  const v = decls[0].toLowerCase();
  if (!Object.hasOwn(TEMPLATE_VERSION, v)) return { off, ownerVisual, template: { ok: false, error: `模板「${decls[0]}」不认识（只认 code / ui / security）` } };
  return { off, ownerVisual, template: { ok: true, template: v as AutostartTemplate, version: TEMPLATE_VERSION[v as AutostartTemplate] } };
}

export const templateLabel = (t: TemplateDecl): string => (t.ok ? t.template : "invalid");

/** 武装键：规格卡内容 + 节点文件范围 + 模板。同一 arm 只开一次、失败不重试；PM 改了其中任一样才重新武装 */
export function armOf(specText: string, fileGlobs: readonly string[], template: string): string {
  return createHash("sha256").update(JSON.stringify([specText, [...fileGlobs], template])).digest("hex").slice(0, 16);
}

export interface SpecFile { mtimeMs: number; text: string }

/** 文件门：规格卡在、静置满 60 秒、卡首没写「自动开卡：关」。返回卡不住时的卡首 */
export function specGate(spec: SpecFile | null, now: number): { why: string } | { head: SpecHead } {
  if (!spec) return { why: "规格卡还没放到正式路径" };
  if (now - spec.mtimeMs < SPEC_SETTLE_MS) return { why: "规格卡刚改过，静置满 60 秒再开" };
  const head = parseSpecHead(spec.text);
  return head.off ? { why: "规格卡卡首写了「自动开卡：关」" } : { head };
}

/** Claude 周窗口（weekly / weekly_scoped）里已用到线的那一个；读不到、用量未知为 null（不拦，下游撞额度另有报警） */
export function quotaOver(q: InventoryQuota, line: number): InventoryQuota["windows"][number] | null {
  if (q.status !== "known") return null;
  return q.windows.find((w) => (w.kind === "weekly" || w.kind === "weekly_scoped") && w.usedPct !== null && w.usedPct >= line) ?? null;
}

/** 指针优先；未设时取第一个非调度助理的 PM，没有 = 不开。 */
export function projectPm(db: Database, project: string): string | null {
  return activeProjectPm(db, project);
}

/** feature 记了 PM 且仍在项目 PM 名单里（不是调度助理）就用它，否则项目 PM */
export function featurePm(db: Database, featureId: string): string | null {
  const f = getFeature(db, featureId), meta = f && getMeta(db, f.project), pm = f && readSwitch(db, f.project).features?.[featureId]?.pm;
  return f && meta && pm && meta.pms.includes(pm) && pm !== meta.team?.dispatcher ? pm : f && projectPm(db, f.project);
}

/** 调度服务那边的事实：scheduler.json 有没有列这个项目、autoDispatch、这个项目的 maxActiveWorkers */
export interface ServiceFacts {
  autoDispatch: boolean;
  /** enabled 时 scheduler.json 列出的项目 */
  projects: readonly string[];
  maxWorkers(project: string): number;
  /** Omitted in production: the gate re-reads current scheduler/lend policy and the ledger's latest hello. */
  pool?(project: string): SlotPool;
  now?(): number;
}

type GateCode =
  | "service" | "switch" | "feature" | "proposal" | "frozen" | "node" | "lanes" | "claim" | "capacity" | "no_pm" | "spec" | "armed" | "quota" | "private";

export interface GateStop { gate: GateCode; why: string }

const stop = (gate: GateCode, why: string): GateStop => ({ gate, why });

/** feature 级的门（对它的所有节点一样）：服务、开关、状态、提案、冻结、PM、容量 */
export function featureGate(db: Database, f: Feature, svc: ServiceFacts): GateStop | null {
  const shared = sharedLedgerPlanningReason(f.id); if (shared) return stop("feature", shared);
  if (!svc.autoDispatch || !svc.projects.includes(f.project)) return stop("service", `调度服务没对项目 ${f.project} 开自动派单（scheduler.json enabled + autoDispatch + 列出项目）`);
  const off = switchOff(readSwitch(db, f.project), f.id);
  if (off) return stop("switch", off);
  if (f.status !== "active") return stop("feature", `feature 是 ${f.status}，不是 active`);
  if (!f.currentVersion) return stop("feature", "feature 还没建 DAG");
  if (getPendingProposal(db, f.id)) return stop("proposal", "有等 owner 批的重写提案");
  if (getMeta(db, f.project).queueFrozen.frozen) return stop("frozen", "项目合并队列冻结着");
  if (!projectPm(db, f.project)) return stop("no_pm", "项目没有 PM（PM 名单里除调度助理外没人）");
  return featureCapacity(db, f, svc);
}

/**
 * 容量门按仓库估（审查 private-capacity）：peer 授权按仓库给，只授权了私仓的 peer 有空位时，公共仓「没空位」不能否决私仓节点。
 * 公共仓（键 null）照旧估；private-pool 为 on 时再按本 feature 待开私仓节点的每个仓库各估一次（键 = 小写 owner/name）。
 * 任一仓库有空位就过 feature 门，结果按 feature 对象记下，nodeCandidate / ledgerGate 再按节点自己的仓库核（nodeCapacity）。
 * 开关 off / observe 只有公共仓一项：和改动前逐字一样。
 */
const roomByFeature = new WeakMap<Feature, Map<string | null, string | null>>();

/** 节点仓库：无前缀 = null（公共仓）；私仓且开关 on = 小写 owner/name；私仓但开关不是 on 或前缀写坏 = undefined（privateGate 管） */
function nodeRepoKey(project: string, globs: readonly string[]): string | null | undefined {
  if (!globs.some((g) => g.startsWith("repo:"))) return null;
  if (privatePoolMode(project) !== "on") return undefined;
  try { return repoOfGlobs(globs)?.toLowerCase(); } catch { return undefined; }
}

function featureCapacity(db: Database, f: Feature, svc: ServiceFacts): GateStop | null {
  const max = svc.maxWorkers(f.project), pool = svc.pool?.(f.project), now = svc.now?.();
  const room = new Map<string | null, string | null>([[null, autostartCapacity(db, f.project, max, pool, now)]]);
  if (privatePoolMode(f.project) === "on") {
    for (const n of currentViews(db, f)) {
      if (n.taskId || n.status !== "planned") continue;
      const repo = nodeRepoKey(f.project, n.fileGlobs ?? []);
      if (repo && !room.has(repo)) room.set(repo, autostartCapacity(db, f.project, max, pool, now, repo));
    }
  }
  roomByFeature.set(f, room);
  const publicWhy = room.get(null) as string | null;
  return publicWhy && [...room.values()].every((w) => w) ? stop("capacity", publicWhy) : null;
}

/** 节点自己仓库的容量（feature 门记下的那份）；没跑过 feature 门、或节点仓库不在估算里 = 不拦（原行为） */
function nodeCapacity(f: Feature, globs: readonly string[]): GateStop | null {
  const room = roomByFeature.get(f), repo = nodeRepoKey(f.project, globs);
  const why = room && repo !== undefined ? room.get(repo) : null;
  return why ? stop("capacity", why) : null;
}

export function currentViews(db: Database, f: Feature): NodeView[] {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  return v ? projectNodes(db, effectiveNodes(db, v)) : [];
}

/** 节点级的门：当前版本里 planned、没绑卡、在 startNow 里、没有未结的 claim */
export function nodeGate(db: Database, f: Feature, key: string, lanes: Lanes | null, views = currentViews(db, f)): GateStop | null {
  const node = views.find((n) => n.key === key);
  if (!node) return stop("node", `当前版本里没有节点 ${key}`);
  if (node.taskId || node.status !== "planned") return stop("node", `节点已绑 ${node.taskId ?? "卡"}`);
  if (!lanes?.startNow.includes(key)) {
    const w = lanes?.waiting.find((x) => x.key === key);
    return stop("lanes", w ? `${w.why === "deps" ? "依赖没满足" : w.why === "files" ? "文件和在做的卡重叠" : "没有文件范围"}：${w.on.join(", ")}` : "不在可开工车道里");
  }
  if (openClaims(db, f.id).some((c) => c.key === key)) return stop("claim", "这个节点有开卡中的 claim 没结");
  return null;
}

/** 台账里的全部门（claim 事务重核用的就是这一个）；null = 能开 */
export function ledgerGate(db: Database, f: Feature, key: string, svc: ServiceFacts): GateStop | null {
  return featureGate(db, f, svc) ?? nodeGate(db, f, key, featureLanes(db, f))
    ?? nodeCapacity(f, currentViews(db, f).find((n) => n.key === key)?.fileGlobs ?? []);
}

/** 本项目 active、已建 DAG 的 feature（按 id） */
export function activeFeatures(db: Database, project: string): Feature[] {
  return (db.query("SELECT id FROM features WHERE project = ? AND status = 'active' AND currentVersion > 0 ORDER BY id").all(project) as { id: string }[])
    .map(({ id }) => getFeature(db, id) as Feature);
}

export interface Candidate { f: Feature; key: string; taskId: string; head: SpecHead; arm: string; fileGlobs: string[] }

/**
 * 一个节点能不能开（台账门之外再加文件门与 arm）：调度服务选候选和 feature-show 都用它。read 按卡号读正式路径下的规格卡（读不到为 null）。
 * 同一份规格 + 文件范围 + 模板已经 claim 过（不论结果）就不再选：失败不重试，改了才重新武装。
 */
export function nodeCandidate(db: Database, f: Feature, key: string, lanes: Lanes | null, views: NodeView[], read: (taskId: string) => SpecFile | null,
  now: number): Candidate | GateStop {
  const n = nodeGate(db, f, key, lanes, views);
  if (n) return n;
  const node = views.find((v) => v.key === key) as NodeView;
  const { taskId } = cardNames(db, f, key, node);
  const spec = read(taskId);
  const g = specGate(spec, now);
  if ("why" in g) return stop("spec", g.why);
  const fileGlobs = node.fileGlobs ?? [];
  const priv = privateGate(f.project, fileGlobs);
  if (priv) return priv;
  const room = nodeCapacity(f, fileGlobs);
  if (room) return room;
  const arm = armOf((spec as SpecFile).text, fileGlobs, templateLabel(g.head.template));
  const prior = getEventByDedup(db, claimDedup(f.id, key, arm));
  if (prior) return stop("armed", `这份规格已经自动开过一次（claim ${prior.seq}）：同一份不重试，改了规格卡或节点范围才重新武装`);
  return { f, key, taskId, head: g.head, arm, fileGlobs };
}

const PRIVATE_MANUAL = "私仓节点由 PM 用私仓开卡流程手动开";

/**
 * 私仓节点（fileGlobs 带 repo:）的门（i28-SECPOOL2，card-repo.ts）：开关 off（缺省）照旧 stop、文案不变；observe 同 off，原因后面多一句
 * 「按私仓进池会用 <仓库>（<目录>）开卡」；on 解析仓库并找到项目 dirs 里它的 clone 才放行，混了仓库 / 找不到 clone 都 stop。
 */
function privateGate(project: string, fileGlobs: readonly string[]): GateStop | null {
  if (!fileGlobs.some((g) => g.startsWith("repo:"))) return null;
  const mode = privatePoolMode(project);
  if (mode === "off") return stop("private", PRIVATE_MANUAL);
  if (mode === "observe") return stop("private", `${PRIVATE_MANUAL}${privateObserveNote(project, fileGlobs)}`);
  const r = privateStart(project, fileGlobs, mode);
  if (r && "error" in r) return stop("private", r.error);
  return r && !r.dir ? stop("private", noCloneReason(r.repo)) : null;
}

export const isStop = (x: Candidate | GateStop): x is GateStop => "gate" in x;

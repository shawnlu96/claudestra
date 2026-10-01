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
import { storedOrigin } from "./ledger-origin.js";
import { getEventByDedup, getMeta } from "./ledger-store.js";

export type AutostartTemplate = "code" | "ui" | "security";
/** 各模板现有的最高版本（scheduler-template.ts）；ui / security 的 v3 由 N4 另加 */
export const TEMPLATE_VERSION: Record<AutostartTemplate, number> = { code: 3, ui: 2, security: 2 };
/** 规格卡最后修改满这么久才算定稿：防止读到写了一半的稿子 */
export const SPEC_SETTLE_MS = 60_000;
const DEFAULT_WEEKLY_LINE = 70;

interface SwitchOff { reason: string; by: string; at: number }
export interface AutostartSwitch {
  off?: SwitchOff;
  features?: Record<string, SwitchOff & { off: boolean }>;
  weeklyLinePct?: number;
}

/** 台账 meta 的项目级 key `autostart`；没有 = 全开、额度线 70 */
export function readSwitch(db: Database, project: string): AutostartSwitch {
  const row = db.query("SELECT value FROM meta WHERE project = ? AND key = 'autostart'").get(project) as { value: string } | null;
  if (!row) return {};
  const v = JSON.parse(row.value) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AutostartSwitch) : {};
}

/** 项目关了，或这个 feature 关了；featureId 为 null 的卡（不在任何 feature 下）只看项目 */
export function switchOff(sw: AutostartSwitch, featureId: string | null): string | null {
  if (sw.off) return `项目的自动开卡关着：${sw.off.reason}`;
  const f = featureId ? sw.features?.[featureId] : undefined;
  return f?.off ? `feature ${featureId} 的自动开卡关着：${f.reason}` : null;
}

export const weeklyLine = (sw: AutostartSwitch): number => sw.weeklyLinePct ?? DEFAULT_WEEKLY_LINE;

export type TemplateDecl = { ok: true; template: AutostartTemplate; version: number } | { ok: false; error: string };
export interface SpecHead { off: boolean; template: TemplateDecl }

const TEMPLATE_LINE = /^模板\s*[:：]\s*(.*)$/;
const OFF_LINE = /^自动开卡\s*[:：]\s*关\s*$/;

/** 卡首 = 标题（第一个 `# ` 行）之后、第一个 `## ` 之前；没有标题行就从第一行算 */
export function parseSpecHead(text: string): SpecHead {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const title = lines.findIndex((l) => /^#\s/.test(l));
  const head: string[] = [];
  for (const l of lines.slice(title + 1)) {
    if (/^##\s/.test(l)) break;
    head.push(l);
  }
  const decls = head.map((l) => l.match(TEMPLATE_LINE)?.[1]?.trim()).filter((v): v is string => v !== undefined);
  const off = head.some((l) => OFF_LINE.test(l));
  if (decls.length > 1) return { off, template: { ok: false, error: `卡首写了 ${decls.length} 行模板声明，只能有一行` } };
  if (!decls.length) return { off, template: { ok: true, template: "code", version: TEMPLATE_VERSION.code } };
  const v = decls[0].toLowerCase();
  if (!Object.hasOwn(TEMPLATE_VERSION, v)) return { off, template: { ok: false, error: `模板「${decls[0]}」不认识（只认 code / ui / security）` } };
  return { off, template: { ok: true, template: v as AutostartTemplate, version: TEMPLATE_VERSION[v as AutostartTemplate] } };
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

/** 卡号 / agent / 分支的派生规则与 start_node 的缺省一致（dag-tools-start.ts）：两边开同一个节点会撞同一个卡号，由台账的唯一性裁决 */
export function cardNames(db: Database, f: Feature, key: string): { slug: string; taskId: string; agent: string; branch: string } {
  const origin = storedOrigin(db);
  const slug = origin && f.id.startsWith(`${origin}-`) ? f.id.slice(origin.length + 1) : f.id;
  const taskId = `${slug}-${key}`;
  const agent = `agent-${`task-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48)}`;
  return { slug, taskId, agent, branch: `feat/${taskId.toLowerCase()}` };
}

/** Claude 周窗口（weekly / weekly_scoped）里已用到线的那一个；读不到、用量未知为 null（不拦，下游撞额度另有报警） */
export function quotaOver(q: InventoryQuota, line: number): InventoryQuota["windows"][number] | null {
  if (q.status !== "known") return null;
  return q.windows.find((w) => (w.kind === "weekly" || w.kind === "weekly_scoped") && w.usedPct !== null && w.usedPct >= line) ?? null;
}

/** 项目的 PM：PM 名单里第一个不是调度助理的（同 pm-notify.ts）；没有 = 不开 */
export function projectPm(db: Database, project: string): string | null {
  const meta = getMeta(db, project);
  return meta.pms.find((p) => p !== meta.team?.dispatcher) ?? null;
}

/** 容量：持有本项目 worker 槽的卡，加上 auto、还没到 live 及以后、也还没拿到槽的卡 */
function activeCards(db: Database, project: string): number {
  const prefix = `slot:${project}:`;
  const rows = db.query(`SELECT taskId FROM scheduler_resources WHERE project = ? AND substr(resource, 1, ?) = ?
    UNION SELECT w.taskId FROM task_workflows AS w JOIN tasks AS t ON t.id = w.taskId
    WHERE w.project = ? AND w.mode = 'auto' AND t.stage NOT IN ('live','verified','done','cancelled')`).all(project, prefix.length, prefix, project);
  return rows.length;
}

/** 调度服务那边的事实：scheduler.json 有没有列这个项目、autoDispatch、这个项目的 maxActiveWorkers */
export interface ServiceFacts {
  autoDispatch: boolean;
  /** enabled 时 scheduler.json 列出的项目 */
  projects: readonly string[];
  maxWorkers(project: string): number;
}

type GateCode =
  | "service" | "switch" | "feature" | "proposal" | "frozen" | "node" | "lanes" | "claim" | "capacity" | "no_pm" | "spec" | "armed" | "quota";

export interface GateStop { gate: GateCode; why: string }

const stop = (gate: GateCode, why: string): GateStop => ({ gate, why });

/** feature 级的门（对它的所有节点一样）：服务、开关、状态、提案、冻结、PM、容量 */
export function featureGate(db: Database, f: Feature, svc: ServiceFacts): GateStop | null {
  if (!svc.autoDispatch || !svc.projects.includes(f.project)) return stop("service", `调度服务没对项目 ${f.project} 开自动派单（scheduler.json enabled + autoDispatch + 列出项目）`);
  const off = switchOff(readSwitch(db, f.project), f.id);
  if (off) return stop("switch", off);
  if (f.status !== "active") return stop("feature", `feature 是 ${f.status}，不是 active`);
  if (!f.currentVersion) return stop("feature", "feature 还没建 DAG");
  if (getPendingProposal(db, f.id)) return stop("proposal", "有等 owner 批的重写提案");
  if (getMeta(db, f.project).queueFrozen.frozen) return stop("frozen", "项目合并队列冻结着");
  if (!projectPm(db, f.project)) return stop("no_pm", "项目没有 PM（PM 名单里除调度助理外没人）");
  const max = svc.maxWorkers(f.project);
  if (activeCards(db, f.project) >= max) return stop("capacity", `项目在跑的卡已到 maxActiveWorkers（${max}）`);
  return null;
}

export function currentViews(db: Database, f: Feature): NodeView[] {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  return v ? projectNodes(db, effectiveNodes(db, v)) : [];
}

/** 节点级的门：当前版本里 planned、没绑卡、在 startNow 里、没有未结的 claim */
function nodeGate(db: Database, f: Feature, key: string, lanes: Lanes | null, views = currentViews(db, f)): GateStop | null {
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
  return featureGate(db, f, svc) ?? nodeGate(db, f, key, featureLanes(db, f));
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
  const { taskId } = cardNames(db, f, key);
  const spec = read(taskId);
  const g = specGate(spec, now);
  if ("why" in g) return stop("spec", g.why);
  const fileGlobs = node.fileGlobs ?? [];
  const arm = armOf((spec as SpecFile).text, fileGlobs, templateLabel(g.head.template));
  const prior = getEventByDedup(db, claimDedup(f.id, key, arm));
  if (prior) return stop("armed", `这份规格已经自动开过一次（claim ${prior.seq}）：同一份不重试，改了规格卡或节点范围才重新武装`);
  return { f, key, taskId, head: g.head, arm, fileGlobs };
}

export const isStop = (x: Candidate | GateStop): x is GateStop => "gate" in x;

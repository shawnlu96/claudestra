/**
 * feature 迁移 dry-run 的 markdown 报告（给 owner 看归类）：每个 feature 一张表，卡按「进 v1 / 待排 / 已完成 / 已取消」分组，
 * 后面是未归类、归类没把握、阶段落后、没进图的依赖边、冲突五张清单。只拼字符串，不读库也不查 gh（查 PR 在 CLI 层）。
 */
import type { Bucket, CardRef, FeaturePlan, MigrationPlan } from "./ledger-feature-migrate.js";

/** 阶段落后：台账阶段没到 verified / done，但 PR 已合并 */
export interface LagInfo {
  id: string;
  stage: string;
  pr: string;
  mergedAt: string | null;
}

export interface ReportInput {
  plan: MigrationPlan;
  lagging: LagInfo[];
  /** 查 PR 失败的卡 → 原因（没查出结论，不算落后也不算没落后） */
  prErrors: Record<string, string>;
  generatedAt: string;
  source: string;
}

const LABEL: Record<Bucket, string> = { active: "进行中", pending: "待排", done: "已完成", cancelled: "已取消" };

/** 表格单元格：竖线与换行会切坏 markdown 表 */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

function cardRow(kind: string, c: CardRef, marks: Map<string, string[]>): string {
  return `| ${kind} | ${c.id} | ${c.stage} | ${cell(c.title)} | ${(marks.get(c.id) ?? []).join("；")} |`;
}

function featureSection(f: FeaturePlan, marks: Map<string, string[]>): string[] {
  const head = `### ${cell(f.title)}（\`${f.id}\`）${f.exists ? " · 已存在" : " · 新建"}`;
  const out = [head, "", `${f.dagNote}；新挂 featureId ${f.toAssign.length} 张`, ""];
  out.push("| 分类 | 卡 | 阶段 | 标题 | 备注 |", "|---|---|---|---|---|");
  for (const c of f.cards.active) out.push(cardRow(f.nodes ? "进行中 · 进 v1" : "进行中", c, marks));
  for (const c of f.cards.done.filter((x) => x.node === "predecessor")) out.push(cardRow(f.nodes ? "已完成 · 前驱进 v1" : "已完成 · 前驱", c, marks));
  for (const c of f.cards.pending) out.push(cardRow(LABEL.pending, c, marks));
  for (const c of f.cards.done.filter((x) => x.node !== "predecessor")) out.push(cardRow(LABEL.done, c, marks));
  for (const c of f.cards.cancelled) out.push(cardRow(LABEL.cancelled, c, marks));
  if (f.nodes?.some((n) => n.deps.length)) {
    out.push("", `v1 依赖：${f.nodes.filter((n) => n.deps.length).map((n) => `${n.taskId} ← ${n.deps.join(", ")}`).join("；")}`);
  }
  return [...out, ""];
}

function list(title: string, rows: string[], empty = "无"): string[] {
  return [`### ${title}（${rows.length}）`, "", ...(rows.length ? rows : [empty]), ""];
}

export function renderMigrationReport(r: ReportInput): string {
  const { plan } = r;
  const marks = new Map<string, string[]>();
  const mark = (id: string, s: string) => marks.set(id, [...(marks.get(id) ?? []), s]);
  for (const u of plan.unsure) mark(u.id, `没把握：${cell(u.note)}`);
  for (const l of r.lagging) mark(l.id, `阶段落后（PR ${l.pr} 已合并）`);
  for (const [id, e] of Object.entries(r.prErrors)) mark(id, `PR 没查到：${cell(e)}`);
  const count = (b: Bucket) => plan.features.reduce((n, f) => n + f.cards[b].length, 0);
  const lines = [
    "# 旧卡迁进 feature · dry-run",
    "",
    `生成于 ${r.generatedAt}；库：${r.source}；项目 ${plan.project}；本机前缀 ${plan.origin ?? "（库里还没有，正式迁移时生成）"}`,
    "",
    "这是只读预演，库没有被改。正式迁移只会新增 feature、子 DAG 版本、卡上的 featureId（每张卡 rev + 1、追加一条事件），不改阶段、依赖和旧事件。",
    "",
    `- ${plan.features.length} 个 feature（新建 ${plan.writes.features}），建 v1 的 ${plan.writes.versions} 个，新挂 featureId ${plan.writes.cards} 张`,
    `- 进行中 ${count("active")} · 待排 ${count("pending")} · 已完成 ${count("done")} · 已取消 ${count("cancelled")} · 未归类 ${plan.unassigned.length}`,
    `- 归类没把握 ${plan.unsure.length} · 阶段落后 ${r.lagging.length} · 没进图的依赖边 ${plan.droppedEdges.length} · 冲突 ${plan.conflicts.length}`,
    "",
    "## 各 feature",
    "",
    ...plan.features.flatMap((f) => featureSection(f, marks)),
    "## 清单",
    "",
    ...list("未归类（featureId 留空）", plan.unassigned.map((c) => `- ${c.id}（${c.stage}）${cell(c.title)}`)),
    ...list("归类没把握", plan.unsure.map((u) => `- ${u.id} → ${u.feature ?? "未归类"}：${cell(u.note)}`)),
    ...list("阶段落后（PR 已合并、台账阶段没跟上；不自动改，交给 PM）", r.lagging.map((l) => `- ${l.id}：阶段 ${l.stage}，PR ${l.pr} 合并于 ${l.mergedAt ?? "?"}`)),
    ...list("没进图的依赖边（blocks，前置 → 后续）", plan.droppedEdges.map((e) => `- ${e.from} → ${e.to}：${e.why}`)),
    ...list("冲突（有冲突时正式迁移整批拒绝）", plan.conflicts.map((c) => `- ${c}`)),
    ...(plan.missing.length ? list("映射表里有、库里没有的卡", plan.missing.map((id) => `- ${id}`)) : []),
    ...(Object.keys(r.prErrors).length ? list("PR 没查到的卡", Object.entries(r.prErrors).map(([id, e]) => `- ${id}：${cell(e)}`)) : []),
  ];
  return lines.join("\n");
}

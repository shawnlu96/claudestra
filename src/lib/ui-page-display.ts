/**
 * PAGEOK 的读侧显示（UIAC2）：feature 已凭项目整页验收源改 done 时，当前版那个没绑卡的 PAGEOK 按已完成显示。
 * 规则：feature done，且 ui_page_members 里它的成员记录指向 verified 向量、条目结论 approve、条目 scope 的 dagVersion
 * 等于正在显示的版本、这个版本就是当前版本。只读查询，表没建 = 不叠加；不现算 check（看板没有 manager 身份）。
 * nodePhase / projectNodes 被写路径共用，不改；叠加只在 dagSnapshot、boardNodes、productBoard 三处读。
 */
import type { Database } from "bun:sqlite";
import type { DagNode, Feature } from "./ledger-feature.js";
import { PAGE_CHECK_KEY } from "./ui-acceptance.js";

/** 这一版的 PAGEOK 是否凭验收源按已完成显示 */
export function pageAcceptedBySource(db: Database, f: Feature, version: number): boolean {
  if (f.status !== "done" || !version || version !== f.currentVersion) return false;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ui_page_members'").get()) return false;
  const row = db.query(`SELECT v.state, v.entries FROM ui_page_members m
    JOIN ui_page_vectors v ON v.sourceId = m.sourceId AND v.revision = m.revision WHERE m.project = ? AND m.featureId = ?`)
    .get(f.project, f.id) as { state: string; entries: string } | null;
  if (row?.state !== "verified") return false;
  const entries = JSON.parse(row.entries) as { scope: { featureId: string; dagVersion: number }; verdict: string }[];
  const e = entries.find((x) => x.scope.featureId === f.id);
  return e?.verdict === "approve" && e.scope.dagVersion === version;
}

/** 按规则显示完成的那个节点：没绑卡的 PAGEOK（绑卡的老路径照卡显示） */
export const isSourceAcceptedNode = (n: Pick<DagNode, "key" | "taskId">): boolean => n.key === PAGE_CHECK_KEY && !n.taskId;

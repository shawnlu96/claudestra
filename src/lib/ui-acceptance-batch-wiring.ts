/**
 * 项目整页验收源（UiAcceptanceBatch，UIAC1）接到 feature 完成闸与 CLI（UIACW）。
 * 开关：项目级 mode 存 statePath("ui-page-batch.json")（{ projects: { <项目>: "on" | "observe" | "off" } }），每次现读；
 * 缺失 = observe，读坏 = observe + 诊断，即原单 feature PAGEOK 闸。只有 on 时，原闸拒绝后才查批验收源。
 * batch 要 feature-write 的 requireManager，本文件又被 feature-write 导入：为不成环，这里只 type 引 batch，
 * check 由 manager/ledger-ui-acceptance.ts（ledger CLI 必载，setFeature 唯一调用方 feature-set 走它）注入；
 * 没注入的进程 mode=on 也只走原闸（拒，不放行）。tests/ui-acceptance-batch-wiring.test.ts 覆盖冷启动导入顺序。
 */
import type { Database } from "bun:sqlite";
import { instanceIdSync } from "./instance-id.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { Feature } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import type { UiAcceptanceBatch } from "./ui-acceptance-batch.js";
import { requirePageCheck } from "./ui-acceptance.js";

// ledger-feature-write.ts 的 PAGEOK 入口统一从这里取（规格只给那边改 2 行）；重导出是活绑定，不受导入环影响
export { dropPageCheck, withPageCheck } from "./ui-acceptance.js";

export type PageMode = "on" | "observe" | "off";
export const PAGE_MODES: readonly PageMode[] = ["on", "observe", "off"];
const isMode = (v: unknown): v is PageMode => typeof v === "string" && (PAGE_MODES as readonly string[]).includes(v);

export function pageModePath(): string {
  return statePath("ui-page-batch.json");
}

type ModeFile = { projects: Record<string, PageMode> };
function readModeFile(path: string): { file: ModeFile | null; diagnostic?: string } {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return { file: { projects: {} } };
  if (r.status === "corrupt") return { file: null, diagnostic: `${path} 读坏（${r.error}），按 observe 走原 PAGEOK 闸` };
  const projects = (r.data as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects) || !Object.values(projects).every(isMode)) {
    return { file: null, diagnostic: `${path} 结构不对，按 observe 走原 PAGEOK 闸` };
  }
  return { file: { projects: { ...(projects as Record<string, PageMode>) } } };
}

/** 项目当前开关；文件缺失 / 没登记这个项目 = observe，读坏 = observe + 诊断 */
export function readPageMode(project: string, path = pageModePath()): { mode: PageMode; diagnostic?: string } {
  const { file, diagnostic } = readModeFile(path);
  return { mode: file?.projects[project] ?? "observe", ...(diagnostic ? { diagnostic } : {}) };
}

/** 改开关（调用方先核 PM / master / owner）；文件读坏时拒绝覆盖，免得冲掉别的项目的设置 */
export function writePageMode(project: string, mode: PageMode, path = pageModePath()): PageMode {
  if (!isMode(mode)) throw new LedgerError("invalid", "ui-page-mode 只收 on / observe / off");
  const { file, diagnostic } = readModeFile(path);
  if (!file) throw new LedgerError("conflict", `${diagnostic}；修好或删掉后重试`);
  const previous = file.projects[project] ?? "observe";
  file.projects[project] = mode;
  writeJsonAtomicSync(path, file, { trailingNewline: true });
  return previous;
}

type BatchCheck = (db: Database, c: Parameters<UiAcceptanceBatch["check"]>[0], featureId: string) => { ok: boolean; reason?: string };
let batchCheck: BatchCheck | null = null;
/** 由持有 UiAcceptanceBatch 的一侧装入；完成闸只经它查源 */
export function installPageBatchCheck(fn: BatchCheck | null): void {
  batchCheck = fn;
}

/** 批验收的调用上下文：实例 id 取本机实例，mode 现读；now 透传给 ask 过期判定 */
export function batchContext(project: string, actor: string, now?: number, actorChannelId?: string | null) {
  return { instanceId: instanceIdSync(), project, actor, mode: readPageMode(project).mode, ...(now !== undefined ? { now } : {}),
    ...(actorChannelId !== undefined ? { actorChannelId } : {}) };
}

/**
 * setFeature(done) 的完成闸：先跑原 requirePageCheck；它拒且 mode=on 才查项目验收源（setFeature 事务内，batch 用嵌套 savepoint）。
 * 源放行 → 通过；否则原错误后附批验收原因再抛。off / observe 永不调 check，错误逐字同原闸。
 */
export function requirePageCheckOrBatch(db: Database, ctx: WriteCtx, f: Feature): void {
  try {
    requirePageCheck(db, f);
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    const c = batchContext(f.project, ctx.actor, ctx.now);
    if (c.mode !== "on") throw e;
    const r = batchCheck ? batchCheck(db, c, f.id) : { ok: false, reason: "本进程未接入项目验收源" };
    if (r.ok) return;
    throw new LedgerError(e.code, `${e.message}。项目整页验收源也未放行：${r.reason}`, e.current);
  }
}

export interface PageSourceView {
  instanceId: string; sourceId: string; revision: number; state: string | null; askId: string | null;
  features: { featureId: string; verdict: string }[];
}

/** 项目当前验收源（只读，表还没建 = null）；不吐证据原文，私有证据留在台账里 */
export function currentPageSource(db: Database, project: string): PageSourceView | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ui_page_batch'").get()) return null;
  const row = db.query(`SELECT b.instanceId, b.sourceId, b.revision, v.state, v.askId, v.entries FROM ui_page_batch b
    LEFT JOIN ui_page_vectors v ON v.sourceId = b.sourceId AND v.revision = b.revision WHERE b.project = ?`).get(project) as
    (Omit<PageSourceView, "features"> & { entries: string | null }) | null;
  if (!row) return null;
  const entries = row.entries ? JSON.parse(row.entries) as { scope: { featureId: string }; verdict: string }[] : [];
  const { entries: _, ...rest } = row;
  return { ...rest, features: entries.map((e) => ({ featureId: e.scope.featureId, verdict: e.verdict })) };
}

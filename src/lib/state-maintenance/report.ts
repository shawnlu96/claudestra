/**
 * observe 预演报告与报告落盘。预演对状态根零写入:只读清单 + STATE1 的 observe 模式(不建日志和锁);
 * 前后各取一次元数据指纹,对不上标「非一致快照」——在线预演无论如何都不能充当 on 的停写证据。
 * 报告只写逻辑根名与相对路径(scrub 把绝对路径换掉),落在 reports/<runId>/,0600,tmp + rename。
 * tests/state-maintenance-observe.test.ts。
 */

import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, inspectLayout } from "../floka-migration/state/layout.js";
import { migrateState } from "../floka-migration/state/migrate.js";
import type { StateFs } from "../floka-migration/state/types.js";
import { identityInventory, treeInventory, type IdentityInventory } from "./inventory.js";
import { ensureDir, FILE_MODE, LOGICAL_ROOTS, maintPaths, runDir } from "./paths.js";

export const REPORT_FORMAT = 1;

export interface Roots { home: string; oldRoot: string; newRoot: string }

/** 把文本里的绝对路径换成逻辑名(长的先换,避免 home 先吃掉根路径) */
export function scrub(text: string, r: Roots, maintRoot?: string): string {
  const pairs: [string, string][] = [[r.oldRoot, LOGICAL_ROOTS.old], [r.newRoot, LOGICAL_ROOTS.new], [r.home, "~"]];
  if (maintRoot) pairs.push([maintRoot, "maintenance-root"]);
  let out = text;
  for (const [abs, name] of pairs.sort((a, b) => b[0].length - a[0].length)) out = out.split(abs).join(name);
  return out;
}

const logicalName = (root: string | null, r: Roots): string | null =>
  root === r.oldRoot ? LOGICAL_ROOTS.old : root === r.newRoot ? LOGICAL_ROOTS.new : null;

interface Fingerprint { layout: string; identity: string; tree: string | null }

async function fingerprint(fs: StateFs, r: Roots): Promise<{ fp: Fingerprint; data: string | null; identity: IdentityInventory | null }> {
  const layout = await inspectLayout(fs, r.oldRoot, r.newRoot);
  const data = dataRoot(layout, r.oldRoot, r.newRoot);
  if (!data) return { fp: { layout: layout.kind, identity: "", tree: null }, data, identity: null };
  const identity = await identityInventory(fs, data);
  const tree = await treeInventory(fs, data, false);
  return { fp: { layout: layout.kind, identity: JSON.stringify(identity.items), tree: tree.metaDigest }, data, identity };
}

export interface ObserveInput extends Roots {
  fs: StateFs;
  maintRoot: string;
  runId: string;
  mode: "observe" | "on";
  version: string;
  baseline: string;
  now: number;
  approvedCustom?: { oldRoot: string; newRoot: string };
}

export interface ObserveReport {
  format: number;
  kind: "observe";
  version: string;
  baseline: string;
  runId: string;
  createdAt: string;
  mode: string;
  roots: { old: string; new: string; dataRoot: string | null; layout: string };
  identity: IdentityInventory | null;
  tree: { entries: number; metaDigest: string } | null;
  plannedSteps: { id: string; state: string; conflicts: string[] }[];
  conflicts: string[];
  snapshot: "一致快照" | "非一致快照";
  notes: string[];
}

export async function buildObserveReport(i: ObserveInput): Promise<ObserveReport> {
  const before = await fingerprint(i.fs, i);
  const journalDir = join(maintPaths(i.maintRoot).journals, i.runId); // observe 不建它,只用来过「日志不在根里」的检查
  const plan = await migrateState({
    mode: "observe", oldRoot: i.oldRoot, newRoot: i.newRoot, home: i.home, approvedCustom: i.approvedCustom,
    writers: { activeWriters: async () => [] }, fs: i.fs, journalDir, txId: i.runId,
  });
  const after = await fingerprint(i.fs, i);
  const consistent = JSON.stringify(before.fp) === JSON.stringify(after.fp);
  const tree = after.data ? await treeInventory(i.fs, after.data, false) : null;
  const steps = plan.steps.map((s) => ({ id: s.id, state: s.state, conflicts: (s.conflicts ?? []).concat(s.error ? [s.error] : []).map((c) => scrub(c, i)) }));
  const conflicts = [...new Set([...steps.flatMap((s) => s.conflicts), ...(after.identity?.conflicts ?? []), ...(plan.error ? [scrub(plan.error, i)] : [])])];
  if (!after.data) conflicts.push("旧根和新根都没有数据");
  return {
    format: REPORT_FORMAT, kind: "observe", version: i.version, baseline: i.baseline, runId: i.runId,
    createdAt: new Date(i.now).toISOString(), mode: i.mode,
    roots: { old: LOGICAL_ROOTS.old, new: LOGICAL_ROOTS.new, dataRoot: logicalName(after.data, i), layout: after.fp.layout },
    identity: after.identity, tree: tree && { entries: tree.entries.length, metaDigest: tree.metaDigest },
    plannedSteps: steps, conflicts, snapshot: consistent ? "一致快照" : "非一致快照",
    notes: [
      "在线预演:未停服务、未核停写,不得作为 on 的停写前置证据",
      "拟执行步骤只是计划;observe 不搬根、不生成身份,也不产生回滚样本",
      ...(consistent ? [] : ["预演前后元数据或清单有变化(有写者在写),本报告是非一致快照"]),
    ],
  };
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 写 reports/<runId>/<name>.json;返回维护根内的相对路径与内容哈希 */
export function writeReport(maintRoot: string, runId: string, name: string, report: unknown): { rel: string; sha256: string } {
  const dir = runDir(maintPaths(maintRoot).reports, runId);
  ensureDir(dir);
  const text = JSON.stringify(report, null, 2);
  const path = join(dir, `${name}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: FILE_MODE });
  renameSync(tmp, path);
  return { rel: `reports/${runId}/${name}.json`, sha256: sha256Hex(text) };
}

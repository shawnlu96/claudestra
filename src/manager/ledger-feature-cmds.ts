/**
 * `ledger feature-new / feature-set / dag-init / feature-show`：feature 与子 DAG 初版（T84，docs/design/feature-dag.md）。
 * 写入、权限与 CAS 在 lib/ledger-feature-write.ts；这里只解析参数。feature id 可以写全（带本机前缀）也可以只写 slug。
 * 重写（v2 起）、审批、绑卡与 dag-show 在 ledger-dag-cmds.ts。
 */
import type { FeatureStatus } from "../lib/ledger-feature-schema.js";
import { effectiveNodes, getDagVersion, getPendingProposal, projectNodes, resolveFeature } from "../lib/ledger-feature.js";
import { createFeature, initDag, setFeature, type FeaturePatch } from "../lib/ledger-feature-write.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { LedgerError } from "../lib/ledger-store.js";
import { autostartShow } from "./ledger-autostart-cmds.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const feature = (c: LedgerCli) => resolveFeature(c.db, c.p.pos[1], storedOrigin(c.db));

function needRev(c: LedgerCli, what: string): number {
  const rev = intFlag(c.p, "rev");
  if (rev === undefined) throw new LedgerError("invalid", `${what}要带 --rev（feature-show 里看当前 rev）`);
  return rev;
}

function patchFlags(c: LedgerCli): FeaturePatch {
  const f = c.p.flags;
  return {
    ...(f.title !== undefined ? { title: f.title } : {}),
    ...(f.words !== undefined ? { ownerWords: f.words } : {}),
    ...(f.status !== undefined ? { status: f.status as FeatureStatus } : {}),
  };
}

function featureNew(c: LedgerCli): Result {
  const slug = c.p.pos[1];
  if (!slug) throw new LedgerError("invalid", "缺 feature id");
  const r = createFeature(c.db, c.ctx(), { ...patchFlags(c), project: c.project(), slug, title: c.need("title") });
  return { ok: true, feature: r.row, event: r.event, duplicate: r.duplicate };
}

function featureSet(c: LedgerCli): Result {
  const f = feature(c);
  const r = setFeature(c.db, c.ctx(), { id: f.id, rev: needRev(c, "改 feature"), patch: patchFlags(c) });
  return { ok: true, feature: r.row, event: r.event, duplicate: r.duplicate };
}

function dagInit(c: LedgerCli): Result {
  const f = feature(c);
  let nodes: unknown;
  try {
    nodes = JSON.parse(c.need("nodes"));
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError("invalid", `--nodes 不是合法 JSON：${(e as Error).message}`);
  }
  const r = initDag(c.db, c.ctx(), { id: f.id, rev: needRev(c, "建 DAG"), nodes, reasonText: c.p.flags.reason });
  return { ok: true, version: r.row, event: r.event, duplicate: r.duplicate };
}

/** 当前版本的节点（并上绑卡），状态从任务卡现读；还没建 DAG 时 nodes 为空。有待批的重写一并给出版本号与 ask */
function featureShow(c: LedgerCli): Result {
  const f = feature(c);
  const v = f.currentVersion ? getDagVersion(c.db, f.id, f.currentVersion) : null;
  const p = getPendingProposal(c.db, f.id);
  return { ok: true, feature: f, version: v ? { ...v, nodes: undefined } : null, nodes: v ? projectNodes(c.db, effectiveNodes(c.db, v)) : [],
    pending: p ? { version: p.version, askId: p.askId, proposedBy: p.proposedBy, createdAt: p.createdAt } : null, autostart: autostartShow(c, f) };
}

export const FEATURE_CMDS: Record<string, CommandSpec> = {
  "feature-new": {
    valued: ["title", "words", "status", "project", "dedup"],
    usage: "feature-new <id> --title <名字> [--words <owner 原话>] [--status active|paused|done|dropped]",
    run: featureNew,
  },
  "feature-set": { valued: ["rev", "title", "words", "status", "project", "dedup"], usage: "feature-set <feature> --rev <n> [--title] [--words] [--status]", run: featureSet },
  "dag-init": {
    valued: ["rev", "nodes", "reason", "project", "dedup"],
    usage: "dag-init <feature> --rev <n> --nodes '<[{key?,taskId?,oneLine?,deps?,estimate?,fileGlobs?}]>' [--reason <原文>]（只建 v1）",
    run: dagInit,
  },
  "feature-show": { valued: ["project"], usage: "feature-show <feature>", run: featureShow },
};

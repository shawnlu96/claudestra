import { requireLocalSharedLedgerPlanning } from "../lib/shared-ledger-gate.js";
import { readFileSync, writeFileSync } from "node:fs";
import { effectiveNodes, getDagVersion, resolveFeature } from "../lib/ledger-feature.js";
import { requireManager } from "../lib/ledger-feature-write.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { applyFeatureSplit } from "../lib/ledger-feature-split.js";
import { parseSplitMap, planFeatureSplit } from "../lib/ledger-feature-split-plan.js";
import { renderSplitReport } from "../lib/ledger-feature-split-report.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

async function featureSplit(c: LedgerCli): Promise<Result> {
  const f = resolveFeature(c.db, c.p.pos[1], storedOrigin(c.db));
  requireManager(c.db, c.deps.actor, f.project);
  if (!c.p.bools.has("dry-run")) requireLocalSharedLedgerPlanning(f.id);
  const map = parseSplitMap(JSON.parse(readFileSync(c.need("plan"), "utf8")));
  if (!c.p.bools.has("dry-run")) return { ok: true, ...applyFeatureSplit(c.db, c.ctx(), f.id, map) };
  const plan = planFeatureSplit(c.db, f.id, map);
  const markdown = renderSplitReport(c.db, plan);
  if (c.p.flags.out) writeFileSync(c.p.flags.out, markdown, { flag: "wx" });
  return { ok: plan.rejected.length === 0, dryRun: true, plan, markdown,
    sourceNodes: effectiveNodes(c.db, getDagVersion(c.db, f.id, f.currentVersion) ?? { featureId: f.id, version: 0, nodes: [] }) };
}

export const FEATURE_SPLIT_CMDS: Record<string, CommandSpec> = {
  "feature-split": { valued: ["plan", "out", "dedup"], bools: ["dry-run"],
    usage: "feature-split <源 feature> --plan <映射.json> [--dry-run [--out <报告.md>]] [--dedup <键>]", run: featureSplit },
};

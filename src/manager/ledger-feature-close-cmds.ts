/**
 * `ledger feature-close-candidates / feature-close`（team-project-FCLOSE1）：判定与关单在 lib/ledger-feature-close.ts，这里只解析参数。
 * candidates 走只读连接（write-commands.ts 的 READER_ONLY_SUBS），先 requireManager 再列；feature-close 是写命令，闸都在 setFeature。
 */
import { closeFeature, featureCloseCandidates } from "../lib/ledger-feature-close.js";
import { resolveFeature } from "../lib/ledger-feature.js";
import { requireManager } from "../lib/ledger-feature-write.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function candidates(c: LedgerCli): Result {
  const project = c.project();
  requireManager(c.db, c.ctx().actor, project);
  return { ok: true, project, candidates: featureCloseCandidates(c.db, project, c.deps.now()) };
}

function close(c: LedgerCli): Result {
  const f = resolveFeature(c.db, c.p.pos[1], storedOrigin(c.db));
  const rev = intFlag(c.p, "rev");
  if (rev === undefined) throw new LedgerError("invalid", "关单要带 --rev（feature-close-candidates 的输出里有）");
  const ctx = c.ctx();
  const r = closeFeature(c.db, ctx, { id: f.id, rev, now: ctx.now ?? c.deps.now() });
  return { ok: true, feature: r.row, event: r.event, duplicate: r.duplicate };
}

export const FEATURE_CLOSE_CMDS: Record<string, CommandSpec> = {
  "feature-close-candidates": { valued: ["project"], usage: "feature-close-candidates [--project <id>]（子 DAG 全完成仍 active 的 feature）", run: candidates },
  "feature-close": { valued: ["rev", "project"], usage: "feature-close <feature> --rev <n>（复核全完成后改 done）", run: close },
};

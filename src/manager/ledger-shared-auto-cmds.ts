import { STATE_DIR } from "../lib/paths.js";
import { LedgerError } from "../lib/ledger-store.js";
import { readSharedLedgerBindings } from "../lib/shared-ledger-gate-bindings.js";
import { readSharedLedgerImportRecord, sharedLedgerImportJournalPath } from "../lib/shared-ledger-import-run.js";
import {
  autoShareProject, updateAutoShareState, validAutoShareId, type AutoShareMode, type AutoShareProject, type AutoShareStatus,
} from "../lib/shared-ledger-auto-share-state.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const LABELS: Record<AutoShareStatus, string> = {
  will_share: "会共享", deferred: "暂缓", refused: "拒收", shared: "已共享", excluded: "排除", in_batch: "共享中",
};
const USAGE = "shared-auto status|off|observe|on <本机项目> | exclude|include <本机项目> <featureId>"
  + "（已绑定团队的项目里进行中 feature 自动只读共享到中心；改动只许本机 PM / owner；先 observe 看清单再 on）";

function sharedAutoStatus(localProjectId: string, dir = STATE_DIR) {
  const p = autoShareProject(dir, localProjectId), at = (t: number | undefined) => t ? new Date(t).toISOString() : null;
  const lists: Record<string, { featureId: string; reason?: string }[]> = Object.fromEntries(Object.values(LABELS).map((l) => [l, []]));
  for (const [featureId, f] of Object.entries(p.features ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    lists[LABELS[f.status]]!.push({ featureId, ...(f.reason ? { reason: f.reason } : {}) });
  }
  return { ok: true, localProjectId, mode: p.mode, exclude: p.exclude,
    bound: readSharedLedgerBindings(dir).some((b) => b.localProjectId === localProjectId),
    halted: p.halted ?? null, pending: p.pending ?? null, lastRunAt: at(p.lastRunAt), lastError: p.lastError ?? null,
    lists, batches: p.batches ?? [] };
}

/** halted clears only after the PM checked the batch: its journal must have reached verified / revoked / aborted. */
function clearHalt(p: AutoShareProject, dir: string): void {
  if (!p.halted) return;
  const phase = readSharedLedgerImportRecord(sharedLedgerImportJournalPath(dir, p.halted.batchId))?.phase;
  if (!phase || !["verified", "revoked", "aborted"].includes(phase)) {
    throw new LedgerError("conflict", `批次 ${p.halted.batchId} 的 journal 还没到 verified / revoked / aborted，先用 scripts/shared-ledger-import.ts 核对处理`);
  }
  if (p.pending?.batchId === p.halted.batchId) p.pending = phase === "verified" ? { ...p.pending, unknown: 0 } : null;
  p.halted = null;
}

async function sharedAutoSet(localProjectId: string, change: { mode?: AutoShareMode; exclude?: string; include?: string }, dir = STATE_DIR) {
  await updateAutoShareState(dir, (projects) => {
    const p = projects[localProjectId] ?? { mode: "off", exclude: [] };
    if (change.mode === "on") clearHalt(p, dir);
    if (change.mode) p.mode = change.mode;
    if (change.exclude && !p.exclude.includes(change.exclude)) p.exclude = [...p.exclude, change.exclude].sort();
    if (change.include) p.exclude = p.exclude.filter((id) => id !== change.include);
    projects[localProjectId] = p;
  });
  return sharedAutoStatus(localProjectId, dir);
}

/** N8A: `ledger shared-auto …`；状态文件 shared-ledger-auto-share.json，cron 里 5 分钟一轮（lib/shared-ledger-auto-share.ts）。 */
export const SHARED_AUTO_CMDS: Record<string, CommandSpec> = {
  "shared-auto": {
    valued: [],
    usage: USAGE,
    async run(c) {
      const [, action, project, featureId] = c.p.pos;
      const modes = ["off", "observe", "on"], edits = ["exclude", "include"];
      if (![...modes, ...edits, "status"].includes(action ?? "") || !validAutoShareId(project) || (edits.includes(action!) !== validAutoShareId(featureId))) {
        throw new LedgerError("invalid", `用法：${USAGE}`);
      }
      if (action === "status") return sharedAutoStatus(project);
      c.requireManager(project, "改自动共享开关");
      if (modes.includes(action!)) return sharedAutoSet(project, { mode: action as AutoShareMode });
      return sharedAutoSet(project, action === "exclude" ? { exclude: featureId } : { include: featureId });
    },
  },
};

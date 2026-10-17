/**
 * 中心副本自动开卡的台账写口（`ledger scheduler-autostart center-replica <feature> <节点> --mode observe|skip …`，只给调度身份）。
 * 节点还没有卡，scheduler-recovery-observe 要的卡号给不出，台账事件的 target 又只收卡 / 事项，所以两种都记成项目级事件，feature 与节点在 data 里：
 * - observe：recovery_observe 样本（recordObserved），actionKey = feature:节点:arm，同一份只记一次；
 * - skip：中心拒绝认领的 note，去重键按副本当前版本 + arm 在这里现算（center-replica-autostart.ts centerSkipDedup，节点门读同一个）。
 */
import type { Database } from "bun:sqlite";
import { CENTER_REPLICA_AUTOSTART_KEY, centerSkipDedup, isCenterReplica } from "./center-replica-autostart.js";
import type { WriteCtx } from "./ledger-checks.js";
import { getFeature } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved } from "./recovery-policy.js";

const ARM = /^[a-f0-9]{16}$/;

function extraOf(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  const v = JSON.parse(raw) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new LedgerError("invalid", "--extra 要是 JSON 对象");
  return v as Record<string, unknown>;
}

export function centerReplicaCli(db: Database, ctx: WriteCtx, pos: string[], flags: Record<string, string | undefined>): Record<string, unknown> {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "中心副本自动开卡的写口只给调度服务");
  const [featureId, key] = pos, mode = flags.mode, text = flags.text?.trim();
  if (!featureId || !key || !text) throw new LedgerError("invalid", "center-replica <feature> <节点> --mode observe|skip --text <一句话> [--dedup K] [--extra JSON]");
  const f = getFeature(db, featureId);
  if (!f) throw new LedgerError("not_found", `没有 feature ${featureId}`);
  if (!isCenterReplica(f.id)) throw new LedgerError("conflict", `feature ${f.id} 不是中心副本`);
  const extra = extraOf(flags.extra);
  if (mode === "observe") {
    if (!flags.dedup) throw new LedgerError("invalid", "observe 要 --dedup <节点:arm>");
    const r = recordObserved(db, { project: f.project, mechanism: CENTER_REPLICA_AUTOSTART_KEY, target: "", actionKey: `${f.id}:${flags.dedup}`, action: text.slice(0, 400),
      data: { ...extra, feature: f.id, node: key } }, ctx.now ?? Date.now());
    return { ok: true, ...r };
  }
  if (mode !== "skip") throw new LedgerError("invalid", "--mode 只能是 observe / skip");
  const arm = String(extra.arm ?? "");
  if (!ARM.test(arm)) throw new LedgerError("invalid", "skip 的 --extra 要带 arm（16 位十六进制）");
  const r = appendEvent(db, { ...ctx, dedupKey: centerSkipDedup(f.id, key, f.currentVersion, arm) },
    { project: f.project, target: "", kind: "note", text: `中心副本自动开卡跳过 ${key}：${text}`.slice(0, 600),
      data: { ...extra, op: "center_replica_skip", feature: f.id, key, version: f.currentVersion, arm } });
  return { ok: true, seq: r.event.seq, duplicate: r.duplicate };
}

/**
 * 调度服务每个核对点用的授权判定（收单入口、claim 前、起 worker 前、首条派单前、每次续租）：每次现读 lend.json 和联系人，按此刻重算，
 * 不用本轮开头的快照——前面几张单的网络调用都要时间，出借方随时可能收回。宿主看门狗那一处在 lend-watchdog.ts（同步、只读 lend.json）。
 * 授权没了之后各阶段怎么收尾在 lend-drive.ts revoke。tests/lend-revoke.test.ts。
 */
import type { LendEntry } from "./lend-config.js";
import type { LendDeps } from "./lend-drive.js";
import type { LendRow } from "./lend-journal.js";
import { effectiveLend } from "./lend-policy.js";
import { scopeProblem } from "./lend-grant-rules.js";

export type LiveGrant = { ok: true; entry: LendEntry } | { ok: false; problem: string };

/** 因授权没了而停下 / 退回的单，reason 以它开头；W3 据此给 proto 2 的 A 报 `revoked, clean:true`（isRevoked） */
export const REVOKED = "出借授权已收回或失效";

export const isRevoked = (row: Pick<LendRow, "reason">): boolean => (row.reason ?? "").startsWith(REVOKED);

/**
 * row 带了挂单摘要（preview）就连这张单的仓库 / 阶段 / 家族一起核（scopeProblem）；收单入口只有 peer，只核整条。
 * 先读联系人、最后读 lend.json：读完到调用方发出效果（claim、起 worker、派单）之间不再有别的 I/O，收回落在任何一次 await 里都看得见。
 */
export async function liveGrant(row: Pick<LendRow, "peer" | "fp"> & Partial<Pick<LendRow, "preview" | "family">>,
  d: Pick<LendDeps, "readLend" | "context" | "now">): Promise<LiveGrant> {
  const ctx = await d.context();
  const read = await d.readLend();
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, d.now());
  if (eff.invalid) return { ok: false, problem: `lend.json 无效：${eff.invalid}` };
  const entry = eff.lend.find((e) => e.peer === row.peer);
  if (!entry) {
    const why = eff.dropped.find((x) => x.startsWith(`lend ${row.peer}：`));
    return { ok: false, problem: why ?? (read.file.enabled ? `没有给 ${row.peer} 的授权` : "出借已关") };
  }
  if (row.fp && entry.fp !== row.fp) return { ok: false, problem: `${row.peer} 的实例指纹和领单时的不一样` };
  const out = row.preview && row.family ? scopeProblem(entry, { repo: String(row.preview.repo ?? ""), step: String(row.preview.step ?? ""), family: row.family }) : null;
  return out ? { ok: false, problem: out } : { ok: true, entry };
}

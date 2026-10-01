/**
 * 自动开卡（i28-A1）的 claim：调度身份对一张卡的写权只由这张卡活着的 claim 授予。claim 是 feature 上的一条 `autostart_claim` 事件
 * （dedupKey `autostart:<feature>:<节点>:<arm>`，库的 UNIQUE 保证同一 arm 只有一条），结清是一条 dedupKey `autostart-settle:<claim>` 的事件。
 * 这里只读：claim 的读取、卡是不是本 claim 建的，以及 lib 里三处钩子共用的 autostartGrant——它只认调度身份，并且 ctx.autostart
 * 只由 ledger-autostart-step.ts 在同一事务里核过 claim 之后放进去（tests/ledger-autostart-claim.test.ts 用源码断言钉住出现的位置）。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, toEvent } from "./ledger-store.js";

export interface AutostartClaim {
  seq: number;
  project: string;
  featureId: string;
  key: string;
  taskId: string;
  agent: string;
  pm: string;
  branch: string;
  item: string | null;
  title: string;
  /** null = 规格卡的模板行不合法：claim 只为记这一笔失败，不授予开 auto */
  template: "code" | "ui" | "security" | null;
  version: number | null;
  arm: string;
  /** 规格卡首写了「owner 看截图：是」：建卡时写进 extra.ownerVisual */
  ownerVisual: boolean;
  peer?: { name: string; repo: string; reason: string } | null;
}

export const claimDedup = (featureId: string, key: string, arm: string): string => `autostart:${featureId}:${key}:${arm}`;
export const settleDedup = (seq: number): string => `autostart-settle:${seq}`;

function toClaim(row: Record<string, unknown>): AutostartClaim {
  const e = toEvent(row);
  const d = e.data as Record<string, unknown>;
  return {
    seq: e.seq, project: e.project, featureId: e.target, key: String(d.key), taskId: String(d.taskId), agent: String(d.agent), pm: String(d.pm),
    branch: String(d.branch), item: typeof d.item === "string" ? d.item : null, title: String(d.title),
    template: (d.template ?? null) as AutostartClaim["template"], version: typeof d.version === "number" ? d.version : null, arm: String(d.arm),
    ownerVisual: d.ownerVisual === true, peer: (d.peer ?? null) as AutostartClaim["peer"],
  };
}

const CLAIMS = "SELECT * FROM events WHERE kind = 'feature' AND dedupKey LIKE 'autostart:%' AND json_extract(data, '$.op') = 'autostart_claim'";

export function getClaim(db: Database, seq: number): AutostartClaim | null {
  const row = db.query(`${CLAIMS} AND seq = ?`).get(seq) as Record<string, unknown> | null;
  return row ? toClaim(row) : null;
}

export const claimSettled = (db: Database, seq: number): boolean => getEventByDedup(db, settleDedup(seq)) !== null;

/** 还没结的 claim（按 seq）；调度服务每轮开头拿它对账 */
export function openClaims(db: Database, featureId?: string): AutostartClaim[] {
  const rows = db.query(`${CLAIMS}${featureId ? " AND target = ?" : ""} ORDER BY seq`).all(...(featureId ? [featureId] : [])) as Record<string, unknown>[];
  return rows.map(toClaim).filter((c) => !claimSettled(db, c.seq));
}

/** 卡是这个 claim 建的：建卡事件是调度身份写的、在 claim 之后。调度身份只有经 claim 的 step 才建得了卡，所以这就是归属 */
export function claimOwnsCard(db: Database, claim: AutostartClaim, taskId: string): boolean {
  if (taskId !== claim.taskId) return false;
  const born = db.query(`SELECT seq, actor FROM events WHERE target = ? AND kind = 'task' AND json_extract(data, '$.op') = 'new' ORDER BY seq LIMIT 1`)
    .get(taskId) as { seq: number; actor: string } | null;
  return !!born && born.actor === "scheduler" && born.seq > claim.seq;
}

/** lib 钩子：调度身份 + 事务内核过的 claim 指向这张卡（bind 还要同一 feature、同一节点） */
export function autostartGrant(ctx: WriteCtx, taskId: string, node?: { featureId: string; key: string }): boolean {
  const g = ctx.autostart;
  if (ctx.actor !== "scheduler" || !g || g.taskId !== taskId) return false;
  return !node || (node.featureId === g.featureId && node.key === g.key);
}

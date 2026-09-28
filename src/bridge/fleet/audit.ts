/**
 * 批量动作的留痕：bridge 日志记全量（谁、何时、动作、每个 agent 的结果），台账按项目分组各写一条项目级 note。
 * 台账写失败只记日志：动作已经做完了，留痕失败不该让调用方以为动作失败。
 */
import { ACTION_LABEL, bareName, outcomeLabel, type FleetAction, type FleetResult } from "../../lib/fleet-plan.js";
import { openLedger } from "../../lib/ledger-store.js";
import { appendEvent } from "../../lib/ledger-write.js";

export interface AuditInput {
  runId: string;
  action: FleetAction;
  /** 谁调的：网页 / CLI 是 "owner"，MCP 工具是 bridge 按连接认出的调用方名字；也是台账 note 的 actor */
  actor: string;
  /** 从哪来：web 设备名 / "cli" / "mcp" */
  via: string;
  at: number;
  results: FleetResult[];
  /** agent 名 → 项目 id（大总管和没归属的不在里面） */
  projectOf: Map<string, string>;
}

function describe(a: FleetAction): string {
  if (a.kind === "text") return `${ACTION_LABEL.text}「${(a.text ?? "").slice(0, 80)}${(a.text ?? "").length > 80 ? "…" : ""}」`;
  return ACTION_LABEL[a.kind];
}

function auditLines(x: AuditInput): string[] {
  const when = new Date(x.at).toISOString();
  return [
    `🛰 [fleet] ${x.runId} ${when} ${x.actor} via ${x.via}：${describe(x.action)} → ${x.results.length} 个 agent`,
    ...x.results.map((r) => `🛰 [fleet] ${x.runId}   ${bareName(r.agent)}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ""}`),
  ];
}

/** 项目 → 那一组的 note 正文 */
export function ledgerNotes(x: AuditInput): Map<string, string> {
  const groups = new Map<string, FleetResult[]>();
  for (const r of x.results) {
    const p = x.projectOf.get(bareName(r.agent));
    if (p) groups.set(p, [...(groups.get(p) ?? []), r]);
  }
  const when = new Date(x.at).toLocaleString("zh-CN", { hour12: false });
  const out = new Map<string, string>();
  for (const [p, rs] of groups) {
    const lines = rs.map((r) => `${bareName(r.agent)} ${outcomeLabel(r.outcome)}${r.detail ? `（${r.detail}）` : ""}`);
    out.set(p, `批量管理 ${x.runId}：${x.actor}（${x.via}）${when} 执行「${describe(x.action)}」，${rs.length} 个 agent：${lines.join("；")}`);
  }
  return out;
}

export function auditFleet(x: AuditInput, log: (line: string) => void = console.log): void {
  for (const l of auditLines(x)) log(l);
  let db: ReturnType<typeof openLedger> | null = null;
  for (const [project, text] of ledgerNotes(x)) {
    try {
      db ??= openLedger();
      appendEvent(db, { actor: x.actor, now: x.at, dedupKey: `fleet:${x.runId}:${project}` }, { project, target: "", kind: "note", text, data: { fleetRun: x.runId } });
    } catch (e) {
      console.warn(`⚠️ [fleet] ${x.runId} 台账 note 没写进 ${project}: ${(e as Error).message}`);
    }
  }
}

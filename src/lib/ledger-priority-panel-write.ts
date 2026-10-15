/** Bound owner requests; all business mutations go through PRIO1's controlled set/order functions. */
import type { Database } from "bun:sqlite";
import { bindHash } from "./ask-bind.js";
import { getAsk, ownerAnswered, type Ask, type AskAnswer, type NewAsk } from "./ledger-asks.js";
import { priorityPanel, panelKey } from "./ledger-priority-panel.js";
import { readPriority } from "./ledger-priority-read.js";
import { PRIORITY_BANDS, type PriorityBand, type PriorityTarget } from "./ledger-priority-types.js";
import { priorityAudit, setPriority, setPriorityOrder } from "./ledger-priority-write.js";
import type { PriorityPanel } from "./ledger-priority-panel.js";
import type { PriorityRecord } from "./ledger-priority-types.js";
import { LedgerError } from "./ledger-store.js";

export interface PanelRequest {
  target: PriorityTarget; rev: number; operation: "set" | "clear" | "up" | "down";
  band?: PriorityBand; snapshot: string; observedAt: number;
}
export function panelAsk(db: Database, project: string, input: PanelRequest, now: number): NewAsk & { source: "system"; createdBy: string } {
  if (!input || !["set", "clear", "up", "down"].includes(input.operation) || !input.target
    || !["task", "node"].includes(input.target.kind) || !Number.isSafeInteger(input.rev) || input.rev < 0
    || (input.operation === "set" && !PRIORITY_BANDS.includes(input.band!))) throw new LedgerError("invalid", "优先级请求格式错误");
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt > now || now - input.observedAt > 60000) {
    throw new LedgerError("conflict", "快照过期，请刷新后重试");
  }
  // Read without scheduler estimates: the authorization binds priority, target lifecycle and mode facts.
  const current = priorityPanel(db, project, now);
  if (current.modes.priorityPanel.mode === "off") throw new LedgerError("forbidden", "优先级面板已关闭");
  if (current.version !== input.snapshot || readPriority(db, project, input.target).rev !== input.rev
    || !current.rows.some(r => r.key === panelKey(input.target))) throw new LedgerError("conflict", "优先级版本冲突，请刷新");
  input = { target: input.target.kind === "task" ? { kind: "task", id: input.target.id }
    : { kind: "node", id: input.target.id, nodeKey: "nodeKey" in input.target ? input.target.nodeKey : "" }, rev: input.rev, operation: input.operation,
    ...(input.operation === "set" ? { band: input.band } : {}), snapshot: input.snapshot, observedAt: input.observedAt };
  const labels = { now: "现在做", next: "接着做", later: "可以拖" };
  const label = input.operation === "set" ? `改为${labels[input.band!]}` : input.operation === "clear" ? "恢复继承" : input.operation === "up" ? "同档前移" : "同档后移";
  const title = current.modes.priorityPanel.mode === "observe" ? `本会应用：${label}` : label;
  const bind = { action: "priority-panel", version: "1", params: { ...input, mode: current.modes.priorityPanel }, approve: ["priority_apply"] };
  return { project, source: "system", kind: "authorize", title, context: `${input.target.id} · ${"nodeKey" in input.target ? input.target.nodeKey : ""}`,
    body: "仅 owner 本人可确认；版本变化将拒绝应用。", allowText: true, expiresAt: now + 60000,
    options: [{ type: "buttons", buttons: [{ id: "priority_apply", label: title, style: "primary" }] }],
    bind: { ...bind, paramsHash: bindHash(bind, "") }, extra: { priorityPanel: true }, createdBy: "system:priority-panel" };
}

export function preparePriorityPanelAnswer(db: Database, ask: Ask, answer: AskAnswer, within?: () => void): (() => void) | undefined {
  if (ask.bind?.action !== "priority-panel") return within;
  return () => {
    if (!ownerAnswered(answer)) throw new LedgerError("forbidden", "只允许已认证 owner 本人作答");
    const stored = getAsk(db, ask.id);
    if (!stored?.bind || stored.createdBy !== "system:priority-panel" || stored.source !== "system"
      || stored.bind.paramsHash !== bindHash(stored.bind, "") || ask.bind?.paramsHash !== stored.bind.paramsHash
      || answer.choices.length !== 1 || answer.choices[0] !== "[button:priority_apply]") throw new LedgerError("forbidden", "owner 授权参数不匹配");
    const input = stored.bind.params as PanelRequest & { mode: { mode: string; rev: number } };
    const current = priorityPanel(db, stored.project, answer.at);
    if (current.version !== input.snapshot || current.modes.priorityPanel.rev !== input.mode.rev
      || current.modes.priorityPanel.mode !== input.mode.mode || current.modes.priorityPanel.mode === "off") {
      throw new LedgerError("conflict", "优先级版本冲突，请刷新后重新确认");
    }
    if (answer.at - input.observedAt > 60000) throw new LedgerError("conflict", "快照过期，请刷新后重试");
    const evidence = { ownerWords: [...answer.labels, answer.text].filter(Boolean).join("；"), ownerAt: answer.at, sourceRef: `ask:${ask.id}` };
    const ctx = { actor: "owner", project: stored.project, now: answer.at, dedupKey: `priority-panel:${ask.id}` };
    if (current.modes.priorityPanel.mode === "observe") {
      priorityAudit(db, ctx, stored.project, { op: "would_apply", request: input, ...evidence,
        recordId: readPriority(db, stored.project, input.target).recordId, target: input.target }, true);
    } else if (input.operation === "up" || input.operation === "down") {
      const targets = reordered(db, current, input);
      setPriorityOrder(db, ctx, { queue: "project", band: "now", targets, rev: current.order.rev, evidence });
      const reread = priorityPanel(db, stored.project, answer.at);
      if (reread.order.rev !== current.order.rev + 1) throw new LedgerError("conflict", "顺序读回不一致，请刷新");
    } else {
      const result = setPriority(db, ctx, { target: input.target, rev: input.rev, band: input.operation === "clear" ? null : input.band!, evidence });
      const reread = readPriority(db, stored.project, input.target);
      if (reread.rev !== result.row.rev || reread.explicit !== result.row.explicit) throw new LedgerError("conflict", "档位读回不一致，请刷新");
    }
    within?.();
  };
}

/** Preserve PRIO1 members outside the current panel, including feature entries and completed cards. */
function reordered(db: Database, panel: PriorityPanel, input: PanelRequest): PriorityTarget[] {
  const records = db.query("SELECT * FROM priority_records WHERE project=? AND archived=0").all(panel.project) as PriorityRecord[];
  const known = new Map(records.map(r => [r.id, r]));
  const members: PriorityTarget[] = [];
  for (const id of panel.order.members) {
    const r = known.get(id);
    if (!r) continue;
    const target: PriorityTarget = r.taskId ? { kind: "task", id: r.taskId } : r.nodeKey && r.featureId
      ? { kind: "node", id: r.featureId, nodeKey: r.nodeKey } : { kind: "feature", id: r.featureId! };
    if (readPriority(db, panel.project, target).effective === "now") members.push(target);
  }
  for (const row of panel.rows) if (!members.some(t => panelKey(t) === row.key)) members.push(row.target);
  const index = panel.rows.findIndex(r => r.key === panelKey(input.target));
  const neighbor = panel.rows[index + (input.operation === "up" ? -1 : 1)];
  if (!neighbor) throw new LedgerError("invalid", "已经在同档边界，无需移动");
  const from = members.findIndex(t => panelKey(t) === panelKey(input.target));
  const to = members.findIndex(t => panelKey(t) === neighbor.key);
  [members[from], members[to]] = [members[to], members[from]];
  return members;
}

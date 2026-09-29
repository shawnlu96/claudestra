/**
 * 批量动作的留痕：bridge 日志记全量（谁、何时、动作、每个 agent 的结果、没选中的原因），台账按项目分组各写一条项目级 note。
 * 预演也记（标明没发键）：MCP 默认就是预演，不记的话调用方试探了哪些 agent 在哪都查不到。
 * 台账写失败只记日志：动作已经做完了，留痕失败不该让调用方以为动作失败。
 */
import { ACTION_LABEL, bareName, outcomeLabel, type Excluded, type FleetAction, type FleetResult } from "../../lib/fleet-plan.js";
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
  /** 预演：一个键都没发，results 为空，按 targets 记「会执行」——不能写成已执行 */
  dryRun?: boolean;
  targets?: string[];
  results: FleetResult[];
  /** 没选中的和原因（点名了但越界、条件不符、调用方自己）：预演、真执行都记，全被排除也留得下痕 */
  excluded?: Excluded[];
  /** agent 名 → 项目 id（大总管和没归属的不在里面）；目标和没选中的都按它归到项目 */
  projectOf: Map<string, string>;
  /** 一个都归不到项目时 note 写到这里（PM 调用方管的项目）；空 = 只进 bridge 日志 */
  fallbackProjects?: readonly string[];
}

interface Row { agent: string; log: string; note: string }

function describe(a: FleetAction): string {
  if (a.kind === "text") return `${ACTION_LABEL.text}「${(a.text ?? "").slice(0, 80)}${(a.text ?? "").length > 80 ? "…" : ""}」`;
  return ACTION_LABEL[a.kind];
}

/** 每个 agent 一行：真执行按结果，预演按「会执行」，没选中的带原因 */
function rows(x: AuditInput): { picked: Row[]; skipped: Row[] } {
  const picked = x.dryRun
    ? (x.targets ?? []).map((t) => ({ agent: bareName(t), log: "dry-run — 会执行，没发键", note: `${bareName(t)} 会执行` }))
    : x.results.map((r) => ({
      agent: bareName(r.agent), log: `${r.outcome}${r.detail ? ` — ${r.detail}` : ""}`, note: `${bareName(r.agent)} ${outcomeLabel(r.outcome)}${r.detail ? `（${r.detail}）` : ""}`,
    }));
  const skipped = (x.excluded ?? []).map((e) => ({ agent: e.name, log: `excluded — ${e.reason}`, note: `${e.name} 未选中（${e.reason}）` }));
  return { picked, skipped };
}

function auditLines(x: AuditInput): string[] {
  const when = new Date(x.at).toISOString();
  const { picked, skipped } = rows(x);
  const what = x.dryRun ? `预演 ${describe(x.action)}（没发键）` : describe(x.action);
  return [
    `🛰 [fleet] ${x.runId} ${when} ${x.actor} via ${x.via}：${what} → ${picked.length} 个 agent`,
    ...[...picked, ...skipped].map((r) => `🛰 [fleet] ${x.runId}   ${r.agent}: ${r.log}`),
  ];
}

/** 项目 → 那一组的 note 正文 */
export function ledgerNotes(x: AuditInput): Map<string, string> {
  const { picked, skipped } = rows(x);
  const groups = new Map<string, { picked: Row[]; skipped: Row[] }>();
  const add = (r: Row, k: "picked" | "skipped", p: string | undefined) => {
    if (!p) return;
    const g = groups.get(p) ?? { picked: [], skipped: [] };
    g[k].push(r);
    groups.set(p, g);
  };
  for (const r of picked) add(r, "picked", x.projectOf.get(r.agent));
  for (const r of skipped) add(r, "skipped", x.projectOf.get(r.agent));
  // 一个都归不到项目（点名了不存在的、只剩没归属的）：记到调用方管的项目，别让这次调用在台账上无影无踪
  if (!groups.size) for (const p of x.fallbackProjects ?? []) groups.set(p, { picked, skipped });
  const when = new Date(x.at).toLocaleString("zh-CN", { hour12: false });
  const verb = x.dryRun ? "预演（没发键）" : "执行";
  const out = new Map<string, string>();
  for (const [p, g] of groups) {
    const lines = [...g.picked, ...g.skipped].map((r) => r.note);
    const head = g.picked.length ? `${g.picked.length} 个 agent` : "没有选中任何 agent";
    out.set(p, `批量管理 ${x.runId}：${x.actor}（${x.via}）${when} ${verb}「${describe(x.action)}」，${head}${lines.length ? `：${lines.join("；")}` : ""}`);
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

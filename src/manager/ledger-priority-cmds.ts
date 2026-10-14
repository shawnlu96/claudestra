import { resolveFeature } from "../lib/ledger-feature.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { priorityHistory, readPriority, readPriorityModes, readPriorityOrder } from "../lib/ledger-priority-read.js";
import { setPriority, setPriorityMode, setPriorityOrder } from "../lib/ledger-priority-write.js";
import { PRIORITY_BANDS, type PriorityBand, type PriorityContext, type PriorityEvidence,
  type PriorityMechanism, type PriorityMode, type PriorityTarget } from "../lib/ledger-priority-types.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const EVIDENCE = ["owner-words", "owner-at", "source", "rev", "dedup", "project"];
export const PRIORITY_READ_COMMANDS = ["priority-show", "priority-history"];

function target(c: LedgerCli): PriorityTarget {
  const [kind, raw, nodeKey] = c.p.pos.slice(1);
  if (!raw || !["feature", "task", "node"].includes(kind) || c.p.pos.length !== (kind === "node" ? 4 : 3)) {
    throw new LedgerError("invalid", "目标格式：feature <id> / task <id> / node <feature> <nodeKey>");
  }
  if (kind === "task") return { kind, id: raw };
  const feature = resolveFeature(c.db, raw, storedOrigin(c.db));
  if (feature.project !== c.project()) throw new LedgerError("not_found", "本项目没有该 feature");
  return kind === "feature" ? { kind, id: feature.id } : { kind: "node", id: feature.id, nodeKey };
}

function context(c: LedgerCli): PriorityContext {
  if (c.deps.actor !== "owner" && c.deps.actorProject !== c.project()) throw new LedgerError("forbidden", "PM 只能登记自己所属项目");
  return { ...c.ctx(), project: c.project(), dedupKey: c.need("dedup") };
}

function numeric(c: LedgerCli, name: string): number {
  const value = c.need(name);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new LedgerError("invalid", `--${name} 须为安全非负整数`);
  return Number(value);
}

function evidence(c: LedgerCli): PriorityEvidence {
  return { ownerWords: c.need("owner-words"), ownerAt: numeric(c, "owner-at"), sourceRef: c.need("source") };
}

function band(c: LedgerCli, raw = c.need("band")): PriorityBand {
  if (!PRIORITY_BANDS.includes(raw as PriorityBand)) throw new LedgerError("invalid", "档位只能是 now / next / later");
  return raw as PriorityBand;
}

function set(c: LedgerCli, clear: boolean) {
  const result = setPriority(c.db, context(c), { target: target(c), rev: numeric(c, "rev"),
    band: clear ? null : band(c), evidence: evidence(c) });
  return { ok: true, priority: result.row, event: result.event, duplicate: result.duplicate };
}

function order(c: LedgerCli) {
  if (c.p.pos.length !== 2) throw new LedgerError("invalid", "priority-order 要且只要一个档位");
  const queue = c.p.flags.queue ?? "project", selectedBand = band(c, c.p.pos[1]);
  if (c.p.flags.targets === undefined) return { ok: true, order: readPriorityOrder(c.db, c.project(), queue, selectedBand) };
  let targets: unknown;
  try { targets = JSON.parse(c.need("targets")); }
  catch { throw new LedgerError("invalid", "--targets 须为目标 JSON 数组"); } // Invalid user JSON is reported as an input error.
  const result = setPriorityOrder(c.db, context(c), { queue, band: selectedBand,
    targets: targets as PriorityTarget[], rev: numeric(c, "rev"), evidence: evidence(c) });
  return { ok: true, order: result.row, event: result.event, duplicate: result.duplicate };
}

function mode(c: LedgerCli) {
  if (c.p.flags.mode === undefined) {
    if (c.p.pos.length !== 1) throw new LedgerError("invalid", "priority-mode 查询不带位置参数");
    return { ok: true, modes: readPriorityModes(c.db, c.project()) };
  }
  if (c.p.pos.length !== 2) throw new LedgerError("invalid", "priority-mode 修改须指定一个机制");
  const result = setPriorityMode(c.db, context(c), { mechanism: c.p.pos[1] as PriorityMechanism, mode: c.need("mode") as PriorityMode,
    rev: numeric(c, "rev"), evidence: evidence(c) });
  return { ok: true, mode: result.row, event: result.event, duplicate: result.duplicate };
}

export const PRIORITY_CMDS: Record<string, CommandSpec> = {
  "priority-set": { valued: [...EVIDENCE, "band"], bools: [],
    usage: "priority-set feature|task|node <id> [nodeKey] --band now|next|later --rev N --dedup K --owner-words W --owner-at MS --source REF",
    run: (c) => set(c, false) },
  "priority-clear": { valued: EVIDENCE, bools: [],
    usage: "priority-clear feature|task|node <id> [nodeKey] --rev N --dedup K --owner-words W --owner-at MS --source REF", run: (c) => set(c, true) },
  "priority-show": { valued: ["project", "queue"], bools: [], usage: "priority-show feature|task|node <id> [nodeKey] [--queue Q]",
    run: (c) => ({ ok: true, priority: readPriority(c.db, c.project(), target(c), c.p.flags.queue) }) },
  "priority-history": { valued: ["project"], bools: [], usage: "priority-history [feature|task|node <id> [nodeKey]]",
    run: (c) => ({ ok: true, history: priorityHistory(c.db, c.project(), c.p.pos.length > 1 ? target(c) : undefined) }) },
  "priority-order": { valued: [...EVIDENCE, "queue", "targets"], bools: [],
    usage: "priority-order now|next|later [--queue Q --targets JSON --rev N --dedup K --owner-words W --owner-at MS --source REF]", run: order },
  "priority-mode": { valued: [...EVIDENCE, "mode"], bools: [],
    usage: "priority-mode [prioritySort|priorityNowStart|priorityStall|priorityPanel --mode off|observe|on --rev N --dedup K --owner-words W --owner-at MS --source REF]",
    run: mode },
};

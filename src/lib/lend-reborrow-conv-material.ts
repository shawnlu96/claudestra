/**
 * CVREBOR1: the CONV-frozen history (every round's report, fix diff summary and probe) is a real file whose digest was recorded in the
 * materials event when it was frozen. Preparation and the canonical CAS both prove the file against that digest, and the order carries
 * exactly those bytes — a path in the materials event, or a digest computed only at recovery time, proves nothing.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { FIX_STRATEGY_RULE } from "./fix-strategy.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";

export interface ConvMaterial { path: string; sha256: string; bytes: number }

const refuse = (message: string): never => { throw new LedgerError("conflict", `接回写租约：${message}`); };
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function readFrozen(path: string): Buffer {
  let bytes: Buffer | null = null;
  try { if (lstatSync(path).isFile()) bytes = readFileSync(path); } catch { /* missing / unreadable is the refusal right below, never a fallback */ }
  return bytes ?? refuse("冻结的 CONV 材料文件缺失、不是普通文件或失读");
}

/**
 * The materials event must name the file materialFor wrote for this exact intent (fix-strategy-runtime.ts) and carry the digest of the
 * bytes frozen then; the current file must match it. An event without a digest (frozen before it was recorded) is refused, never
 * degraded to a header check — otherwise a file whose history was trimmed behind a valid header would pass.
 */
export function frozenConvMaterial(materials: LedgerEvent, taskId: string, intentEventSeq: unknown): ConvMaterial {
  const { material: path, sha256, bytes: size } = materials.data;
  if (typeof path !== "string" || !isAbsolute(path) || basename(path) !== `${taskId}-fix-materials-${String(intentEventSeq)}.md`) {
    refuse("CONV 材料事件没有指向本意图的冻结文件");
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || (size as number) <= 0) {
    refuse("CONV 材料事件缺冻结时的摘要");
  }
  const bytes = readFrozen(path as string);
  if (sha(bytes) !== sha256 || bytes.length !== size) refuse("冻结的 CONV 材料和冻结时的摘要不符");
  if (!bytes.toString("utf8").startsWith(FIX_STRATEGY_RULE)) refuse("冻结的 CONV 材料不是收敛材料格式");
  return { path: path as string, sha256: sha256 as string, bytes: size as number };
}

/** Historical heads get the 12-char refs the remote CONV order uses; the reviewed head stays full for the provider's checks. */
function shortRefs(db: Database, task: LedgerTask, text: string): string {
  for (const e of listEvents(db, { project: task.project, target: task.id })) {
    const h = e.kind === "deliver" ? e.data.headSHA : e.kind === "review" ? e.data.head : null;
    if (typeof h === "string" && h !== task.headSHA && /^[0-9a-f]{40}$/.test(h)) text = text.split(h).join(h.slice(0, 12));
  }
  return text;
}

/** Inside the write transaction: the bytes appended to the order spec are read once more and must be the proven material. */
export function convOrderSpec(db: Database, task: LedgerTask, spec: string, m: ConvMaterial): string {
  const bytes = readFrozen(m.path);
  if (sha(bytes) !== m.sha256 || bytes.length !== m.bytes) refuse("冻结的 CONV 材料在核验后被改动");
  return `${spec}\n\n## CONV 冻结材料（sha256 前 12 位 ${m.sha256.slice(0, 12)}，${m.bytes} 字节）\n\n${shortRefs(db, task, bytes.toString("utf8"))}`;
}

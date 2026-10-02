import { DAG_REASON_KINDS, type DagReasonKind } from "./ledger-feature-schema.js";
import { LedgerError } from "./ledger-store.js";
const REASON_MAX = 2000;

export function reasonOf(kind: string, text: string): { reasonKind: DagReasonKind; reasonText: string } {
  if (!DAG_REASON_KINDS.slice(1).includes(kind as DagReasonKind)) throw new LedgerError("invalid", `--reason-kind 只能是 ${DAG_REASON_KINDS.slice(1).join(" / ")}`);
  const t = String(text ?? "").trim();
  if (!t) throw new LedgerError("invalid", "重写要带 --reason（原因原文：owner 原话或审查结论）");
  if ([...t].length > REASON_MAX) throw new LedgerError("invalid", `--reason 不超过 ${REASON_MAX} 字`);
  return { reasonKind: kind as DagReasonKind, reasonText: t };
}

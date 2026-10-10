/** Deterministic fitting of already-gated convergence inputs. Current findings, reports and unrelated inputs remain intact. */
import { WIRE_MAX_BYTES, type OrderWire } from "./order-wire.js";
import { chunkInput } from "./order-wire-chunks.js";
import { fitHistory, type FitReport, type FitDigest } from "./order-wire-fit-history.js";
import { redactOrderForPeer } from "./order-wire-render.js";

export const orderWireBytes = (wire: OrderWire): number => Buffer.byteLength(JSON.stringify(wire));
const LABEL = "历轮报告、修复diff摘要、复现probe";
const HEADER = /^历轮报告、修复diff摘要、复现probe(?:\(第 (\d+)\/(\d+) 段\))?:\n/;
type FitStage = "original" | "history" | "diff" | "probe";
export interface WireFit { ok: boolean; order: OrderWire; bytes: number; limit: number; stage: FitStage;
  measurements: { stage: FitStage; bytes: number }[]; digests: FitDigest[] }

/** Only consecutive complete chunks of the production history label are reassembled. Unknown input forms stay whole. */
function transform(wire: OrderWire, edit: (s: string) => string): OrderWire {
  const inputs: string[] = [];
  for (let i = 0; i < wire.inputs.length; i++) {
    const head = HEADER.exec(wire.inputs[i]);
    if (!head || (head[1] && head[1] !== "1")) { inputs.push(wire.inputs[i]); continue; }
    const total = Number(head[2] ?? 1), parts: string[] = [];
    for (let j = 0; j < total; j++) {
      const part = wire.inputs[i + j], h = part && HEADER.exec(part);
      if (!h || (total > 1 && (Number(h[1]) !== j + 1 || Number(h[2]) !== total))) break;
      parts.push(part.slice(h[0].length));
    }
    if (parts.length !== total) { inputs.push(wire.inputs[i]); continue; }
    const text = parts.join(""), changed = edit(text);
    inputs.push(...(changed === text ? wire.inputs.slice(i, i + total)
      : redactOrderForPeer({ ...wire, inputs: chunkInput(LABEL, changed) }, wire.head).order.inputs));
    i += total - 1;
  }
  return { ...wire, inputs };
}

export function fitOrderWire(wire: OrderWire, reports: readonly FitReport[], heads: ReadonlySet<string>): WireFit {
  redactOrderForPeer(wire, wire.head);
  transform(wire, (text) => {
    // Scan reassembled history before any lossy edit, including secrets that span a chunk boundary.
    redactOrderForPeer({ ...wire, inputs: [text] }, wire.head);
    return text;
  });
  let order = wire;
  const measurements = [{ stage: "original" as FitStage, bytes: orderWireBytes(wire) }], digests: FitDigest[] = [];
  const result = (stage: FitStage): WireFit => ({ ok: orderWireBytes(order) <= WIRE_MAX_BYTES,
    order, bytes: orderWireBytes(order), limit: WIRE_MAX_BYTES, stage, measurements, digests });
  if (result("original").ok) return result("original");
  for (const stage of ["history", "diff", "probe"] as const) {
    order = transform(order, (s) => {
      const changed = fitHistory(s, wire, reports, heads, stage);
      digests.push(...changed.digests);
      return changed.text;
    });
    measurements.push({ stage, bytes: orderWireBytes(order) });
    if (result(stage).ok) return result(stage);
  }
  return result("probe");
}

/**
 * Long foreign text (a spec, a review report) split into wire inputs of at most WIRE_LIMITS.input bytes each, so a 20–26K spec
 * still fits an order without raising the protocol caps both sides check. Split on line ends, each line keeping its own "\n":
 * the parts, headers removed, concatenate back to the text byte for byte. Nothing is ever cut — a line too long for one input,
 * or more parts than WIRE_LIMITS.items, refuses the order. tests/lend-order-chunks.test.ts.
 */
import { LedgerError } from "./ledger-store.js";
import { WIRE_LIMITS } from "./order-wire.js";

const bytes = (s: string): number => Buffer.byteLength(s);
/** The peer gate measures each input after folding (NFKC) and redaction, which can grow it; parts leave this much headroom under the cap. */
export const CHUNK_HEADROOM = 1024;

/**
 * One part keeps today's exact input (`<label>：\n<text>`, judged against the full cap); more parts are headed `<label>（第 i/n 段）：\n`
 * and each, header included, stays within cap − headroom.
 */
export function chunkInput(label: string, text: string, cap: number = WIRE_LIMITS.input, headroom: number = CHUNK_HEADROOM): string[] {
  const whole = `${label}：\n${text}`;
  if (bytes(whole) <= cap) return [whole];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const head = (i: number, n: number) => `${label}（第 ${i}/${n} 段）：\n`;
  // The header grows with n's digits, so pack for a guessed n and repack until the count it yields fits that header.
  for (let n = 2; ; ) {
    const room = cap - headroom - bytes(head(n, n));
    const parts: string[] = [];
    let cur = "";
    let used = 0;
    for (const line of lines) {
      const size = bytes(line);
      if (size > room) throw new LedgerError("invalid", `${label}有一行 ${size} 字节，一段装不下（分段时每段上限 ${cap - headroom} 字节），不截断、拒绝出单`);
      if (cur && used + size > room) { parts.push(cur); cur = ""; used = 0; }
      cur += line;
      used += size;
    }
    if (cur) parts.push(cur);
    if (parts.length <= n) return parts.map((p, i) => head(i + 1, parts.length) + p);
    n = parts.length;
  }
}

type InputSources = readonly (readonly [label: string, text: string])[];
/** How an order builder turns its sources into inputs: chunkInputs for the wire, wholeInputs for the peer gate's scan. */
export type InputSplit = (sources: InputSources) => string[];

/**
 * One unsplit input per source. The peer gate scans each input on its own, so a key wrapped across a part boundary would slip
 * past it; offerLendCore gates this whole form too before the split one goes out (tests/lend-order-chunks.test.ts).
 */
export const wholeInputs: InputSplit = (sources) => sources.map(([label, text]) => `${label}：\n${text}`);

/** Every input of one order, in order; more than WIRE_LIMITS.items in total refuses rather than dropping the tail. */
export const chunkInputs: InputSplit = (sources) => {
  const inputs = sources.flatMap(([label, text]) => chunkInput(label, text));
  if (inputs.length > WIRE_LIMITS.items) throw new LedgerError("invalid", `规格分段后超过 ${WIRE_LIMITS.items} 段（共 ${inputs.length} 段），不截断、拒绝出单`);
  return inputs;
};

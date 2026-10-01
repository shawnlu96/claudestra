/**
 * Long foreign text (a spec, a review report) split into wire inputs of at most WIRE_LIMITS.input bytes each, so a 20–26K spec
 * still fits an order without raising the protocol caps both sides check. Split on line ends, each line keeping its own "\n":
 * the parts, headers removed, concatenate back to the text byte for byte. Nothing is ever cut — a line too long for one input,
 * or more parts than WIRE_LIMITS.items, refuses the order. tests/lend-order-chunks.test.ts.
 */
import { LedgerError } from "./ledger-store.js";
import { WIRE_LIMITS } from "./order-wire.js";

const bytes = (s: string): number => Buffer.byteLength(s);

/** One part keeps today's exact input (`<label>：\n<text>`); more parts are headed `<label>（第 i/n 段）：\n`, header counted in the cap. */
export function chunkInput(label: string, text: string, cap: number = WIRE_LIMITS.input): string[] {
  const whole = `${label}：\n${text}`;
  if (bytes(whole) <= cap) return [whole];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const head = (i: number, n: number) => `${label}（第 ${i}/${n} 段）：\n`;
  // The header grows with n's digits, so pack for a guessed n and repack until the count it yields fits that header.
  for (let n = 2; ; ) {
    const room = cap - bytes(head(n, n));
    const parts: string[] = [];
    let cur = "";
    let used = 0;
    for (const line of lines) {
      const size = bytes(line);
      if (size > room) throw new LedgerError("invalid", `${label}有一行 ${size} 字节，一段装不下（每段上限 ${cap} 字节），不截断、拒绝出单`);
      if (cur && used + size > room) { parts.push(cur); cur = ""; used = 0; }
      cur += line;
      used += size;
    }
    if (cur) parts.push(cur);
    if (parts.length <= n) return parts.map((p, i) => head(i + 1, parts.length) + p);
    n = parts.length;
  }
}

/** Every input of one order, in order; more than WIRE_LIMITS.items in total refuses rather than dropping the tail. */
export function chunkInputs(sources: readonly (readonly [label: string, text: string])[]): string[] {
  const inputs = sources.flatMap(([label, text]) => chunkInput(label, text));
  if (inputs.length > WIRE_LIMITS.items) throw new LedgerError("invalid", `规格分段后超过 ${WIRE_LIMITS.items} 段（共 ${inputs.length} 段），不截断、拒绝出单`);
  return inputs;
}

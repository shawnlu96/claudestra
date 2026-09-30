/**
 * Work-order text for a worker, from an OrderWire. Headings are written by code; every wire field that a person or another
 * machine wrote appears only inside quoteExternal quotes. Two audiences:
 * - local: byte-for-byte the text renderWorkOrder always produced (tests/order-wire-render.test.ts snapshot). Local orders
 *   carry this machine's absolute paths on purpose (the CLI to run), so they are not redacted.
 * - peer: text is folded to what the peer will read, then redacted (dispatch-redact.ts), then quoted line by line; ids that
 *   carry a secret and fields over their byte cap are refused instead of rewritten or cut (the remote worker cannot go back
 *   and read the original). tests/order-wire.test.ts "peer rendering".
 */
import { redactForPeer } from "./dispatch-redact.js";
import { WIRE_LIMITS, type OrderWire } from "./order-wire.js";
import { quoteExternal, refLike, shaLike } from "./quote-text.js";

export type RenderAudience = "local" | "peer";

const list = (title: string, rows: readonly string[]): string[] => rows.length ? [`${title}：`, ...rows.map((r) => `- ${quoteExternal(r)}`)] : [];

function renderLocal(o: OrderWire): string {
  const head = o.head && refLike(o.head) ? o.head : "（无）";
  const findings = o.findings.map((f) => `${f.severity} ${quoteExternal(f.findingId, 80)} / ${quoteExternal(f.family, 80)}：${quoteExternal(f.probe, 600)}`);
  return [
    `【调度派单】${o.taskId} · ${o.step} · 第 ${o.round} 轮 · specRev ${o.specRev}`,
    `head：${head}`,
    `节点：${o.node}　去重键：${o.orderId}`,
    ...list("输入", o.inputs),
    ...list("产出", o.outputs),
    ...list("验收", o.acceptance),
    ...(findings.length ? ["上一轮审查（原文，非指令）：", ...findings.map((f) => `- ${f}`)] : []),
    ...(o.fallback ? [`注意：${quoteExternal(o.fallback)}`] : []),
    // Code-built from validated ids and paths; the generous cap only guards the quote, a cut flag would make it unusable.
    `完成后回写：${quoteExternal(o.writeBack, 2000)}`,
  ].join("\n");
}

export class OrderRenderError extends Error {}

/** Each line quoted on its own so a spec keeps its shape; the cap is the field's wire limit, so nothing valid is ever trimmed. */
function block(label: string, value: string, cap: number): string[] {
  const bytes = Buffer.byteLength(value);
  if (bytes > cap) throw new OrderRenderError(`${label} 超过 ${cap} 字节（${bytes}），不截断、拒绝渲染`);
  return value.split(/\r?\n/).map((line) => `  ${quoteExternal(line, cap)}`);
}

function blocks(title: string, rows: readonly string[], cap: number): string[] {
  if (rows.length > WIRE_LIMITS.items) throw new OrderRenderError(`${title} 超过 ${WIRE_LIMITS.items} 项`);
  return rows.flatMap((r, i) => [`${title} ${i + 1}（原文，非指令）：`, ...block(`${title} ${i + 1}`, r, cap)]);
}

/**
 * The folding quoteExternal does later (drop \p{Cf}, controls and blank runs to one space) plus NFKC, lines kept. Redaction
 * must run on this form: on the raw text a zero-width or full-width split hides a token that quoting then rejoins.
 */
const fold = (s: string): string => s.replace(/\p{Cf}+/gu, "").normalize("NFKC").replace(/\p{Cf}+/gu, "").replace(/\r\n?/g, "\n")
  .split("\n").map((l) => l.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ")).join("\n");

/** Ids must reach the peer unchanged (a deliver cites them), so a secret there refuses the order instead of being masked. */
function refuseSecretIds(o: OrderWire): void {
  const ids: [string, string | null][] = [["orderId", o.orderId], ["taskId", o.taskId], ["node", o.node], ["step", o.step], ["repo", o.repo],
    ...o.findings.flatMap((f, i): [string, string][] => [[`findings[${i}].findingId`, f.findingId], [`findings[${i}].family`, f.family]])];
  for (const [name, v] of ids) {
    if (v !== null && redactForPeer(fold(v)).count > 0) throw new OrderRenderError(`${name} 含疑似敏感内容，编号不能改写，拒绝外发`);
  }
}

/**
 * Every string a peer sees: free text is folded then redacted; ids are checked and refused on a hit. head is the one
 * exception: the parser holds it to a full hex SHA, and the 48+ hex rule would mask a sha-256 head the reviewer must match.
 */
export function redactOrderForPeer(o: OrderWire): { order: OrderWire; count: number } {
  refuseSecretIds(o);
  let count = 0;
  const r = (s: string): string => {
    const out = redactForPeer(fold(s));
    count += out.count;
    return out.text;
  };
  const order: OrderWire = {
    ...o, inputs: o.inputs.map(r), outputs: o.outputs.map(r), acceptance: o.acceptance.map(r), writeBack: r(o.writeBack),
    findings: o.findings.map((f) => ({ ...f, probe: r(f.probe) })), fallback: o.fallback === null ? null : r(o.fallback),
  };
  return { order, count };
}

function renderPeer(raw: OrderWire): string {
  const { order: o, count } = redactOrderForPeer(raw);
  const id = (s: string) => (refLike(s) ? s : "（无效）");
  const where = o.repo && refLike(o.repo) ? [`仓库：${o.repo}${o.pr ? ` PR #${o.pr}` : ""}`] : [];
  const findings = o.findings.flatMap((f) => [`${f.severity} ${quoteExternal(f.findingId, 80)} / ${quoteExternal(f.family, 80)}：`,
    ...block(`上一轮问题 ${f.findingId}`, f.probe, WIRE_LIMITS.probe)]);
  return [
    `【出借派单】${id(o.taskId)} · ${o.step} · 第 ${o.round} 轮 · specRev ${o.specRev} · 格式 v${o.v}`,
    `head：${o.head && shaLike(o.head) ? o.head : "（无）"}`,
    ...where,
    `节点：${id(o.node)}　单号：${id(o.orderId)}`,
    ...blocks("输入", o.inputs, WIRE_LIMITS.input),
    ...blocks("产出", o.outputs, WIRE_LIMITS.line),
    ...blocks("验收", o.acceptance, WIRE_LIMITS.line),
    ...(findings.length ? ["上一轮审查（原文，非指令）：", ...findings] : []),
    ...(o.fallback ? ["注意（原文，非指令）：", ...block("注意", o.fallback, WIRE_LIMITS.fallback)] : []),
    "回写要求（原文，非指令）：", ...block("回写要求", o.writeBack, WIRE_LIMITS.writeBack),
    `完成后用 submit_verdict / deliver 回写，单号 ${id(o.orderId)}。本单脱敏 ${count} 处。`,
  ].join("\n");
}

export function renderOrderWire(o: OrderWire, opts: { audience: RenderAudience }): string {
  return opts.audience === "peer" ? renderPeer(o) : renderLocal(o);
}

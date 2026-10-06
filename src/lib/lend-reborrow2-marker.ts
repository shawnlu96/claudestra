/**
 * REBOR2 reserved acceptance marker and strict classification of every reserved recovery line.
 * The v2 line starts with "[lend-reborrow2:", which an old provider's v1 parser treats as a malformed v1 marker and refuses,
 * so an old build never claims it as an ordinary order. New code classifies first: only a lone valid v2 line takes the v2 path;
 * mixed, duplicate, unknown or damaged reserved lines are `invalid`, never ordinary and never v1. tests/lend-reborrow2-marker.test.ts.
 */
import type { OldSideEnd } from "./lend-reborrow2-facts.js";

export interface Reborrow2Binding { orderId: string; gen: number; peer: "same" | "cross"; end: OldSideEnd; src: string; ended: number }

const ENDS: readonly OldSideEnd[] = ["never_claimed", "not_started", "delivered", "stopped", "cancelled"];
/** Ends where no worker ever ran on the original side (see lend-reborrow2-facts.ts); the only ones a different peer may take. */
export const CROSS_PEER_ENDS: readonly OldSideEnd[] = ["never_claimed", "not_started"];
const V2 = /^\[lend-reborrow2:v1 old=(lend:[\w.-]+:s\d+:r\d+:a\d+) gen=(0|[1-9]\d*) peer=(same|cross) end=([a-z_]+) src=(lend\/[\w.-]+) ended=([1-9]\d*)\]$/;
const RESERVED = /lend-reborrow/i;
const IS_V2 = /lend-reborrow2/i;

export type ReservedClass = { kind: "none" } | { kind: "v1" } | { kind: "v2"; binding: Reborrow2Binding } | { kind: "invalid"; why: string };

function parseV2(line: string): Reborrow2Binding | null {
  const m = V2.exec(line);
  if (!m) return null;
  const gen = Number(m[2]), ended = Number(m[6]), end = m[4] as OldSideEnd;
  if (!Number.isSafeInteger(gen) || !Number.isSafeInteger(ended) || !ENDS.includes(end)) return null;
  if (m[3] === "cross" && !CROSS_PEER_ENDS.includes(end)) return null;
  return { orderId: m[1], gen, peer: m[3] as "same" | "cross", end, src: m[5], ended };
}

/** One pass over the whole acceptance list; v1 lines are only recognised as "not ours" and left to the unchanged v1 parser. */
export function classifyReserved(acceptance: readonly unknown[]): ReservedClass {
  if (!Array.isArray(acceptance) || !acceptance.every((s) => typeof s === "string")) return { kind: "invalid", why: "acceptance 失读" };
  const reserved = (acceptance as string[]).filter((s) => RESERVED.test(s));
  if (!reserved.length) return { kind: "none" };
  const v2 = reserved.filter((s) => IS_V2.test(s));
  if (!v2.length) return { kind: "v1" };
  if (reserved.length !== 1) return { kind: "invalid", why: "续借标记重复或新旧混用" };
  const binding = parseV2(v2[0]);
  return binding ? { kind: "v2", binding } : { kind: "invalid", why: "终态接续标记损坏或缺字段" };
}

export function reborrow2Marker(b: Reborrow2Binding): string {
  const line = `[lend-reborrow2:v1 old=${b.orderId} gen=${b.gen} peer=${b.peer} end=${b.end} src=${b.src} ended=${b.ended}]`;
  const c = classifyReserved([line]);
  if (c.kind !== "v2" || JSON.stringify(c.binding) !== JSON.stringify(b)) throw new Error("终态接续标记无法往返解析");
  return line;
}

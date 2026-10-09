import type { AskRow, WireMatch } from "../lib/ask-options.js";
import { isRuntimeAsk, type Ask, type NewAsk } from "../lib/ledger-asks.js";
import { id, object, positive, scope, literal, v2ObjectDigest, type V2Ask } from "../lib/shared-ledger-contract-v2.js";

const parseMapping = object({ ...scope, centerAskId: id, centerFeatureId: id, localFeatureId: id,
  epoch: positive, displayOnly: literal(true), authoritative: literal(false) });
export type SharedAskMapping = ReturnType<typeof parseMapping>;

/** A mapping never contains an approval. Malformed mappings must fail closed instead of becoming local asks. */
export function sharedAskMapping(a: Ask): SharedAskMapping | null {
  if (isRuntimeAsk(a) || a.kind === "assigned") return null;
  return Object.hasOwn(a.extra, "sharedAsk") ? parseMapping(a.extra.sharedAsk) : null;
}

export const sharedOptionId = (wire: string): string => `option_${v2ObjectDigest(wire)}`;

/** Keep the original wires in the message mapping; the center gets stable, contract-valid option identifiers. */
export function sharedAskOptions(input: NewAsk): V2Ask["options"] {
  const options = (input.options ?? []) as AskRow[];
  return options.flatMap((row) => row.type === "buttons"
    ? row.buttons.map((b) => ({ id: sharedOptionId(`[button:${b.id}]`), label: b.label }))
    : row.options.map((o) => ({ id: sharedOptionId(`[select:${row.id}:${o.value}]`), label: o.label })));
}

export function sharedAnswerValue(a: Ask, picks: WireMatch[], text: string): V2Ask["answer"] {
  if (picks.length === 1 && sharedAskOptions(a).some((o) => o.id === sharedOptionId(picks[0].wire))) {
    return { kind: "option", optionId: sharedOptionId(picks[0].wire) };
  }
  return { kind: "text", text: [...picks.map((p) => p.wire), text].filter(Boolean).join("\n") };
}

/** This view is returned from a live center read. Persisting it in asks.answer would recreate local authority. */
export function sharedAskView(a: Ask, center: V2Ask): Ask {
  const answer = center.answer;
  const optionId = answer?.kind === "option" ? answer.optionId : null;
  return { ...a, state: center.state, expiresAt: center.expiresAt, updatedAt: center.answeredAt ?? center.createdAt,
    answer: center.answer ? { choices: center.answer.kind === "option"
      ? sharedWires(a).filter((w) => sharedOptionId(w.wire) === optionId).map((w) => w.wire) : [],
    labels: center.answer.kind === "option" ? center.options.filter((o) => o.id === optionId).map((o) => o.label) : [],
    text: center.answer.kind === "text" ? center.answer.text : "", principal: center.answeredBy!, via: "web_card", at: center.answeredAt! } : null };
}

function sharedWires(a: Ask): { wire: string }[] {
  return (a.options as AskRow[]).flatMap((row) => row.type === "buttons"
    ? row.buttons.map((b) => ({ wire: `[button:${b.id}]` }))
    : row.options.map((o) => ({ wire: `[select:${row.id}:${o.value}]` })));
}

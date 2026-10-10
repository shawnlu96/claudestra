import { expect, test } from "bun:test";
import { openAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { parseAsk } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { sharedAskMapping, sharedAskOptions, sharedAskView, sharedOptionId } from "../src/bridge/shared-ledger-v2-asks-mapping.js";

const mapping = { teamId: "team", projectId: "project", centerAskId: "ask", centerFeatureId: "feature",
  localFeatureId: "local-feature", epoch: 1, displayOnly: true, authoritative: false } as const;

test("mapped center answers are display views, never local approvals", () => {
  const db = openLedger(":memory:");
  try {
    const a = openAsk(db, { project: "project", source: "reply", kind: "decide", title: "Choose",
      options: [{ type: "buttons", buttons: [{ id: "approve", label: "Approve" }] }], extra: { sharedAsk: mapping } });
    const center = parseAsk({ ...V2_DTO_FIXTURES.ask.valid as object, kind: "decide", bind: null,
      options: sharedAskOptions(a), state: "answered", rev: 2, answeredBy: "person", answeredAt: 2000,
      answer: { kind: "option", optionId: sharedOptionId("[button:approve]") }, decision: "acknowledged" });
    const view = sharedAskView(a, center);
    expect(view.state).toBe("answered");
    expect(view.answer?.choices).toEqual(["[button:approve]"]);
    expect(a.answer).toBeNull();
    expect(a.state).toBe("open");
    expect(sharedAskMapping(a)).toEqual(mapping);
    expect(db.query("SELECT count(*) AS n FROM events WHERE kind = 'decision'").get()).toEqual({ n: 0 });
  } finally { closeLedger(":memory:"); }
});

test("runtime/AUQ asks remain local even with a shared-looking extra", () => {
  const db = openLedger(":memory:");
  try {
    for (const source of ["permission", "auq", "codex"] as const) {
      const a = openAsk(db, { project: "project", source, kind: "decide", title: source, extra: { sharedAsk: mapping } });
      expect(sharedAskMapping(a)).toBeNull();
    }
  } finally { closeLedger(":memory:"); }
});

test("malformed center mappings cannot silently become local asks", () => {
  const db = openLedger(":memory:");
  try {
    const a = openAsk(db, { project: "project", source: "reply", kind: "decide", title: "Choose", extra: { sharedAsk: { ...mapping, authoritative: true } } });
    expect(() => sharedAskMapping(a)).toThrow("invalid_field");
  } finally { closeLedger(":memory:"); }
});

test("center expiry is displayed without evaluating the local clock or recording an expiry", () => {
  const db = openLedger(":memory:");
  try {
    const a = openAsk(db, { project: "project", source: "reply", kind: "decide", title: "Choose", expiresAt: 1,
      extra: { sharedAsk: mapping } });
    const open = parseAsk({ ...V2_DTO_FIXTURES.ask.valid as object, kind: "decide", bind: null });
    expect(sharedAskView(a, open).state).toBe("open");
    expect(sharedAskView(a, parseAsk({ ...open, state: "expired", rev: 2 })).state).toBe("expired");
    expect(a.state).toBe("open");
    expect(db.query("SELECT count(*) AS n FROM events WHERE kind = 'ask_expire'").get()).toEqual({ n: 0 });
  } finally { closeLedger(":memory:"); }
});

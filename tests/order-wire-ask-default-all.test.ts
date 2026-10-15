import { expect, test } from "bun:test";
import { askBlockerDefaultRefusal, askScopeExtra, lenientAskFields, parseAskWire } from "../src/lib/order-wire.js";

const base = { v: 1, orderId: "o", question: "q" };

test("risk is a strict whitelist on the local wire", () => {
  for (const risk of ["delete_data", "permission", "security", "schema"]) {
    expect(parseAskWire({ ...base, class: "blocker", default: "d", risk })).toMatchObject({ ok: true, value: { risk } });
  }
  expect(parseAskWire({ ...base, risk: "other" }).ok).toBe(false);
  expect(parseAskWire({ ...base, risk: null }).ok).toBe(false);
});

test("scope asks may carry files without reason; other classes still need both", () => {
  const w = parseAskWire({ ...base, class: "scope", default: "改", files: ["src/lib/a.ts", "src/lib/a.ts"] });
  expect(w).toMatchObject({ ok: true, value: { files: ["src/lib/a.ts"] } });
  if (!w.ok) throw new Error(w.error);
  expect(w.value).not.toHaveProperty("reason");
  expect(askScopeExtra(w.value)).toEqual({ files: ["src/lib/a.ts"] });
  expect(parseAskWire({ ...base, class: "design", default: "x", files: ["src/a.ts"] }).ok).toBe(false);
  expect(parseAskWire({ ...base, class: "scope", default: "x", files: ["src/*.ts"] }).ok).toBe(false);
  expect(askScopeExtra({ files: ["tests/a.test.ts"] })).toEqual({});
});

test("blocker needs a default; lenient fields drop unknown values and cut default", () => {
  expect(askBlockerDefaultRefusal({ class: "blocker" })).toContain("blocker 也要写你打算怎么做");
  expect(askBlockerDefaultRefusal({ class: "blocker", default: "d" })).toBeNull();
  expect(askBlockerDefaultRefusal({ class: "design" })).toBeNull();
  expect(lenientAskFields({ class: "x", risk: 3, default: "  " })).toEqual({});
  expect(lenientAskFields({ class: "scope", risk: "schema", default: `a\u0001${"🙂".repeat(700)}` })).toEqual({ class: "scope", risk: "schema", default: `a${"🙂".repeat(599)}` });
});

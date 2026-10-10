/**
 * CVREBOR1 r2 conv-material: the frozen CONV history is proven against the digest recorded in the materials event when it was frozen,
 * not against a digest computed at recovery time. A legal rule header with trimmed or edited history behind it, or an event frozen
 * before the digest existed, refuses with zero order / lease / business writes over the real `--conv-end --apply` CLI.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { closeLedger, listEvents } from "../src/lib/ledger-store.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { FIX_STRATEGY_RULE } from "../src/lib/fix-strategy.js";
import { resources, db, dbPath, intentId, oldId, conv, snapshot, tamper, convEnd, setup } from "./lend-reborrow-conv-fixture.js";

afterEach(async () => { closeLedger(dbPath); await resources.dispose(); });
const materials = () => listEvents(db, { target: "T1" }).find((e) => e.dedupKey === `scheduler:${intentId}:materials`)!;
const zero = () => {
  const before = snapshot(), r = conv("--apply");
  expect(r).toMatchObject({ ok: false, code: "conflict" });
  expect(snapshot()).toBe(before);
  return String(r.error);
};

describe("frozen CONV material is proven against its freeze-time digest", () => {
  beforeEach(async () => { await setup("codex"); await convEnd(); }, 60_000);

  test("the materials event records sha256 and bytes of the exact frozen file; a matching file signs one successor", () => {
    const m = materials(), bytes = readFileSync(String(m.data.material));
    expect(m.data).toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    const r = conv("--apply");
    expect(r).toMatchObject({ ok: true, supersedes: oldId });
    const o = getLendOrder(db, r.orderId)!;
    // The outbound gate normalises full-width punctuation; the proven digest prefix and size are what must ride the order.
    expect(JSON.stringify(o.wire)).toMatch(new RegExp(`sha256 前 12 位 ${String(m.data.sha256).slice(0, 12)}\\W+${bytes.length} 字节`));
  }, 60_000);

  // Review probe: keep the legal rule header, delete every round after the first "## 第 ", then run the real apply.
  test.each([
    ["history trimmed after the first round heading", (t: string) => t.slice(0, t.indexOf("## 第 "))],
    ["review report text edited", (t: string) => t.replace(/报告原文（[^）]*）：\nreport /, (s) => s.replace("report ", "report (softened) "))],
    ["fix diff summary edited", (t: string) => t.replace("修复 diff 摘要：\ndiff ", "修复 diff 摘要：\ndiff (edited) ")],
    ["reproduction probe edited", (t: string) => t.replace("auth bypass reproduces", "auth bypass fixed")],
  ])("%s behind a legal header refuses", (_name, edit) => {
    const path = String(materials().data.material), text = readFileSync(path, "utf8"), edited = edit(text);
    expect(edited).not.toBe(text);
    expect(edited.startsWith(FIX_STRATEGY_RULE)).toBe(true);
    writeFileSync(path, edited);
    expect(zero()).toContain("摘要不符");
  }, 60_000);

  test("a materials event frozen before the digest was recorded refuses instead of falling back to the header check", () => {
    tamper("UPDATE events SET data = json_remove(data, '$.sha256', '$.bytes') WHERE dedupKey = ?", [`scheduler:${intentId}:materials`]);
    expect(zero()).toContain("缺冻结时的摘要");
  }, 60_000);
});

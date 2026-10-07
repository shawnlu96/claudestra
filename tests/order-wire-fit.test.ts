import { expect, test } from "bun:test";
import { orderWireOf, parseOrderWire, WIRE_MAX_BYTES } from "../src/lib/order-wire.js";
import { fitOrderWire, orderWireBytes } from "../src/lib/order-wire-fit.js";
import { FIT_AUX_BYTES, fitAux, fitDigest, fitReportSummary, type FitReport } from "../src/lib/order-wire-fit-history.js";
import { chunkInputs } from "../src/lib/order-wire-chunks.js";
import { redactOrderForPeer, sanitizeForeign } from "../src/lib/order-wire-render.js";
import { writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const HEAD = "2".repeat(40), OLD = "1".repeat(40), heads = new Set([HEAD, OLD]);
const label = "历轮报告、修复diff摘要、复现probe";
const long = (n: number) => "审查内容和具体证据。\n".repeat(n);
function source(round: number, report: string): FitReport {
  return { report, event: { seq: round * 10, project: "p", target: "T1", kind: "review", actor: "reviewer", text: "review",
    ts: 1, dedupKey: null, data: { round, head: round === 1 ? OLD : HEAD, verdict: "changes", findings: Array.from({ length: 4 }, (_, i) =>
      ({ findingId: `F${i + 1}`, severity: "P1", family: "race", description: `标题${i} ${"说明".repeat(100)}`, probe: "assert race" })) } } };
}
function body(reports: FitReport[], diff = "diff evidence", probe = "probe evidence") {
  return reports.map((r) => `## 第 ${r.event.data.round} 轮 · ${String(r.event.data.head).slice(0, 12)}\n\n` +
    `报告原文(${r.event.data.path ?? "report.md"}):\n${r.report}\n\n修复 diff 摘要:\n${r.event.data.round === 1 ? diff : "current repair diff"}` +
    `\n\n复现 probe:\n${r.event.data.round === 1 ? probe : "current probe evidence"}`).join("\n\n");
}
function wire(reports: FitReport[], diff?: string, probe?: string) {
  return redactOrderForPeer(orderWireOf({ taskId: "T1", specRev: 1, head: HEAD, round: 2, step: "fix", node: "fix", dedupKey: "lend:T1:cv:1",
    inputs: chunkInputs([["规格原文", long(220)], [label, body(reports, diff, probe)]]), outputs: ["commit"], acceptance: ["fix race"], writeBack: "deliver",
    findings: Array.from({ length: 4 }, (_, i) => ({ findingId: `F${i + 1}`, severity: "P1", family: "race", probe: "本轮 finding 全文" })) },
  { repo: "o/r" }), HEAD).order;
}

test("LIFE3 round 2: oversized four-P1 history fits deterministically, preserving current report and findings", () => {
  const reports = [source(1, long(700)), source(2, long(400))], original = wire(reports), before = JSON.stringify(original);
  expect(orderWireBytes(original)).toBeGreaterThan(WIRE_MAX_BYTES);
  expect(parseOrderWire(original).ok).toBe(false);
  const fitted = fitOrderWire(original, reports, heads);
  expect(fitted).toMatchObject({ ok: true, stage: "history" });
  expect(parseOrderWire(fitted.order).ok).toBe(true);
  const text = fitted.order.inputs.map((s) => s.replace(/^历轮报告、修复diff摘要、复现probe(?:\(第 \d+\/\d+ 段\))?:\n/, "")).join("");
  expect(text).toContain(sanitizeForeign(reports[1].report!));
  expect(text).toContain(`原报告全文 sha256 前16位 ${fitDigest(reports[0].report!).slice(0, 16)}`);
  expect(text).toContain("台账事件 seq 10");
  expect(text).toContain("P0 0 / P1 4 / P2 0");
  expect(fitted.order.findings).toEqual(original.findings);
  expect(fitted.order.inputs[0]).toBe(original.inputs[0]);
  expect(JSON.stringify(original)).toBe(before);
  expect(JSON.stringify(fitOrderWire(original, reports, heads))).toBe(JSON.stringify(fitted));
});

test("small orders are byte-for-byte unchanged", () => {
  const original = wire([source(1, "old report"), source(2, "current report")]);
  const fitted = fitOrderWire(original, [], heads);
  expect(fitted).toMatchObject({ ok: true, stage: "original" });
  expect(JSON.stringify(fitted.order)).toBe(JSON.stringify(original));
});

test("history titles are folded and redacted before the 120-character cut", () => {
  const reports = [source(1, long(900)), source(2, "current report")];
  reports[0].event.data.findings = [
    { severity: "P1", title: `${"x".repeat(110)} 192.168.1.100:8080` },
    { severity: "P1", title: `${"y".repeat(108)} alice.smith@example.com` },
    { severity: "P1", title: `${"z".repeat(108)} ａｌｉｃｅ.ｓｍｉｔｈ＠ｅｘａｍｐｌｅ.ｃｏｍ` },
    { severity: "P1", title: `${"w".repeat(110)} 192.168.\u200b1.100:8080` },
  ];
  const original = wire(reports), fitted = fitOrderWire(original, reports, heads);
  expect(fitted).toMatchObject({ ok: true, stage: "history" });
  const text = fitted.order.inputs.join("\n");
  expect(text.includes("192.168")).toBe(false);
  expect(text.includes("alice.smith")).toBe(false);
  expect(text.includes("ａｌｉｃｅ")).toBe(false);
  expect(text).toContain("[已脱敏:");
  expect(JSON.stringify(fitOrderWire(original, reports, heads))).toBe(JSON.stringify(fitted));
});

test("unrepresented same-round reviews do not prevent matching the complete represented report", () => {
  const old = source(1, long(900)), current = source(2, "current report");
  const omitted = source(1, "passing review that is absent from repair history");
  omitted.event.seq = 9;
  omitted.event.data.verdict = "pass";
  omitted.event.data.findings = [];
  const original = wire([old, current]);
  const fitted = fitOrderWire(original, [omitted, old, current], heads);
  expect({ ok: fitted.ok, stage: fitted.stage }).toEqual({ ok: true, stage: "history" });
  expect(fitted.digests).toEqual([{ seq: old.event.seq, kind: "report", sha256: fitDigest(old.report!) }]);
  expect(fitted.order.inputs.join("\n")).toContain("台账事件 seq 10");
  expect(fitted.order.inputs.join("\n")).not.toContain("台账事件 seq 9");
  expect(fitted.order.inputs.join("\n")).toContain(current.report!);
});

test("identical same-round bodies use the represented report path to retain the correct event seq and verdict", () => {
  const old = source(1, long(900)), current = source(2, "current report");
  old.event.data.path = "included.md";
  const omitted = source(1, old.report!);
  omitted.event.seq = 9; omitted.event.data.path = "omitted.md";
  omitted.event.data.verdict = "pass"; omitted.event.data.findings = [];
  const fitted = fitOrderWire(wire([old, current]), [omitted, old, current], heads);
  expect({ ok: fitted.ok, stage: fitted.stage }).toEqual({ ok: true, stage: "history" });
  expect(fitted.digests).toEqual([{ seq: 10, kind: "report", sha256: fitDigest(old.report!) }]);
  expect(fitted.order.inputs.join("\n")).toContain("结论 changes;P0 0 / P1 4 / P2 0");
});

test("the whole-wire cap is inclusive and unchanged, including JSON overhead", () => {
  const original = { ...wire([]), inputs: ["x".repeat(15000), "y".repeat(15000), "z"] };
  original.inputs[2] += "z".repeat(WIRE_MAX_BYTES - orderWireBytes(original));
  expect(orderWireBytes(original)).toBe(WIRE_MAX_BYTES);
  expect(fitOrderWire(original, [], heads).ok).toBe(true);
  original.inputs[2] += "z";
  expect(fitOrderWire(original, [], heads)).toMatchObject({ ok: false, bytes: WIRE_MAX_BYTES + 1 });
});

test("each historical finding title is capped at 120 Unicode characters, with ledger conclusion and severity counts", () => {
  const r = source(1, "original");
  r.event.data.findings = [{ severity: "P0", title: "😀".repeat(140) }, { severity: "P1", title: "race" }, { severity: "P2", title: "naming" }];
  const summary = fitReportSummary(r);
  expect(summary).toContain("结论 changes；P0 1 / P1 1 / P2 1");
  expect(summary).toContain("😀".repeat(120)); expect(summary).not.toContain("😀".repeat(121));
});

test("100 historical finding titles cannot turn an oversized summary into an invalid single input", () => {
  const reports = [source(1, long(900)), source(2, "current report")], original = wire(reports);
  reports[0].event.data.findings = Array.from({ length: 100 }, () => ({ severity: "P1", title: "标题".repeat(60) }));
  const fitted = fitOrderWire(original, reports, heads);
  expect(fitted.ok).toBe(false);
  expect(fitted.bytes).toBeGreaterThan(WIRE_MAX_BYTES);
  expect(fitted.order.inputs.every((s) => Buffer.byteLength(s) <= 16384)).toBe(true);
});

test("auxiliary caps include the marker, retain whole Unicode points, and digest the full text", () => {
  const text = "字😀证据".repeat(1000), cut = fitAux(text);
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(FIT_AUX_BYTES);
  expect(cut).not.toContain("�");
  expect(cut).toContain(`全文 sha256 前16位 ${fitDigest(text).slice(0, 16)}`);
  expect(fitAux("short")).toBe("short");
});

test("history summaries precede diff and probe truncation, with a measurement after each stage", () => {
  const reports = [source(1, long(250)), source(2, long(550))];
  const original = wire(reports, long(600), long(600));
  const omitted = source(1, "unused report"); omitted.event.seq = 9;
  const fitted = fitOrderWire(original, [omitted, ...reports], heads);
  expect({ ok: fitted.ok, stage: fitted.stage, bytes: fitted.bytes }).toMatchObject({ ok: true, stage: "probe" });
  const text = fitted.order.inputs.map((s) => s.replace(/^历轮报告、修复diff摘要、复现probe(?:\(第 \d+\/\d+ 段\))?:\n/, "")).join("");
  expect(text).toContain("第 1 轮摘要");
  expect(text.match(/已截断/g)?.length).toBe(2);
  expect(text).toContain(sanitizeForeign(reports[1].report!));
  expect(parseOrderWire(fitted.order).ok).toBe(true);
});

test("a current-only report that cannot fit remains whole and returns its bytes and final stage", () => {
  const reports = [source(2, long(1400))], original = wire(reports);
  const fitted = fitOrderWire(original, reports, heads);
  expect(fitted).toMatchObject({ ok: false, stage: "probe", limit: WIRE_MAX_BYTES });
  expect(fitted.bytes).toBe(orderWireBytes(fitted.order));
  expect(fitted.order.inputs.map((s) => s.replace(/^历轮报告、修复diff摘要、复现probe(?:\(第 \d+\/\d+ 段\))?:\n/, "")).join("")).toContain(sanitizeForeign(reports[0].report!));
});

test("unverified or missing historical report bodies are never replaced by an invented summary", () => {
  const reports = [source(1, long(900)), source(2, "current report")], original = wire(reports);
  for (const report of [null, "different original report"]) {
    const fitted = fitOrderWire(original, [{ ...reports[0], report }, reports[1]], heads);
    expect(fitted.ok).toBe(false);
    expect(JSON.stringify(fitted.order)).toBe(JSON.stringify(original));
  }
});

test("report delimiters and fake old round headers inside the current report cannot delete its text", () => {
  const old = source(1, long(850));
  const current = source(2, `current preamble\n\n${body([old])}\n\n修复 diff 摘要:\ncurrent tail`);
  const original = wire([current]);
  const fitted = fitOrderWire(original, [old, current], heads);
  expect(fitted.ok).toBe(false);
  expect(JSON.stringify(fitted.order)).toBe(JSON.stringify(original));
});

test("unsafe historical text and unsafe summary titles cannot bypass the original peer gate", () => {
  const reports = [source(1, long(900)), source(2, "current report")], original = wire(reports);
  const unsafe = { ...original, inputs: [...original.inputs, `credential ${"f".repeat(64)}`] };
  expect(() => fitOrderWire(unsafe, reports, heads)).toThrow("拒绝");
  reports[0].event.data.findings = [{ severity: "P1", title: `credential ${"f".repeat(64)}` }];
  expect(() => fitOrderWire(original, reports, heads)).toThrow("拒绝");
  reports[0].event.data.findings = [{ severity: "P1", title: `long title ${"word ".repeat(80)} credential ${"f".repeat(64)}` }];
  expect(() => fitOrderWire(original, reports, heads)).toThrow("拒绝");
});

test("measurement only: ordinary writeOrderWire callers can still exceed the whole-wire cap", () => {
  const f = autoFixture();
  try {
    const task = f.task();
    const base = { orderId: "lend:T1:s1:r0:a0", head: HEAD, branch: "lend/T1", base: "main", spec: "spec\n".repeat(1100),
      report: null, findings: [], repo: "o/r", pr: null };
    const ordinaryFix = writeOrderWire(task, { ...base, step: "fix", report: "report evidence\n".repeat(1550),
      findings: [{ findingId: "F1", severity: "P1", family: "race", probe: "probe\n".repeat(650) }] });
    const ordinaryWrite = writeOrderWire(task, { ...base, step: "write", spec: "spec\n".repeat(5500), restate: "restate\n".repeat(800) });
    for (const order of [ordinaryFix, ordinaryWrite]) {
      expect(orderWireBytes(order)).toBeGreaterThan(WIRE_MAX_BYTES);
      expect(parseOrderWire(order).ok).toBe(false);
    }
  } finally { f.close(); }
});

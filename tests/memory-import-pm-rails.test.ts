import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMemoryImport, planMemoryImport, type ImportVectors } from "../src/lib/memory-import.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { markIntervention, pmRailsScope, workflowModes } from "../src/lib/pm-rails.js";
import type { EventKind } from "../src/lib/ledger-stages.js";

let dir: string, path: string, db: Database;
const ctx = { actor: "agent-pm", now: 1000 };
const row = (extra: Record<string, unknown> = {}) => ({
  kind: "pitfall", title: "事务回调不能 await", symptom: "事务提前提交", rule: "事务内必须同步写",
  files: ["src/lib/widget.ts"], family: "widget-tx", fixable: false, feature: null, task: null,
  sourceNote: "PM 私人记忆导入", visibility: "team", ...extra,
});
const text = [row(), row({ family: "other", title: "分页必须固定排序", files: ["src/lib/page.ts"] })].map((r) => JSON.stringify(r)).join("\n");
const inRails = <T>(run: () => T) => pmRailsScope.run({ cmd: "memory-import", mode: () => "on", modesAtStart: workflowModes(db) }, run);
const strip = (p: ReturnType<typeof planMemoryImport>) => ({ rows: p.rows.map((r) => ({ line: r.line, key: r.key, replay: r.replay, memory: r.memory })), issues: p.issues });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-import-rails-")); path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  db.prepare("INSERT INTO meta(project,key,value) VALUES ('demo','pms',?)").run(JSON.stringify(["agent-pm"]));
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

test("[验收线 1] 介入标记开启时 dry-run clean 的清单正式导入成功，条数一致，事件打标口径与 PM 其他写操作一致", () => {
  const dry = planMemoryImport(db, ctx, "demo", text);
  expect(dry.issues).toEqual([]);
  const writes = dry.rows.filter((r) => !r.replay).length;
  const r = inRails(() => applyMemoryImport(db, ctx, "demo", text));
  expect(r.imported).toHaveLength(writes);
  const events = db.query("SELECT project, target, kind, data FROM events ORDER BY seq").all() as { project: string; target: string; kind: EventKind; data: string }[];
  expect(events.filter((e) => e.kind === "memory").length).toBeGreaterThanOrEqual(writes);
  // Each stored event carries exactly what markIntervention gives under the same scope on the real ledger.
  for (const e of events) {
    const data = JSON.parse(e.data) as Record<string, unknown>;
    const { manual: _m, intervention: _i, ...bare } = data;
    expect(data).toEqual(inRails(() => markIntervention(db, ctx.actor, { ...e, data: bare })));
  }
});

test("[验收线 1] 真实写库那次事务仍在介入作用域里：只有计划阶段退出", () => {
  let seen: unknown[] = [];
  const probe: ImportVectors = { size: 0, get: () => { seen.push(pmRailsScope.getStore()); return undefined; } } as unknown as ImportVectors;
  inRails(() => {
    expect(pmRailsScope.getStore()).toBeDefined();
    planMemoryImport(db, ctx, "demo", text, probe);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === undefined)).toBe(true);
    expect(pmRailsScope.getStore()).toBeDefined();
  });
});

test("[验收线 2] 介入标记开与关两种情况下计划结果（rows / issues）完全一致", () => {
  const dirty = `${text}\n{bad\n${JSON.stringify(row({ feature: "missing", title: "锚点不存在的坑", family: "x", files: ["src/x.ts"] }))}`;
  for (const t of [text, dirty]) {
    const off = planMemoryImport(db, ctx, "demo", t);
    const on = inRails(() => planMemoryImport(db, ctx, "demo", t));
    expect(strip(on)).toEqual(strip(off));
  }
  expect(inRails(() => planMemoryImport(db, ctx, "demo", text)).issues).toEqual([]);
});

test("[验收线 3] 计划阶段的非 LedgerError 带原始类名与首行消息，过脱敏", () => {
  class ProbeFailure extends Error {}
  const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
  const boom: ImportVectors = { size: 1, get: () => { throw new ProbeFailure(`stub exploded ${secret}\nsecond line detail`); } } as unknown as ImportVectors;
  const p = planMemoryImport(db, ctx, "demo", JSON.stringify(row()), boom);
  expect(p.issues).toHaveLength(1);
  const issue = p.issues[0]!;
  expect(issue.kind).toBe("format");
  expect(issue.reason).toContain("ProbeFailure");
  expect(issue.reason).toContain("stub exploded");
  expect(issue.reason).not.toContain("second line");
  expect(issue.reason).not.toContain(secret);
  expect(issue.reason.length).toBeLessThanOrEqual(200);
});

test("[验收线 3] 先脱敏再截断：跨 200 字边界的密钥不漏片段，占位符扩张后总长仍 ≤200", () => {
  const reasonFor = (message: string) => {
    const boom: ImportVectors = { size: 1, get: () => { throw new Error(message); } } as unknown as ImportVectors;
    return planMemoryImport(db, ctx, "demo", JSON.stringify(row()), boom).issues[0]!.reason;
  };
  const key = ["AKIA", "QWERTYUIOPASDFGH"].join("");
  for (let pad = 160; pad <= 200; pad++) {
    const reason = reasonFor(`${"x".repeat(pad)} ${key}`);
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason).not.toContain(key.slice(0, 6));
  }
  for (let pad = 160; pad <= 200; pad++) expect(reasonFor(`${"x".repeat(pad)} a@b.co`).length).toBeLessThanOrEqual(200);
});

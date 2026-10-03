/** 每周卫生清单（pmem-M7 验收线 2）：三条理由各有用例；只出报告，不写 mark / 事件（query_only 连接上照样跑通）。夹具非生产数据。 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { markMemory, recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { hygieneReport, hygieneText, type HygieneMemory } from "../src/lib/memory-hygiene-report.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation, READER_ONLY_SUBS } from "../src/manager/write-commands.js";

const P = "demo", DAY = 86_400_000, NOW = 400 * DAY;
const mem = (id: string, over: Partial<HygieneMemory> = {}): HygieneMemory => ({ id, kind: "pitfall", family: "widget-tx", files: ["src/lib/widget-store.ts"],
  createdAt: NOW - 200 * DAY, title: id, status: "open", disputed: false, ...over });
let seq = 0;
const ev = (target: string, kind: LedgerEvent["kind"], ts: number, data: Record<string, unknown>): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "scheduler", project: P, target, kind, text: "", data, dedupKey: null });
const push = (ts: number, ids: string[]) => ev("A", "scheduler", ts, { op: "memory_retrieve", order: "write", specRev: 1, head: null, memoryIds: ids });
const p1 = (ts: number, family: string) => ev("A", "review", ts, { round: 1, p1: 1,
  findings: [{ findingId: "f", family, severity: "P1", probe: "复现", description: "[验收线 1] 夹具" }] });
const HEAD = ["src/lib/widget-store.ts", "src/lib/gadget-import.ts"];

describe("hygieneReport 三条理由", () => {
  test("90 天没被单子选中 / 文件全没了 / 同 family 60 天没再出 P1；近期推过、近期复发、文件还在的不列", () => {
    const memories = [
      mem("m-stale", { kind: "summary", family: null }),
      mem("m-pushed", { kind: "summary", family: null }),
      mem("m-gone", { kind: "summary", family: null, files: ["src/lib/old.ts", "src/old/*.ts"], createdAt: NOW - DAY }),
      mem("m-quiet", { family: "tx-await", files: ["src/lib/*-import.ts"] }),
      mem("m-loud", { family: "Widget_TX" }),
      mem("m-young", { family: "tx-await", createdAt: NOW - 10 * DAY }),
    ];
    const events = [push(NOW - 30 * DAY, ["m-pushed", "m-loud", "m-quiet"]), push(NOW - 100 * DAY, ["m-stale"]), p1(NOW - 5 * DAY, "widget-tx")];
    const rows = hygieneReport({ memories, events, headFiles: HEAD, now: NOW });
    expect(rows.map((r) => [r.id, r.reasons])).toEqual([
      ["m-gone", ["files_gone"]], ["m-quiet", ["family_quiet_60d"]], ["m-stale", ["not_pushed_90d"]]]);
    expect(rows.find((r) => r.id === "m-stale")!.lastPushedAt).toBe(NOW - 100 * DAY);
  });

  test("没有 HEAD 文件列表不判「文件全没了」；fixed / retracted / superseded 不进清单", () => {
    const gone = mem("m-gone", { kind: "summary", family: null, files: ["src/lib/old.ts"], createdAt: NOW - DAY });
    expect(hygieneReport({ memories: [gone], events: [], headFiles: null, now: NOW })).toEqual([]);
    const dead = (["fixed", "retracted", "superseded"] as const).map((status) => mem(`m-${status}`, { status }));
    expect(hygieneReport({ memories: dead, events: [], headFiles: HEAD, now: NOW })).toEqual([]);
    const live = (["candidate", "fixing"] as const).map((status) => mem(`m-${status}`, { status, disputed: true }));
    expect(hygieneReport({ memories: live, events: [], headFiles: HEAD, now: NOW }).map((r) => r.id)).toEqual(["m-candidate", "m-fixing"]);
  });

  test("清单正文只建议不执行", () => {
    const rows = hygieneReport({ memories: [mem("m1")], events: [], headFiles: null, now: NOW });
    const text = hygieneText(P, rows, false);
    expect(text).toContain("只报告，处置由 PM 决定");
    expect(text).toContain("没拿到 HEAD 文件列表");
    expect(text).toContain("m1 [pitfall · open] m1：90 天没被单子选中；同 family 60 天没再出 P1");
    expect(hygieneText(P, [], true)).toContain("无需处理的记忆");
  });
});

describe("ledger memory-hygiene / memory-metrics：只读", () => {
  let db: Database;
  const PIT: MemoryInput = { project: P, kind: "pitfall", title: "写入没包事务", symptom: "rev 跳号", rule: "写入包事务",
    files: ["src/lib/widget-store.ts"], family: "widget-tx", fixable: true, via: "tool", authorRole: "reviewer", taskId: "A", head: "abc1234", specRev: 1,
    sources: [{ origin: "ab12", originSeq: 1 }] };
  const deps = () => ({ db, actor: "agent-pm", projectIds: [P], now: () => NOW,
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
  const counts = () => ["events", "memories", "memory_marks"].map((t) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);

  beforeEach(() => {
    db = openLedger(":memory:");
    db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    createTask(db, { actor: "owner", now: 1 }, { project: P, id: "A", title: "A", kind: "code" });
    const old = recordMemory(db, { actor: "agent-r", now: NOW - 200 * DAY }, PIT).memory;
    recordMemory(db, { actor: "agent-r", now: NOW - 200 * DAY }, { ...PIT, title: "另一条", family: "tx-await" });
    markMemory(db, { actor: "agent-pm", now: NOW - DAY }, { memoryId: old.id, mark: "retract", reason: "规矩改了" });
  });
  afterEach(() => closeLedger(":memory:"));

  test("卫生清单在 query_only 连接上跑通，库里的事件 / 记忆 / marks 一行不多", async () => {
    const before = counts();
    db.exec("PRAGMA query_only = 1");
    const r = await runLedger(["memory-hygiene", "--project", P], deps());
    expect(r).toMatchObject({ ok: true, project: P });
    expect((r.rows as { id: string; reasons: string[] }[]).map((x) => [x.id, x.reasons])).toEqual([["ab12-m2", ["not_pushed_90d", "family_quiet_60d"]]]);
    expect(String(r.text)).toContain("只报告");
    const m = await runLedger(["memory-metrics", "--project", P, "--since", new Date(0).toISOString()], deps());
    expect(m).toMatchObject({ ok: true, uses: { pushed: 0 }, specs: { recurrenceRate: { threshold: null } } });
    db.exec("PRAGMA query_only = 0");
    expect(counts()).toEqual(before);
  });

  test("两条命令按只读算（认主守卫放行、ledger.ts 给只读连接）；时间参数坏了报错", async () => {
    for (const sub of ["memory-hygiene", "memory-metrics"]) {
      expect(READER_ONLY_SUBS.has(sub)).toBe(true);
      expect(isWriteInvocation("ledger", [sub])).toBe(false);
    }
    expect(await runLedger(["memory-metrics", "--project", P, "--since", "昨天"], deps())).toMatchObject({ ok: false });
  });
});

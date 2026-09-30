/**
 * token 账 · Codex 计入（src/lib/usage-codex.ts + usage-ingest）：去重、切轮、revert 新段、增量幂等、归属、请求模型。
 * fixture 用本机 codex-cli 0.159 rollout 的真实形状：每请求一条 token_usage_record，紧跟一条同数的 token_count；
 * 轮边界 task_started / turn_context 的 turn_id；老版本（0.149）没有 token_usage_record，只有 token_count。
 */
import { describe, test, expect } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { codexThreadOfFile, codexUsage } from "../src/lib/usage-codex.js";
import { ingestUsage } from "../src/lib/usage-ingest.js";
import { turnsFor, usageSummary } from "../src/lib/usage-query.js";
import { openUsageDb } from "../src/lib/usage-store.js";

const NOW = Date.now();
const T = NOW - 2 * 3600_000;
const TH = "01a0f213-c163-7451-97e9-1efc21f9736d";
const SUB = "01a0f300-0000-7000-8000-000000000001";
const REV = "01a0f399-0000-7000-8000-00000000abcd";
const iso = (ms: number) => new Date(ms).toISOString();
const turnUuid = (k: number) => `01a0f214-0000-7000-8000-${String(k).padStart(12, "0")}`;

let ord = 0;
const line = (at: number, type: string, payload: object) => ({ timestamp: iso(at), ordinal: ++ord, type, payload });
const meta = (thread: string, extra: object = {}) =>
  line(T - 1000, "session_meta", { id: thread, session_id: thread, cwd: "/work", source: "vscode", cli_version: "0.159.0", ...extra });
const usage = (input: number, cached: number, output: number, reasoning = 0) =>
  ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });

/** 一轮：task_started → 用户消息 → turn_context → 每个请求一对（token_usage_record + 同数的 token_count）→ task_complete */
function turn(k: number, at: number, text: string, reqs: [number, number, number, number?][], opts: { model?: string; tools?: string[]; total?: { v: number } } = {}) {
  const id = turnUuid(k);
  const out: object[] = [
    line(at, "event_msg", { type: "task_started", turn_id: id, model_context_window: 475000 }),
    line(at + 1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    line(at + 2, "turn_context", { turn_id: id, cwd: "/work", model: opts.model ?? "gpt-6.1-sol", effort: "high" }),
  ];
  for (const [i, name] of (opts.tools ?? []).entries()) out.push(line(at + 3, "response_item", { type: "custom_tool_call", call_id: `call_${k}_${i}`, name }));
  reqs.forEach(([input, cached, output, reasoning], r) => {
    const u = usage(input, cached, output, reasoning ?? 0);
    const total = opts.total ?? { v: 0 };
    total.v += u.total_tokens;
    out.push(line(at + 10 + r, "token_usage_record", { thread_id: TH, turn_id: id, response_id: `resp_${k}_${r}`, usage: u }));
    out.push(line(at + 10 + r, "event_msg", { type: "token_count", info: { total_token_usage: { ...u, total_tokens: total.v }, last_token_usage: u } }));
  });
  out.push(line(at + 50, "event_msg", { type: "task_complete", turn_id: id }));
  return out;
}

function fx(registry: { name: string; sessionId: string; cwd?: string; runtime?: string }[] = [{ name: "agent-cx", sessionId: TH, runtime: "codex" }]) {
  const root = mkdtempSync(join(tmpdir(), "usage-codex-"));
  const codex = join(root, "sessions", "2026", "09", "30");
  const archive = join(root, "archive");
  mkdirSync(codex, { recursive: true });
  mkdirSync(archive, { recursive: true });
  const db = openUsageDb(":memory:");
  const run = (extra = {}) =>
    ingestUsage(db, { projectsRoot: join(root, "projects"), archiveRoot: archive, codexRoot: join(root, "sessions"), registry: registry as never, now: NOW, ...extra });
  const path = (thread: string, seg?: string) => join(codex, `rollout-2026-09-30T20-29-36-${thread}${seg ? `_${seg}` : ""}.jsonl`);
  const write = (p: string, recs: object[]) => writeFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const append = (p: string, recs: object[]) => appendFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const total = () => usageSummary(db, 0).reduce((s, r) => s + r.totalTokens, 0);
  return { root, archive, db, run, path, write, append, total };
}

describe("文件名与用量换算", () => {
  test("rollout 原文件和 revert 新段都认出线程 id；别的文件名不认", () => {
    expect(codexThreadOfFile(`rollout-2026-09-30T20-29-36-${TH}.jsonl`)).toBe(TH);
    expect(codexThreadOfFile(`rollout-2026-09-30T20-29-36-${TH}_${REV}.jsonl`)).toBe(TH);
    expect(codexThreadOfFile(`${TH}.jsonl`)).toBeNull();
  });
  test("input 拆出命中缓存、output 拆出 reasoning；五项之和 = total_tokens；全零不算", () => {
    const u = usage(23853, 13056, 500, 107);
    expect(codexUsage(u)).toEqual({ input: 10797, cacheCreation: 0, cacheRead: 13056, output: 393, reasoning: 107 });
    const c = codexUsage(u)!;
    expect(c.input + c.cacheCreation + c.cacheRead + c.output + c.reasoning!).toBe(u.total_tokens);
    expect(codexUsage(usage(0, 0, 0))).toBeNull();
  });
});

describe("去重", () => {
  test("token_usage_record 和紧跟的 token_count 是同一次请求；token_count 重复落盘不算；合计 = 最后的 total_token_usage", () => {
    const f = fx();
    const total = { v: 0 };
    const recs = [meta(TH), ...turn(1, T, "做一件事", [[20000, 13000, 300, 50], [30000, 20000, 400]], { total })];
    const dup = recs.find((r: any) => r.payload?.type === "token_count")!;
    f.write(f.path(TH), [...recs, { ...dup, ordinal: ++ord, timestamp: iso(T + 40) }]);
    f.run();
    const [row] = usageSummary(f.db, 0);
    expect(row).toMatchObject({ agent: "agent-cx", runtime: "codex", calls: 2, reasoning: 50 });
    expect(f.total()).toBe(total.v);
  });

  test("重复导入、追加后增量导入都不翻倍，追加的请求接进同一轮", () => {
    const f = fx();
    f.write(f.path(TH), [meta(TH), ...turn(1, T, "一", [[20000, 13000, 300]])]);
    f.run();
    f.run();
    f.append(f.path(TH), [line(T + 60, "token_usage_record", { turn_id: turnUuid(1), usage: usage(25000, 20000, 100) })]);
    f.run();
    f.run();
    expect(turnsFor(f.db, "agent-cx").map((t) => t.calls)).toEqual([2]);
    expect(f.total()).toBe(20300 + 25100);
  });

  test("老版本 rollout（没有 token_usage_record）：按 token_count.last_token_usage 计，同一累计值重复落盘只算一次", () => {
    const f = fx();
    const recs = turn(1, T, "老版本", [[1000, 0, 10], [2000, 1000, 20]]).filter((r: any) => r.type !== "token_usage_record");
    const counts = recs.filter((r: any) => r.payload?.type === "token_count");
    f.write(f.path(TH), [meta(TH), ...recs, { ...counts[1], ordinal: ++ord }]);
    f.run();
    expect(usageSummary(f.db, 0)[0]).toMatchObject({ calls: 2, totalTokens: 3030 });
  });
});

describe("切轮", () => {
  test("两个 task_started 两轮；轮里的 turn_context、插话、工具调用不切；来源摘要取本轮第一条输入", () => {
    const f = fx();
    const t1 = turn(1, T, "第一件", [[20000, 13000, 300], [21000, 20000, 200]], { tools: ["exec_command", "exec_command", "apply_patch"] });
    t1.splice(5, 0, line(T + 5, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "插一句" }] }),
      line(T + 6, "turn_context", { turn_id: turnUuid(1), model: "gpt-6.1-sol" }));
    const ch = `<channel source="claudestra" message_id="m1">\n第二件\n</channel>`;
    f.write(f.path(TH), [meta(TH), ...t1, ...turn(2, T + 100_000, ch, [[30000, 29000, 100]])]);
    f.run();
    const turns = turnsFor(f.db, "agent-cx");
    expect(turns.map((t) => [t.kind, t.trigger, t.calls])).toEqual([["human", "第一件", 2], ["channel", "第二件", 1]]);
    expect(turns[0].tools).toEqual({ exec_command: 2, apply_patch: 1 });
    expect(turns[0].contextSeen).toBe(21000);
  });

  test("注入的环境说明（AGENTS.md / environment_context）不当来源", () => {
    const f = fx();
    const t1 = turn(1, T, "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>", [[1000, 0, 10]]);
    t1.splice(2, 0, line(T + 1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "真正的问题" }] }));
    f.write(f.path(TH), [meta(TH), ...t1]);
    f.run();
    expect(turnsFor(f.db, "agent-cx")[0].trigger).toBe("真正的问题");
  });

  test("整轮没有外来输入（只有注入的说明）：来源记 other，不冒充 continued", () => {
    const f = fx();
    f.write(f.path(TH), [meta(TH), ...turn(1, T, "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>", [[1000, 0, 10]])]);
    f.run();
    expect(turnsFor(f.db, "agent-cx").map((t) => [t.kind, t.trigger])).toEqual([["other", ""]]);
  });
});

describe("revert 新段", () => {
  test("新段带着旧段的记录、再加新的一轮：旧段的不重复计，新一轮照计；轮不重复", () => {
    const f = fx();
    const a = turn(1, T, "一", [[20000, 13000, 300]]);
    const b = turn(2, T + 100_000, "二（后来被 revert 掉）", [[30000, 20000, 400]]);
    f.write(f.path(TH), [meta(TH), ...a, ...b]);
    f.run();
    f.write(f.path(TH, REV), [meta(TH), ...a, ...turn(3, T + 200_000, "三", [[25000, 20000, 100]])]);
    f.run();
    f.run();
    expect(turnsFor(f.db, "agent-cx").map((t) => [t.trigger, t.calls])).toEqual([["一", 1], ["二（后来被 revert 掉）", 1], ["三", 1]]);
    expect(f.total()).toBe(20300 + 30400 + 25100);
  });

  test("新段从一轮中间开始（没有 task_started）：接回原来那一轮，不另算", () => {
    const f = fx();
    const a = turn(1, T, "一", [[20000, 13000, 300], [21000, 20000, 200]]);
    f.write(f.path(TH), [meta(TH), ...a]);
    f.run();
    const tail = a.filter((r: any) => r.type === "token_usage_record").slice(1);
    f.write(f.path(TH, REV), [meta(TH), ...tail, line(T + 90, "token_usage_record", { turn_id: turnUuid(1), usage: usage(22000, 21000, 50) })]);
    f.run();
    expect(turnsFor(f.db, "agent-cx").map((t) => [t.trigger, t.calls])).toEqual([["一", 3]]);
  });
});

describe("归属与模型", () => {
  test("子线程记到父线程的主人、标 sidechain；认不出的记 unowned；模型标成请求模型", () => {
    const f = fx();
    f.write(f.path(TH), [meta(TH), ...turn(1, T, "主线", [[20000, 13000, 300]])]);
    f.write(f.path(SUB), [meta(SUB, { session_id: TH, parent_thread_id: TH, source: { subagent: "review" } }), ...turn(7, T, "子线程的活", [[5000, 0, 50]])]);
    const wild = "01a0f3ff-0000-7000-8000-00000000ffff";
    f.write(f.path(wild), [meta(wild, { source: "exec" }), ...turn(9, T, "ask_codex", [[1000, 0, 10]], { model: "gpt-6-mini" })]);
    f.run();
    const rows = usageSummary(f.db, 0);
    expect(rows.map((r) => [r.agent, r.model, r.modelBasis, r.calls])).toEqual([
      ["agent-cx", "gpt-6.1-sol", "request", 2], ["unowned", "gpt-6-mini", "request", 1],
    ]);
    expect(rows[0].sidechainTokens).toBe(5050);
    expect(turnsFor(f.db, "agent-cx").find((t) => t.sidechain)?.kind).toBe("subagent");
  });

  test("归档副本（archive/<agent>/<thread>.jsonl）认出主人，和原件不重复计", () => {
    const f = fx([]);
    f.write(f.path(TH), [meta(TH), ...turn(1, T, "一", [[20000, 13000, 300]])]);
    f.run();
    expect(usageSummary(f.db, 0)[0].agent).toBe("unowned");
    mkdirSync(join(f.archive, "agent-old"), { recursive: true });
    copyFileSync(f.path(TH), join(f.archive, "agent-old", `${TH}.jsonl`));
    f.run();
    expect(usageSummary(f.db, 0).map((r) => [r.agent, r.calls])).toEqual([["agent-old", 1]]);
  });

});

/** 老 Codex（0.149）的一轮：只有 token_count，没有 token_usage_record */
function oldTurn(k: number, at: number, reqs: [number, number, number][], total: { v: number }) {
  const id = turnUuid(k);
  const out: object[] = [line(at, "event_msg", { type: "task_started", turn_id: id }), line(at + 1, "turn_context", { turn_id: id, model: "gpt-6.1-sol" })];
  reqs.forEach(([input, cached, output], r) => {
    const u = usage(input, cached, output);
    total.v += u.total_tokens;
    out.push(line(at + 10 + r, "event_msg", { type: "token_count", info: { total_token_usage: { ...u, total_tokens: total.v }, last_token_usage: u } }));
  });
  return out;
}
const SAME: [number, number, number, number] = [1000, 500, 100, 20];

describe("r1 回归：计数相同的独立请求不能并成一次（P1-1）", () => {
  test("审查员反例：同一线程两轮、五项计数完全相同 → 2 次调用、2 轮、2200", () => {
    const f = fx();
    const total = { v: 0 };
    f.write(f.path(TH), [meta(TH), ...turn(1, T, "一", [SAME], { total }), ...turn(2, T + 10_000, "二", [SAME], { total })]);
    f.run();
    f.run();
    expect(turnsFor(f.db, "agent-cx").map((t) => [t.calls, t.totalTokens])).toEqual([[1, 1100], [1, 1100]]);
    expect(f.total()).toBe(2200);
  });

  test("同一轮里两次计数相同的请求 → 2 次", () => {
    const f = fx();
    f.write(f.path(TH), [meta(TH), ...turn(1, T, "一", [SAME, SAME])]);
    f.run();
    expect(usageSummary(f.db, 0)[0].calls).toBe(2);
  });

  test("revert 新段：带着旧轮副本 + 一个计数相同的新请求 → 旧的不重算、新的要算；再导一遍不变", () => {
    const f = fx();
    const total = { v: 0 };
    const first = [meta(TH), ...turn(1, T, "一", [SAME], { total })];
    f.write(f.path(TH), first);
    f.run();
    f.write(f.path(TH, REV), [...first, ...turn(2, T + 10_000, "二", [SAME], { total })]);
    f.run();
    f.run();
    expect(f.total()).toBe(2200);
    expect(turnsFor(f.db, "agent-cx").map((t) => t.calls)).toEqual([1, 1]);
  });

  test("record 和它的回声被增量导入切开：先导到 record，回声下一趟才到，不多算", () => {
    const f = fx();
    const recs = [meta(TH), ...turn(1, T, "一", [[20000, 13000, 300]])];
    const cut = recs.findIndex((r: any) => r.type === "token_usage_record") + 1;
    f.write(f.path(TH), recs.slice(0, cut));
    f.run();
    f.append(f.path(TH), recs.slice(cut));
    f.run();
    expect(usageSummary(f.db, 0)[0].calls).toBe(1);
  });

  test("回声紧挨着重复落盘、重复那条落在下一轮 task_started 之后：不算进下一轮", () => {
    const f = fx();
    const a = turn(1, T, "一", [[20000, 13000, 300]]);
    const echo = a.find((r: any) => r.payload?.type === "token_count")!;
    const b = turn(2, T + 10_000, "二", [[30000, 20000, 400]]);
    f.write(f.path(TH), [meta(TH), ...a, b[0], { ...echo, ordinal: ++ord, timestamp: iso(T + 10_001) }, ...b.slice(1)]);
    f.run();
    expect(turnsFor(f.db, "agent-cx").map((t) => t.calls)).toEqual([1, 1]);
  });

  test("老 Codex（只有 token_count）：计数相同、累计值不同的是两次；同一行写两遍是一次", () => {
    const f = fx();
    const total = { v: 0 };
    const a = oldTurn(1, T, [[1000, 500, 100], [1000, 500, 100]], total);
    const b = oldTurn(2, T + 10_000, [[1000, 500, 100]], total);
    f.write(f.path(TH), [meta(TH, { cli_version: "0.149.0" }), ...a, a[a.length - 1], ...b]);
    f.run();
    expect(usageSummary(f.db, 0)[0].calls).toBe(3);
    expect(f.total()).toBe(3300);
  });
});

describe("r1 回归：汇总按运行时分（P2-1）", () => {
  test("同一 agent、同名模型的 Claude 与 Codex 各是一行，Claude 那行仍是应答模型；按明细和按 daily 都一样", () => {
    const f = fx();
    f.write(f.path(TH), [meta(TH), ...turn(1, T, "一", [SAME], { model: "unknown" })]);
    f.run();
    f.db.run("INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime) VALUES ('cc', 'agent-cx', 'cc-sid', 0, ?, 'human', '', 'claude-code')", [T]);
    f.db.run("INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning) SELECT 'cc-call', 'cc', ts, day, 'unknown', 100, 0, 0, 10, 0 FROM calls LIMIT 1");
    f.db.run("INSERT OR IGNORE INTO dirty_days SELECT day FROM calls");
    f.run();
    for (const rows of [usageSummary(f.db, 0), usageSummary(f.db)]) {
      expect(rows.map((r) => [r.runtime, r.modelBasis, r.totalTokens])).toEqual([["codex", "request", 1100], ["claude-code", "response", 110]]);
    }
  });
});

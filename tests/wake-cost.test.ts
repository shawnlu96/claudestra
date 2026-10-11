/**
 * 按叫醒计量（src/lib/wake-cost.ts）：叫醒切分、来源归类、去重请求、分位数、步数桶、压缩后底线、窗口截断与坏行。只用合成数据。
 */
import { describe, test, expect } from "bun:test";
import {
  aggregateWakes, buildWakeReport, classifyWakeSource, isWakeBoundary, percentiles, renderWakeTable, scanWakes, stepBucket,
} from "../src/lib/wake-cost.js";

let clock = Date.parse("2026-10-10T00:00:00Z");
const ts = () => new Date((clock += 1000)).toISOString();
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", timestamp: ts(), message: { role: "user", content }, ...extra });
const toolResult = () => user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]);
const asst = (id: string, u: [number, number, number, number], extra: Record<string, unknown> = {}) => ({
  type: "assistant", timestamp: ts(), requestId: `req_${id}`,
  message: { id, model: "m", content: [{ type: "text", text: "x" }], usage: { input_tokens: u[0], cache_read_input_tokens: u[1], cache_creation_input_tokens: u[2], output_tokens: u[3] } },
  ...extra,
});
const ch = (attrs: string, body = "正文") => `<channel source="claudestra" chat_id="1" message_id="m" ${attrs}>\n${body}\n</channel>`;
const jsonl = (recs: unknown[]) => recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

describe("[验收线 1] 叫醒切分与去重请求", () => {
  test("owner → 同 id 两块 + tool_result + 第二响应；后台通知另成一轮", () => {
    const text = jsonl([
      user(ch('trigger="user_discord" user="o" user_id="1"')),
      asst("r1", [1, 1, 1, 1]),
      asst("r1", [10, 20, 30, 4]),
      toolResult(),
      asst("r2", [1, 2, 3, 1]),
      user("<task-notification><summary>done</summary></task-notification>"),
      asst("r3", [5, 5, 5, 5]),
    ]);
    const s = scanWakes(text);
    expect(s.wakes.length).toBe(2);
    expect(s.wakes[0]).toMatchObject({ source: "owner", requests: 2, contextTotal: 66, output: 5, unfinished: false, windowTruncated: false });
    expect(s.wakes[1]).toMatchObject({ source: "task_notification", requests: 1, contextTotal: 15, unfinished: true });
  });
  test("纯 tool_result 不切；混合文本与 tool_result 的 user 切；compact_boundary 本身不切", () => {
    expect(isWakeBoundary(toolResult())).toBe(false);
    expect(isWakeBoundary(user([{ type: "tool_result", tool_use_id: "t" }, { type: "text", text: "补一句" }]))).toBe(true);
    expect(isWakeBoundary({ type: "system", subtype: "compact_boundary" })).toBe(false);
    expect(isWakeBoundary(user("hi"))).toBe(true);
  });
});

describe("[验收线 2] 来源归类与压缩后底线", () => {
  const cls = (rec: any) => classifyWakeSource(rec).source;
  test("channel 结构字段归类，未知为其他，不猜 owner", () => {
    expect(cls(user(ch('trigger="user_discord" user="o" user_id="1"')))).toBe("owner");
    expect(cls(user(ch('trigger="ask_answer" user="o" user_id="1"')))).toBe("owner");
    expect(cls(user(ch('trigger="agent_tool" user="scheduler" user_id="agent" is_agent="true"')))).toBe("dispatch");
    expect(cls(user(ch('trigger="agent_tool" user="agent-ledger-audit" user_id="agent" is_agent="true"')))).toBe("dispatch");
    expect(cls(user(ch('trigger="agent_tool" user="agent-dev" user_id="agent" is_agent="true"')))).toBe("executor");
    expect(cls(user(ch('trigger="bridge_synth" user="bridge:ia-watchdog" user_id="bridge" is_bridge="true"')))).toBe("dispatch");
    expect(cls(user(ch('trigger="system" user="bridge" user_id="bridge"')))).toBe("dispatch");
    expect(cls(user(ch('trigger="peer_http" user="x"')))).toBe("executor");
    expect(cls(user(ch('trigger="user_discord" api="true" user="web" user_id="api:t"')))).toBe("other");
    expect(cls(user("<task-notification><summary>x</summary></task-notification>"))).toBe("task_notification");
    expect(cls(user([{ type: "text", text: "Base directory for this skill: /x\n\n# Skill" }], { isMeta: true }))).toBe("skill");
    expect(cls(user("This session is being continued from a previous conversation…", { isCompactSummary: true }))).toBe("compact_resume");
    expect(cls(user("随便打的字"))).toBe("other");
    expect(cls(user("随便打的字", { origin: { kind: "human" } }))).toBe("other");
  });
  test("理由只有规则代号，不含正文与用户名", () => {
    const r = classifyWakeSource(user(ch('trigger="agent_tool" user="secret-name" user_id="agent" is_agent="true"', "机密正文")));
    expect(r.reason).not.toContain("secret-name");
    expect(r.reason).not.toContain("机密");
  });
  test("compact_boundary 后首请求上下文 60 → 底线唯一样本 60；无边界为 null", () => {
    const withBoundary = jsonl([
      user("a"), asst("p1", [100, 100, 100, 1]),
      { type: "system", subtype: "compact_boundary", timestamp: ts() },
      user("This session is being continued from a previous conversation", { isCompactSummary: true }),
      asst("p2", [10, 20, 30, 1]), asst("p3", [5, 5, 5, 1]),
    ]);
    const s = scanWakes(withBoundary);
    expect(s.compactFloors).toEqual([60]);
    expect(aggregateWakes(s).compactFloor).toEqual({ n: 1, p10: 60, p50: 60, p90: 60, max: 60 });
    const none = aggregateWakes(scanWakes(jsonl([user("a"), asst("q1", [1, 1, 1, 1])]))).compactFloor;
    expect(none).toEqual({ n: 0, p10: null, p50: null, p90: null, max: null });
  });
});

describe("[验收线 3] 分位数与步数桶", () => {
  test("10/20/30/40 → p50=20 p90=30 max=40；空样本 null", () => {
    expect(percentiles([40, 10, 30, 20])).toEqual({ n: 4, p10: 10, p50: 20, p90: 30, max: 40 });
    expect(percentiles([]).p50).toBeNull();
  });
  test("0 / 3 / 10 / 11 请求四轮各进一桶，占比合计 100%", () => {
    expect([0, 3, 10, 11].map(stepBucket)).toEqual(["0", "1-3", "4-10", "11+"]);
    let n = 0;
    const wake = (k: number) => [user(`w${k}`), ...Array.from({ length: k }, () => asst(`b${n++}`, [1, 2, 3, 0]))];
    const agg = aggregateWakes(scanWakes(jsonl([...wake(0), ...wake(3), ...wake(10), ...wake(11)])));
    expect(agg.buckets.map((b) => [b.bucket, b.wakes, b.requests])).toEqual([["0", 1, 0], ["1-3", 1, 3], ["4-10", 1, 10], ["11+", 1, 11]]);
    expect(agg.buckets.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 10);
    expect(agg.requestContext.n).toBe(24);
  });
  test("文件头元数据不算叫醒：snapshot 前缀不改变四轮分桶，仅元数据为 0 次叫醒", () => {
    const snap = () => ({ type: "file-history-snapshot", messageId: "snapshot", snapshot: { timestamp: ts() } });
    let n = 0;
    const wake = (k: number) => [user(`w${k}`), ...Array.from({ length: k }, () => asst(`m${n++}`, [1, 2, 3, 0]))];
    const agg = aggregateWakes(scanWakes(jsonl([snap(), { type: "permission-mode", mode: "default" }, ...wake(0), ...wake(3), ...wake(10), ...wake(11)])));
    expect(agg.totals.wakes).toBe(4);
    expect(agg.buckets.map((b) => b.wakes)).toEqual([1, 1, 1, 1]);
    expect(scanWakes(jsonl([snap()])).wakes).toEqual([]);
    expect(scanWakes(jsonl([{}])).wakes).toEqual([]);
    const one = aggregateWakes(scanWakes(jsonl([snap(), user("a"), asst("s1", [10, 20, 30, 1])])));
    expect(one.totals.wakes).toBe(1);
    expect([one.wakeCost.p50, one.wakeCost.p90]).toEqual([60, 60]);
    // 边界前确有请求（续接会话开头）仍单列一次 other / no-boundary-head
    const head = scanWakes(jsonl([snap(), asst("h1", [1, 1, 1, 0]), user("a")]));
    expect(head.wakes.map((w) => [w.reason, w.requests])).toEqual([["no-boundary-head", 1], [expect.any(String), 0]]);
  });
  test("零总量时占比为 0", () => {
    const agg = aggregateWakes(scanWakes(jsonl([user("a"), user("b")])));
    expect(agg.buckets.every((b) => b.share === 0)).toBe(true);
    expect(agg.totals.wakes).toBe(2);
  });
});

describe("叫醒结束时间", () => {
  test("前一轮止于下一次叫醒的边界时间；尾轮止于最后一条记录", () => {
    const at = (iso: string, r: Record<string, unknown>) => ({ ...r, timestamp: iso });
    const s = scanWakes(jsonl([
      at("2026-10-10T00:00:00.000Z", user("a")), at("2026-10-10T00:00:01.000Z", asst("e1", [1, 1, 1, 0])),
      at("2026-10-10T00:00:30.000Z", user("b")), at("2026-10-10T00:00:31.000Z", asst("e2", [1, 1, 1, 0])),
    ]));
    expect(s.wakes.map((w) => [w.start, w.end])).toEqual([
      ["2026-10-10T00:00:00.000Z", "2026-10-10T00:00:30.000Z"],
      ["2026-10-10T00:00:30.000Z", "2026-10-10T00:00:31.000Z"],
    ]);
  });
});

describe("[验收线 4] 窗口截断、坏行、缺 usage、重复响应、未结束尾轮", () => {
  test("只累计窗口内请求并标截断；坏行不崩；JSON 与表格合计一致", () => {
    clock = Date.parse("2026-10-10T00:00:00Z");
    const before = [user(ch('trigger="user_discord" user="o" user_id="1"')), asst("w1", [100, 0, 0, 1])];
    const since = clock + 500;
    const text = jsonl([
      ...before,
      asst("w2", [1, 2, 3, 1]),
      "{坏 JSON",
      { type: "assistant", timestamp: ts(), message: { id: "nu", content: [] } },
      asst("w2", [1, 2, 3, 2]),
      user("<task-notification>x</task-notification>"),
      asst("w3", [4, 4, 4, 4]),
    ]);
    const s = scanWakes(text, since);
    expect(s.badLines).toBe(1);
    expect(s.wakes.length).toBe(2);
    expect(s.wakes[0]).toMatchObject({ source: "owner", requests: 1, contextTotal: 6, output: 2, windowTruncated: true, unfinished: false });
    expect(s.wakes[1]).toMatchObject({ requests: 1, contextTotal: 12, windowTruncated: false, unfinished: true });
    const r = buildWakeReport("agent-x", "abcdef1234567890", s, { since, source: "since" });
    expect(r.coverage.session).toBe("abcdef12");
    expect(r.totals).toMatchObject({ wakes: 2, requests: 2, contextTotal: 18, output: 6 });
    const total = renderWakeTable(r).split("\n").find((l) => l.startsWith("total:"))!;
    const kv = Object.fromEntries(total.slice(7).split(" ").map((p) => p.split("=")).map(([k, v]) => [k, Number(v)]));
    expect(kv).toEqual({ ...r.totals });
  });
  test("窗口前开始、窗口内无请求的叫醒不输出", () => {
    clock = Date.parse("2026-10-10T00:00:00Z");
    const text = jsonl([user("old"), asst("o1", [1, 1, 1, 1])]);
    expect(scanWakes(text, clock + 10_000).wakes).toEqual([]);
  });
  test("表格与 JSON 都不带正文", () => {
    const r = buildWakeReport("a", "s", scanWakes(jsonl([user(ch('trigger="user_discord" user="o" user_id="1"', "绝密内容")), asst("z", [1, 1, 1, 1])])), { since: 0, source: "all" });
    expect(JSON.stringify(r)).not.toContain("绝密");
    expect(renderWakeTable(r)).not.toContain("绝密");
  });
});

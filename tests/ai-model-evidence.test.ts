/** lib/ai-model-evidence.ts：三家会话记录里的模型抽取、按响应去重、最近 N 次分布、没数据时 sample 0。 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHits, codexHits, modelDistribution, piHits, scanEvidence } from "../src/lib/ai-model-evidence.js";

const ts = (m: number) => new Date(Date.UTC(2026, 8, 30, 10, m)).toISOString();
const cc = (id: string, model: string, m: number) => JSON.stringify({ type: "assistant", timestamp: ts(m), message: { id, model, role: "assistant" } });

describe("claudeHits", () => {
  test("取 message.model，排除 <synthetic>，不安全的名字记 unknown，坏行跳过", () => {
    const hits = claudeHits([
      cc("m1", "claude-opus-5-5", 1),
      cc("m1", "claude-opus-5-5", 1), // 同一响应的第二个内容块
      cc("m2", "<synthetic>", 2),
      cc("m3", "deepseek-chat", 3),
      cc("m4", "bad model<script>", 4),
      '{"type":"assistant", half',
      JSON.stringify({ type: "user", message: { model: "x" } }),
    ]);
    expect(hits.map((h) => h.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "deepseek-chat", "unknown"]);
    expect(hits[0]!.id).toBe("cc:m1");
  });
});

test("piHits 拼 provider/model", () => {
  const line = JSON.stringify({ type: "message", id: "e1", timestamp: ts(1), message: { role: "assistant", provider: "openrouter", model: "qwen3-coder" } });
  expect(piHits([line])).toEqual([{ id: "pi:e1", ts: Date.parse(ts(1)), model: "openrouter/qwen3-coder" }]);
});

describe("codexHits", () => {
  const tc = (turn: string, model: string, m: number) => JSON.stringify({ type: "turn_context", timestamp: ts(m), payload: { turn_id: turn, model } });
  const rec = (turn: string, resp: string, m: number) => JSON.stringify({ type: "token_usage_record", timestamp: ts(m), payload: { turn_id: turn, response_id: resp, usage: {} } });
  const cnt = (m: number, info: unknown = { total_token_usage: {} }) => JSON.stringify({ type: "event_msg", timestamp: ts(m), payload: { type: "token_count", info } });

  test("token_usage_record 按 turn_id 归到那一回合的模型", () => {
    const hits = codexHits([tc("t1", "gpt-6.1-sol", 0), rec("t1", "r1", 1), cnt(1), tc("t2", "gpt-6-mini", 2), rec("t2", "r2", 3), rec("t1", "r3", 4)]);
    expect(hits.map((h) => [h.id, h.model])).toEqual([["codex:r1", "gpt-6.1-sol"], ["codex:r2", "gpt-6-mini"], ["codex:r3", "gpt-6.1-sol"]]);
  });
  test("老 rollout 没有 token_usage_record：退回带 info 的 token_count（只有限流信息的不算）", () => {
    const hits = codexHits([tc("t1", "gpt-5", 0), cnt(1), cnt(2, null), cnt(3)]);
    expect(hits.map((h) => h.model)).toEqual(["gpt-5", "gpt-5"]);
  });
});

describe("modelDistribution", () => {
  test("最近 limit 次、按 id 去重、占比", () => {
    const hits = [
      { id: "a", ts: 1, model: "old" },
      { id: "b", ts: 2, model: "x" },
      { id: "b", ts: 2, model: "x" },
      { id: "c", ts: 3, model: "y" },
      { id: null, ts: 4, model: "x" },
      { id: null, ts: NaN, model: "z" },
    ];
    const d = modelDistribution(hits, 3, "response_model", 2);
    expect(d.sample).toBe(3);
    expect(d.models).toEqual([{ model: "x", count: 2, share: 0.67 }, { model: "y", count: 1, share: 0.33 }]);
    expect([d.from, d.to]).toEqual([2, 4]);
    expect(d.filesScanned).toBe(2);
  });
  test("没有数据：sample 0、models 空、时间 null（不编）", () => {
    expect(modelDistribution([], 200, "request_model", 0)).toEqual({ source: "request_model", sample: 0, limit: 200, from: null, to: null, models: [], filesScanned: 0 });
  });
});

describe("scanEvidence 读文件尾", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-ev-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("按 mtime 从新到旧，fork 抄过去的历史行去重", async () => {
    const now = Date.now();
    mkdirSync(join(dir, "proj", "sub"), { recursive: true });
    const a = join(dir, "proj", "a.jsonl");
    const b = join(dir, "proj", "sub", "b.jsonl");
    writeFileSync(a, [cc("m1", "claude-opus-5-5", 1), cc("m2", "claude-opus-5-5", 2)].join("\n"));
    writeFileSync(b, [cc("m1", "claude-opus-5-5", 1), cc("m3", "glm-5", 3)].join("\n") + "\n");
    utimesSync(a, new Date(now - 60_000), new Date(now - 60_000));
    const ev = await scanEvidence([dir, join(dir, "missing")], claudeHits, "response_model", 10, now);
    expect(ev.sample).toBe(3);
    expect(ev.filesScanned).toBe(2);
    expect(ev.models).toEqual([{ model: "claude-opus-5-5", count: 2, share: 0.67 }, { model: "glm-5", count: 1, share: 0.33 }]);
  });

  test("根目录不存在 = 空证据", async () => {
    expect((await scanEvidence([join(dir, "nope")], claudeHits, "response_model")).sample).toBe(0);
  });
});

/**
 * 跨实例交接记录：一次交接 = request + 一条结局，汇总给 Peer 面板。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffEnd, handoffStart, readHandoffs, summarizeHandoffs, type HandoffRecord } from "../src/lib/handoff-log.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "handoff-")), "handoffs.jsonl");

describe("handoffStart / handoffEnd", () => {
  test("结局带上从 request 起的毫秒；同一个 id 只结一次；没开过的 id 不落盘", async () => {
    const p = tmp();
    await handoffStart("thr_1", { dir: "in", peer: "Sekai", localAgent: "agent-claudestra" }, 42, p);
    expect(await handoffEnd("thr_1", "reply", { chars: 100 }, p)).toBe(true);
    expect(await handoffEnd("thr_1", "reply", {}, p)).toBe(false);
    expect(await handoffEnd("thr_unknown", "reply", {}, p)).toBe(false);
    const recs = await readHandoffs(0, p);
    expect(recs.map((r) => r.event)).toEqual(["request", "reply"]);
    expect(recs[0]).toMatchObject({ id: "thr_1", dir: "in", peer: "Sekai", chars: 42 });
    expect(recs[1]).toMatchObject({ id: "thr_1", dir: "in", peer: "Sekai", localAgent: "agent-claudestra", chars: 100 });
    expect(typeof recs[1].ms).toBe("number");
  });
  test("文件不存在 = 还没有交接", async () => {
    expect(await readHandoffs(0, join(tmpdir(), "no-such-dir-xyz", "handoffs.jsonl"))).toEqual([]);
  });
});

describe("summarizeHandoffs", () => {
  const at = (min: number) => new Date(Date.parse("2026-09-25T00:00:00Z") + min * 60_000).toISOString();
  const r = (o: Partial<HandoffRecord>): HandoffRecord => ({ ts: at(0), id: "x", dir: "in", peer: "A", localAgent: "a", event: "request", ...o });
  const recs: HandoffRecord[] = [
    r({ id: "1", ts: at(1) }), r({ id: "1", ts: at(2), event: "reply", ms: 60_000 }),
    r({ id: "2", ts: at(3), dir: "out", peer: "B" }), r({ id: "2", ts: at(4), dir: "out", peer: "B", event: "timeout", ms: 7_200_000 }),
    r({ id: "3", ts: at(5) }), r({ id: "3", ts: at(6), event: "reply", ms: 180_000 }),
    r({ id: "4", ts: at(7) }), r({ id: "4", ts: at(8), event: "fallback", ms: 30_000 }),
    r({ id: "old", ts: at(-100_000) }),
  ];
  test("总计：按 request 计数、分方向；中位只算正式回复", () => {
    const s = summarizeHandoffs(recs, Date.parse(at(0)));
    expect(s).toMatchObject({ total: 4, in: 3, out: 1, replied: 2, fallback: 1, failed: 1 });
    expect(s.medianMs).toBe(180_000);
  });
  test("按 peer 分，次数多的在前；时间窗外的不算", () => {
    const s = summarizeHandoffs(recs, Date.parse(at(0)));
    expect(s.byPeer.map((p) => [p.peer, p.total, p.failed])).toEqual([["A", 3, 0], ["B", 1, 1]]);
  });
});

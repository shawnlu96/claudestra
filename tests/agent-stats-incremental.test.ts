/**
 * readFileStats 续读（BML-2）：文件追加只读新增字节、没变不读、截断 / 轮转 / 原地重写整窗重读。
 * 口径对拍：续读的结果必须与「同内容的新文件冷读一遍」完全一致；顺序折叠必须与倒扫 scanStatsWindow 一致。
 */

import { describe, test, expect } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, truncateSync, utimesSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ccStatsFold, readFileStats, scanStatsWindow, type FileStats } from "../src/lib/agent-stats.js";
import { codexStatsFold, scanCodexStatsWindow } from "../src/lib/codex-usage.js";
import type { UsageWindowBounds } from "../src/lib/usage-window.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const H = 3600_000;
const WIN: UsageWindowBounds = { dayStart: NOW - 12 * H, weekStart: NOW - 5 * 24 * H, weekSource: "quota" };
const iso = (ms: number) => new Date(ms).toISOString();
const dir = mkdtempSync(join(tmpdir(), "agent-stats-inc-"));
let seq = 0;
const freshPath = () => join(dir, `s-${seq++}.jsonl`);

/** 一条响应写成多行（同 id，usage 递增），夹着用户行 / compact 摘要 / 窗口外记录；模型中途换过 */
function ccLines(n: number, startMs: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = startMs + i * 37 * 60_000;
    const model = i % 7 < 4 ? "claude-opus-5-5" : "claude-sonnet-5-5";
    out.push(JSON.stringify({ type: "user", timestamp: iso(ts), message: { content: `问题 ${i}，中文正文` } }));
    for (let part = 1; part <= 1 + (i % 3); part++) {
      out.push(JSON.stringify({
        type: "assistant", timestamp: iso(ts + part * 1000), requestId: `req_${i}`,
        message: { id: i % 5 === 0 ? undefined : `msg_${i}`, model,
          usage: { input_tokens: 100 + i, cache_read_input_tokens: 1000 * i, cache_creation_input_tokens: 7, output_tokens: 10 * part } },
      }));
    }
    if (i % 11 === 10) out.push(JSON.stringify({ type: "user", isCompactSummary: true, timestamp: iso(ts + 5000), message: { content: "摘要".repeat(300) } }));
  }
  return out;
}

const text = (lines: string[]) => lines.map((l) => l + "\n").join("");

/** 同内容新路径冷读一遍（新路径 = 没有续读状态） */
async function cold(content: string): Promise<FileStats> {
  const p = freshPath();
  writeFileSync(p, content);
  return readFileStats(p, { window: WIN, tailStartBytes: 512 });
}

function expectSame(a: FileStats, b: FileStats) {
  const strip = (s: FileStats) => ({ ...s, today: { ...s.today, costUsd: 0 }, week: { ...s.week, costUsd: 0 } });
  expect(strip(a)).toEqual(strip(b));
  // 求和顺序不同（顺扫 vs 倒扫），浮点成本只差舍入
  expect(a.today.costUsd).toBeCloseTo(b.today.costUsd, 9);
  expect(a.week.costUsd).toBeCloseTo(b.week.costUsd, 9);
}

describe("顺序折叠与倒扫同口径", () => {
  test("Claude Code 行：任意切成几批喂，结果都等于 scanStatsWindow 一遍倒扫", () => {
    const lines = ccLines(270, NOW - 7 * 24 * H); // 跨周界外 / 本周 / 今日
    const want = scanStatsWindow(lines, WIN.dayStart, WIN.weekStart);
    for (const cuts of [[0], [1, 50], [17, 18, 90, 120], [lines.length - 1]]) {
      const fold = ccStatsFold({ runtime: undefined, floor: Math.min(WIN.dayStart, WIN.weekStart), fromFileStart: true });
      let at = 0;
      for (const c of [...cuts, lines.length]) { fold.feed(lines.slice(at, c)); at = c; }
      expectSame(fold.result(WIN.dayStart, WIN.weekStart), want.stats);
      expect(fold.oldestTs()).toBe(want.oldestTs);
    }
    expect(want.stats.today.requests).toBeGreaterThan(0);
    expect(want.stats.week.requests).toBeLessThan(270);
  });

  test("Codex 行：分批喂等于一遍扫（累计计数器跨批续上）", () => {
    const t0 = NOW - 6 * 24 * H;
    const tc = (ms: number, total: number, last: number) => JSON.stringify({ timestamp: iso(ms), type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { total_tokens: last }, model_context_window: 258400 } } });
    const lines = [JSON.stringify({ timestamp: iso(t0), type: "turn_context", payload: { model: "gpt-5.5" } })];
    let total = 0;
    for (let i = 0; i < 80; i++) { const last = 50 + i; total = i === 40 ? last : total + last; lines.push(tc(t0 + i * 2 * H, total, last)); }
    const want = scanCodexStatsWindow(lines, WIN.dayStart, WIN.weekStart, true);
    const fold = codexStatsFold({ runtime: "codex", floor: Math.min(WIN.dayStart, WIN.weekStart), fromFileStart: true });
    fold.feed(lines.slice(0, 33));
    fold.feed(lines.slice(33, 34));
    fold.feed(lines.slice(34));
    expect(fold.result(WIN.dayStart, WIN.weekStart)).toEqual(want.stats);
    expect(want.stats.week.requests).toBeGreaterThan(0);
  });
});

describe("readFileStats 续读", () => {
  test("文件不变：结果不变", async () => {
    const p = freshPath();
    writeFileSync(p, text(ccLines(40, NOW - 6 * 24 * H)));
    const a = await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    const b = await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    expect(b).toEqual(a);
    expectSame(a, await cold(readFileSync(p, "utf8")));
  });

  test("追加（含先写半行、再补完）：等于冷读整个新文件", async () => {
    const lines = ccLines(80, NOW - 6 * 24 * H);
    const p = freshPath();
    writeFileSync(p, text(lines.slice(0, 50)));
    await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    const next = text(lines.slice(50, 70));
    appendFileSync(p, next.slice(0, 123)); // 半行：这次只该吃到前面的整行
    expectSame(await readFileStats(p, { window: WIN, tailStartBytes: 512 }), await cold(text(lines.slice(0, 50)) + next.slice(0, 123)));
    appendFileSync(p, next.slice(123) + text(lines.slice(70)));
    expectSame(await readFileStats(p, { window: WIN, tailStartBytes: 512 }), await cold(text(lines)));
  });

  test("截断后重写（变短）：整窗重读", async () => {
    const lines = ccLines(60, NOW - 6 * 24 * H);
    const p = freshPath();
    writeFileSync(p, text(lines));
    await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    truncateSync(p, 0);
    appendFileSync(p, text(lines.slice(0, 10)));
    expectSame(await readFileStats(p, { window: WIN, tailStartBytes: 512 }), await cold(text(lines.slice(0, 10))));
  });

  test("原地重写成更长的不同内容（inode 不变、大小不缩）：哈希对不上，整窗重读", async () => {
    const p = freshPath();
    writeFileSync(p, text(ccLines(20, NOW - 6 * 24 * H)));
    await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    const other = text(ccLines(50, NOW - 3 * 24 * H));
    writeFileSync(p, other);
    expectSame(await readFileStats(p, { window: WIN, tailStartBytes: 512 }), await cold(other));
  });

  test("轮转（新文件 rename 到同一路径，inode 变了）：整窗重读", async () => {
    const p = freshPath();
    writeFileSync(p, text(ccLines(40, NOW - 6 * 24 * H)));
    await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    const tmp = freshPath();
    const rotated = text(ccLines(5, NOW - 2 * H));
    writeFileSync(tmp, rotated);
    renameSync(tmp, p);
    expectSame(await readFileStats(p, { window: WIN, tailStartBytes: 512 }), await cold(rotated));
  });

  test("窗口往后挪（跨日 / 周重置）不重读也对；往前挪整窗重读", async () => {
    const content = text(ccLines(90, NOW - 7 * 24 * H));
    const p = freshPath();
    writeFileSync(p, content);
    await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    const later: UsageWindowBounds = { dayStart: WIN.dayStart + 24 * H, weekStart: WIN.weekStart + 2 * 24 * H, weekSource: "quota" };
    const want = (w: UsageWindowBounds) => scanStatsWindow(content.split("\n"), w.dayStart, w.weekStart).stats;
    expectSame(await readFileStats(p, { window: later, tailStartBytes: 512 }), want(later));
    const earlier: UsageWindowBounds = { ...WIN, weekStart: WIN.weekStart - 24 * H };
    expectSame(await readFileStats(p, { window: earlier, tailStartBytes: 1 << 30 }), want(earlier));
  });

  // Shawn PR870-r1 rewrite-prefix-cache-stale：只比已读区尾部几 KB 会漏掉「改了开头、尾部原样」
  test("改写已统计过的首条、保留很长的末尾用户记录、大小不变、推进 mtime：等于重新扫描", async () => {
    const asst = (input: number) => JSON.stringify({ type: "assistant", timestamp: iso(NOW - H), requestId: "r1",
      message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: 1 } } });
    const user = JSON.stringify({ type: "user", timestamp: iso(NOW - H + 1000), message: { content: "长".repeat(6000) } });
    const p = freshPath();
    writeFileSync(p, `${asst(100)}\n${user}\n`);
    expect((await readFileStats(p, { window: WIN })).week.tokens).toBe(101);
    writeFileSync(p, `${asst(900)}\n${user}\n`);
    utimesSync(p, new Date(NOW), new Date(NOW + 5000)); // 显式推进 mtime（同一毫秒的写也能复现）
    const warm = await readFileStats(p, { window: WIN });
    expect(warm.week.tokens).toBe(901);
    expectSame(warm, await cold(readFileSync(p, "utf8")));
  });

  // Shawn PR870-r1 valid-final-line-dropped：末行完整但没换行（导入的 / 不再追加的文件）
  const lone = (input: number, id: string) => JSON.stringify({ type: "assistant", timestamp: iso(NOW - H), requestId: id,
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: 1 } } });

  test("静态文件末行没有换行：照样计入，与倒扫一致", async () => {
    const p = freshPath();
    writeFileSync(p, lone(100, "m1"));
    const s = await readFileStats(p, { window: WIN });
    expect(s.week.tokens).toBe(101);
    expect(s.contextTokens).toBe(100);
    expectSame(s, scanStatsWindow([lone(100, "m1")], WIN.dayStart, WIN.weekStart).stats);
  });

  test("末行先缺换行、之后补上换行再追加：那条只计一次", async () => {
    const p = freshPath();
    writeFileSync(p, lone(100, "m1"));
    expect((await readFileStats(p, { window: WIN })).week.tokens).toBe(101);
    appendFileSync(p, "\n");
    utimesSync(p, new Date(NOW), new Date(NOW + 1000));
    expect((await readFileStats(p, { window: WIN })).week).toMatchObject({ tokens: 101, requests: 1 });
    appendFileSync(p, lone(10, "m2") + "\n");
    utimesSync(p, new Date(NOW), new Date(NOW + 2000));
    const s = await readFileStats(p, { window: WIN });
    expect(s.week).toMatchObject({ tokens: 112, requests: 2 });
    expectSame(s, await cold(readFileSync(p, "utf8")));
  });

  test("没换行的末行是写到一半的：等补完，补完后只计一次", async () => {
    const p = freshPath();
    const full = lone(100, "m1");
    writeFileSync(p, full.slice(0, 40));
    expect((await readFileStats(p, { window: WIN })).week.tokens).toBe(0);
    appendFileSync(p, full.slice(40) + "\n");
    utimesSync(p, new Date(NOW), new Date(NOW + 1000));
    expect((await readFileStats(p, { window: WIN })).week).toMatchObject({ tokens: 101, requests: 1 });
  });

  test("末行看似完整（无换行）却被同一行续写成坏行：整窗重读，不留错计", async () => {
    const p = freshPath();
    writeFileSync(p, lone(100, "m1"));
    expect((await readFileStats(p, { window: WIN })).week.tokens).toBe(101);
    appendFileSync(p, "garbage\n" + lone(10, "m2") + "\n");
    utimesSync(p, new Date(NOW), new Date(NOW + 1000));
    const s = await readFileStats(p, { window: WIN });
    expectSame(s, await cold(readFileSync(p, "utf8")));
    expect(s.week).toMatchObject({ tokens: 11, requests: 1 });
  });

  // Shawn PR870-r2 append-same-mtime-skipped：保留时间戳的写入 / 粗粒度时间戳，追加后 mtime 不变
  test("固定 mtime 追加一条（不推进 mtime）：等于重新扫描", async () => {
    const p = freshPath();
    writeFileSync(p, lone(100, "m1") + "\n");
    const pinned = new Date(NOW - 10 * H);
    utimesSync(p, pinned, pinned);
    expect((await readFileStats(p, { window: WIN })).week.tokens).toBe(101);
    appendFileSync(p, lone(900, "m2") + "\n");
    utimesSync(p, pinned, pinned); // mtime 恢复原值
    const warm = await readFileStats(p, { window: WIN });
    expect(warm.week).toMatchObject({ tokens: 1002, requests: 2 });
    expectSame(warm, await cold(readFileSync(p, "utf8")));
    expect((await readFileStats(p, { window: WIN })).week.tokens).toBe(1002); // 再问一次不重复计
  });

  // 本地审查 r1 same-size-preserved-mtime-stale：等长改写 + 写入方把 mtime 复原，大小、mtime 都对得上
  test("等长原地改写并复原 mtime：等于重新扫描", async () => {
    const p = freshPath();
    writeFileSync(p, lone(100, "m1") + "\n");
    const pinned = new Date(NOW - 10 * H);
    utimesSync(p, pinned, pinned);
    expect((await readFileStats(p, { window: WIN })).week.tokens).toBe(101);
    writeFileSync(p, lone(900, "m1") + "\n"); // 100 → 900，等长
    utimesSync(p, pinned, pinned);
    const warm = await readFileStats(p, { window: WIN });
    expect(warm.week.tokens).toBe(901);
    expectSame(warm, await cold(readFileSync(p, "utf8")));
  });

  test("时间戳都没动但超过复核时限：只核哈希，结果不变", async () => {
    const p = freshPath();
    writeFileSync(p, text(ccLines(30, NOW - 3 * 24 * H)));
    const before = await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    const realNow = Date.now;
    const later = realNow() + 6 * 60_000;
    Date.now = () => later;
    try {
      expectSame(await readFileStats(p, { window: WIN, tailStartBytes: 512 }), before);
    } finally {
      Date.now = realNow;
    }
  });

  test("大小不变、只有 mtime 变了：按改写整窗重读，结果不变", async () => {
    const p = freshPath();
    writeFileSync(p, text(ccLines(30, NOW - 3 * 24 * H)));
    const before = await readFileStats(p, { window: WIN, tailStartBytes: 512 });
    utimesSync(p, new Date(NOW), new Date(NOW + 9000));
    expectSame(await readFileStats(p, { window: WIN, tailStartBytes: 512 }), before);
  });

  test("文件被删：返回空统计", async () => {
    const p = freshPath();
    writeFileSync(p, text(ccLines(5, NOW - H)));
    await readFileStats(p, { window: WIN });
    truncateSync(p, 0);
    renameSync(p, p + ".gone");
    const s = await readFileStats(p, { window: WIN });
    expect(s.week.requests).toBe(0);
    expect(s.contextTokens).toBe(0);
  });
});

/**
 * session-history-grep 流式字节扫描单测:chunk 边界(UTF-8 / 换行 / 长行)、ASCII 大小写、
 * 全文件行号、提前 break 关句柄;并经原入口 searchSessionHistory 跑大文件前部命中。
 * 对照组是「整文件读成字符串逐行 toLowerCase().includes」的朴素实现。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { anchorIndex, findFolded, grepJsonlLines } from "../src/lib/session-history-grep.js";
import { searchSessionHistory } from "../src/lib/session-history.js";

const dir = mkdtempSync(join(tmpdir(), "cstra-grep-"));

function naive(path: string, q: string): { line: string; idx: number }[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: { line: string; idx: number }[] = [];
  lines.forEach((line, idx) => {
    if (line.trim() && line.toLowerCase().includes(q)) out.push({ line, idx });
  });
  return out;
}

async function collect(path: string, q: string, chunkBytes?: number) {
  const out: { line: string; idx: number }[] = [];
  for await (const r of grepJsonlLines(path, q, chunkBytes)) out.push(r);
  return out;
}

const openFds = () => readdirSync("/dev/fd").length;

describe("findFolded / anchorIndex", () => {
  test("ASCII 大小写折叠、非 ASCII 原样、from 起点与越界", () => {
    const needle = Buffer.from("db9", "utf8");
    const ai = anchorIndex(needle);
    const buf = Buffer.from("xx DB9 yy dB9 zz db9", "utf8");
    expect(findFolded(buf, needle, ai)).toBe(3);
    expect(findFolded(buf, needle, ai, 4)).toBe(10);
    expect(findFolded(buf, needle, ai, 11)).toBe(17);
    expect(findFolded(buf, needle, ai, 18)).toBe(-1);
    expect(findFolded(Buffer.from("db"), needle, ai)).toBe(-1);
    expect(findFolded(buf, Buffer.alloc(0), 0)).toBe(-1);
    const cjk = Buffer.from("碳罐总成", "utf8");
    expect(findFolded(Buffer.from("前缀碳罐总成后缀"), cjk, anchorIndex(cjk))).toBe(6);
  });

  test("锚点取最稀有字节:'aston' 选 s 而非首字节 a", () => {
    expect(anchorIndex(Buffer.from("aston"))).toBe(1);
    expect(anchorIndex(Buffer.from("quiz"))).toBe(3);
  });
});

describe("grepJsonlLines", () => {
  // 每行混入 3 字节 CJK、大小写变体、长短不一,逼各种 chunk 大小把 UTF-8 / 换行切在任意偏移
  const rows: string[] = [];
  for (let i = 0; i < 120; i++) {
    const pad = "填充".repeat(i % 7) + "x".repeat(i % 13);
    const tag = i % 5 === 0 ? "Needle火山" : i % 7 === 0 ? "NEEDLE火山" : "无关";
    rows.push(JSON.stringify({ i, text: `${pad}${tag}${pad}` }));
  }
  rows.splice(40, 0, ""); // 空行计入行号但不产出
  rows.splice(77, 0, JSON.stringify({ long: "长".repeat(300) + "needle火山" + "尾".repeat(300) })); // 远超 chunk 的长行
  const withNl = join(dir, "mix.jsonl");
  writeFileSync(withNl, rows.join("\n") + "\n");
  const noNl = join(dir, "mix-tail.jsonl");
  writeFileSync(noNl, rows.join("\n") + "\n" + JSON.stringify({ tail: "needle火山 结尾无换行" }));

  test("所有 chunk 大小(含跨 UTF-8 / 换行 / 长行)与朴素全文件逐行结果逐字段一致", async () => {
    for (const f of [withNl, noNl]) {
      for (const q of ["needle火山", "needle", "火山", "le火"]) {
        const want = naive(f, q);
        expect(want.length).toBeGreaterThan(20);
        for (const chunk of [64, 65, 66, 67, 97, 128, 159, 1000, 4099, 65536, undefined]) expect(await collect(f, q, chunk)).toEqual(want);
      }
    }
  });

  test("chunk 64..160 逐个扫过:每个偏移对齐下 UTF-8 / 换行切点结果都不变", async () => {
    const want = naive(noNl, "needle火山");
    for (let chunk = 64; chunk <= 160; chunk++) expect(await collect(noNl, "needle火山", chunk)).toEqual(want);
  });

  test("行号是全文件坐标:空行与长行都计数,尾部无换行的半行也带正确行号", async () => {
    const got = await collect(noNl, "needle火山", 64);
    expect(got.some((r) => r.idx === 77 && r.line.startsWith('{"long"'))).toBe(true);
    expect(got.at(-1)).toEqual({ line: JSON.stringify({ tail: "needle火山 结尾无换行" }), idx: rows.length });
  });

  test("非 ASCII 大小写会变的词走慢路,大小写不敏感且结果同朴素实现", async () => {
    const f = join(dir, "umlaut.jsonl");
    writeFileSync(f, ['{"t":"ÖSTERREICH"}', '{"t":"x"}', '{"t":"Österreich"}', ""].join("\n"));
    for (const chunk of [64, 70, 4096]) expect(await collect(f, "österreich", chunk)).toEqual(naive(f, "österreich"));
  });

  test("提前 break(maxHits 场景)走 finally 关闭文件句柄", async () => {
    // 只认被测文件:Linux 核 /proc/self/fd 没有链到它的句柄;拿不到链接(macOS)退成句柄数不比之前多
    const links = () => { try { return readdirSync("/proc/self/fd").map((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return ""; } }); } catch { return null; } };
    const target = realpathSync(withNl), before = openFds();
    const closed = () => { const l = links(); if (l) expect(l).not.toContain(target); else expect(openFds()).toBeLessThanOrEqual(before); };
    for await (const _ of grepJsonlLines(withNl, "needle", 64)) break;
    closed();
    const capped = await searchSessionHistory(withNl, "needle", { maxHits: 1, chunkBytes: 64 });
    expect(capped.length).toBeLessThanOrEqual(1);
    closed();
  });
});

describe("searchSessionHistory 原入口经抽出的 grep", () => {
  test("超过 16MB 的大文件:前部命中可搜到且 seq 为全文件行号", async () => {
    const f = join(dir, "big.jsonl");
    const head = [
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00Z", message: { content: "开头无关" } }),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:01:00Z", message: { content: "前部聊过 Db9 碳罐总成" } }),
    ];
    const filler = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:02:00Z", message: { content: "填".repeat(400) } });
    const fillerCount = Math.ceil((17 * 1024 * 1024) / (Buffer.byteLength(filler) + 1));
    const tail = JSON.stringify({ type: "assistant", timestamp: "2026-07-02T00:00:00Z", message: { content: [{ type: "text", text: "尾部 DB9" }] } });
    writeFileSync(f, head.join("\n") + "\n" + (filler + "\n").repeat(fillerCount) + tail + "\n");
    const hits = await searchSessionHistory(f, "db9");
    expect(hits.map((h) => [h.seq, h.role])).toEqual([[1, "user"], [fillerCount + 2, "assistant"]]);
    expect(hits[0]!.snippet).toContain("Db9 碳罐总成");
    const small = await searchSessionHistory(f, "DB9", { chunkBytes: 1 << 20 });
    expect(small).toEqual(hits);
  });
});

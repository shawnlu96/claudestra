/**
 * lib/zstd-file.ts + copyIfLarger 的 .zst 路径：不整份解进内存、声明大小不超过已有归档时不解、解压炸弹中止且不留临时文件、
 * 截断 / 校验和不符 / 解出字节与声明不符一律 failed 不落盘。
 * .zst 都在临时目录里现造（Bun 压缩带帧头大小；node:zlib 的流式压缩不带；手搓帧用来造「声明大小与内容不符」）。
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { copyIfLarger, sweepStaleTmp } from "../src/lib/archive-copy.js";
import { readZstdFirstLine, scanZstdFile } from "../src/lib/zstd-file.js";
import { blockHeaderOffsets, streamCompress, zstdFrame } from "./zstd-test-kit.js";

const base = mkdtempSync(join(tmpdir(), "zstd-file-"));
/** 压不太动的文本：块多、每块都是真压缩块（截断才落在块中间） */
const noisy = (bytes: number) => Buffer.from(Array.from({ length: Math.ceil(bytes / 40) }, () => Math.random().toString(36).repeat(2)).join("\n") + "\n");
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const file = (data: Uint8Array | string) => {
  const p = join(base, `f-${++n}.jsonl.zst`);
  writeFileSync(p, data);
  return p;
};

describe("scanZstdFile：只走帧头 / 块头，判完整 + 求声明大小", () => {
  test("Bun 压缩的单帧 / 多帧拼接 / 前面带可跳过帧：完整，声明大小之和；流式压缩没声明：完整、size null", async () => {
    const a = Buffer.from("a".repeat(300_000) + "\n");
    const b = Buffer.from("line\n");
    expect(await scanZstdFile(file(Bun.zstdCompressSync(a)))).toEqual({ complete: true, size: a.length });
    expect(await scanZstdFile(file(Buffer.concat([Bun.zstdCompressSync(a), Bun.zstdCompressSync(b)])))).toEqual({ complete: true, size: a.length + b.length });
    const skip = Buffer.alloc(12);
    skip.writeUInt32LE(0x184d2a50, 0);
    skip.writeUInt32LE(4, 4);
    expect(await scanZstdFile(file(Buffer.concat([skip, Bun.zstdCompressSync(b)])))).toEqual({ complete: true, size: b.length });
    expect(await scanZstdFile(file(await streamCompress(Buffer.from("x\n"))))).toEqual({ complete: true, size: null });
  });

  test("空文件 / 不是 zstd / 截在块内容、块头、帧尾校验和 / 末尾多余字节：不完整", async () => {
    const z = Buffer.from(Bun.zstdCompressSync(noisy(600_000)));
    const heads = blockHeaderOffsets(z);
    expect(heads.length).toBeGreaterThan(2);
    const withCk = zlib.zstdCompressSync(Buffer.from("x\n"), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("not zstd at all\n"),
      z.subarray(0, Math.floor(z.length * 0.6)),
      z.subarray(0, heads[1]! + 1),
      z.subarray(0, z.length - 1),
      withCk.subarray(0, withCk.length - 1),
      Buffer.concat([z, Buffer.from("junk")]),
    ]) {
      expect((await scanZstdFile(file(bytes))).complete).toBe(false);
    }
  });
});

describe("readZstdFirstLine：流式，到换行为止", () => {
  test("首行 / 无换行 / 超上限 / 坏流", async () => {
    expect(await readZstdFirstLine(file(Bun.zstdCompressSync(Buffer.from("first\nsecond\n"))), 1024)).toEqual({ kind: "line", text: "first" });
    expect(await readZstdFirstLine(file(Bun.zstdCompressSync(Buffer.from("only"))), 1024)).toEqual({ kind: "eof", text: "only" });
    expect(await readZstdFirstLine(file(Bun.zstdCompressSync(Buffer.alloc(3_000_000, 0x61))), 1_000_000)).toEqual({ kind: "too-long" });
    expect((await readZstdFirstLine(file("garbage"), 1024)).kind).toBe("error");
  });
});

describe("copyIfLarger 的 .zst 路径", () => {
  const destDir = () => {
    const d = join(base, `dest-${++n}`);
    mkdirSync(d);
    return d;
  };

  test("流式炸弹（没声明大小）解出超上限：failed，写明上限，目标目录不留临时文件", async () => {
    const src = file(await streamCompress(Buffer.alloc(3 * 1024 * 1024)));
    const dir = destDir();
    const errs: string[] = [];
    expect(await copyIfLarger(src, join(dir, "x.jsonl"), (e) => errs.push(e.message), 1024 * 1024)).toBe("failed");
    expect(errs.join()).toContain("上限");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("帧头声明超上限：不解压直接 failed（默认上限 1 GiB）", async () => {
    const spy = spyOn(zlib, "createZstdDecompress");
    try {
      const src = file(zstdFrame(2 * 1024 * 1024 * 1024, Buffer.from("x\n")));
      const dir = destDir();
      const errs: string[] = [];
      expect(await copyIfLarger(src, join(dir, "x.jsonl"), (e) => errs.push(e.message))).toBe("failed");
      expect(errs.join()).toContain("帧头声明");
      expect(spy).toHaveBeenCalledTimes(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("帧头大小 ≤ 已有归档：same，不解压；大一字节就真解（这份手搓帧解不开 → failed）", async () => {
    const dir = destDir();
    const dest = join(dir, "x.jsonl");
    writeFileSync(dest, "0123456789\n");
    const spy = spyOn(zlib, "createZstdDecompress");
    try {
      expect(await copyIfLarger(file(zstdFrame(11, Buffer.from("short\n"))), dest)).toBe("same");
      expect(spy).toHaveBeenCalledTimes(0);
      expect(await copyIfLarger(file(zstdFrame(12, Buffer.from("short\n"))), dest)).toBe("failed");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(dest, "utf8")).toBe("0123456789\n");
    expect(readdirSync(dir)).toEqual(["x.jsonl"]);
  });

  test("截断（块中间 / 块头中间 / 帧尾前 1 字节，含没声明大小的流）：failed「不完整」，不解压、不留文件", async () => {
    const data = noisy(600_000);
    const z = Buffer.from(Bun.zstdCompressSync(data));
    const zs = await streamCompress(data);
    const spy = spyOn(zlib, "createZstdDecompress");
    try {
      for (const bytes of [z.subarray(0, Math.floor(z.length * 0.6)), z.subarray(0, blockHeaderOffsets(z)[1]! + 1), z.subarray(0, z.length - 1), zs.subarray(0, Math.floor(zs.length * 0.6))]) {
        const dir = destDir();
        const errs: string[] = [];
        expect(await copyIfLarger(file(bytes), join(dir, "x.jsonl"), (e) => errs.push(e.message))).toBe("failed");
        expect(errs.join()).toContain(".zst 不完整");
        expect(readdirSync(dir)).toEqual([]);
      }
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("带内容校验和的帧被改了一位：解码器核对失败 → failed，不落盘", async () => {
    const z = Buffer.from(zlib.zstdCompressSync(noisy(300_000), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1, [zlib.constants.ZSTD_c_contentSizeFlag]: 1 } }));
    z[z.length - 2]! ^= 0xff;
    const dir = destDir();
    const errs: string[] = [];
    expect(await copyIfLarger(file(z), join(dir, "x.jsonl"), (e) => errs.push(e.message))).toBe("failed");
    expect(errs.join()).toContain("checksum");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("sweepStaleTmp：只删超过 1 小时的本模块临时文件", async () => {
    const dir = destDir();
    for (const f of ["a.jsonl.tmp-123-1700000000000", "b.jsonl.tmp-9-1", "keep.jsonl", "c.jsonl.tmp-note"]) writeFileSync(join(dir, f), "x");
    writeFileSync(join(dir, "fresh.jsonl.tmp-1-2"), "x");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const f of ["a.jsonl.tmp-123-1700000000000", "b.jsonl.tmp-9-1", "keep.jsonl", "c.jsonl.tmp-note"]) utimesSync(join(dir, f), old, old);
    expect(await sweepStaleTmp(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["c.jsonl.tmp-note", "fresh.jsonl.tmp-1-2", "keep.jsonl"]);
    expect(await sweepStaleTmp(join(dir, "nope"))).toBe(0);
  });

  test("没声明大小的正常流：解完再比，更大才落盘", async () => {
    const dir = destDir();
    const dest = join(dir, "x.jsonl");
    const src = file(await streamCompress(Buffer.from("a\nb\n")));
    expect(await copyIfLarger(src, dest)).toBe("copied");
    expect(readFileSync(dest, "utf8")).toBe("a\nb\n");
    expect(await copyIfLarger(src, dest)).toBe("same");
    expect(existsSync(dest)).toBe(true);
    expect(readdirSync(dir)).toEqual(["x.jsonl"]);
  });
});

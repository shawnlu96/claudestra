/**
 * lib/zstd-file.ts + copyIfLarger 的 .zst 路径：不整份解进内存、声明大小不超过已有归档时不解、解压炸弹中止且不留临时文件。
 * .zst 都在临时目录里现造（Bun 压缩带帧头大小；node:zlib 的流式压缩不带；手搓帧用来造「声明大小与内容不符」）。
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { copyIfLarger } from "../src/lib/archive-copy.js";
import { readZstdFirstLine, zstdContentSize } from "../src/lib/zstd-file.js";
import { streamCompress, zstdFrame } from "./zstd-test-kit.js";

const base = mkdtempSync(join(tmpdir(), "zstd-file-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const file = (data: Uint8Array | string) => {
  const p = join(base, `f-${++n}.jsonl.zst`);
  writeFileSync(p, data);
  return p;
};

describe("zstdContentSize：只走帧头 / 块头", () => {
  test("Bun 压缩的单帧 / 多帧拼接 / 前面带可跳过帧：声明大小之和", async () => {
    const a = Buffer.from("a".repeat(300_000) + "\n");
    const b = Buffer.from("line\n");
    expect(await zstdContentSize(file(Bun.zstdCompressSync(a)))).toBe(a.length);
    expect(await zstdContentSize(file(Buffer.concat([Bun.zstdCompressSync(a), Bun.zstdCompressSync(b)])))).toBe(a.length + b.length);
    const skip = Buffer.alloc(12);
    skip.writeUInt32LE(0x184d2a50, 0);
    skip.writeUInt32LE(4, 4);
    expect(await zstdContentSize(file(Buffer.concat([skip, Bun.zstdCompressSync(b)])))).toBe(b.length);
  });

  test("没声明大小 / 不是 zstd / 截断 / 末尾有多余字节：null", async () => {
    expect(await zstdContentSize(file(await streamCompress(Buffer.from("x\n"))))).toBeNull();
    expect(await zstdContentSize(file("not zstd at all\n"))).toBeNull();
    const z = Bun.zstdCompressSync(Buffer.from("hello\n".repeat(1000)));
    expect(await zstdContentSize(file(z.subarray(0, z.length - 3)))).toBeNull();
    expect(await zstdContentSize(file(Buffer.concat([z, Buffer.from("junk")])))).toBeNull();
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

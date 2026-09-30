/** 测试造 .zst 用（tests/zstd-file.test.ts、tests/codex-archive-read.test.ts） */
import zlib from "node:zlib";

/** 不带帧头大小的流式压缩（Codex 以外的写法 / 炸弹） */
export async function streamCompress(data: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  const c = zlib.createZstdCompress();
  c.on("data", (d: Buffer) => out.push(d));
  const done = new Promise((r) => c.on("end", r));
  c.end(data);
  await done;
  return Buffer.concat(out);
}

/** 手搓单帧：帧头声明 fcs 字节（8 字节字段，非单段、窗口 1KB），内容是一个 raw 块（≤ 1KB）。声明与内容可以故意不符 */
export function zstdFrame(fcs: number, content: Buffer): Buffer {
  const head = Buffer.alloc(14);
  head.writeUInt32LE(0xfd2fb528, 0);
  head[4] = 0xc0;
  head[5] = 0x00;
  head.writeBigUInt64LE(BigInt(fcs), 6);
  const bh = 1 | (content.length << 3);
  return Buffer.concat([head, Buffer.from([bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff]), content]);
}

const blockHeader = (last: boolean, type: number, size: number) => {
  const h = (last ? 1 : 0) | (type << 1) | (size << 3);
  return Buffer.from([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]);
};

/**
 * 单帧、结构完整、声明 total 字节的解压炸弹：首块是 raw 的 `headLine\n`（流式读首行拿得到），其余是 128KB 的 RLE 块。
 * 声明与内容一致，2GiB 也只有约 64KB
 */
export function rleBomb(headLine: string, total: number): Buffer {
  const head = Buffer.from(`${headLine}\n`);
  const fh = Buffer.alloc(14);
  fh.writeUInt32LE(0xfd2fb528, 0);
  fh[4] = 0xc0; // FCS 8 字节、非单段
  fh[5] = 0x38; // 窗口 128KB：块最大 128KB
  fh.writeBigUInt64LE(BigInt(total), 6);
  const parts = [fh, blockHeader(false, 0, head.length), head];
  for (let left = total - head.length; left > 0; ) {
    const n = Math.min(left, 128 * 1024);
    left -= n;
    parts.push(blockHeader(left === 0, 1, n), Buffer.from("x"));
  }
  return Buffer.concat(parts);
}

/** pzstd 的输出：每个数据帧前面一个 4 字节内容的可跳过帧（记下一帧的压缩后长度） */
export function pzstdLike(frames: Uint8Array[]): Buffer {
  return Buffer.concat(frames.flatMap((f) => {
    const skip = Buffer.alloc(12);
    skip.writeUInt32LE(0x184d2a50, 0);
    skip.writeUInt32LE(4, 4);
    skip.writeUInt32LE(f.length, 8);
    return [skip, Buffer.from(f)];
  }));
}

/** 单帧 .zst 里各块头的偏移（造「截在块头中间」用）；只认 Bun / Codex 那种带 FCS 的单帧 */
export function blockHeaderOffsets(z: Buffer): number[] {
  const fhd = z[4]!;
  const single = (fhd >> 5) & 1;
  const fcsFlag = fhd >> 6;
  const fcsSize = fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag]!;
  let p = 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3]! + fcsSize;
  const out: number[] = [];
  for (;;) {
    out.push(p);
    const h = z[p]! | (z[p + 1]! << 8) | (z[p + 2]! << 16);
    p += 3 + (((h >> 1) & 3) === 1 ? 1 : h >>> 3);
    if (h & 1) return out;
  }
}

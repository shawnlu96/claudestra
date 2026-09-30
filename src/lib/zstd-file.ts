/**
 * 读 Codex 压缩的 rollout（`.jsonl.zst`，标准 zstd 流）而不把整份解进内存：归档在 bridge 进程的每日 sweep 里跑，
 * 同步全量解压会卡住事件循环、内存随解压后大小线性涨（10KB 的 .zst 能解成 400MB）。
 *   zstdContentSize     只走帧头 / 块头，求解压后总大小（Codex 压缩时 set_pledged_src_size，帧头带大小）；不解压
 *   readZstdFirstLine   流式解到第一个换行为止，封顶 max
 *   decompressZstdToFile 流式解到文件，超过 max 中止
 * 格式依据 RFC 8878（zstd 帧格式）。tests/zstd-file.test.ts
 */
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

/** 分窗顺序读：块头只有 3 字节，块内容直接跳过，不读 */
async function windowReader(path: string) {
  const fh = await open(path, "r");
  const size = (await fh.stat()).size;
  let win = Buffer.alloc(0);
  let winPos = 0;
  const at = async (pos: number, n: number): Promise<Buffer | null> => {
    if (pos + n > size) return null;
    if (pos < winPos || pos + n > winPos + win.length) {
      win = Buffer.alloc(Math.max(n, 64 * 1024));
      const { bytesRead } = await fh.read(win, 0, win.length, pos);
      win = win.subarray(0, bytesRead);
      winPos = pos;
    }
    return win.subarray(pos - winPos, pos - winPos + n);
  };
  return { size, at, close: () => fh.close() };
}

/**
 * 各帧声明的解压后大小之和。任一帧没声明大小、帧结构不对、末尾有多余字节 → null（调用方只能真解压）。
 * 声明大小由压缩方写入，解压时 zstd 会核对；这里只拿它决定「要不要解」，不据此落盘。
 */
export async function zstdContentSize(path: string): Promise<number | null> {
  const r = await windowReader(path);
  try {
    let pos = 0;
    let total = 0;
    while (pos < r.size) {
      const head = await r.at(pos, 4);
      if (!head) return null;
      const magic = head.readUInt32LE(0);
      if ((magic & 0xfffffff0) === 0x184d2a50) { // 可跳过帧：4 字节长度 + 内容
        const len = await r.at(pos + 4, 4);
        if (!len) return null;
        pos += 8 + len.readUInt32LE(0);
        continue;
      }
      if (magic !== ZSTD_MAGIC) return null;
      const fhd = (await r.at(pos + 4, 1))?.[0];
      if (fhd === undefined || fhd & 0x08) return null; // 保留位必须是 0
      const single = (fhd >> 5) & 1;
      const fcsFlag = fhd >> 6;
      const fcsSize = fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag]!;
      if (fcsSize === 0) return null;
      const fcsPos = pos + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3]!;
      const fcs = await r.at(fcsPos, fcsSize);
      if (!fcs) return null;
      total += fcsSize === 1 ? fcs[0]! : fcsSize === 2 ? fcs.readUInt16LE(0) + 256 : fcsSize === 4 ? fcs.readUInt32LE(0) : Number(fcs.readBigUInt64LE(0));
      let p = fcsPos + fcsSize;
      for (;;) {
        const bh = await r.at(p, 3);
        if (!bh) return null;
        const h = bh[0]! | (bh[1]! << 8) | (bh[2]! << 16);
        const type = (h >> 1) & 3;
        if (type === 3) return null;
        p += 3 + (type === 1 ? 1 : h >>> 3); // RLE 块内容只有 1 字节
        if (p > r.size) return null;
        if (h & 1) break;
      }
      pos = p + ((fhd >> 2) & 1 ? 4 : 0); // 内容校验和
    }
    return pos === r.size ? total : null;
  } finally {
    await r.close();
  }
}

export type ZstdFirstLine = { kind: "line" | "eof"; text: string } | { kind: "too-long" } | { kind: "error"; message: string };

/** 流式解压到第一个换行；解出 max 字节还没换行 = too-long。拿到就销毁流，不解后面的 */
export function readZstdFirstLine(path: string, max: number): Promise<ZstdFirstLine> {
  return new Promise((resolve) => {
    const src = createReadStream(path);
    const dec = zlib.createZstdDecompress();
    const chunks: Buffer[] = [];
    let got = 0;
    let done = false;
    const finish = (r: ZstdFirstLine) => {
      if (done) return;
      done = true;
      src.destroy();
      dec.destroy();
      resolve(r);
    };
    const fail = (e: Error) => finish({ kind: "error", message: e.message });
    src.on("error", fail);
    dec.on("error", fail);
    dec.on("data", (c: Buffer) => {
      const nl = c.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(c.subarray(0, nl));
        return got + nl <= max ? finish({ kind: "line", text: Buffer.concat(chunks).toString("utf8") }) : finish({ kind: "too-long" });
      }
      chunks.push(c);
      got += c.length;
      if (got > max) finish({ kind: "too-long" });
    });
    dec.on("end", () => finish({ kind: "eof", text: Buffer.concat(chunks).toString("utf8") }));
    src.pipe(dec);
  });
}

/** 流式解压 src 写到 dest（调用方给临时路径、负责失败时删掉）；解出超过 max 字节就中止并抛错。返回解压后字节数 */
export async function decompressZstdToFile(src: string, dest: string, max: number): Promise<number> {
  let n = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      cb(n > max ? new Error(`.zst 解压超过上限 ${max} 字节`) : null, n > max ? undefined : chunk);
    },
  });
  await pipeline(createReadStream(src), zlib.createZstdDecompress(), limit, createWriteStream(dest));
  return n;
}

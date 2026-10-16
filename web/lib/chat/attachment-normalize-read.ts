/**
 * 读附件的整份字节：依次试 a FileReader / b File.arrayBuffer / c fetch(blob URL) / d 300ms 后再用 a，第一种读通就停。
 * 微信 Mac 版复制的图片交给 Chrome 的 File 会拒绝 slice().arrayBuffer()，别的网站却能读，差别只可能在读法或时机；
 * a 必须在 paste 回调里同步发起（调用链上不能先 await），否则可能错过来源 app 交出文件的那个时机。
 * 只记 DOMException 名进诊断，不记 message（可能带路径）。用例：tests/web-attachment-normalize-read.test.ts。
 */

export type ReadMethod = "a" | "b" | "c" | "d";
export type ReadOutcome = { ok: true; bytes: ArrayBuffer; via: ReadMethod } | { ok: false; errors: string[] };

/** 四种读法的底层调用；测试替换成会拒 / 会挂起的假实现 */
export interface ReadDeps {
  fileReader(f: File): Promise<ArrayBuffer>;
  whole(f: File): Promise<ArrayBuffer>;
  blobUrl(f: File): Promise<ArrayBuffer>;
  wait(ms: number): Promise<void>;
}

export const RETRY_DELAY_MS = 300;

/** 根目录 tsc 只有 ESNext + Bun 类型，没有 DOM 的 FileReader 声明（Bun 运行时也没有这个全局） */
interface FileReaderLike {
  result: unknown;
  error: unknown;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsArrayBuffer(f: File): void;
}

function readWithFileReader(f: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const Ctor = (globalThis as unknown as { FileReader?: new () => FileReaderLike }).FileReader;
    if (!Ctor) throw new DOMException("FileReader unavailable", "NotSupportedError");
    const r = new Ctor();
    r.onload = () => (r.result instanceof ArrayBuffer ? resolve(r.result) : reject(new DOMException("no result", "NotReadableError")));
    r.onerror = () => reject(r.error ?? new DOMException("read failed", "NotReadableError"));
    r.readAsArrayBuffer(f);
  });
}

async function readViaBlobUrl(f: File): Promise<ArrayBuffer> {
  const url = URL.createObjectURL(f);
  try {
    return await (await fetch(url)).arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const browserReadDeps: ReadDeps = {
  fileReader: readWithFileReader,
  whole: (f) => f.arrayBuffer(),
  blobUrl: readViaBlobUrl,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** 错误只留类型名（NotReadableError / NotFoundError / SecurityError …），名字之外的字符一律去掉 */
export function errorName(e: unknown): string {
  const n = e instanceof Error || e instanceof DOMException ? e.name : "";
  return n.replace(/[^A-Za-z]/g, "").slice(0, 40) || "?";
}

/**
 * 依次试四种读法。a 在调用这一刻同步发起（发起前没有 await），调用方（paste 回调 → AttachmentIntake.run →
 * normalizeAttachment）一路都在各自第一个 await 之前调到这里；把 a 挪进 async 段会错过 paste 回调的时机。
 */
export function readAllBytes(f: File, deps: ReadDeps = browserReadDeps): Promise<ReadOutcome> {
  const errors: string[] = [];
  const attempt = (via: ReadMethod, run: () => Promise<ArrayBuffer>): Promise<ReadOutcome | null> => {
    let p: Promise<ArrayBuffer>;
    try {
      p = run();
    } catch (e) {
      p = Promise.reject(e); // 同步抛（构造不了 FileReader 等）与异步拒一视同仁，记进诊断
    }
    return p.then((bytes): ReadOutcome => ({ ok: true, bytes, via }), (e: unknown) => (errors.push(errorName(e)), null));
  };
  const first = attempt("a", () => deps.fileReader(f));
  return (async () => {
    const steps: [ReadMethod, () => Promise<ArrayBuffer>][] = [
      ["b", () => deps.whole(f)],
      ["c", () => deps.blobUrl(f)],
      ["d", async () => (await deps.wait(RETRY_DELAY_MS), deps.fileReader(f))],
    ];
    let r = await first;
    for (const [via, run] of steps) {
      if (r) return r;
      r = await attempt(via, run);
    }
    return r ?? { ok: false, errors };
  })();
}

/** 诊断里的可读状态：empty（0 字节没读）/ untested（超限没读）/ ok:<哪种读通> / fail:<各读法的错误名> */
export type ReadState = "empty" | "untested" | `ok:${ReadMethod}` | `fail:${string}`;

export function readState(o: ReadOutcome): ReadState {
  return o.ok ? `ok:${o.via}` : `fail:${o.errors.join(",")}`;
}

/**
 * WXPASTE2C：微信 Mac 版复制的图片，Chrome 交出的 File 拒绝 slice().arrayBuffer()。附件改由
 * web/lib/chat/attachment-normalize-read.ts 依次试 a FileReader / b arrayBuffer / c fetch(blob URL) / d 300ms 后再 a；
 * 诊断行记哪种读通或各自的错误名，每次粘贴经 log（hook 里接 postClientLog）回传一次。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NO_CONTENT_HINT, normalizeAttachment } from "@/lib/chat/attachment-normalize";
import { RETRY_DELAY_MS, browserReadDeps, errorName, readAllBytes, type ReadDeps } from "@/lib/chat/attachment-normalize-read";
import { AttachmentIntake, handlePaste, type AttachNotice } from "@/lib/chat/attachment-normalize-queue";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 7, 7, 7];
/** 错误 message 里故意放路径和文件名：诊断只许出现错误名 */
const SECRET = "/Users/someone/Library/Containers/com.tencent.xinWeChat/私密名字.png";
const domErr = (name: string) => new DOMException(`could not read ${SECRET}`, name);
const ab = (a: number[]) => new Uint8Array(a).buffer as ArrayBuffer;

/** 模拟微信交来的 File：slice().arrayBuffer() 与 arrayBuffer() 都拒 */
function wechatFile(bytes: number[], name = "私密名字", type = "image/png"): File {
  const f = new File([new Uint8Array(bytes)], name, { type });
  const boom = () => Promise.reject(domErr("NotReadableError"));
  Object.defineProperty(f, "slice", { value: () => ({ arrayBuffer: boom }) });
  Object.defineProperty(f, "arrayBuffer", { value: boom });
  return f;
}

type Step = ArrayBuffer | string; // 字符串 = 以该名字拒绝
const settle = (s: Step) => (typeof s === "string" ? Promise.reject(domErr(s)) : Promise.resolve(s));

/** 可控读法：fileReader 按调用次序取 a / d 的结果；记录每次调用与等待时长 */
function fakeDeps(o: { a: Step; b: Step; c: Step; d?: Step }) {
  const calls: string[] = [];
  const waits: number[] = [];
  let readerCalls = 0;
  const deps: ReadDeps = {
    fileReader: () => (calls.push(readerCalls ? "d" : "a"), settle(readerCalls++ ? o.d ?? "NotReadableError" : o.a)),
    whole: () => (calls.push("b"), settle(o.b)),
    blobUrl: () => (calls.push("c"), settle(o.c)),
    wait: async (ms) => void waits.push(ms),
  };
  return { deps, calls, waits };
}

function sink() {
  const s = { added: [] as File[][], notices: [] as (AttachNotice | null)[], logs: [] as string[] };
  return { s, sink: { addFiles: (f: File[]) => s.added.push(f), setNotice: (n: AttachNotice | null) => s.notices.push(n), log: (l: string) => s.logs.push(l) } };
}

/** ClipboardEvent 里用得到的部分 */
function pasteEvent(o: { files?: File[]; text?: string }) {
  const files = o.files ?? [];
  const ev = {
    prevented: false,
    clipboardData: {
      types: [...(files.length ? ["Files"] : []), ...(o.text ? ["text/plain"] : [])],
      items: [...files.map((f) => ({ kind: "file", type: f.type })), ...(o.text ? [{ kind: "string", type: "text/plain" }] : [])],
      files,
      getData: (t: string) => (t === "text/plain" ? o.text ?? "" : ""),
    },
    preventDefault: () => void (ev.prevented = true),
  };
  return ev;
}

const bytesOf = async (f: File) => [...new Uint8Array(await f.arrayBuffer())];

describe("[验收线 1] slice() 被拒、FileReader 能读 → 收下", () => {
  test("附件进待发列表、字节一致、不出提示，诊断 ok:a；FileReader 在 paste 回调里同步发起", async () => {
    const { s, sink: sk } = sink();
    const fd = fakeDeps({ a: ab(PNG), b: "NotReadableError", c: "NotReadableError" });
    const intake = new AttachmentIntake(sk, fd.deps);
    const f = wechatFile(PNG);
    const pending = handlePaste(pasteEvent({ files: [f] }), { intake, log: sk.log, otherInputFocused: () => false, focusComposer: () => {} });
    expect(fd.calls).toEqual(["a"]); // 还没 await 任何东西就已发起
    await pending;
    expect(s.added.length).toBe(1);
    expect(await bytesOf(s.added[0][0])).toEqual(PNG);
    expect(s.added[0][0].type).toBe("image/png");
    expect(s.notices).toEqual([null]);
    expect(s.logs.length).toBe(1);
    expect(s.logs[0]).toContain("/ok:a");
    expect(fd.calls).toEqual(["a"]); // 第一种读通就停
  });
  test("默认读法在 Bun 下：没有 FileReader → a 记 NotSupportedError，b 被拒，c（blob URL）读通且 URL 用完 revoke", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const [origCreate, origRevoke] = [URL.createObjectURL, URL.revokeObjectURL];
    URL.createObjectURL = (b: Blob) => (created.push(origCreate(b)), created[created.length - 1]);
    URL.revokeObjectURL = (u: string) => (revoked.push(u), origRevoke(u));
    try {
      const r = await normalizeAttachment(wechatFile(PNG, "图片", ""), browserReadDeps);
      expect(r.ok && [r.diag.readable, r.file.type, r.file.name]).toEqual(["ok:c", "image/png", "图片.png"]);
      expect(r.ok && (await bytesOf(r.file))).toEqual(PNG);
      expect(revoked).toEqual(created);
      expect(created.length).toBe(1);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});

describe("[验收线 2] 300ms 后再试 / 四种全拒", () => {
  test("a、b、c 都拒，等 300ms 后 d 能读 → 收下，诊断 ok:d", async () => {
    const fd = fakeDeps({ a: "NotReadableError", b: "NotFoundError", c: "SecurityError", d: ab(PNG) });
    const r = await normalizeAttachment(wechatFile(PNG), fd.deps);
    expect(r.ok).toBe(true);
    expect(r.diag.readable).toBe("ok:d");
    expect(fd.calls).toEqual(["a", "b", "c", "d"]);
    expect(fd.waits).toEqual([RETRY_DELAY_MS]);
    expect(RETRY_DELAY_MS).toBe(300);
  });
  test("四种全拒 → 原提示，诊断 fail: 加各自错误名，不带 message 里的路径 / 文件名", async () => {
    const { s, sink: sk } = sink();
    const fd = fakeDeps({ a: "NotReadableError", b: "NotFoundError", c: "SecurityError", d: "NotReadableError" });
    const f = wechatFile(PNG);
    await handlePaste(pasteEvent({ files: [f] }), { intake: new AttachmentIntake(sk, fd.deps), log: sk.log, otherInputFocused: () => false, focusComposer: () => {} });
    expect(s.added).toEqual([]);
    expect(s.notices.length).toBe(1);
    expect(s.notices[0]?.hint).toBe(NO_CONTENT_HINT);
    expect(s.logs[0]).toContain("/fail:NotReadableError,NotFoundError,SecurityError,NotReadableError");
    expect(s.notices[0]?.diag).toBe(s.logs[0]);
    expect(s.logs[0]).not.toMatch(/私密|Users|xinWeChat|could not/);
  });
  test("同步抛错与非 Error 的拒绝也记成名字；名字之外的字符去掉", async () => {
    const deps: ReadDeps = {
      fileReader: () => {
        throw new TypeError("boom /a/b");
      },
      whole: () => Promise.reject("plain string /a/b"),
      blobUrl: () => Promise.reject(new DOMException("x", "Not Readable-Error")),
      wait: async () => {},
    };
    expect(await readAllBytes(new File([new Uint8Array(PNG)], "x"), deps)).toEqual({ ok: false, errors: ["TypeError", "?", "NotReadableError", "TypeError"] });
    expect(errorName(undefined)).toBe("?");
  });
  test("0 字节记 empty、超 10MB 记 untested，都不读", async () => {
    const fd = fakeDeps({ a: ab(PNG), b: ab(PNG), c: ab(PNG) });
    expect((await normalizeAttachment(new File([], "e.png", { type: "image/png" }), fd.deps)).diag.readable).toBe("empty");
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    const r = await normalizeAttachment(big, fd.deps);
    expect(r).toMatchObject({ ok: false, reason: "too_large" });
    expect(r.diag.readable).toBe("untested");
    expect(fd.calls).toEqual([]);
  });
});

describe("[验收线 3] 一次粘贴两个文件：一个可读、一个读不出", () => {
  test("可读的收下，读不出的给提示", async () => {
    const { s, sink: sk } = sink();
    const good = new File([new Uint8Array(PNG)], "good.png", { type: "image/png" });
    const bad = wechatFile(PNG, "bad.png");
    const pick = (f: File, ok: () => Promise<ArrayBuffer>) => (f === bad ? Promise.reject(domErr("NotReadableError")) : ok());
    const deps: ReadDeps = {
      fileReader: (f) => pick(f, () => Promise.resolve(ab(PNG))),
      whole: (f) => pick(f, () => f.arrayBuffer()),
      blobUrl: (f) => pick(f, () => f.arrayBuffer()),
      wait: async () => {},
    };
    await handlePaste(pasteEvent({ files: [good, bad] }), { intake: new AttachmentIntake(sk, deps), log: sk.log, otherInputFocused: () => false, focusComposer: () => {} });
    expect(s.added.map((g) => g.map((f) => f.name))).toEqual([["good.png"]]);
    expect(s.notices[0]?.hint).toBe(NO_CONTENT_HINT);
    expect(s.logs[0]).toContain("/ok:a;image/png/");
    expect(s.logs[0]).toContain("/fail:NotReadableError,NotReadableError,NotReadableError,NotReadableError");
  });
});

describe("[验收线 4] 每次粘贴恰好回传一行诊断，不含文件名、路径、内容", () => {
  test("收附件 / 纯文字 / 焦点在别的输入框：各记一次", async () => {
    const fd = fakeDeps({ a: ab(PNG), b: ab(PNG), c: ab(PNG) });
    const logs: string[] = [];
    const log = (l: string) => void logs.push(l); // hook 里 intake 与 handlePaste 用的是同一个 pasteLog
    const ctx = (other: boolean) => ({ intake: new AttachmentIntake({ ...sink().sink, log }, fd.deps), log, otherInputFocused: () => other, focusComposer: () => {} });
    const withFile = pasteEvent({ files: [wechatFile(PNG)] });
    await handlePaste(withFile, ctx(false));
    expect([logs.length, withFile.prevented]).toEqual([1, true]);
    const text = pasteEvent({ text: "一段私密文字" });
    expect(handlePaste(text, ctx(false))).toBeNull();
    expect([logs.length, text.prevented]).toEqual([2, false]);
    const elsewhere = pasteEvent({ files: [wechatFile(PNG)] });
    expect(handlePaste(elsewhere, ctx(true))).toBeNull();
    expect([logs.length, elsewhere.prevented]).toEqual([3, false]);
    for (const l of logs) {
      expect(l.startsWith("[paste-diag] ")).toBe(true);
      expect(l).not.toMatch(/私密|Users|xinWeChat|\.png\b|file:\/\//);
    }
  });
  test("hook 把这一行同时交给 console 和 postClientLog（web/lib/client-log.ts），粘贴入口只挂 handlePaste", () => {
    const src = readFileSync(join(import.meta.dir, "../web/lib/chat/attachment-normalize-intake.ts"), "utf8");
    expect(src).toMatch(/function pasteLog\(line: string\): void \{\s*console\.info\(line\);\s*postClientLog\(line\);\s*\}/);
    expect(src).toContain("log: pasteLog");
    expect(src).toContain("void handlePaste(e, ctx)");
  });
});

describe("[验收线 5] 不读系统剪贴板", () => {
  test("附件入口模块里没有 navigator.clipboard.read", () => {
    const dir = join(import.meta.dir, "../web/lib/chat");
    const mods = readdirSync(dir).filter((n) => n.startsWith("attachment-normalize"));
    expect(mods.length).toBeGreaterThanOrEqual(5);
    for (const n of mods) expect(readFileSync(join(dir, n), "utf8")).not.toMatch(/clipboard\s*\.\s*read/);
  });
});

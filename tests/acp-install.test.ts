import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CODEX_ACP_SHA256, codexAcpEntry, codexAcpInstalled, extractTarEntry, installCodexAcp, sha256Hex } from "../src/lib/acp/install.ts";

/** 造一个最小的 ustar：每个文件一个 512 字节头 + 按 512 补齐的内容，末尾两个空块 */
function tar(files: { name: string; body: string; type?: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    const body = enc.encode(f.body);
    const h = new Uint8Array(512);
    h.set(enc.encode(f.name).subarray(0, 100), 0);
    h.set(enc.encode(body.length.toString(8).padStart(11, "0")), 124);
    h.set(enc.encode(f.type ?? "0"), 156);
    h.set(enc.encode("ustar"), 257);
    blocks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of blocks) (out.set(b, off), (off += b.length));
  return out;
}

const PKG = [
  { name: "package/LICENSE", body: "Apache-2.0" },
  { name: "package/dist", body: "", type: "5" },
  { name: "package/dist/index.js", body: "console.log('codex-acp stub');" },
];

let root = "";
afterEach(() => root && rmSync(root, { recursive: true, force: true }));
const fresh = () => (root = mkdtempSync(join(tmpdir(), "acp-install-")));
const served = (buf: Uint8Array, status = 200) => async () => ({ ok: status === 200, status, arrayBuffer: async () => Uint8Array.from(buf).buffer });

describe("extractTarEntry", () => {
  test("按完整名字取普通文件；目录项、不在包里的名字返回 null", () => {
    const t = tar(PKG);
    expect(new TextDecoder().decode(extractTarEntry(t, "package/dist/index.js")!)).toBe("console.log('codex-acp stub');");
    expect(extractTarEntry(t, "package/dist")).toBeNull();
    expect(extractTarEntry(t, "../etc/passwd")).toBeNull();
  });
});

describe("installCodexAcp（版本钉死、sha256 校验不过就拒装）", () => {
  test("生产路径的 sha256 就是写死的那个", () => {
    expect(CODEX_ACP_SHA256).toBe("a8d48bdf70c0e3e585abbdce19f78765450d8fa6ada1da0fd53508e64315905b");
  });

  test("sha256 对不上：拒装、不落任何文件", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    const r = await installCodexAcp({ fetch: served(tgz), root });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("sha256 对不上");
    expect(codexAcpInstalled(root).ok).toBe(false);
  });

  test("校验通过：只解出 dist/index.js，记下两份哈希；再装一次直接复用", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    const expectSha256 = sha256Hex(tgz);
    const r = await installCodexAcp({ fetch: served(tgz), root, expectSha256 });
    expect(r).toEqual({ ok: true, path: codexAcpEntry(root), reused: false });
    expect(codexAcpInstalled(root, expectSha256).ok).toBe(true);
    let fetched = 0;
    const again = await installCodexAcp({ fetch: async () => (fetched++, served(tgz)()), root, expectSha256 });
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(fetched).toBe(0);
  });

  test("装好后入口被改过：不再算已装", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    const expectSha256 = sha256Hex(tgz);
    await installCodexAcp({ fetch: served(tgz), root, expectSha256 });
    writeFileSync(codexAcpEntry(root), "process.exit(0) // tampered");
    const st = codexAcpInstalled(root, expectSha256);
    expect(st.ok).toBe(false);
    expect(!st.ok && st.hint).toContain("acp-install");
  });

  test("HTTP 失败 / 网络异常 / 包里没有入口：都报错不落盘", async () => {
    fresh();
    expect(await installCodexAcp({ fetch: served(new Uint8Array(), 404), root })).toMatchObject({ ok: false });
    expect(await installCodexAcp({ fetch: async () => Promise.reject(new Error("ENOTFOUND")), root })).toMatchObject({ ok: false });
    const noEntry = gzipSync(tar([{ name: "package/README.md", body: "x" }]));
    const r = await installCodexAcp({ fetch: served(noEntry), root, expectSha256: sha256Hex(noEntry) });
    expect(!r.ok && r.error).toContain("没有 package/dist/index.js");
  });
});

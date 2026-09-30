import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  codexAcpInstalled, codexPairsWithAdapter, currentCodexAcp, ensureCodexAcpFor, extractTarEntry, installCodexAcp, sha256Hex, sha512Integrity, useCodexAcp,
} from "../src/lib/acp/install.ts";
import type { AcpRelease } from "../src/lib/acp/resolve.ts";

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

const T = "https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-";
const release = (version: string, codexRange: string, tgz: Uint8Array): AcpRelease => ({ version, codexRange, integrity: sha512Integrity(tgz), tarball: `${T}${version}.tgz` });
const entry = (version: string) => join(root, `codex-acp-${version}`, "index.js");

describe("installCodexAcp（按 registry 的 integrity 验包，装进版本目录，不切指针）", () => {
  test("integrity 对不上：拒装、不落任何文件", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    const rel = { ...release("2.0.1", "^0.159.1", tgz), integrity: sha512Integrity(new Uint8Array([1, 2, 3])) };
    const r = await installCodexAcp(rel, { fetch: served(tgz), root });
    expect(!r.ok && r.error).toContain("integrity");
    expect(existsSync(entry("2.0.1"))).toBe(false);
    expect(codexAcpInstalled(root).ok).toBe(false);
  });

  test("校验通过：只解出 dist/index.js、记下 integrity 和配套范围；不切指针；再装一次直接复用", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    const rel = release("2.0.1", "^0.159.1", tgz);
    const r = await installCodexAcp(rel, { fetch: served(tgz), root });
    expect(r).toEqual({ ok: true, path: entry("2.0.1"), reused: false, version: "2.0.1", codexRange: "^0.159.1" });
    expect(JSON.parse(readFileSync(join(root, "codex-acp-2.0.1", "installed.json"), "utf8"))).toMatchObject({ integrity: rel.integrity, codexRange: "^0.159.1" });
    expect(currentCodexAcp(root)).toBeNull();
    let fetched = 0;
    const again = await installCodexAcp(rel, { fetch: async () => (fetched++, served(tgz)()), root });
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(fetched).toBe(0);
  });

  test("HTTP 失败 / 网络异常 / 包里没有入口：都报错不落盘", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    expect(await installCodexAcp(release("2.0.1", "^0.159.1", tgz), { fetch: served(new Uint8Array(), 404), root })).toMatchObject({ ok: false });
    expect(await installCodexAcp(release("2.0.1", "^0.159.1", tgz), { fetch: async () => Promise.reject(new Error("ENOTFOUND")), root })).toMatchObject({ ok: false });
    const noEntry = gzipSync(tar([{ name: "package/README.md", body: "x" }]));
    const r = await installCodexAcp(release("2.0.1", "^0.159.1", noEntry), { fetch: served(noEntry), root });
    expect(!r.ok && r.error).toContain("没有 package/dist/index.js");
  });
});

describe("指针：当前用哪个版本", () => {
  test("原子切换：切过去即生效，旧版本目录留着、指回去即回退；切换不留 tmp", async () => {
    fresh();
    const a = gzipSync(tar(PKG));
    const b = gzipSync(tar([{ name: "package/dist/index.js", body: "console.log('2.0.1');" }]));
    await installCodexAcp(release("2.0.0", "^0.158.0", a), { fetch: served(a), root });
    await installCodexAcp(release("2.0.1", "^0.159.1", b), { fetch: served(b), root });
    useCodexAcp("2.0.1", root);
    expect(codexAcpInstalled(root)).toEqual({ ok: true, path: entry("2.0.1"), version: "2.0.1", codexRange: "^0.159.1" });
    expect(existsSync(join(root, "current.json.tmp"))).toBe(false);
    useCodexAcp("2.0.0", root);
    expect(codexAcpInstalled(root)).toMatchObject({ ok: true, version: "2.0.0" });
  });

  test("指针指向没装的版本：不算已装", () => {
    fresh();
    useCodexAcp("9.9.9", root);
    expect(codexAcpInstalled(root)).toMatchObject({ ok: false });
  });

  test("装好后入口被改过：不再算已装", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    await ensureCodexAcpFor("0.159.2", { fetch: served(tgz), fetchMeta: meta({ "2.0.1": release("2.0.1", "^0.159.1", tgz) }), root });
    writeFileSync(entry("2.0.1"), "process.exit(0) // tampered");
    const st = codexAcpInstalled(root);
    expect(st.ok).toBe(false);
    expect(!st.ok && st.hint).toContain("acp-install");
  });

  test("老 2.0.0 安装（没有指针、标记里只有 sha256）：照样判已装，配套范围 ^0.158.0", () => {
    fresh();
    const body = "console.log('codex-acp 2.0.0');";
    mkdirSync(join(root, "codex-acp-2.0.0"), { recursive: true });
    writeFileSync(entry("2.0.0"), body);
    const legacy = { version: "2.0.0", sha256: "a8d48bdf70c0e3e585abbdce19f78765450d8fa6ada1da0fd53508e64315905b", entrySha256: sha256Hex(new TextEncoder().encode(body)) };
    writeFileSync(join(root, "codex-acp-2.0.0", "installed.json"), JSON.stringify(legacy));
    expect(codexAcpInstalled(root)).toEqual({ ok: true, path: entry("2.0.0"), version: "2.0.0", codexRange: "^0.158.0" });
    expect(codexPairsWithAdapter("0.158.0", root)).toBe(true);
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(false);
  });
});

/** registry 元数据：版本 → 已知 release */
const meta = (vs: Record<string, AcpRelease>) => async () => ({
  ok: true, status: 200,
  json: async () => ({
    versions: Object.fromEntries(Object.entries(vs).map(([v, r]) => [v, { dependencies: { "@openai/codex": r.codexRange }, dist: { integrity: r.integrity, tarball: r.tarball } }])),
  }),
});

describe("配套判断读自当前适配器的标记", () => {
  test("0.158.0 配 2.0.0，0.159.2 配 2.0.1；没装适配器不拦", async () => {
    fresh();
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(true);
    const a = gzipSync(tar(PKG));
    const b = gzipSync(tar([{ name: "package/dist/index.js", body: "console.log('2.0.1');" }]));
    const vs = { "2.0.0": release("2.0.0", "^0.158.0", a), "2.0.1": release("2.0.1", "^0.159.1", b) };
    const byUrl = async (u: string) => served(u.endsWith("2.0.0.tgz") ? a : b)();
    expect(await ensureCodexAcpFor("0.158.0", { fetch: byUrl, fetchMeta: meta(vs), root })).toMatchObject({ ok: true, version: "2.0.0" });
    expect(codexPairsWithAdapter("0.158.0", root)).toBe(true);
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(false);
    expect(await ensureCodexAcpFor("0.159.2", { fetch: byUrl, fetchMeta: meta(vs), root })).toMatchObject({ ok: true, version: "2.0.1" });
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(true);
    expect(codexPairsWithAdapter("0.158.0", root)).toBe(false);
  });

  test("ensureCodexAcpFor：解析不到 / 读不出版本 / 离线 都报错且不动指针", async () => {
    fresh();
    const a = gzipSync(tar(PKG));
    const vs = { "2.0.0": release("2.0.0", "^0.158.0", a) };
    expect(await ensureCodexAcpFor("0.161.0", { fetch: served(a), fetchMeta: meta(vs), root })).toMatchObject({ ok: false });
    expect(await ensureCodexAcpFor(undefined, { fetch: served(a), fetchMeta: meta(vs), root })).toMatchObject({ ok: false });
    expect(await ensureCodexAcpFor("0.158.0", { fetch: served(a), fetchMeta: async () => Promise.reject(new Error("offline")), root })).toMatchObject({ ok: false });
    expect(currentCodexAcp(root)).toBeNull();
  });
});

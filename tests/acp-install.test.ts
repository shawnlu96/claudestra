import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  codexAcpInstalled, codexPairsWithAdapter, currentCodexAcp, reconcileCodexAcp, extractTarEntry, installCodexAcp, tmpName, sha256Hex, sha512Integrity, useCodexAcp,
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
const served = (buf: Uint8Array, status = 200) => async () => new Response(Uint8Array.from(buf), { status });

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
    expect(existsSync(join(root, "current.json"))).toBe(false); // 不切指针（单独一个非 2.0.0 目录、没指针 = broken，见 R2-①）
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
    await useCodexAcp("2.0.1", root);
    expect(codexAcpInstalled(root)).toEqual({ ok: true, path: entry("2.0.1"), version: "2.0.1", codexRange: "^0.159.1" });
    expect(existsSync(join(root, "current.json.tmp"))).toBe(false);
    await useCodexAcp("2.0.0", root);
    expect(codexAcpInstalled(root)).toMatchObject({ ok: true, version: "2.0.0" });
  });

  test("指针指向没装的版本：不算已装", async () => {
    fresh();
    await useCodexAcp("9.9.9", root);
    expect(codexAcpInstalled(root)).toMatchObject({ ok: false });
  });

  test("装好后入口被改过：不再算已装", async () => {
    fresh();
    const tgz = gzipSync(tar(PKG));
    await reconcileCodexAcp({ codexVersion: async () => "0.159.2",  fetch: served(tgz), fetchMeta: meta({ "2.0.1": release("2.0.1", "^0.159.1", tgz) }), root });
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
    expect(await reconcileCodexAcp({ codexVersion: async () => "0.158.0",  fetch: byUrl, fetchMeta: meta(vs), root })).toMatchObject({ ok: true, version: "2.0.0" });
    expect(codexPairsWithAdapter("0.158.0", root)).toBe(true);
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(false);
    expect(await reconcileCodexAcp({ codexVersion: async () => "0.159.2",  fetch: byUrl, fetchMeta: meta(vs), root })).toMatchObject({ ok: true, version: "2.0.1" });
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(true);
    expect(codexPairsWithAdapter("0.158.0", root)).toBe(false);
  });

  test("reconcileCodexAcp：解析不到 / 读不出版本 / 离线 都报错且不动指针", async () => {
    fresh();
    const a = gzipSync(tar(PKG));
    const vs = { "2.0.0": release("2.0.0", "^0.158.0", a) };
    expect(await reconcileCodexAcp({ codexVersion: async () => "0.161.0",  fetch: served(a), fetchMeta: meta(vs), root })).toMatchObject({ ok: false });
    expect(await reconcileCodexAcp({ codexVersion: async () => undefined,  fetch: served(a), fetchMeta: meta(vs), root })).toMatchObject({ ok: false });
    expect(await reconcileCodexAcp({ codexVersion: async () => "0.158.0",  fetch: served(a), fetchMeta: async () => Promise.reject(new Error("offline")), root })).toMatchObject({ ok: false });
    expect(currentCodexAcp(root)).toBeNull();
  });
});

describe("审查 r1 的加固", () => {
  const a = () => gzipSync(tar(PKG));
  const b = () => gzipSync(tar([{ name: "package/dist/index.js", body: "console.log('2.0.1');" }]));

  test("F1 current.json 损坏：判 broken（不退回 2.0.0），不算已装、不算配套；ensure 能把它修好", async () => {
    fresh();
    await installCodexAcp(release("2.0.0", "^0.158.0", a()), { fetch: served(a()), root });
    writeFileSync(join(root, "current.json"), "{not json");
    expect(currentCodexAcp(root)).toBe("broken");
    expect(codexAcpInstalled(root)).toMatchObject({ ok: false, hint: expect.stringContaining("坏了") });
    expect(codexPairsWithAdapter("0.158.0", root)).toBe(false);
    writeFileSync(join(root, "current.json"), JSON.stringify({ version: "../../etc" }));
    expect(currentCodexAcp(root)).toBe("broken");
    const tgz = b();
    expect(await reconcileCodexAcp({ codexVersion: async () => "0.159.2",  fetch: served(tgz), fetchMeta: meta({ "2.0.1": release("2.0.1", "^0.159.1", tgz) }), root }))
      .toMatchObject({ ok: true, version: "2.0.1" });
    expect(codexAcpInstalled(root)).toMatchObject({ ok: true, version: "2.0.1" });
  });

  test("F1 指针指向的版本没有标记 / 标记缺范围：broken；从没装过：null", async () => {
    fresh();
    expect(currentCodexAcp(root)).toBeNull();
    await useCodexAcp("2.0.1", root);
    expect(currentCodexAcp(root)).toBe("broken");
    mkdirSync(join(root, "codex-acp-2.0.1"), { recursive: true });
    writeFileSync(join(root, "codex-acp-2.0.1", "installed.json"), JSON.stringify({ version: "2.0.1", entrySha256: "x" }));
    expect(currentCodexAcp(root)).toBe("broken");
  });

  test("F3 tarball 不是这个版本自己的包：拒装（元数据把 2.1.0 指到 2.0.0 的包）", async () => {
    fresh();
    const tgz = a();
    const rel = { ...release("2.1.0", "^0.160.0", tgz), tarball: `${T}2.0.0.tgz` };
    const r = await installCodexAcp(rel, { fetch: served(tgz), root });
    expect(!r.ok && r.error).toContain("tarball 地址不是");
    expect(existsSync(join(root, "codex-acp-2.1.0"))).toBe(false);
  });

  test("F4 content-length 超上限：不读 body 直接拒", async () => {
    fresh();
    const tgz = a();
    let read = false;
    const body = new ReadableStream({ pull: (c) => { read = true; c.enqueue(tgz); c.close(); } }, { highWaterMark: 0 });
    const fetch = async () => new Response(body, { headers: { "content-length": String(64 * 1024 * 1024) } });
    const r = await installCodexAcp(release("2.0.1", "^0.159.1", tgz), { fetch, root });
    expect(!r.ok && r.error).toContain("远超预期");
    expect(read).toBe(false);
  });

  test("F4 没给长度、流超上限：读到超限就停", async () => {
    fresh();
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    // 20MB 后结束：读到上限就停的话只会拉 9 块左右；不计数则读完全部 20 块（测试变红而不是卡死）
    const body = new ReadableStream({ pull: (c) => (++pulled > 20 ? c.close() : c.enqueue(chunk)) }, { highWaterMark: 0 });
    const r = await installCodexAcp(release("2.0.1", "^0.159.1", a()), { fetch: async () => new Response(body), root });
    expect(!r.ok && r.error).toContain("远超预期");
    expect(pulled).toBeLessThan(12);
  });

  test("F4 integrity 对得上的解压炸弹：解开超过上限就拒", async () => {
    fresh();
    const bomb = gzipSync(new Uint8Array(40 * 1024 * 1024));
    const r = await installCodexAcp(release("2.0.1", "^0.159.1", bomb), { fetch: served(bomb), root });
    expect(!r.ok && r.error).toContain("解包失败");
  });

  test("F5 临时文件名每次不同且带 pid：manager 与 bridge 两个进程同时装同一版本也不会 rename 走对方的文件", () => {
    const [x, y] = [tmpName("/a/index.js"), tmpName("/a/index.js")];
    expect(x).not.toBe(y);
    expect(x).toContain(`.${process.pid}.`);
    expect(x.startsWith("/a/index.js.")).toBe(true); // 同目录：rename 才是原子的
  });
  test("F5 同一版本并发安装：临时文件名不撞，都成功、不留 tmp", async () => {
    fresh();
    const tgz = a();
    const rel = release("2.0.0", "^0.158.0", tgz);
    const rs = await Promise.all([1, 2, 3].map(() => installCodexAcp(rel, { fetch: served(tgz), root })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(readdirSync(join(root, "codex-acp-2.0.0")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("R2-③ 对账：挑版本期间 Codex 被别的进程升了，锁里重探发现变了就按新版本重来，最终配套磁盘上的 Codex", async () => {
    fresh();
    const [ta, tb] = [a(), b()];
    const vs = { "2.0.0": release("2.0.0", "^0.158.0", ta), "2.0.1": release("2.0.1", "^0.159.1", tb) };
    const byUrl = async (u: string) => served(u.endsWith("2.0.0.tgz") ? ta : tb)();
    // acp-install 开始时探到旧 codex 0.158.0；进锁重探时网页更新已把 codex 装成 0.159.2
    const seen = ["0.158.0", "0.159.2"];
    let probes = 0;
    const codexVersion = async () => seen[Math.min(probes++, seen.length - 1)];
    const r = await reconcileCodexAcp({ codexVersion, fetch: byUrl, fetchMeta: meta(vs), root });
    expect(r).toMatchObject({ ok: true, version: "2.0.1" });
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.1" });
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(true);
  });

  test("R2-③ 对账幂等、离线可用：registry 不通时用本地已装且完好的配套版本切指针；一个都没有才报错", async () => {
    fresh();
    const [ta, tb] = [a(), b()];
    await installCodexAcp(release("2.0.0", "^0.158.0", ta), { fetch: served(ta), root });
    await installCodexAcp(release("2.0.1", "^0.159.1", tb), { fetch: served(tb), root });
    const offline = async () => Promise.reject(new Error("offline"));
    const r = await reconcileCodexAcp({ codexVersion: async () => "0.159.2", fetchMeta: offline, root });
    expect(r).toMatchObject({ ok: true, version: "2.0.1", reused: true });
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.1" });
    expect(await reconcileCodexAcp({ codexVersion: async () => "0.159.2", fetchMeta: offline, root })).toMatchObject({ ok: true, version: "2.0.1" });
    expect(await reconcileCodexAcp({ codexVersion: async () => "0.161.0", fetchMeta: offline, root })).toMatchObject({ ok: false, error: expect.stringContaining("offline") });
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.1" });
  });

  test("R3-2 对账时 registry 的最高候选下不动：退回本地已装、完好、配套的最高版本，不报错", async () => {
    fresh();
    const [ta, tb] = [a(), b()];
    await installCodexAcp(release("2.0.0", "^0.158.0", ta), { fetch: served(ta), root });
    await installCodexAcp(release("2.0.1", "^0.159.1", tb), { fetch: served(tb), root }); // codex-update 预装的
    const newer = release("2.0.2", "^0.159.1", gzipSync(tar([{ name: "package/dist/index.js", body: "2.0.2" }])));
    const vs = { "2.0.0": release("2.0.0", "^0.158.0", ta), "2.0.1": release("2.0.1", "^0.159.1", tb), "2.0.2": newer };
    const flaky = async (u: string) => (u.endsWith("2.0.2.tgz") ? new Response("", { status: 503 }) : served(tb)());
    const r = await reconcileCodexAcp({ codexVersion: async () => "0.159.2", fetch: flaky, fetchMeta: meta(vs), root });
    expect(r).toMatchObject({ ok: true, version: "2.0.1", reused: true });
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.1" });
  });

  test("R3-2 本地配套的版本不完好（入口被改）：不拿它兜底，明确报下载失败", async () => {
    fresh();
    const tb = b();
    await installCodexAcp(release("2.0.1", "^0.159.1", tb), { fetch: served(tb), root });
    writeFileSync(entry("2.0.1"), "tampered");
    const newer = release("2.0.2", "^0.159.1", gzipSync(tar([{ name: "package/dist/index.js", body: "2.0.2" }])));
    const r = await reconcileCodexAcp({ codexVersion: async () => "0.159.2", fetch: async () => new Response("", { status: 503 }), fetchMeta: meta({ "2.0.2": newer }), root });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 503") });
    expect(existsSync(join(root, "current.json"))).toBe(false);
  });

  test("R2-③ Codex 版本一直在变：三轮后明确报错，不切", async () => {
    fresh();
    const tgz = a();
    let n = 0;
    const r = await reconcileCodexAcp({ codexVersion: async () => `0.158.${n++}`, fetch: served(tgz), fetchMeta: meta({ "2.0.0": release("2.0.0", "^0.158.0", tgz) }), root });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("一直在变") });
    expect(existsSync(join(root, "current.json"))).toBe(false);
  });

  test("F6 复用版本目录要比对配套范围：范围变了就重装、标记跟着改", async () => {
    fresh();
    const tgz = a();
    await installCodexAcp(release("2.0.0", "^0.158.0", tgz), { fetch: served(tgz), root });
    const r = await installCodexAcp(release("2.0.0", "^0.158.2", tgz), { fetch: served(tgz), root });
    expect(r).toMatchObject({ ok: true, reused: false, codexRange: "^0.158.2" });
    await useCodexAcp("2.0.0", root);
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.0", codexRange: "^0.158.2" });
  });
});

describe("审查 r2：唯一判定处 + 老安装只认单独的 2.0.0", () => {
  const a = () => gzipSync(tar(PKG));
  const b = () => gzipSync(tar([{ name: "package/dist/index.js", body: "console.log('2.0.1');" }]));
  const both = async () => {
    await installCodexAcp(release("2.0.0", "^0.158.0", a()), { fetch: served(a()), root });
    await installCodexAcp(release("2.0.1", "^0.159.1", b()), { fetch: served(b()), root });
  };

  test("R2-① 指针丢了：有 2.0.0 也有别的版本目录 → broken（不回退 2.0.0）；只有别的版本 → broken；什么都没有 → null", async () => {
    fresh();
    expect(currentCodexAcp(root)).toBeNull();
    await both();
    await useCodexAcp("2.0.1", root);
    rmSync(join(root, "current.json"));
    expect(currentCodexAcp(root)).toBe("broken");
    expect(codexAcpInstalled(root).ok).toBe(false);
    rmSync(join(root, "codex-acp-2.0.0"), { recursive: true });
    expect(currentCodexAcp(root)).toBe("broken");
  });

  test("R2-① 老安装旁边装新版本：先把 2.0.0 写成显式指针，装的过程中老安装一直可用", async () => {
    fresh();
    await installCodexAcp(release("2.0.0", "^0.158.0", a()), { fetch: served(a()), root });
    expect(existsSync(join(root, "current.json"))).toBe(false);
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.0" });
    await installCodexAcp(release("2.0.1", "^0.159.1", b()), { fetch: served(b()), root });
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.0", codexRange: "^0.158.0" });
    expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8")).version).toBe("2.0.0");
  });

  test("R2-② 唯一判定处含入口校验：标记缺 entrySha256、入口文件丢了、入口被改 → broken，也不算配套", async () => {
    fresh();
    await both();
    await useCodexAcp("2.0.1", root);
    expect(currentCodexAcp(root)).toMatchObject({ version: "2.0.1", path: entry("2.0.1") });
    const markerPath = join(root, "codex-acp-2.0.1", "installed.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(markerPath, JSON.stringify({ ...marker, entrySha256: undefined }));
    expect(currentCodexAcp(root)).toBe("broken");
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(false);
    writeFileSync(markerPath, JSON.stringify(marker));
    rmSync(entry("2.0.1"));
    expect(currentCodexAcp(root)).toBe("broken");
    expect(codexPairsWithAdapter("0.159.2", root)).toBe(false);
    expect(codexAcpInstalled(root)).toMatchObject({ ok: false });
  });
});

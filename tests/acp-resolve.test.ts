/** 按 registry 元数据挑能配本机 Codex 的 codex-acp（src/lib/acp/resolve.ts）。不联网：元数据是手造的。 */
import { describe, expect, test } from "bun:test";
import { fetchAcpReleases, parseAcpReleases, pickAdapterFor, rangeAllows } from "../src/lib/acp/resolve.ts";

const T = "https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-";
const ver = (codex: string, tarball?: string, integrity = "sha512-AAAA") => ({ dependencies: { "@openai/codex": codex }, dist: { integrity, tarball } });
const META = {
  versions: {
    "1.13.1": ver("^0.156.1", `${T}1.13.1.tgz`),
    "2.0.0": ver("^0.158.0", `${T}2.0.0.tgz`),
    "2.0.1-preview.1": ver("^0.159.1", `${T}2.0.1-preview.1.tgz`),
    "2.0.1": ver("^0.159.1", `${T}2.0.1.tgz`),
    "2.0.2": ver("^0.159.1", `${T}2.0.2.tgz`),
    "2.0.3-preview.1": ver("^0.159.1", `${T}2.0.3-preview.1.tgz`),
    "2.1.0": ver("^0.160.0", `${T}2.1.0.tgz`),
  },
};

describe("pickAdapterFor", () => {
  const rels = parseAcpReleases(META);
  test("挑满足范围的最高正式版", () => {
    expect(pickAdapterFor(rels, "0.159.2")?.version).toBe("2.0.2");
    expect(pickAdapterFor(rels, "0.158.0")?.version).toBe("2.0.0");
    expect(pickAdapterFor(rels, "0.160.3")).toMatchObject({ version: "2.1.0", codexRange: "^0.160.0", tarball: `${T}2.1.0.tgz` });
  });
  test("跳过 preview：只有预发布能配时返回 null", () => {
    expect(rels.map((r) => r.version)).not.toContain("2.0.3-preview.1");
    const onlyPreview = parseAcpReleases({ versions: { "2.0.1-preview.1": ver("^0.159.1", `${T}2.0.1-preview.1.tgz`) } });
    expect(pickAdapterFor(onlyPreview, "0.159.2")).toBeNull();
  });
  test("没有能配的返回 null；低于 2.0.0 的旧适配器不认", () => {
    expect(pickAdapterFor(rels, "0.161.0")).toBeNull();
    expect(pickAdapterFor(rels, "0.159.0")).toBeNull(); // ^0.159.1 不含 0.159.0
    expect(pickAdapterFor(rels, "0.156.2")).toBeNull();
    expect(pickAdapterFor(rels, undefined)).toBeNull();
  });
  test("拒绝不在 registry.npmjs.org 的 tarball、不是 sha512 的 integrity、缺范围", () => {
    const bad = parseAcpReleases({
      versions: {
        "2.0.1": ver("^0.159.1", "https://evil.example/codex-acp-2.0.1.tgz"),
        "2.0.2": ver("^0.159.1", "https://registry.npmjs.org.evil.example/@agentclientprotocol/codex-acp/-/x.tgz"),
        "2.0.3": ver("^0.159.1", `${T}2.0.3.tgz`, "sha1-AAAA"),
        "2.0.4": { dist: { integrity: "sha512-AAAA", tarball: `${T}2.0.4.tgz` } },
      },
    });
    expect(bad).toEqual([]);
    expect(parseAcpReleases(null)).toEqual([]);
  });
});

test("rangeAllows：范围写坏或版本不是 x.y.z 都算不配套", () => {
  expect(rangeAllows("^0.158.0", "0.158.4")).toBe(true);
  expect(rangeAllows("^0.158.0", "0.159.2")).toBe(false);
  for (const loose of ["not a range ((", "*", ">=0.1.0", "^0.158.0 || *"]) expect(rangeAllows(loose, "0.158.0")).toBe(false);
  expect(rangeAllows("^0.158.0", "0.158.0-alpha.1")).toBe(false);
});

test("fetchAcpReleases：HTTP 失败抛错（调用方按离线处理）", async () => {
  const f = (status: number, body: unknown) => async () => ({ ok: status === 200, status, json: async () => body });
  expect((await fetchAcpReleases(f(200, META))).at(-1)?.version).toBe("2.1.0");
  await expect(fetchAcpReleases(f(503, {}))).rejects.toThrow("503");
});

import { describe, expect, test } from "bun:test";
import { Directory } from "../src/relay/directory.ts";
import { keyFingerprint } from "../src/lib/relay-protocol.ts";
import { keyFromSeed, seedOf } from "./relay-test-client.ts";

const kA = keyFromSeed(seedOf(1));
const kB = keyFromSeed(seedOf(2));
const fpA = keyFingerprint(kA.publicKey);
const fpB = keyFingerprint(kB.publicKey);

describe("directory: 登记与 slug", () => {
  test("首次登记拿到想要的 slug；同指纹再来更新名字", () => {
    const d = new Directory(":memory:");
    expect(d.register(fpA, kA.publicKey, "mini", "Mini")).toEqual({ slug: "mini" });
    expect(d.register(fpA, kA.publicKey, "mini", "Mini 2")).toEqual({ slug: "mini" });
    expect(d.byFp(fpA)?.name).toBe("Mini 2");
    expect(d.bySlug("mini")?.fp).toBe(fpA);
    expect(d.count()).toBe(1);
    d.close();
  });

  test("slug 被别的指纹占着：追加指纹前 4 位，再冲突追加前 8 位", () => {
    const d = new Directory(":memory:");
    d.register(fpA, kA.publicKey, "mini", "A");
    const r = d.register(fpB, kB.publicKey, "mini", "B");
    expect(r).toEqual({ slug: `mini-${fpB.replace(/-/g, "").slice(0, 4)}` });
    // 把 4 位候选也占掉，B 换钥匙…不行，指纹不变；用第三把钥匙验证 8 位候选
    const kC = keyFromSeed(seedOf(3));
    const fpC = keyFingerprint(kC.publicKey);
    const hex = fpC.replace(/-/g, "");
    // 先让 A 抢走 C 的 4 位候选
    d.register(fpA, kA.publicKey, `mini-${hex.slice(0, 4)}`, "A");
    d.register(fpB, kB.publicKey, "mini", "B");
    expect(d.register(fpC, kC.publicKey, "mini", "C")).toEqual({ slug: `mini-${hex.slice(0, 8)}` });
    d.close();
  });

  test("同指纹换 slug：旧 slug 释放给别人", () => {
    const d = new Directory(":memory:");
    d.register(fpA, kA.publicKey, "mini", "A");
    expect(d.register(fpA, kA.publicKey, "studio", "A")).toEqual({ slug: "studio" });
    expect(d.bySlug("mini")).toBeNull();
    expect(d.register(fpB, kB.publicKey, "mini", "B")).toEqual({ slug: "mini" });
    d.close();
  });

  test("另一把公钥算出同一指纹 → fingerprint_conflict", () => {
    const d = new Directory(":memory:");
    d.register(fpA, kA.publicKey, "mini", "A");
    expect(d.register(fpA, kB.publicKey, "mini", "Impostor")).toBe("fingerprint_conflict");
    d.close();
  });

  test("many / touch", () => {
    const d = new Directory(":memory:");
    d.register(fpA, kA.publicKey, "a", "A", "2026-01-01T00:00:00.000Z");
    d.register(fpB, kB.publicKey, "b", "B", "2026-01-01T00:00:00.000Z");
    expect(d.many([fpA, fpB, "0000-0000-0000-0000"]).map((r) => r.slug).sort()).toEqual(["a", "b"]);
    d.touch([fpA], "2026-02-02T00:00:00.000Z");
    expect(d.byFp(fpA)?.lastSeen).toBe("2026-02-02T00:00:00.000Z");
    expect(d.byFp(fpB)?.lastSeen).toBe("2026-01-01T00:00:00.000Z");
    d.close();
  });
});

describe("directory: 配对短码", () => {
  test("登记、查找、过期、删除", () => {
    const d = new Directory(":memory:");
    d.register(fpA, kA.publicKey, "mini", "A");
    const now = 1_790_000_000_000;
    expect(d.putCode("K7PM2XQ9", fpA, now + 60_000, now)).toBe(true);
    expect(d.lookupCode("K7PM2XQ9", now)?.slug).toBe("mini");
    expect(d.lookupCode("K7PM2XQ9", now + 60_001)).toBeNull();
    expect(d.sweepCodes(now + 60_001)).toBe(1);
    expect(d.putCode("K7PM2XQ9", fpA, now + 60_000, now)).toBe(true);
    expect(d.delCode("K7PM2XQ9", fpB)).toBe(false); // 别人删不掉
    expect(d.delCode("K7PM2XQ9", fpA)).toBe(true);
    d.close();
  });

  test("每实例最多 5 个有效短码；别人的短码不能覆盖", () => {
    const d = new Directory(":memory:");
    d.register(fpA, kA.publicKey, "a", "A");
    d.register(fpB, kB.publicKey, "b", "B");
    const now = 1_790_000_000_000;
    for (let i = 0; i < 5; i++) expect(d.putCode(`AAAAAAA${i + 2}`, fpA, now + 60_000, now)).toBe(true);
    expect(d.putCode("BBBBBBB2", fpA, now + 60_000, now)).toBe(false);
    expect(d.putCode("AAAAAAA2", fpA, now + 60_000, now)).toBe(true); // 重新登记自己的不算新增
    expect(d.putCode("AAAAAAA2", fpB, now + 60_000, now)).toBe(false);
    // 过期的不占额度
    expect(d.putCode("BBBBBBB2", fpA, now + 60_000, now + 61_000)).toBe(true);
    d.close();
  });
});

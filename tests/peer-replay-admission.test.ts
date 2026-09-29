import { expect, test } from "bun:test";
import { ReplayCache } from "../src/lib/peer-replay.js";
const sig = (n: number) => Buffer.from(`signature-${n}`).toString("base64url");

test("GET 计次满表不逐出有效计数，签名过期清扫后才恢复接纳", () => {
  const c = new ReplayCache(2, 0, 1_000, 2);
  expect(c.hits(sig(1), "10", 10_000, "p")).toBe(1);
  expect(c.hits(sig(2), "10", 10_000, "p")).toBe(1);
  for (let i = 2; i <= 6; i++) expect(c.hits(sig(1), "10", 10_000, "p")).toBe(i);
  expect(c.hits(sig(3), "10", 10_000, "p")).toBe("full");
  expect(c.hits(sig(1), "10", 10_000, "p")).toBe(7);
  expect(c.hits(sig(3), "12", 12_000, "p")).toBe(1);
  expect(c.size).toBe(1);
});

test("只读预判不占条目、不增加次数；扣桶成功后才提交", () => {
  const c = new ReplayCache(1, 0, 60_000);
  for (let i = 0; i < 10; i++) expect(c.hits(sig(1), "10", 10_000, "p", false)).toBe(1);
  expect(c.size).toBe(0);
  expect(c.hits(sig(1), "10", 10_000, "p")).toBe(1);
  expect(c.hits(sig(1), "10", 10_000, "p", false)).toBe(2);
  expect(c.hits(sig(1), "10", 10_000, "p", false)).toBe(2);
  expect(c.hits(sig(1), "10", 10_000, "p")).toBe(2);
});

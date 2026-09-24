import { expect, test } from "bun:test";
import { shellUrlNeedsAlign } from "../web/lib/shell-url-match";

const ORIGIN = "https://hemacbook-pro.tail3247a9.ts.net"; // WebKit 给出的页面 origin：小写、无默认端口

test("写法不同但是同一个站 → 需要对齐", () => {
  expect(shellUrlNeedsAlign("https://HeMacBook-Pro.tail3247a9.ts.net", ORIGIN)).toBe(true);
  expect(shellUrlNeedsAlign("https://hemacbook-pro.tail3247a9.ts.net:443", ORIGIN)).toBe(true);
  expect(shellUrlNeedsAlign("https://hemacbook-pro.tail3247a9.ts.net/chat", ORIGIN)).toBe(true);
});

test("已经一致 / 未设置 / 换了站 / 写坏了 → 不碰", () => {
  expect(shellUrlNeedsAlign(ORIGIN, ORIGIN)).toBe(false);
  expect(shellUrlNeedsAlign("", ORIGIN)).toBe(false);
  expect(shellUrlNeedsAlign("http://100.82.126.46:3333", ORIGIN)).toBe(false);
  expect(shellUrlNeedsAlign("not a url", ORIGIN)).toBe(false);
});

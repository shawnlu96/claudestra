/** 媒体文件定位：定位串只拼得出白名单目录内的普通文件；出站副本按时间窗认领，窗内多份不同内容 = ambiguous */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentDirs } from "../src/lib/attachment-lookup.js";
import { findAttachment, uploadDayDir } from "../src/lib/attachment-lookup.js";
import { buildInboxCatalog, displayName, openLoc, resolveInbound, resolveOutbound, safeName, type OutboundLedger } from "../src/lib/media-store.js";

let root: string;
let dirs: AttachmentDirs;
const T0 = Date.parse("2026-09-28T10:00:00.000Z");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "media-store-"));
  const uploadDir = join(root, "web", "uploads");
  const inbox = join(root, "inbox");
  const old = join(root, "old-inbox");
  mkdirSync(join(uploadDir, "2026-09-01"), { recursive: true });
  mkdirSync(inbox);
  mkdirSync(old);
  writeFileSync(join(uploadDir, "2026-09-01", "aaaa1111-x.png"), "UP");
  writeFileSync(join(inbox, "1525028954195361932_IMG.png"), "DISCORD");
  writeFileSync(join(inbox, `${T0 + 800}_shot.png`), "S1");
  writeFileSync(join(inbox, `${T0 + 3_600_000}_shot.png`), "S2-later");
  writeFileSync(join(inbox, `${T0 + 1000}_dup.png`), "SAME");
  writeFileSync(join(inbox, `${T0 + 1002}_dup.png`), "SAME");
  writeFileSync(join(inbox, `${T0 + 1000}_amb.png`), "A");
  writeFileSync(join(inbox, `${T0 + 5000}_amb.png`), "B");
  writeFileSync(join(inbox, `${T0 + 100}_朱耷-新.png`), "CN");
  writeFileSync(join(old, "legacy.txt"), "L");
  writeFileSync(join(root, "secret.txt"), "SECRET");
  symlinkSync(join(root, "secret.txt"), join(inbox, "1700000000000_link.png"));
  mkdirSync(join(root, "outside", "2026-09-22"), { recursive: true });
  writeFileSync(join(root, "outside", "2026-09-22", "bbbb2222-x.png"), "OUTSIDE-DATED");
  symlinkSync(join(root, "outside", "2026-09-22"), join(uploadDir, "2026-09-22")); // 软链的日期目录
  dirs = { uploadDir, inboxDirs: [inbox, old] };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("openLoc（取文件时的保守解析）", () => {
  test("合法定位串", () => {
    expect(openLoc("u:2026-09-01/aaaa1111-x.png", dirs)?.size).toBe(2);
    expect(openLoc("i1:legacy.txt", dirs)?.name).toBe("legacy.txt");
  });
  test("穿越 / 越界下标 / 符号链接 / 目录名 / 坏格式一律 null", () => {
    for (const loc of ["u:2026-09-01/../../secret.txt", "u:..%2F/secret.txt", "i0:../secret.txt", "i0:..", "i0:.", "i9:legacy.txt",
      "i0:1700000000000_link.png", "u:2026-09-01", "i0:", "x:secret.txt", `i0:${root}/secret.txt`, "u:2026-9-1/aaaa1111-x.png"]) {
      expect(openLoc(loc, dirs)).toBeNull();
    }
  });
  test("safeName", () => {
    expect(safeName("a b.png")).toBe("a b.png");
    for (const bad of ["", ".env", "a/b", "a\\b", "a\u0000b", "../x"]) expect(safeName(bad)).toBeNull();
  });
});

describe("resolveInbound（父目录必须正好是白名单目录，不按名字兜底）", () => {
  test("上传目录按日期、inbox、旧 inbox；可信度原样带出", () => {
    expect(resolveInbound(join(dirs.uploadDir, "2026-09-01", "aaaa1111-x.png"), dirs, true)).toMatchObject({ loc: "u:2026-09-01/aaaa1111-x.png", trusted: true });
    expect(resolveInbound(join(dirs.inboxDirs[0], "1525028954195361932_IMG.png"), dirs, false)).toMatchObject({ loc: "i0:1525028954195361932_IMG.png", trusted: false });
    expect(resolveInbound(join(dirs.inboxDirs[1], "legacy.txt"), dirs, true)?.loc).toBe("i1:legacy.txt");
    expect(resolveInbound(join(dirs.inboxDirs[0], "nope.png"), dirs, true)).toBeNull();
  });
  test("目录不是白名单目录（哪怕名字在白名单里有同名文件）→ null：手写标记没法按名字认领别的文件（审查 P0）", () => {
    expect(resolveInbound("/nonexistent/1525028954195361932_IMG.png", dirs, false)).toBeNull();
    expect(resolveInbound("/x/web/uploads/2026-09-01/aaaa1111-x.png", dirs, true)).toBeNull();
    expect(resolveInbound(join(root, "1525028954195361932_IMG.png"), dirs, true)).toBeNull();
  });
  test("穿越 / 链接拼不出目录外", () => {
    expect(resolveInbound(join(dirs.inboxDirs[0], "..", "secret.txt"), dirs, true)).toBeNull();
    expect(resolveInbound(join(dirs.inboxDirs[0], "1700000000000_link.png"), dirs, true)).toBeNull();
  });
});

describe("resolveOutbound", () => {
  const cat = () => buildInboxCatalog(dirs);
  const at = (ms: number) => new Date(ms).toISOString();
  const noLedger: OutboundLedger = { copyFor: () => null, ownedByOther: () => false, othersSentSameName: () => false };
  test("有账：直接认账上的副本，可信", async () => {
    const ledger: OutboundLedger = { ...noLedger, copyFor: (src) => (src === "/tmp/w/amb.png" ? `${T0 + 5000}_amb.png` : null) };
    expect(await resolveOutbound("/tmp/w/amb.png", at(T0), dirs, cat(), ledger)).toMatchObject({ loc: `i0:${T0 + 5000}_amb.png`, trusted: true, ambiguous: false });
  });
  test("没账按时间窗猜：只要消息之后拷进来的；猜出来的不可信；一小时后的同名副本不认", async () => {
    const r = await resolveOutbound("/tmp/scratch/shot.png", at(T0), dirs, cat(), noLedger);
    expect(r).toMatchObject({ loc: `i0:${T0 + 800}_shot.png`, trusted: false, ambiguous: false });
    expect(await resolveOutbound("/tmp/scratch/shot.png", at(T0 + 60_000), dirs, cat(), noLedger)).toBeNull(); // 消息之前的旧副本不认
  });
  test("窗里两份字节相同不算歧义；内容不同、或别的 agent 同窗发过同名 = ambiguous；别人账上的副本排除", async () => {
    expect((await resolveOutbound("/a/dup.png", at(T0), dirs, cat(), noLedger))?.ambiguous).toBe(false);
    expect((await resolveOutbound("/a/amb.png", at(T0), dirs, cat(), noLedger))?.ambiguous).toBe(true);
    expect((await resolveOutbound("/a/dup.png", at(T0), dirs, cat(), { ...noLedger, othersSentSameName: () => true }))?.ambiguous).toBe(true);
    const owned = { ...noLedger, ownedByOther: (d: string) => d.endsWith("_shot.png") };
    expect(await resolveOutbound("/tmp/scratch/shot.png", at(T0), dirs, cat(), owned)).toBeNull();
  });
  test("中文名走同一套清洗；Discord 雪花前缀、窗外、符号链接都不认", async () => {
    expect((await resolveOutbound("/a/朱耷-新.png", at(T0), dirs, cat(), noLedger))?.loc).toBe(`i0:${T0 + 100}_朱耷-新.png`);
    expect(await resolveOutbound("/a/IMG.png", at(T0), dirs, cat(), noLedger)).toBeNull();
    expect(await resolveOutbound("/a/shot.png", at(T0 - 3_600_000), dirs, cat(), noLedger)).toBeNull();
    expect(await resolveOutbound("/a/link.png", at(1700000000000), dirs, cat(), noLedger)).toBeNull();
  });
});

test("上传目录下软链的日期目录一律不认：索引解析、定位串、/attachments?d= 都拿不到根外的文件（adv1 P2-3）", () => {
  const f = join(dirs.uploadDir, "2026-09-22", "bbbb2222-x.png");
  expect(uploadDayDir(dirs.uploadDir, "2026-09-22")).toBeNull();
  expect(uploadDayDir(dirs.uploadDir, "2026-09-01")).not.toBeNull();
  expect(resolveInbound(f, dirs, true)).toBeNull();
  expect(openLoc("u:2026-09-22/bbbb2222-x.png", dirs)).toBeNull();
  expect(findAttachment("bbbb2222-x.png", "2026-09-22", dirs)).toBeNull();
  expect(findAttachment("bbbb2222-x.png", null, dirs)).toBeNull();
  expect(findAttachment("aaaa1111-x.png", "2026-09-01", dirs)?.filename).toBe("aaaa1111-x.png");
});

test("displayName 只剥一层前缀；uuid 规则只用于旧上传目录", () => {
  expect(displayName("1790588791502_v3.png", false)).toBe("v3.png");
  expect(displayName("api_1790588791502_20240928_x.png", false)).toBe("20240928_x.png");
  expect(displayName("64890de5-IMG_8870.jpeg", true)).toBe("IMG_8870.jpeg");
  expect(displayName("20240928-report.pdf", false)).toBe("20240928-report.pdf");
});

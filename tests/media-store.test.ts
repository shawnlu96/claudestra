/** 媒体文件定位：定位串只拼得出白名单目录内的普通文件；出站副本按时间窗认领，窗内多份不同内容 = ambiguous */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentDirs } from "../src/lib/attachment-lookup.js";
import { buildInboxCatalog, displayName, openLoc, resolveInbound, resolveOutbound, safeName } from "../src/lib/media-store.js";

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

describe("resolveInbound", () => {
  test("上传目录按日期；inbox 按名；找不到 null", () => {
    expect(resolveInbound("/whatever/web/uploads/2026-09-01/aaaa1111-x.png", dirs)?.loc).toBe("u:2026-09-01/aaaa1111-x.png");
    expect(resolveInbound("/Users/x/.claude-orchestrator/inbox/1525028954195361932_IMG.png", dirs)?.loc).toBe("i0:1525028954195361932_IMG.png");
    expect(resolveInbound("/tmp/claude-orchestrator/inbox/legacy.txt", dirs)?.loc).toBe("i1:legacy.txt");
    expect(resolveInbound("/x/inbox/nope.png", dirs)).toBeNull();
  });
  test("记录里的路径带穿越 / 指向链接也拼不出目录外", () => {
    expect(resolveInbound("/x/inbox/../../secret.txt", dirs)).toBeNull();
    expect(resolveInbound("/x/inbox/1700000000000_link.png", dirs)).toBeNull();
  });
});

describe("resolveOutbound", () => {
  const cat = () => buildInboxCatalog(dirs);
  const at = (ms: number) => new Date(ms).toISOString();
  test("时间窗里唯一的副本；一小时后的同名副本不认（修「旧消息显示成新图」）", async () => {
    const r = await resolveOutbound("/tmp/scratch/shot.png", at(T0), dirs, cat());
    expect(r).toMatchObject({ loc: `i0:${T0 + 800}_shot.png`, ambiguous: false });
    const later = await resolveOutbound("/tmp/scratch/shot.png", at(T0 + 3_600_000 - 2000), dirs, cat());
    expect(later?.loc).toBe(`i0:${T0 + 3_600_000}_shot.png`);
  });
  test("窗里两份字节相同 = 同一次投递拷了两份，不算歧义；内容不同 = ambiguous", async () => {
    expect((await resolveOutbound("/a/dup.png", at(T0), dirs, cat()))?.ambiguous).toBe(false);
    expect((await resolveOutbound("/a/amb.png", at(T0), dirs, cat()))?.ambiguous).toBe(true);
  });
  test("中文名走同一套清洗；Discord 雪花前缀、窗外、符号链接都不认", async () => {
    expect((await resolveOutbound("/a/朱耷-新.png", at(T0), dirs, cat()))?.loc).toBe(`i0:${T0 + 100}_朱耷-新.png`);
    expect(await resolveOutbound("/a/IMG.png", at(T0), dirs, cat())).toBeNull();
    expect(await resolveOutbound("/a/shot.png", at(T0 - 3_600_000), dirs, cat())).toBeNull();
    expect(await resolveOutbound("/a/link.png", at(1700000000000), dirs, cat())).toBeNull();
  });
});

test("displayName 去掉落盘前缀", () => {
  expect(displayName("1790588791502_v3.png")).toBe("v3.png");
  expect(displayName("api_1790588791502_r.pdf")).toBe("r.pdf");
  expect(displayName("64890de5-IMG_8870.jpeg")).toBe("IMG_8870.jpeg");
});

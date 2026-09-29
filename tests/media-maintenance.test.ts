/** 媒体索引的维护：库损坏自动重建、版本升级清缩略图、缩略图缓存按上限清理、出站副本账本（记账 / 按账认领 / 同名不互相覆盖） */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeMediaIndex, openMediaIndex } from "../src/lib/media-index.js";
import { canonicalAgent, copyOutboundFiles, inboxOwner, ledgerCopy, ownedByOther, saveDiscordDownload, saveUpload } from "../src/lib/media-outbound.js";
import { clearThumbs, convertedImage, pruneThumbs } from "../src/lib/media-thumb.js";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "media-maint-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("索引库", () => {
  test("文件损坏（不是 sqlite）：打开时删掉重建，并通知清缩略图", () => {
    const p = join(root, "bad.sqlite");
    writeFileSync(p, "this is not a database at all, just garbage bytes ".repeat(200));
    let reset = 0;
    const db = openMediaIndex(p, () => reset++);
    expect((db.prepare("SELECT COUNT(*) AS n FROM media").get() as { n: number }).n).toBe(0);
    expect(reset).toBeGreaterThan(0);
    closeMediaIndex(p);
  });
  test("正常库重开不触发重置；busy_timeout 已设", () => {
    const p = join(root, "ok.sqlite");
    openMediaIndex(p);
    closeMediaIndex(p);
    let reset = 0;
    const db = openMediaIndex(p, () => reset++);
    expect(reset).toBe(0);
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    closeMediaIndex(p);
  });
});

describe("缩略图缓存", () => {
  test("超上限按访问时间从旧到新删到八成；clearThumbs 全清；非 jpg 不动", () => {
    const d = join(root, "thumbs");
    mkdirSync(d);
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(d, `t${i}.thumb.jpg`), Buffer.alloc(100));
      utimesSync(join(d, `t${i}.thumb.jpg`), new Date(1_000_000 + i * 1000), new Date(1_000_000));
    }
    writeFileSync(join(d, "keep.txt"), "x");
    pruneThumbs(d, 500);
    const left = readdirSync(d).filter((f) => f.endsWith(".jpg")).sort();
    expect(left).toEqual(["t6.thumb.jpg", "t7.thumb.jpg", "t8.thumb.jpg", "t9.thumb.jpg"]);
    clearThumbs(d);
    expect(readdirSync(d)).toEqual(["keep.txt"]);
  });
  test("PDF 按文件头认、不做缩略图：改名成 .png 的也直接回占位（failed），不跑 sips（adv2 P2-d / adv3 P2-①）", async () => {
    // 能被 sips 正常转换的最小 PDF：不拦的话改名成 .png 会真的交给 sips 并转出图来
    const MINI_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 50 50]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
    const d = join(root, "pdfs");
    mkdirSync(d);
    const cases: [string, string][] = [["x.pdf", "%PDF-1.7\n"], ["disguised.png", MINI_PDF], ["junk-first.jpg", `${"x".repeat(500)}%PDF-1.5`]];
    for (const [name, body] of cases) {
      writeFileSync(join(d, name), body);
      for (const v of ["thumb", "display"] as const) {
        expect(await convertedImage(join(root, "thumbs"), "0".repeat(24), `i:${name}`, v, join(d, name), name)).toBe("failed");
      }
    }
  });
});

describe("出站副本账本", () => {
  test("拷进 inbox 并记账；同一毫秒同名不再互相覆盖；按账认领只认同 agent 同原路径；拷贝失败跳过", async () => {
    const p = join(root, "ledger.sqlite");
    const db = openMediaIndex(p);
    const inbox = join(root, "inbox");
    const srcDir = join(root, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "a.png"), "A1");
    const t = Date.now();
    const first = await copyOutboundFiles([join(srcDir, "a.png"), join(srcDir, "a.png"), join(srcDir, "missing.png")], "worker", inbox, db);
    expect(first).toHaveLength(2);
    expect(first[0].attachment).not.toBe(first[1].attachment);
    expect(first.every((f) => existsSync(join(inbox, f.attachment)) && readFileSync(join(inbox, f.attachment), "utf8") === "A1")).toBe(true);
    const dest = ledgerCopy(db, "agent-worker", join(srcDir, "a.png"), t);
    expect(dest && first.map((f) => f.attachment).includes(dest)).toBe(true);
    expect(ledgerCopy(db, "agent-other", join(srcDir, "a.png"), t)).toBeNull();
    expect(ledgerCopy(db, "agent-worker", "/elsewhere/a.png", t)).toBeNull();
    expect(ledgerCopy(db, "agent-worker", join(srcDir, "a.png"), t + 3600_000)).toBeNull();
    expect(ownedByOther(db, "agent-other", dest!)).toBe(true);
    expect(ownedByOther(db, "agent-worker", dest!)).toBe(false);
    closeMediaIndex(p);
  });
  test("两个 agent 并发拷同名文件：副本名各不相同，账上的归属与文件内容一致（审查 r2 P1-A）", async () => {
    const p = join(root, "race.sqlite");
    const db = openMediaIndex(p);
    const inbox = join(root, "race-inbox");
    for (const who of ["a", "b"]) {
      mkdirSync(join(root, `race-${who}`));
      writeFileSync(join(root, `race-${who}`, "shot.png"), `${who.toUpperCase()}-PRIVATE`);
    }
    const pa = join(root, "race-a", "shot.png"), pb = join(root, "race-b", "shot.png");
    for (let i = 0; i < 50; i++) {
      const [x, y] = await Promise.all([copyOutboundFiles([pa], "agent-a", inbox, db), copyOutboundFiles([pb], "agent-b", inbox, db)]);
      expect(x[0].attachment).not.toBe(y[0].attachment);
      for (const [c, who] of [[x[0], "a"], [y[0], "b"]] as const) {
        const row = db.prepare("SELECT agent FROM out_copies WHERE dest = ?").get(c.attachment) as { agent: string };
        expect(row.agent).toBe(`agent-${who}`);
        expect(readFileSync(join(inbox, c.attachment), "utf8")).toBe(`${who.toUpperCase()}-PRIVATE`);
      }
    }
    closeMediaIndex(p);
  });
  test("两个 principal 并发上传同名文件、同一请求里两个同名文件：各自占名，内容与账上归属各自正确（adv1 P1-1）", async () => {
    const p = join(root, "upload.sqlite");
    const db = openMediaIndex(p);
    const inbox = join(root, "upload-inbox");
    const enc = (x: string) => new TextEncoder().encode(x);
    for (let i = 0; i < 50; i++) {
      const [g, o, o2] = await Promise.all([
        saveUpload(inbox, "image.png", enc("GUEST"), "agent-worker", db),
        saveUpload(inbox, "image.png", enc("OWNER-SECRET"), "master", db),
        saveUpload(inbox, "image.png", enc("OWNER-SECOND"), "master", db),
      ]);
      expect(new Set([g, o, o2]).size).toBe(3);
      for (const [path, body, agent] of [[g, "GUEST", "agent-worker"], [o, "OWNER-SECRET", "master"], [o2, "OWNER-SECOND", "master"]]) {
        expect(readFileSync(path, "utf8")).toBe(body);
        const name = path.slice(inbox.length + 1);
        expect(name).toMatch(/^api_\d+_image\.png$/);
        expect(ownedByOther(db, agent === "master" ? "agent-worker" : "master", name)).toBe(true);
        expect(ownedByOther(db, agent, name)).toBe(false);
      }
    }
    closeMediaIndex(p);
  });
  test("归属账落在库文件里：关库重开（bridge 重启）还在；写内容失败时账和文件一起撤", async () => {
    const p = join(root, "persist.sqlite");
    const inbox = join(root, "persist-inbox");
    let db = openMediaIndex(p);
    const dest = await saveUpload(inbox, "a.png", new TextEncoder().encode("A"), "worker", db);
    const name = dest.slice(inbox.length + 1);
    closeMediaIndex(p);
    db = openMediaIndex(p);
    expect(inboxOwner(db, name)).toBe("agent-worker");
    const bad = { byteLength: 1 } as unknown as Uint8Array; // writeFile 会拒掉的数据
    await expect(saveUpload(inbox, "b.png", bad, "worker", db)).rejects.toThrow();
    expect(readdirSync(inbox).filter((f) => f.endsWith("_b.png"))).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM out_copies WHERE dest LIKE '%_b.png'").get() as { n: number }).n).toBe(0);
    closeMediaIndex(p);
  });
  test("Discord 附件落盘：原名取 basename 再清洗（../ / \\ ; 控制字符），不出 inbox、不带 ;；id 必须是雪花；重复投递不覆盖（adv2 P2-b）", async () => {
    const inbox = join(root, "discord-inbox");
    const id = "1525028954195361932";
    const data = new TextEncoder().encode("D");
    const names = ["../../escaped.txt", "a/b/c.png", "..\\..\\win.png", "x.png;/etc/passwd", "a;b.png", "ctl\x00\x1f\x7f.png", "..", "", "图 片 1.png"];
    for (const [i, n] of names.entries()) {
      const dest = await saveDiscordDownload(inbox, `${id.slice(0, -2)}${String(i).padStart(2, "0")}`, n, data);
      expect(dest.startsWith(`${inbox}/`)).toBe(true);
      const file = dest.slice(inbox.length + 1);
      expect(file).toMatch(/^\d{19}_[\p{L}\p{N}._-]+$/u);
      expect(existsSync(dest)).toBe(true);
    }
    expect(readdirSync(inbox).every((f) => /^\d{19}_/.test(f))).toBe(true);
    expect(existsSync(join(root, "escaped.txt")) || existsSync(join(inbox, "escaped.txt"))).toBe(false);
    for (const bad of ["123", "../1525028954195361932", "1525028954195361932/x", "api_1700000000000"]) {
      await expect(saveDiscordDownload(inbox, bad, "x.png", data)).rejects.toThrow();
    }
    const again = await saveDiscordDownload(inbox, `${id.slice(0, -2)}00`, "../../escaped.txt", new TextEncoder().encode("OTHER"));
    expect(readFileSync(again, "utf8")).toBe("D");
  });
  test("agent 名规范成 registry 形状", () => {
    expect([canonicalAgent("worker"), canonicalAgent("agent-x"), canonicalAgent("master"), canonicalAgent("?")]).toEqual(["agent-worker", "agent-x", "master", "?"]);
  });
});

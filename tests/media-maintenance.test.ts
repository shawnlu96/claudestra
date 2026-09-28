/** 媒体索引的维护：库损坏自动重建、版本升级清缩略图、缩略图缓存按上限清理、出站副本账本（记账 / 按账认领 / 同名不互相覆盖） */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeMediaIndex, openMediaIndex } from "../src/lib/media-index.js";
import { canonicalAgent, copyOutboundFiles, ledgerCopy, ownedByOther } from "../src/lib/media-outbound.js";
import { clearThumbs, pruneThumbs } from "../src/lib/media-thumb.js";

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
  test("agent 名规范成 registry 形状", () => {
    expect([canonicalAgent("worker"), canonicalAgent("agent-x"), canonicalAgent("master"), canonicalAgent("?")]).toEqual(["agent-worker", "agent-x", "master", "?"]);
  });
});

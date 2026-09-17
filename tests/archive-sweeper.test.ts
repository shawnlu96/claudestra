/**
 * pruneArchives 作用域（review #10 阻塞项）：清理只走传入的根（缺省 = 手动归档区），
 * 根之外的自动快照一个字节都不碰；days=0 不清理；空目录顺手删。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pruneArchives } from "../src/bridge/archive-sweeper.ts";

const DAY = 86_400_000;

function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "prune-"));
  const manual = join(base, "archived");
  const snapshots = join(base, "agent-foo");
  mkdirSync(join(manual, "old-agent"), { recursive: true });
  mkdirSync(snapshots, { recursive: true });
  const now = Date.now();
  const oldTs = (now - 120 * DAY) / 1000;
  const freshTs = (now - 5 * DAY) / 1000;
  const oldManual = join(manual, "old-agent", "s.jsonl");
  const freshManual = join(manual, "fresh.jsonl");
  const oldSnapshot = join(snapshots, "old.jsonl");
  for (const [p, ts] of [[oldManual, oldTs], [freshManual, freshTs], [oldSnapshot, oldTs]] as const) {
    writeFileSync(p, "{}\n");
    utimesSync(p, ts, ts);
  }
  return { base, manual, oldManual, freshManual, oldSnapshot, now };
}

describe("pruneArchives", () => {
  test("只删根内超期文件，根外的自动快照不碰，空目录顺手删", () => {
    const t = makeTree();
    const removed = pruneArchives(90, t.now, t.manual);
    expect(removed).toBe(1);
    expect(existsSync(t.oldManual)).toBe(false);
    expect(existsSync(join(t.manual, "old-agent"))).toBe(false); // 空目录被删
    expect(existsSync(t.freshManual)).toBe(true);
    expect(existsSync(t.oldSnapshot)).toBe(true); // 根之外：自动快照绝不动
  });

  test("days=0 / 非法天数 = 不清理", () => {
    const t = makeTree();
    expect(pruneArchives(0, t.now, t.manual)).toBe(0);
    expect(pruneArchives(Number.NaN, t.now, t.manual)).toBe(0);
    expect(existsSync(t.oldManual)).toBe(true);
  });

  test("根不存在时安全返回 0", () => {
    expect(pruneArchives(90, Date.now(), join(tmpdir(), "no-such-prune-root-xyz"))).toBe(0);
  });
});

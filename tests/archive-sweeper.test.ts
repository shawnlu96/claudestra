/**
 * pruneArchives 作用域（review #10 阻塞项）：清理只走传入的根（缺省 = 手动归档区），
 * 根之外的自动快照一个字节都不碰；days=0 不清理；空目录顺手删。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pruneArchives } from "../src/bridge/archive-sweeper.ts";
import { markAgentArchived } from "../src/lib/agent-archive-marker.ts";

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

  test("agent 归档标记与老的空标记目录跑完清理仍在；未纳管条目过期照常整条清掉", async () => {
    const t = makeTree();
    const old = (t.now - 120 * DAY) / 1000;
    const legacy = join(t.manual, "legacy-agent"); // 老版本只建的空目录
    mkdirSync(legacy);
    const reg = join(t.base, "registry.json");
    writeFileSync(reg, JSON.stringify({ agents: { "agent-foo": { sessionId: "sid-1", cwd: "/w/foo", runtime: "pi" } } }));
    const marker = await markAgentArchived("agent-foo", t.manual, reg);
    expect(marker).toBe(join(t.manual, "foo")); // 裸名：列表判已归档时也去掉 agent- 前缀
    const metaPath = join(marker, ".meta.json");
    expect(JSON.parse(readFileSync(metaPath, "utf8"))).toMatchObject({ kind: "agent", name: "foo", sessionId: "sid-1", cwd: "/w/foo", runtime: "pi" });
    utimesSync(metaPath, old, old);
    const unmanaged = join(t.manual, "019a-sub");
    mkdirSync(unmanaged);
    for (const f of ["s.jsonl", ".meta.json"]) {
      writeFileSync(join(unmanaged, f), f === ".meta.json" ? '{"kind":"unmanaged"}' : "{}\n");
      utimesSync(join(unmanaged, f), old, old);
    }
    expect(pruneArchives(90, t.now, t.manual)).toBe(3); // old-agent/s.jsonl + 未纳管条目的两份
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(unmanaged)).toBe(false);
    expect(existsSync(t.freshManual)).toBe(true);
  });
});

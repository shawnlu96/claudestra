import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepIdleCodexSubSessions } from "../src/lib/unmanaged-archive";

// Codex 子线程结束 7 天自动归档：只动「够老的未纳管子线程」，主会话、已纳管的、最近还在写的都不碰
const tmp = mkdtempSync(join(tmpdir(), "codex-sub-archive-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const codexRoot = join(tmp, "sessions");
const archiveRoot = join(tmp, "archived");
const day = join(codexRoot, "2026", "09", "01");
mkdirSync(day, { recursive: true });
const NOW = Date.parse("2026-09-29T00:00:00Z");
const id = (n: number) => `019a0000-0000-7000-8000-00000000000${n}`;
const write = (n: number, payload: object, ageDays: number) => {
  const p = join(day, `rollout-2026-09-01T00-00-0${n}-${id(n)}.jsonl`);
  writeFileSync(p, JSON.stringify({ type: "session_meta", payload: { cwd: "/w", ...payload } }) + "\n");
  const t = (NOW - ageDays * 86_400_000) / 1000;
  utimesSync(p, t, t);
  return p;
};

describe("sweepIdleCodexSubSessions", () => {
  const main = write(1, { id: id(1), session_id: id(1) }, 30);
  const oldSub = write(2, { id: id(2), session_id: id(1), parent_thread_id: id(1), thread_source: "subagent" }, 8);
  const freshSub = write(3, { id: id(3), session_id: id(1), thread_source: "guardian_review" }, 2);
  const managedSub = write(4, { id: id(4), session_id: id(1), thread_source: "guardian_review" }, 30);

  test("只归档 7 天没写、未纳管的子线程；副本 mtime 是归档时刻，meta 记原路径", async () => {
    const n = await sweepIdleCodexSubSessions({ keep: new Set([id(4)]), now: NOW, codexRoot, archiveRoot });
    expect(n).toBe(1);
    expect(existsSync(oldSub)).toBe(false);
    for (const p of [main, freshSub, managedSub]) expect(existsSync(p)).toBe(true);
    const dest = join(archiveRoot, id(2));
    const copy = join(dest, oldSub.split("/").pop()!);
    expect(Date.now() - statSync(copy).mtimeMs).toBeLessThan(60_000); // 保留期从归档那一刻算，不会一挪进来就被当超期清掉
    const meta = JSON.parse(readFileSync(join(dest, ".meta.json"), "utf8"));
    expect(meta).toEqual({ kind: "unmanaged", originalPath: oldSub, runtime: "codex", cwd: "/w", sessionId: id(2) });
  });
});

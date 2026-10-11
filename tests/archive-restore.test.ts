import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conflictName, moveArchiveToSnapshots, restoreAgentArchiveFiles } from "../src/bridge/archive-restore";

// 恢复归档 agent 的第一步：用户归档目录 → 自动快照区。全部在临时目录里造
const base = mkdtempSync(join(tmpdir(), "archive-restore-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function world(files: Record<string, string> = { "session.jsonl": "S\n", "notes.md": "N" }) {
  const root = mkdtempSync(join(base, "w-"));
  const src = join(root, "archive", "archived", "agent-x");
  const dest = join(root, "archive", "agent-x");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, ".meta.json"), JSON.stringify({ kind: "agent", sessionId: "sid-1" }));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(src, f), body);
  return { src, dest };
}

describe("restoreAgentArchiveFiles：搬运失败不删归档、不覆盖已有快照", () => {
  test("[验收线 1] 目标 session.jsonl 是个目录：500，源归档里的文件仍在", async () => {
    const w = world();
    mkdirSync(join(w.dest, "session.jsonl"), { recursive: true });
    const res = await restoreAgentArchiveFiles(w.src, w.dest);
    expect(res?.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.notMoved).toContain("session.jsonl");
    expect([...body.moved, ...body.notMoved].sort()).toEqual(["notes.md", "session.jsonl"]);
    expect(readFileSync(join(w.src, "session.jsonl"), "utf8")).toBe("S\n");
    expect(existsSync(join(w.src, ".meta.json"))).toBe(true);
  });

  test("[验收线 1] rename 本身失败（如 EXDEV）：停在那一个，已搬 / 未搬分列，源目录保留", async () => {
    const w = world({ "a.jsonl": "A", "b.jsonl": "B", "c.jsonl": "C" });
    let calls = 0;
    const flaky = {
      ...fsp,
      rename: (async (from: string, to: string) => {
        if (++calls === 2) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        return fsp.rename(from, to);
      }) as typeof fsp.rename,
    };
    const res = await restoreAgentArchiveFiles(w.src, w.dest, flaky);
    expect(res?.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.moved.length).toBe(1);
    expect(body.notMoved.length).toBe(2);
    expect(body.error).toContain("cross-device");
    for (const f of body.notMoved) expect(existsSync(join(w.src, f))).toBe(true);
    expect(existsSync(join(w.src, ".meta.json"))).toBe(true);
  });

  test("[验收线 2] 目标已有同名文件：原文件不被覆盖，新文件换名落下，源目录删掉", async () => {
    const w = world();
    mkdirSync(w.dest, { recursive: true });
    writeFileSync(join(w.dest, "session.jsonl"), "OLD");
    writeFileSync(join(w.dest, "session.restored-1.jsonl"), "OLD1");
    const r = await moveArchiveToSnapshots(w.src, w.dest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.renamed).toEqual({ "session.jsonl": "session.restored-2.jsonl" });
    expect(readFileSync(join(w.dest, "session.jsonl"), "utf8")).toBe("OLD");
    expect(readFileSync(join(w.dest, "session.restored-1.jsonl"), "utf8")).toBe("OLD1");
    expect(readFileSync(join(w.dest, "session.restored-2.jsonl"), "utf8")).toBe("S\n");
    expect(readFileSync(join(w.dest, "notes.md"), "utf8")).toBe("N");
    expect(existsSync(w.src)).toBe(false);
  });

  test("[验收线 2] 路由层：换名成功时返回 null（走原 200 回包）", async () => {
    const w = world();
    mkdirSync(w.dest, { recursive: true });
    writeFileSync(join(w.dest, "notes.md"), "OLD");
    expect(await restoreAgentArchiveFiles(w.src, w.dest)).toBeNull();
    expect(readFileSync(join(w.dest, "notes.md"), "utf8")).toBe("OLD");
    expect(readFileSync(join(w.dest, "notes.restored-1.md"), "utf8")).toBe("N");
    expect(existsSync(w.src)).toBe(false);
  });

  test("[验收线 3] readdir 失败：500，零删除", async () => {
    const w = world();
    const removed: string[] = [];
    const broken = {
      ...fsp,
      readdir: (async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }) as unknown as typeof fsp.readdir,
      rm: (async (p: string) => {
        removed.push(p);
      }) as unknown as typeof fsp.rm,
    };
    const res = await restoreAgentArchiveFiles(w.src, w.dest, broken);
    expect(res?.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body).toMatchObject({ ok: false, moved: [], notMoved: [] });
    expect(removed).toEqual([]);
    expect(readdirSync(w.src).sort()).toEqual([".meta.json", "notes.md", "session.jsonl"]);
    expect(existsSync(w.dest)).toBe(false);
  });

  test("[验收线 4] 正常恢复：全部搬到 archive/<agent>/、.meta.json 不搬、源目录删掉", async () => {
    const w = world();
    expect(await restoreAgentArchiveFiles(w.src, w.dest)).toBeNull();
    expect(readdirSync(w.dest).sort()).toEqual(["notes.md", "session.jsonl"]);
    expect(readFileSync(join(w.dest, "session.jsonl"), "utf8")).toBe("S\n");
    expect(existsSync(w.src)).toBe(false);
  });

  test("conflictName：扩展名前插 .restored-N；无扩展名 / 点开头追加在尾部", () => {
    expect(conflictName("session.jsonl", 1)).toBe("session.restored-1.jsonl");
    expect(conflictName("README", 3)).toBe("README.restored-3");
    expect(conflictName(".worker-kind", 1)).toBe(".worker-kind.restored-1");
  });
});

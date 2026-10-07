/** SCH-2 删出借副本不卡主线程（src/lib/lend-trash.ts trashAway / sweepTrash）：先同步 rename 进回收目录，再后台删；启动清残留 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderDir, removeOrderDir } from "../src/lib/lend-clone.js";
import { sweepTrash, trashSettled, type TrashFs } from "../src/lib/lend-trash.js";
import { claudeTrashDir, removeClaudeWorkerConfig } from "../src/lib/lend-claude-worker.js";

/** 真 fs，记下顺序；rm 挂起到 release()，用来断言「rename 返回时原路径已经没了、回收目录还在」 */
function spyFs() {
  const ops: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fs: TrashFs = {
    rename: (from, to) => { ops.push(`rename ${from} -> ${to}`); renameSync(from, to); },
    rm: async (p) => { ops.push(`rm ${p}`); await gate; await rm(p, { recursive: true, force: true }); },
  };
  return { fs, ops, release: () => release() };
}

function order(root: string, id: string): string {
  const dir = orderDir(id, root);
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", "a.js"), "1");
  return dir;
}

describe("SCH-2 removeOrderDir 走回收目录", () => {
  test("先 rename：返回时原路径已消失、副本在 trash 里；后台 rm 完成后 trash 清空", async () => {
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    const dir = order(root, "o1");
    const s = spyFs();
    expect(removeOrderDir("o1", root, "work", s.fs)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(s.ops[0]).toStartWith(`rename ${dir} -> ${join(root, "trash")}`);
    expect(s.ops[1]).toStartWith(`rm ${join(root, "trash")}`);
    expect(readdirSync(join(root, "trash"))).toHaveLength(1);
    s.release();
    await trashSettled();
    expect(readdirSync(join(root, "trash"))).toEqual([]);
  });

  test("同一张单删两次（work 重建后再删）不撞名", async () => {
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    order(root, "o2");
    removeOrderDir("o2", root);
    order(root, "o2");
    removeOrderDir("o2", root);
    await trashSettled();
    expect(existsSync(orderDir("o2", root))).toBe(false);
    expect(readdirSync(join(root, "trash"))).toEqual([]);
  });

  test("拒删的软链不 rename、不进 trash", () => {
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    const victim = mkdtempSync(join(tmpdir(), "victim-"));
    mkdirSync(join(root, "work"), { recursive: true });
    symlinkSync(victim, orderDir("o3", root));
    const s = spyFs();
    expect(() => removeOrderDir("o3", root, "work", s.fs)).toThrow(/拒绝删除/);
    expect(s.ops).toEqual([]);
    expect(existsSync(victim)).toBe(true);
  });

  test("回收目录是软链：不往里挪", () => {
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    order(root, "o4");
    symlinkSync(elsewhere, join(root, "trash"));
    expect(() => removeOrderDir("o4", root)).toThrow(/软链/);
    expect(existsSync(orderDir("o4", root))).toBe(true);
  });
});

/** sweep 要求根目录整条路径都不是软链：macOS 的 tmpdir 在 /var（→ /private/var）下，先取真实路径 */
const realTemp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

describe("SCH-2 启动清回收目录", () => {
  test("上个进程留下的残留全部后台删掉；没有回收目录就什么都不做", async () => {
    const root = realTemp("lend-root-");
    expect(sweepTrash(join(root, "trash"))).toBe(0);
    const trash = join(root, "trash");
    for (const n of ["a-1-0", "b-2-1"]) (mkdirSync(join(trash, n, "deep"), { recursive: true }), writeFileSync(join(trash, n, "deep", "f"), "x"));
    writeFileSync(join(trash, "loose"), "x");
    expect(sweepTrash(trash)).toBe(3);
    await trashSettled();
    expect(readdirSync(trash)).toEqual([]);
  });

  test("回收目录是软链：拒清，指向的目录原样不动", () => {
    const root = realTemp("lend-root-");
    const victim = realTemp("victim-");
    writeFileSync(join(victim, "keep"), "x");
    symlinkSync(victim, join(root, "trash"));
    expect(() => sweepTrash(join(root, "trash"))).toThrow(/软链/);
    expect(existsSync(join(victim, "keep"))).toBe(true);
  });

  test("PR864-r1：根目录（claude-config）是指向外部的软链：拒清、不枚举，外部 .trash 里的东西还在", async () => {
    const base = realTemp("lend-base-");
    const outside = join(base, "outside");
    mkdirSync(join(outside, ".trash", "keep"), { recursive: true });
    writeFileSync(join(outside, ".trash", "keep", "important"), "x");
    const root = join(base, "claude-config");
    symlinkSync(outside, root);
    expect(() => removeClaudeWorkerConfig("agent-lend-x9", root)).not.toThrow(); // 没这个 worker：什么都不删
    const s = spyFs();
    let err: unknown = null;
    try { sweepTrash(claudeTrashDir(root), s.fs); } catch (e) { err = e; }
    s.release(); // 先放行再断言：断言失败时挂起的 rm 不拖住后面用 trashSettled 的用例
    await trashSettled();
    expect(String(err)).toContain("软链");
    expect(s.ops).toEqual([]);
    expect(existsSync(join(outside, ".trash", "keep", "important"))).toBe(true);
  });

  test("祖先目录是软链（根目录本身不是）：同样拒清", () => {
    const base = realTemp("lend-base-");
    mkdirSync(join(base, "real", "lend", "trash", "x"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"));
    expect(() => sweepTrash(join(base, "link", "lend", "trash"))).toThrow(/软链/);
    expect(existsSync(join(base, "real", "lend", "trash", "x"))).toBe(true);
  });
});

test("SCH-2 removeClaudeWorkerConfig 也走回收目录（root/.trash，同卷）", async () => {
  const root = mkdtempSync(join(tmpdir(), "lend-cc-"));
  const dir = join(root, "agent-lend-x1");
  mkdirSync(join(dir, "run-1"), { recursive: true });
  writeFileSync(join(dir, "run-1", "launch.json"), "{}");
  removeClaudeWorkerConfig("agent-lend-x1", root);
  expect(existsSync(dir)).toBe(false);
  await trashSettled();
  expect(readdirSync(claudeTrashDir(root))).toEqual([]);
});

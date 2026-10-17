// 全量测试闸的进程树记录（src/lib/full-test-gate-record.ts，docs/architecture/full-test-gate.md）：持有者与观察者经同一个写入口，
// 锁内重读再三方合并，不丢对方并进来的成员、不复活已剪掉的键；坏记录不覆盖。临时闸目录，不写真实宿主闸。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeTree } from "../src/lib/full-test-gate.ts";
import { mergeTreeRecord, readTreeRecord, treeLockPath, treePath } from "../src/lib/full-test-gate-record.ts";
import type { Boot, Proc, TreeRoot } from "../src/lib/full-test-gate-tree.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "full-gate-record-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (sec: number) => `darwin:${sec}.000000`;
const boot: Boot = { id: "boot-1", at: at(1_000) };
const proc = (pid: number, sec: number, extra: Partial<Proc> = {}): Proc =>
  ({ pid, ppid: 1, pgid: pid, sid: pid, start: at(sec), uid: 501, uniq: null, puniq: null, ver: null, opv: null, ...extra });
const ROOT: TreeRoot = { pgid: 4000, start: at(2_000), uniq: null, ver: null, uid: 501, members: [], boot: boot.id,
  pgids: [{ id: 4000, leaderStart: at(2_000) }], sids: [{ id: 4000, leaderStart: at(2_000) }] };
const write = (t: TreeRoot) => {
  mkdirSync(join(dir, "trees"), { recursive: true });
  writeFileSync(treePath(dir, "t"), JSON.stringify({ state: "running", ...t }));
};
const current = (): TreeRoot => {
  const r = readTreeRecord(dir, "t");
  if (r === null || r === "missing" || r.state !== "running") throw new Error(`记录不在：${JSON.stringify(r)}`);
  const { state: _, ...t } = r;
  return t;
};
const M = { pid: 4200, start: at(2_010), uniq: null, ver: null };

describe("[验收线 8] 树记录不丢并发新增的成员", () => {
  test("精确交错：观察者读 → 持有者并入 M 写回 → 观察者写回 → 持有者再读，M 仍在", () => {
    write(ROOT);
    const holderBase = current();
    // 观察者已读到记录（observeTree 先读、后扫进程表）；扫表的这一刻持有者并入 M 并写回；观察者的快照里没有 M（它扫在 M 出生之前）
    const verdict = observeTree(dir, "t", () => {
      const w = mergeTreeRecord(dir, "t", holderBase, { ...holderBase, members: [M] });
      expect(w.status).toBe("written");
      return [proc(4000, 2_000)];
    }, 60_000, () => boot);
    expect(verdict).toBe("present");
    expect(current().members).toContainEqual(M);
  });

  test("持有者写回不覆盖观察者并进来的成员，并回持有者手里；自己剪掉的键不复活", () => {
    const base: TreeRoot = { ...ROOT, pgids: [{ id: 4000, leaderStart: at(2_000) }, { id: 4500, leaderStart: null }] };
    write(base);
    // 观察者：并入 X、补上新键 4600
    const X = { pid: 4300, start: at(2_020), uniq: null, ver: null };
    expect(mergeTreeRecord(dir, "t", base, { ...base, members: [X], pgids: [...base.pgids!, { id: 4600, leaderStart: null }] }).status).toBe("written");
    // 持有者（手里还是 base）：剪掉 4500、并入 M
    const w = mergeTreeRecord(dir, "t", base, { ...base, members: [M], pgids: [{ id: 4000, leaderStart: at(2_000) }] });
    if (w.status !== "written") throw new Error(w.status);
    for (const t of [w.tree, current()]) {
      expect(t.members).toEqual([M, X]);
      expect(t.pgids).toEqual([{ id: 4000, leaderStart: at(2_000) }, { id: 4600, leaderStart: null }]);
    }
    // 别人剪掉的（4600 已不在 latest），自己手里的旧 base 带着它也不复活
    const after = current();
    expect(mergeTreeRecord(dir, "t", after, { ...after, pgids: [{ id: 4000, leaderStart: at(2_000) }] }).status).toBe("written");
    expect(mergeTreeRecord(dir, "t", after, after).status).toBe("written");
    expect(current().pgids).toEqual([{ id: 4000, leaderStart: at(2_000) }]);
  });

  test("旧键补上 leaderStart 不算新键：别人已剪掉的号不复活；补齐与别人没动的键照常写回", () => {
    const base: TreeRoot = { ...ROOT, pgids: [{ id: 4000, leaderStart: at(2_000) }, { id: 5000, leaderStart: null }, { id: 5100, leaderStart: null }] };
    write(base);
    // 观察者剪掉 5000
    expect(mergeTreeRecord(dir, "t", base, { ...base, pgids: [{ id: 4000, leaderStart: at(2_000) }, { id: 5100, leaderStart: null }] }).status).toBe("written");
    // 持有者（手里还是 base）给 5000、5100 补上组长时刻
    const next = { ...base, pgids: [{ id: 4000, leaderStart: at(2_000) }, { id: 5000, leaderStart: at(2_010) }, { id: 5100, leaderStart: at(2_011) }] };
    expect(mergeTreeRecord(dir, "t", base, next).status).toBe("written");
    expect(current().pgids).toEqual([{ id: 4000, leaderStart: at(2_000) }, { id: 5100, leaderStart: at(2_011) }]);
    // 对方补过 leaderStart、自己手里没改：取对方的，不退回 null
    const before = current();
    expect(mergeTreeRecord(dir, "t", base, { ...base, pgids: [{ id: 4000, leaderStart: at(2_000) }, { id: 5100, leaderStart: null }] }).status).toBe("written");
    expect(current().pgids).toEqual(before.pgids);
  });

  test("损坏记录不被覆盖、按 unknown 保槽：读时坏、合并前一刻被写坏都一样", () => {
    mkdirSync(join(dir, "trees"), { recursive: true });
    writeFileSync(treePath(dir, "t"), "{bad");
    expect(observeTree(dir, "t", () => [proc(4000, 2_000)], 60_000, () => boot)).toBe("unknown");
    expect(readFileSync(treePath(dir, "t"), "utf8")).toBe("{bad");
    write(ROOT);
    expect(observeTree(dir, "t", () => { writeFileSync(treePath(dir, "t"), "{bad"); return [proc(4000, 2_000)]; }, 60_000, () => boot)).toBe("unknown");
    expect(readFileSync(treePath(dir, "t"), "utf8")).toBe("{bad");
    expect(mergeTreeRecord(dir, "t", ROOT, ROOT)).toEqual({ status: "corrupt" });
    expect(readFileSync(treePath(dir, "t"), "utf8")).toBe("{bad");
  });

  test("记录已被持有者释放删掉：不重建；锁目录用完即删", () => {
    expect(mergeTreeRecord(dir, "t", ROOT, ROOT)).toEqual({ status: "missing" });
    expect(existsSync(treePath(dir, "t"))).toBe(false);
    expect(existsSync(treeLockPath(dir, "t"))).toBe(false);
  });
});

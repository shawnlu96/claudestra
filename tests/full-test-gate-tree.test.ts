// 全量测试闸的进程树归属（src/lib/full-test-gate-tree.ts，docs/architecture/full-test-gate.md）：开机标识、绑定组长启动时刻并会过期的
// pgid / sid 键、传递认进来的成员不得早于根。进程表一律伪造（启动时刻用真实写法 darwin:<秒>.<微秒>），临时闸目录，不写真实宿主闸。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeTree } from "../src/lib/full-test-gate.ts";
import { bootState, liveTree, rememberTree, type Boot, type Proc, type TreeRoot } from "../src/lib/full-test-gate-tree.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "full-gate-tree-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BOOT_AT = 1_000_000; // 本次开机（秒）
const ROOT_AT = 1_000_500; // 根启动
const at = (sec: number) => `darwin:${sec}.000000`;
const boot: Boot = { id: "11111111-2222-3333-4444-555555555555", at: at(BOOT_AT) };
const proc = (pid: number, sec: number, extra: Partial<Proc> = {}): Proc =>
  ({ pid, ppid: 1, pgid: pid, sid: pid, start: at(sec), uid: 501, uniq: null, puniq: null, ver: null, opv: null, ...extra });
const writeTree = (id: string, t: TreeRoot) => {
  mkdirSync(join(root, "trees"), { recursive: true });
  writeFileSync(join(root, "trees", `${id}.json`), JSON.stringify({ state: "running", ...t }));
};
const readTree = (id: string) => JSON.parse(readFileSync(join(root, "trees", `${id}.json`), "utf8"));
// 根 100 已退出；旧格式键集合里攒了 1 和一串小号
const legacy: TreeRoot = { pgid: 4000, start: at(ROOT_AT), uniq: null, ver: null, uid: 501, members: [],
  pgids: [4000, 1, 120, 321, 655], sids: [4000, 1, 120, 321, 655] };
// 系统进程（启动早于根）占着这些号：launchd 1、以及各自为组长 / 会话首进程的小号
const system = [proc(1, BOOT_AT, { pgid: 1, sid: 1 }), proc(120, BOOT_AT + 3), proc(321, BOOT_AT + 9), proc(655, BOOT_AT + 30),
  proc(656, BOOT_AT + 31, { pgid: 655, sid: 655 })];

describe("[验收线 1] 根已退出、键集合含 1 和小号、系统进程占着这些号且早于根", () => {
  test("改前 present，改后 absent；剪过的键落盘，不再只增不减", () => {
    expect(liveTree(legacy, system).members).toEqual([]);
    writeTree("old", legacy);
    expect(observeTree(root, "old", () => system, 60_000, () => boot)).toBe("absent");
    const saved = readTree("old");
    expect(saved.pgids).toEqual([]);
    expect(saved.sids).toEqual([]);
  });

  test("1 / 0 永不收；与根不同用户的成员不贡献键", () => {
    const tree: TreeRoot = { pgid: 4000, start: at(ROOT_AT), uniq: null, ver: null, uid: 501, members: [{ pid: 4100, start: at(ROOT_AT + 2), uniq: null, ver: null }] };
    const live = liveTree(tree, [proc(4000, ROOT_AT), proc(4100, ROOT_AT + 2, { pgid: 1, sid: 1 }), proc(4200, ROOT_AT + 3, { ppid: 4000, pgid: 4300, sid: 4300, uid: 0 }),
      proc(4300, ROOT_AT + 4, { uid: 0 })]);
    const ids = (keys: { id: number }[]) => keys.map((k) => k.id).sort();
    expect(ids(live.pgids)).toEqual([4000]);
    expect(ids(live.sids)).toEqual([4000]);
    expect(live.members.map((p) => p.pid).sort()).toEqual([4000, 4100, 4200]); // 4300 只靠 uid 0 成员的键才认得进来
  });
});

describe("[验收线 2] 开机标识", () => {
  test("开机标识不同 → absent，不扫进程表；相同照常判", () => {
    const tree: TreeRoot = { pgid: 4000, start: at(ROOT_AT), uniq: null, ver: null, uid: 501, members: [], boot: "another-boot" };
    writeTree("b", tree);
    expect(observeTree(root, "b", () => { throw new Error("换了开机不该扫进程表"); }, 60_000, () => boot)).toBe("absent");
    writeTree("b", { ...tree, boot: boot.id });
    expect(observeTree(root, "b", () => [proc(4000, ROOT_AT)], 60_000, () => boot)).toBe("present");
  });

  test("旧格式无开机字段：根早于本次开机 → absent；晚于本次开机照常判", () => {
    const before: TreeRoot = { ...legacy, start: at(BOOT_AT - 100) };
    expect(bootState(before, () => boot)).toBe("other");
    writeTree("legacy", before);
    // 号被系统进程占着（甚至启动时刻对得上）也不算：整棵按 absent
    expect(observeTree(root, "legacy", () => [proc(4000, BOOT_AT - 100), ...system], 60_000, () => boot)).toBe("absent");
    expect(bootState(legacy, () => boot)).toBe("same");
    // Linux：旧记录的根启动时刻里带着 boot_id
    expect(bootState({ ...legacy, start: "linux:aaa:100" }, () => ({ id: "bbb", at: null }))).toBe("other");
    expect(bootState({ ...legacy, start: "linux:aaa:100" }, () => ({ id: "aaa", at: null }))).toBe("same");
  });

  test("读不出开机标识 → unknown，不释放、不写记录", () => {
    writeTree("u", { ...legacy, boot: boot.id });
    const body = readFileSync(join(root, "trees", "u.json"), "utf8");
    expect(observeTree(root, "u", () => [], 60_000, () => null)).toBe("unknown");
    writeTree("u2", legacy);
    expect(observeTree(root, "u2", () => [], 60_000, () => null)).toBe("unknown");
    // 没开机字段、根启动时刻为 null / 认不出写法：也先认开机标识，读不出就 unknown，空进程表不放行
    for (const start of [null, "weird:1"]) {
      const odd: TreeRoot = { ...legacy, boot: null, start };
      expect(bootState(odd, () => null)).toBe("unknown");
      expect(bootState(odd, () => boot)).toBe("same");
      writeTree("u3", odd);
      expect(observeTree(root, "u3", () => [], 60_000, () => null)).toBe("unknown");
    }
    expect(readFileSync(join(root, "trees", "u.json"), "utf8")).toBe(body);
  });
});

describe("[验收线 3] 根启动后产生的真实后代照旧跟踪到退出", () => {
  test("脱组、过继给 1、另起会话的后代仍算成员；经键认进来的必须晚于根", () => {
    let tree: TreeRoot = { pgid: 4000, start: at(ROOT_AT), uniq: null, ver: null, uid: 501, members: [], boot: boot.id,
      pgids: [{ id: 4000, leaderStart: at(ROOT_AT) }], sids: [{ id: 4000, leaderStart: at(ROOT_AT) }] };
    // 第一次扫：根还在，子进程 4100 另起一组（pgid 4100），孙子 4101 在 4100 组里
    const step = (procs: Proc[]) => { const live = liveTree(tree, procs); tree = rememberTree(tree, live); return live.members.map((p) => p.pid).sort(); };
    expect(step([proc(4000, ROOT_AT), proc(4100, ROOT_AT + 1, { ppid: 4000, sid: 4000 }), proc(4101, ROOT_AT + 2, { ppid: 4100, pgid: 4100, sid: 4000 })]))
      .toEqual([4000, 4100, 4101]);
    // 根退出；4100 退出；4101 被过继给 1，另起会话（setsid）：按 PID + 启动时刻照旧认；4102（4100 组里漏采样的）按键认
    expect(step([proc(4101, ROOT_AT + 2, { pgid: 4101, sid: 4101 }), proc(4102, ROOT_AT + 5, { pgid: 4100, sid: 4000 })])).toEqual([4101, 4102]);
    // 占着 4000 组 / 会话号、却早于根的进程不算（重启 / 号复用后的外人）
    expect(step([proc(4101, ROOT_AT + 2, { pgid: 4101, sid: 4101 }), proc(4103, BOOT_AT + 1, { pgid: 4101, sid: 4101 })])).toEqual([4101]);
    expect(step([])).toEqual([]);
  });
});

describe("[验收线 4] pgid 号被复用", () => {
  test("pid == 该号的进程启动时刻不同 → 键作废，新进程不被认进来；组里还有成员时键保留", () => {
    const tree: TreeRoot = { pgid: 4000, start: at(ROOT_AT), uniq: null, ver: null, uid: 501, members: [], boot: boot.id,
      pgids: [{ id: 4000, leaderStart: at(ROOT_AT) }, { id: 5000, leaderStart: at(ROOT_AT + 10) }], sids: [] };
    // 5000 换了人（晚于根启动也不行：启动时刻对不上就是号被复用）
    const reused = liveTree(tree, [proc(5000, ROOT_AT + 99), proc(5001, ROOT_AT + 100, { pgid: 5000, sid: 5000 })]);
    expect(reused.members).toEqual([]);
    expect(reused.pgids.map((k) => k.id)).toEqual([]);
    // 组长 5000 已退出、组里还有 5002：键保留，5002 认进来
    const kept = liveTree(tree, [proc(5002, ROOT_AT + 20, { pgid: 5000, sid: 5002 })]);
    expect(kept.members.map((p) => p.pid)).toEqual([5002]);
    expect(kept.pgids).toContainEqual({ id: 5000, leaderStart: at(ROOT_AT + 10) });
    // 组长原样还在：键保留
    expect(liveTree(tree, [proc(5000, ROOT_AT + 10)]).pgids).toContainEqual({ id: 5000, leaderStart: at(ROOT_AT + 10) });
  });
});

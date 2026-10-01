/**
 * i28-R5b：出借 worker kill 前存 pane 现场（src/lib/lend-pane-archive.ts，lend-deps.ts 的 worker.kill 接线）。
 * tmux 全用假依赖；文件系统要么假的、要么 mkdtemp 临时目录，不碰 ~/.claude-orchestrator。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  archiveLendPane, lendPaneDir, nodePaneArchiveFs, paneArchiveName, parsePaneList, prunePlan, withPaneArchive,
  PANE_ARCHIVE_KEEP, PANE_ARCHIVE_LINES, type PaneArchiveDeps, type PaneArchiveFs, type PaneInfo,
} from "../src/lib/lend-pane-archive.js";
import { workerName } from "../src/lib/lend-drive.js";

const AGENT = workerName("o1");
const T0 = Date.UTC(2026, 9, 1, 4, 40, 30, 240);
const PANES: PaneInfo[] = [
  { id: "%1", index: "0", command: "bun" },
  { id: "%2", index: "1", command: "codex" },
  { id: "%3", index: "2", command: "zsh" },
];

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "lend-pane-"));
  dirs.push(d);
  return join(d, "logs", "lend");
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function memFs(over: Partial<PaneArchiveFs> = {}): PaneArchiveFs & { files: Map<string, string>; removed: string[] } {
  const files = new Map<string, string>();
  const removed: string[] = [];
  return {
    files, removed,
    ensureDir: () => {},
    writeNew: (p, d) => { files.set(p, d); },
    list: () => [...files.keys()].map((p) => p.split(sep).pop()!),
    remove: (p) => { removed.push(p); files.delete(p); },
    ...over,
  };
}

function fakeDeps(over: Partial<PaneArchiveDeps> = {}) {
  const logs: string[] = [];
  const captured: Array<{ id: string; lines: number }> = [];
  const listed: string[] = [];
  const deps: PaneArchiveDeps = {
    root: "/state/logs/lend",
    listPanes: async (a) => { listed.push(a); return PANES; },
    capture: async (id, lines) => { captured.push({ id, lines }); return `output of ${id}`; },
    fs: memFs(),
    now: () => T0,
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, logs, captured, listed };
}

describe("路径：agent 名拼不出 logs/lend 之外", () => {
  test("正常 worker 名落在 root/<agent>", () => {
    expect(lendPaneDir("/state/logs/lend", AGENT)).toBe(`/state/logs/lend/${AGENT}`);
  });
  test.each([
    "", ".", "..", "../x", "../../etc", "a/../../b", "a/b", "/etc/passwd", "a\\b", "a\0b", ".hidden", "x".repeat(129), "名字", "a b",
  ])("恶意 / 非法名 %p → null", (name) => {
    expect(lendPaneDir("/state/logs/lend", name)).toBeNull();
  });
  test("合法名 resolve 后一定在 root 之下", () => {
    for (const n of [AGENT, "a", "a.b", "a..b", "_x", "A-1_b.c"]) {
      const d = lendPaneDir("/state/logs/lend", n)!;
      expect(d.startsWith(resolve("/state/logs/lend") + sep)).toBe(true);
    }
  });
  test("文件名是 UTC 时间戳，字典序 = 时间序", () => {
    expect(paneArchiveName(T0)).toBe("pane-20261001T044030240Z.txt");
    expect(paneArchiveName(T0 + 1) > paneArchiveName(T0)).toBe(true);
    expect(paneArchiveName(T0 + 86_400_000) > paneArchiveName(T0 + 3_600_000)).toBe(true);
  });
});

describe("保留最近 20 份", () => {
  test("25 份删最旧 5 份；不认得的文件不碰", () => {
    const names = Array.from({ length: 25 }, (_, i) => paneArchiveName(T0 + i * 1000));
    const doomed = prunePlan([...names].reverse().concat(["notes.md", "pane-x.log"]));
    expect(doomed).toEqual(names.slice(0, 5));
  });
  test("不到 20 份不删", () => {
    expect(prunePlan(Array.from({ length: PANE_ARCHIVE_KEEP }, (_, i) => paneArchiveName(T0 + i)))).toEqual([]);
  });
});

describe("存档内容", () => {
  test("多 pane 全存，每个抓 2000 行", async () => {
    const { deps, captured, listed } = fakeDeps();
    const r = await archiveLendPane(AGENT, deps);
    expect(r).toEqual({ ok: true, path: `/state/logs/lend/${AGENT}/pane-20261001T044030240Z.txt`, panes: 3 });
    expect(listed).toEqual([AGENT]);
    expect(captured).toEqual(PANES.map((p) => ({ id: p.id, lines: PANE_ARCHIVE_LINES })));
    const text = (deps.fs as ReturnType<typeof memFs>).files.get((r as { path: string }).path)!;
    for (const p of PANES) {
      expect(text).toContain(`=== pane ${p.id} (index ${p.index}, ${p.command}) ===`);
      expect(text).toContain(`output of ${p.id}`);
    }
  });
  test("单个 pane 读失败：其余照存，失败写进存档", async () => {
    const { deps } = fakeDeps({ capture: async (id) => { if (id === "%2") throw new Error("boom"); return `output of ${id}`; } });
    const r = await archiveLendPane(AGENT, deps);
    expect(r.ok).toBe(true);
    const text = [...(deps.fs as ReturnType<typeof memFs>).files.values()][0]!;
    expect(text).toContain("output of %1");
    expect(text).toContain("output of %3");
    expect(text).toContain("capture 失败：boom");
  });
  test("list-panes 输出解析（tab 分隔，空行跳过）", () => {
    expect(parsePaneList("%1\t0\tbun\n\n%2\t1\tcodex\n")).toEqual([PANES[0]!, PANES[1]!]);
  });
});

describe("存档失败：不抛、只记日志", () => {
  const cases: Array<[string, Partial<PaneArchiveDeps>]> = [
    ["tmux list-panes 失败", { listPanes: async () => { throw new Error("no server running"); } }],
    ["窗口里没有 pane", { listPanes: async () => [] }],
    ["建目录失败", { fs: memFs({ ensureDir: () => { throw new Error("EACCES"); } }) }],
    ["写盘失败", { fs: memFs({ writeNew: () => { throw new Error("ENOSPC"); } }) }],
    ["时钟抛错", { now: () => { throw new Error("clock"); } }],
  ];
  test.each(cases)("%s → {ok:false} + 日志", async (_name, over) => {
    const { deps, logs } = fakeDeps(over);
    const r = await archiveLendPane(AGENT, deps);
    expect(r.ok).toBe(false);
    expect(logs.some((l) => l.includes("kill 照常"))).toBe(true);
  });
  test("恶意 agent 名：连 tmux 都不碰", async () => {
    const { deps, listed, logs } = fakeDeps();
    expect((await archiveLendPane("../../etc", deps)).ok).toBe(false);
    expect(listed).toEqual([]);
    expect(logs.length).toBe(1);
  });
  test("清理旧文件失败：新存档仍算成功", async () => {
    const { deps, logs } = fakeDeps({ fs: memFs({ list: () => { throw new Error("EIO"); } }) });
    expect((await archiveLendPane(AGENT, deps)).ok).toBe(true);
    expect(logs.some((l) => l.includes("清理旧文件失败"))).toBe(true);
  });
});

describe("withPaneArchive：先存档、kill 行为不变", () => {
  type Killed = { ok: boolean; reason?: string };
  const results: Killed[] = [{ ok: true }, { ok: false, reason: "读不到 tmux 窗口 / 进程，没法确认已退出" }, { ok: false, reason: "kill 后窗口还在（x）" }];

  test("顺序：archive 先于 kill，名字原样传", async () => {
    const order: string[] = [];
    const wrapped = withPaneArchive(async (n) => { order.push(`kill:${n}`); return { ok: true }; }, async (n) => { order.push(`archive:${n}`); });
    await wrapped(AGENT);
    expect(order).toEqual([`archive:${AGENT}`, `kill:${AGENT}`]);
  });

  test.each(results)("存档失败（tmux 读不到）：kill 照常、返回值逐项一致 %p", async (res) => {
    const kill = async (_n: string): Promise<Killed> => res;
    const { deps } = fakeDeps({ listPanes: async () => { throw new Error("no server running"); } });
    let killed = 0;
    const wrapped = withPaneArchive(async (n) => { killed++; return kill(n); }, (n) => archiveLendPane(n, deps));
    expect(await wrapped(AGENT)).toEqual(await kill(AGENT));
    expect(killed).toBe(1);
  });

  test.each(results)("存档失败（磁盘写不了）：kill 照常、返回值逐项一致 %p", async (res) => {
    const { deps } = fakeDeps({ fs: memFs({ writeNew: () => { throw new Error("EROFS"); } }) });
    let killed = 0;
    const wrapped = withPaneArchive(async () => { killed++; return res; }, (n) => archiveLendPane(n, deps));
    expect(await wrapped(AGENT)).toBe(res);
    expect(killed).toBe(1);
  });

  test("archive 违约抛错也挡不住 kill", async () => {
    const logs: string[] = [];
    const wrapped = withPaneArchive(async () => ({ ok: true }), async () => { throw new Error("bug"); }, (m) => logs.push(m));
    expect(await wrapped(AGENT)).toEqual({ ok: true });
    expect(logs[0]).toContain("kill 照常");
  });

  test("kill 自己抛错（如失租）原样往外抛，不被存档层吞掉", async () => {
    const wrapped = withPaneArchive(async () => { throw new Error("SchedulerLeaseLost"); }, async () => {});
    await expect(wrapped(AGENT)).rejects.toThrow("SchedulerLeaseLost");
  });
});

describe("真文件系统（临时目录）", () => {
  const realDeps = (root: string, now: number): PaneArchiveDeps =>
    ({ ...fakeDeps().deps, root, fs: nodePaneArchiveFs, now: () => now, log: () => {} });

  test("文件 0600、目录 0700（目录事先以 0755 存在也收紧）", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, AGENT), { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    chmodSync(join(root, AGENT), 0o755);
    const r = await archiveLendPane(AGENT, realDeps(root, T0));
    if (!r.ok) throw new Error(r.reason);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, AGENT)).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readFileSync(r.path, "utf8")).toContain("output of %3");
  });

  test("已有 25 份 → 写完剩最新 20 份", async () => {
    const root = tmpRoot();
    const dir = join(root, AGENT);
    mkdirSync(dir, { recursive: true });
    const old = Array.from({ length: 25 }, (_, i) => paneArchiveName(T0 - (25 - i) * 60_000));
    for (const n of old) writeFileSync(join(dir, n), "x");
    writeFileSync(join(dir, "README"), "keep");
    const r = await archiveLendPane(AGENT, realDeps(root, T0));
    expect(r.ok).toBe(true);
    const left = readdirSync(dir).filter((n) => n.startsWith("pane-")).sort();
    expect(left.length).toBe(PANE_ARCHIVE_KEEP);
    expect(left[left.length - 1]).toBe(paneArchiveName(T0));
    expect(left[0]).toBe(old[6]);
    expect(existsSync(join(dir, "README"))).toBe(true);
  });

  test("agent 目录是软链：拒写，不跟着跳出 logs/lend", async () => {
    const root = tmpRoot();
    const outside = join(root, "..", "..", "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, AGENT));
    const r = await archiveLendPane(AGENT, realDeps(root, T0));
    expect(r.ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("同名文件已存在（含软链）不覆盖", async () => {
    const root = tmpRoot();
    const dir = join(root, AGENT);
    mkdirSync(dir, { recursive: true });
    const target = join(root, "..", "victim");
    writeFileSync(target, "orig");
    symlinkSync(target, join(dir, paneArchiveName(T0)));
    expect((await archiveLendPane(AGENT, realDeps(root, T0))).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("orig");
  });
});

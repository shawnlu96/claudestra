/** 关键状态文件的快照 / 轮转 / 恢复与消失报警（src/lib/state-backup.ts）；全部在 mkdtemp 的临时状态目录里 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { KEEP_SNAPSHOTS, latestSnapshotWith, listSnapshots, restoreLocked, restoreSnapshot, stateGuard, takeSnapshot } from "../src/lib/state-backup.js";
import { writeTextAtomicSync } from "../src/lib/state-file.js";
import { acquireLock } from "../src/lib/file-lock.js";

const dirs: string[] = [];
const state = () => { const d = mkdtempSync(join(tmpdir(), "state-backup-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = (min: number) => new Date(Date.UTC(2026, 9, 4, 0, min));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("快照", () => {
  test("只收白名单里存在的文件；目录 0700、文件 0600；内容逐字节一样就不新建", () => {
    const d = state();
    writeFileSync(join(d, "principals.json"), '{"principals":[1]}');
    writeFileSync(join(d, "peers.json"), '{"httpPeers":[]}');
    writeFileSync(join(d, "other.json"), "{}");
    const first = takeSnapshot(d, at(0));
    expect(first).toMatchObject({ created: true, files: ["peers.json", "principals.json"] });
    const snap = join(d, "backups", "state", first.ts!);
    expect(mode(join(d, "backups", "state"))).toBe(0o700);
    expect(mode(snap)).toBe(0o700);
    expect(mode(join(snap, "principals.json"))).toBe(0o600);
    expect(readdirSync(snap).sort()).toEqual(["peers.json", "principals.json"]);
    expect(takeSnapshot(d, at(1))).toEqual({ created: false, ts: first.ts, files: first.files });
    writeFileSync(join(d, "peers.json"), '{"httpPeers":[2]}');
    expect(takeSnapshot(d, at(2)).created).toBe(true);
    rmSync(join(d, "peers.json"));
    expect(takeSnapshot(d, at(3))).toMatchObject({ created: true, files: ["principals.json"] }); // 少了文件也算变了
    expect(listSnapshots(d)).toHaveLength(3);
  });

  test("一个文件都没有就不建", () => {
    const d = state();
    expect(takeSnapshot(d, at(0))).toEqual({ created: false, ts: null, files: [] });
    expect(existsSync(join(d, "backups"))).toBe(false);
  });

  test("轮转：留最新 48 份；某个文件只剩老快照里有时，那一份也留着", () => {
    const d = state();
    writeFileSync(join(d, "peers.json"), "p");
    for (let i = 0; i < KEEP_SNAPSHOTS + 5; i++) {
      writeFileSync(join(d, "registry.json"), String(i));
      takeSnapshot(d, at(i));
      if (i === 0) rmSync(join(d, "peers.json")); // peers 只在第一份里
    }
    const all = listSnapshots(d);
    expect(all).toHaveLength(KEEP_SNAPSHOTS + 1);
    expect(all[0]!.files).toContain("peers.json");
    expect(latestSnapshotWith("peers.json", d)).toBe(all[0]!.ts);
    expect(all.slice(1).map((s) => s.ts)).toEqual(Array.from({ length: KEEP_SNAPSHOTS }, (_, k) => at(k + 5).toISOString().replace(/[:.]/g, "-")));
  });
});

describe("恢复", () => {
  test("恢复指定文件：原子写、0600；恢复前另存当前文件", () => {
    const d = state();
    writeFileSync(join(d, "principals.json"), "good");
    writeFileSync(join(d, "peers.json"), "peers-good");
    const good = takeSnapshot(d, at(0)).ts!;
    writeFileSync(join(d, "principals.json"), "bad");
    const r = restoreSnapshot(good, ["principals.json"], d, at(1));
    expect(r).toMatchObject({ ok: true, restored: ["principals.json"] });
    expect(readFileSync(join(d, "principals.json"), "utf8")).toBe("good");
    expect(mode(join(d, "principals.json"))).toBe(0o600);
    const safety = (r as { safetyTs: string }).safetyTs;
    expect(safety).not.toBe(good);
    expect(readFileSync(join(d, "backups", "state", safety, "principals.json"), "utf8")).toBe("bad");
  });

  test("不给文件名 = 恢复那份里全部（文件被删了也能恢复）", () => {
    const d = state();
    writeFileSync(join(d, "principals.json"), "a");
    writeFileSync(join(d, "peers.json"), "b");
    const ts = takeSnapshot(d, at(0)).ts!;
    rmSync(join(d, "principals.json"));
    rmSync(join(d, "peers.json"));
    expect(restoreSnapshot(ts, [], d, at(1))).toMatchObject({ ok: true, restored: ["peers.json", "principals.json"], safetyTs: ts });
    expect(readFileSync(join(d, "peers.json"), "utf8")).toBe("b");
  });

  test("拒绝白名单外的文件名、带 .. 的文件名和时间戳、那份里没有的文件；拒绝时什么都不写", () => {
    const d = state();
    writeFileSync(join(d, "principals.json"), "a");
    const ts = takeSnapshot(d, at(0)).ts!;
    writeFileSync(join(d, "principals.json"), "changed");
    for (const names of [["../principals.json"], ["evil.json"], ["principals.json", "../../etc/passwd"], ["peers.json"]]) {
      expect(restoreSnapshot(ts, names, d, at(1)).ok).toBe(false);
    }
    expect(restoreSnapshot("../backups", [], d, at(1)).ok).toBe(false);
    expect(restoreSnapshot("2026-01-01T00-00-00-000Z", [], d, at(1)).ok).toBe(false);
    expect(readFileSync(join(d, "principals.json"), "utf8")).toBe("changed");
    expect(listSnapshots(d)).toHaveLength(1);
  });

  test("目标是指到状态目录外的软链：写之前就拒，外部文件内容 / 权限不变，也不做安全快照", () => {
    const d = state();
    const outside = join(state(), "victim.txt");
    writeFileSync(join(d, "principals.json"), "snap");
    const ts = takeSnapshot(d, at(0)).ts!;
    writeFileSync(outside, "outside", { mode: 0o644 });
    rmSync(join(d, "principals.json"));
    symlinkSync(outside, join(d, "principals.json"));
    const r = restoreSnapshot(ts, ["principals.json"], d, at(1));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("不是普通文件") });
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(mode(outside)).toBe(0o644);
    expect(lstatSync(join(d, "principals.json")).isSymbolicLink()).toBe(true);
    expect(listSnapshots(d)).toHaveLength(1);
  });

  test("快照里的文件 / 备份目录经软链指到别处：拒，不读不写", () => {
    const d = state();
    const elsewhere = state();
    writeFileSync(join(d, "peers.json"), "snap");
    const ts = takeSnapshot(d, at(0)).ts!;
    writeFileSync(join(elsewhere, "secret"), "outside-secret");
    rmSync(join(d, "backups", "state", ts, "peers.json"));
    symlinkSync(join(elsewhere, "secret"), join(d, "backups", "state", ts, "peers.json"));
    writeFileSync(join(d, "peers.json"), "current");
    expect(restoreSnapshot(ts, ["peers.json"], d, at(1))).toMatchObject({ ok: false, error: expect.stringContaining("软链") });
    expect(readFileSync(join(d, "peers.json"), "utf8")).toBe("current");
    // backups 本身是软链：快照不往外写，连 state 子目录也不在外面建
    const d2 = state();
    writeFileSync(join(d2, "peers.json"), "x");
    symlinkSync(elsewhere, join(d2, "backups"));
    expect(() => takeSnapshot(d2, at(0))).toThrow("软链");
    expect(readdirSync(elsewhere)).toEqual(["secret"]);
  });

  test("恢复写入不跟软链：核完之后目标才被换成软链，替换的也是软链本身", () => {
    const d = state();
    const outside = join(state(), "victim.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(d, "principals.json"));
    writeTextAtomicSync(join(d, "principals.json"), "restored", { mode: 0o600, noFollow: true });
    expect(lstatSync(join(d, "principals.json")).isFile()).toBe(true);
    expect(readFileSync(join(d, "principals.json"), "utf8")).toBe("restored");
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  test("principals 锁被别人占着：拒绝恢复、什么都不写；锁在写之前丢了同样不写；拿到锁的恢复完会放锁", async () => {
    const d = state();
    writeFileSync(join(d, "principals.json"), "good");
    const ts = takeSnapshot(d, at(0)).ts!;
    writeFileSync(join(d, "principals.json"), "bad");
    const lock = join(d, "principals.json.lock");
    const holder = (await acquireLock(lock))!; // 另一个持有者：真建出 principals.json.lock/owner
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(holder.token);
    expect(await restoreLocked(ts, ["principals.json"], { dir: d, waitMs: 300 })).toMatchObject({ ok: false, error: expect.stringContaining("锁被占着") });
    expect(readFileSync(join(d, "principals.json"), "utf8")).toBe("bad");
    expect(listSnapshots(d)).toHaveLength(1);
    expect(holder.held()).toBe(true);
    holder.release();
    expect(restoreSnapshot(ts, ["principals.json"], d, at(1), () => false)).toMatchObject({ ok: false, error: expect.stringContaining("锁") });
    expect(readFileSync(join(d, "principals.json"), "utf8")).toBe("bad");
    expect(listSnapshots(d)).toHaveLength(1);
    expect(await restoreLocked(ts, ["principals.json"], { dir: d, waitMs: 300 })).toMatchObject({ ok: true, restored: ["principals.json"] });
    expect(readFileSync(join(d, "principals.json"), "utf8")).toBe("good");
    expect(existsSync(lock)).toBe(false);
  });

  test("restore 是写命令（认主守卫 + 命令级写锁），list / now 不是", () => {
    expect(isWriteInvocation("state-backup", ["restore", "x"])).toBe(true);
    expect(isWriteInvocation("state-backup", ["list"])).toBe(false);
    expect(isWriteInvocation("state-backup", ["now"])).toBe(false);
  });
});

describe("manager state-backup（子进程，临时 CLAUDESTRA_STATE_DIR）", () => {
  test("now → list → restore；出借 worker 不许 restore；用法错给 usage", () => {
    const d = state();
    const run = (args: string[], extra: Record<string, string> = {}) => {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: d, ...extra };
      delete env.DISCORD_CHANNEL_ID;
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/manager.ts"), "state-backup", ...args], { env, stdout: "pipe", stderr: "pipe" });
      return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
    };
    writeFileSync(join(d, "peers.json"), "good");
    const now = run(["now"]);
    expect(now).toMatchObject({ ok: true, created: true, files: ["peers.json"] });
    expect(run(["list"]).snapshots).toEqual([{ ts: now.ts, files: ["peers.json"] }]);
    rmSync(join(d, "peers.json"));
    expect(run(["restore", now.ts, "peers.json"], { CLAUDESTRA_LEND_WORKER: "1" })).toMatchObject({ ok: false });
    expect(existsSync(join(d, "peers.json"))).toBe(false);
    expect(run(["restore", now.ts, "peers.json"])).toMatchObject({ ok: true, restored: ["peers.json"] });
    expect(readFileSync(join(d, "peers.json"), "utf8")).toBe("good");
    expect(run(["restore"]).error).toContain("usage");
  });
});

describe("消失报警", () => {
  function guard(d: string) {
    const notes: string[] = [];
    const logs: string[] = [];
    const tick = stateGuard({ dir: d, notify: (t, b) => notes.push(`${t}|${b}`), log: (l) => logs.push(l), backupEvery: 1000 });
    return { tick, notes, logs };
  }

  test("在 → 消失报一次（带最近备份与恢复命令）；连着不在不重复报；回来后再消失再报", () => {
    const d = state();
    writeFileSync(join(d, "principals.json"), "x");
    writeFileSync(join(d, "peers.json"), "y");
    const g = guard(d);
    g.tick(); // 第一拍顺带快照
    const ts = listSnapshots(d)[0]!.ts;
    rmSync(join(d, "principals.json"));
    g.tick();
    expect(g.notes).toHaveLength(1);
    expect(g.notes[0]).toContain(`bun src/manager.ts state-backup restore ${ts} principals.json`);
    expect(g.logs.join("\n")).toContain("principals.json 不见了");
    g.tick(); g.tick();
    expect(g.notes).toHaveLength(1);
    writeFileSync(join(d, "principals.json"), "x");
    g.tick();
    expect(g.notes).toHaveLength(1);
    rmSync(join(d, "principals.json"));
    g.tick();
    expect(g.notes).toHaveLength(2);
  });

  test("启动时就不在的不报；没有备份时也照报，只是不带恢复命令", () => {
    const d = state();
    const g = guard(d);
    g.tick(); g.tick();
    expect(g.notes).toEqual([]);
    writeFileSync(join(d, "peers.json"), "y");
    g.tick();
    rmSync(join(d, "peers.json"));
    g.tick();
    expect(g.notes).toHaveLength(1);
    expect(g.notes[0]).toContain("没有找到含这个文件的备份");
  });
});

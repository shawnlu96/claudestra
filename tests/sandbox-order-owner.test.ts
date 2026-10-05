/**
 * 订单沙箱属主记录（lib/sandbox-order-owner.ts）：真实临时子进程登记、身份探测、读失败 / 损坏 / 软链 / 跨根一律 unknown。
 * 只在 /tmp 下的临时根目录里起 sleep / perl，不碰生产 tmux、bridge 或状态目录。
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  addSandboxOwned, archiveOwnerEvidence, identityVerdict, listSandboxOwners, ownerRecordId, ownerReviewDue, probeProcess,
  readSandboxOwner, registerSandboxOwner, type SandboxOwnerKey,
} from "../src/lib/sandbox-order-owner.ts";

const spawned: Bun.Subprocess[] = [];
let base = "";
let root = "";
let owners = "";

/** 真实子进程，cwd 在给定目录；命令行里放一个假凭据，检查它不落盘 */
function child(cwd = root, secret = "sk-test-SECRET123"): Bun.Subprocess {
  const p = Bun.spawn(["perl", "-e", "sleep 300", secret], { cwd, stdout: "ignore", stderr: "ignore" });
  spawned.push(p);
  return p;
}

const key = (orderId = "o-1", generation = 0): SandboxOwnerKey => ({ orderId, worker: "agent-lend-x", generation, scope: "write" });
const recordFile = (k: SandboxOwnerKey) => join(owners, "records", `${ownerRecordId(k)}.json`);

beforeEach(() => {
  base = mkdtempSync("/tmp/sbo-");
  root = join(base, "root");
  owners = join(base, "owners");
  mkdirSync(root);
});

afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
});

test("登记：自己探测身份，记录可读；命令行原文不落盘", async () => {
  const p = child();
  const rec = await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] }, 1000);
  expect(rec.resources[0]).toMatchObject({ kind: "child", pid: p.pid, entry: "perl" });
  expect(rec.resources[0].startedAt).toBeGreaterThan(0);
  const read = readSandboxOwner(owners, key());
  expect(read).toEqual({ status: "ok", record: rec });
  expect(readFileSync(recordFile(key()), "utf8")).not.toContain("SECRET123");
  expect(identityVerdict(rec.resources[0], await probeProcess(p.pid))).toBe("same");
});

test("登记拒绝：重复 key、cwd 不在根下、进程已退、pid 1 / 自己、坏 key、没有进程", async () => {
  const p = child();
  await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] });
  await expect(registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] })).rejects.toThrow("已经登记过");
  const outside = mkdtempSync("/tmp/sbo-out-");
  const q = child(outside);
  await expect(registerSandboxOwner(owners, { key: key("o-2"), root, resources: [{ kind: "child", pid: q.pid }] })).rejects.toThrow("不在沙箱根");
  const dead = child();
  dead.kill("SIGKILL");
  await dead.exited;
  await expect(registerSandboxOwner(owners, { key: key("o-3"), root, resources: [{ kind: "child", pid: dead.pid }] })).rejects.toThrow("已经不在");
  await expect(registerSandboxOwner(owners, { key: key("o-4"), root, resources: [{ kind: "child", pid: 1 }] })).rejects.toThrow();
  await expect(registerSandboxOwner(owners, { key: key("o-5"), root, resources: [{ kind: "bridge", pid: process.pid }] })).rejects.toThrow("登记者自己");
  await expect(registerSandboxOwner(owners, { key: key("../x"), root, resources: [{ kind: "child", pid: p.pid }] })).rejects.toThrow("不合法");
  await expect(registerSandboxOwner(owners, { key: key("o-6"), root, resources: [] })).rejects.toThrow("没有可登记");
  // 普通进程冒充 tmux：不是 socket 上的 tmux server
  writeFileSync(join(root, "fake.sock"), "");
  await expect(registerSandboxOwner(owners, { key: key("o-7"), root, resources: [{ kind: "tmux", pid: p.pid, socket: join(root, "fake.sock") }] }))
    .rejects.toThrow("不是 socket 文件");
  expect(readdirSync(join(owners, "records"))).toEqual([`${ownerRecordId(key())}.json`]);
});

test("登记拒绝：根目录是软链 / 家目录 / 与属主目录重叠；同一进程不能归两单", async () => {
  const p = child();
  const link = join(base, "link");
  symlinkSync(root, link);
  await expect(registerSandboxOwner(owners, { key: key(), root: link, resources: [{ kind: "child", pid: p.pid }] })).rejects.toThrow("不是普通目录");
  await expect(registerSandboxOwner(owners, { key: key(), root: homedir(), resources: [{ kind: "child", pid: p.pid }] })).rejects.toThrow("家目录");
  await expect(registerSandboxOwner(join(root, "owners"), { key: key(), root, resources: [{ kind: "child", pid: p.pid }] })).rejects.toThrow("重叠");
  await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] });
  const root2 = join(base, "root2");
  mkdirSync(root2);
  await expect(registerSandboxOwner(owners, { key: key("o-2"), root: root2, resources: [{ kind: "child", pid: p.pid }] })).rejects.toThrow();
  await expect(registerSandboxOwner(owners, { key: key("o-3"), root: join(root, "sub"), resources: [{ kind: "child", pid: p.pid }] })).rejects.toThrow();
});

test("读：没有 / 损坏 / 软链 / 文件名与 key 不符 / 根目录换成软链 / 属主目录是软链，全部 unknown", async () => {
  expect(readSandboxOwner(owners, key()).status).toBe("unknown");
  const p = child();
  await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] });
  const file = recordFile(key());
  const good = readFileSync(file, "utf8");

  writeFileSync(file, "{not json");
  expect(readSandboxOwner(owners, key())).toMatchObject({ status: "unknown", reason: expect.stringContaining("损坏") });
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), resources: [] }));
  expect(readSandboxOwner(owners, key()).status).toBe("unknown");

  const elsewhere = join(base, "elsewhere.json");
  writeFileSync(elsewhere, good);
  rmSync(file);
  symlinkSync(elsewhere, file);
  expect(readSandboxOwner(owners, key())).toMatchObject({ status: "unknown", reason: expect.stringContaining("软链") });
  rmSync(file);

  // 别的 key 的记录挪到这个 key 的文件名下
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), key: key("o-other") }));
  expect(readSandboxOwner(owners, key())).toMatchObject({ status: "unknown", reason: expect.stringContaining("对不上") });
  writeFileSync(file, good);
  expect(readSandboxOwner(owners, key()).status).toBe("ok");

  renameSync(root, `${root}.real`);
  symlinkSync(`${root}.real`, root);
  expect(readSandboxOwner(owners, key()).status).toBe("unknown");
  rmSync(root);
  renameSync(`${root}.real`, root);

  renameSync(owners, `${owners}.real`);
  symlinkSync(`${owners}.real`, owners);
  expect(readSandboxOwner(owners, key()).status).toBe("unknown");
  expect(listSandboxOwners(owners).status).toBe("unknown");
});

test("列举：目录读不了是 unknown 不是空；坏记录单列", async () => {
  expect(listSandboxOwners(join(base, "missing")).status).toBe("unknown");
  const p = child();
  await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] });
  writeFileSync(join(owners, "records", "junk.json"), "[]");
  const l = listSandboxOwners(owners);
  if (l.status !== "ok") throw new Error(l.reason);
  expect(l.entries.map((e) => [e.id, e.read.status])).toEqual(
    [[ownerRecordId(key()), "ok"], ["junk", "unknown"]].sort((a, b) => a[0].localeCompare(b[0])),
  );
});

test("身份：pid 复用（启动时刻不同）= reused；进程退出 = gone；命令对不上 = unknown", async () => {
  const p = child();
  const rec = await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] });
  const r = rec.resources[0];
  const now = await probeProcess(p.pid);
  expect(identityVerdict({ ...r, startedAt: r.startedAt - 60_000 }, now)).toBe("reused");
  expect(identityVerdict({ ...r, commandHash: "0".repeat(64) }, now)).toBe("unknown");
  expect(identityVerdict({ ...r, cwd: "/" }, now)).toBe("unknown");
  expect(identityVerdict(r, { state: "unknown", reason: "x" })).toBe("unknown");
  p.kill("SIGKILL");
  await p.exited;
  expect(await probeProcess(p.pid)).toEqual({ state: "gone" });
  expect(identityVerdict(r, await probeProcess(p.pid))).toBe("gone");
  expect((await probeProcess(0)).state).toBe("unknown");
});

test("补登记子进程：核根目录、清理开始后拒绝；记录不存在拒绝", async () => {
  const p = child();
  await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "bridge", pid: p.pid }] });
  const c = child();
  const rec = await addSandboxOwned(owners, key(), { pid: c.pid });
  expect(rec.resources.map((r) => r.kind)).toEqual(["bridge", "child"]);
  await expect(addSandboxOwned(owners, key(), { pid: c.pid })).rejects.toThrow();
  const outside = child(mkdtempSync("/tmp/sbo-out-"));
  await expect(addSandboxOwned(owners, key(), { pid: outside.pid })).rejects.toThrow("不在沙箱根");
  await expect(addSandboxOwned(owners, key("nope"), { pid: c.pid })).rejects.toThrow("没有属主记录");
  const file = recordFile(key());
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), cleanup: { attempts: 1, lastAt: 1, done: false, outcomes: [] } }));
  await expect(addSandboxOwned(owners, key(), { pid: child().pid })).rejects.toThrow("已经开始清理");
});

test("自有临时目录：登记真实路径 + dev/ino；软链 / 家目录 / 属主目录 / 与别单重叠拒绝；可补登记", async () => {
  const tmpA = mkdtempSync("/tmp/sbo-place-");
  const rec = await registerSandboxOwner(owners, { key: key(), root, resources: [], dirs: [tmpA] });
  expect(rec.dirs).toEqual([{ path: realpathSync(tmpA), dev: expect.any(Number), ino: expect.any(Number) }]);
  expect(readSandboxOwner(owners, key()).status).toBe("ok");
  const link = join(base, "dirlink");
  symlinkSync(tmpA, link);
  const fresh = () => key(`o-${Math.random().toString(36).slice(2, 8)}`);
  await expect(registerSandboxOwner(owners, { key: fresh(), root: join(base, "r2"), resources: [], dirs: [] })).rejects.toThrow();
  mkdirSync(join(base, "r2"));
  for (const d of [link, homedir(), owners, join(base, "nope")]) {
    await expect(registerSandboxOwner(owners, { key: fresh(), root: join(base, "r2"), resources: [], dirs: [d] })).rejects.toThrow();
  }
  // 别单已登记的目录（或它的子目录）不能再归这一单
  mkdirSync(join(tmpA, "sub"));
  await expect(registerSandboxOwner(owners, { key: fresh(), root: join(base, "r2"), resources: [], dirs: [join(tmpA, "sub")] })).rejects.toThrow("重叠");
  const tmpB = mkdtempSync("/tmp/sbo-val-");
  expect((await addSandboxOwned(owners, key(), { dir: tmpB })).dirs.map((d) => d.path)).toEqual([realpathSync(tmpA), realpathSync(tmpB)]);
  await expect(addSandboxOwned(owners, key(), { dir: tmpB })).rejects.toThrow("已在这份记录里");
});

test("证据保全：读回一致才算；archive 是软链就失败", async () => {
  const p = child();
  const rec = await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] });
  const file = await archiveOwnerEvidence(owners, rec, { n: 1 }, 42);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ record: rec, snapshot: { n: 1 }, at: 42 });
  rmSync(join(owners, "archive"), { recursive: true });
  symlinkSync(base, join(owners, "archive"));
  await expect(archiveOwnerEvidence(owners, rec, {}, 43)).rejects.toThrow("不是普通目录");
});

test("TTL 只标记该复核：没到 / 已清完都不算", async () => {
  const p = child();
  const rec = await registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "child", pid: p.pid }] }, 1000);
  expect(ownerReviewDue(rec, 1500, 1000)).toBe(false);
  expect(ownerReviewDue(rec, 2000, 1000)).toBe(true);
  expect(ownerReviewDue({ ...rec, cleanup: { attempts: 1, lastAt: 2, done: true, outcomes: [] } }, 9e9, 1000)).toBe(false);
});


test("root-prefix: 根外 cwd 与包含根前缀的 argv 不构成归属", async () => {
  const outside = `${root}-other`;
  mkdirSync(outside);
  const p = child(outside, realpathSync(outside));
  await expect(registerSandboxOwner(owners, { key: key(), root, resources: [{ kind: "bridge", pid: p.pid }] })).rejects.toThrow("不在沙箱根");
  expect((await probeProcess(p.pid)).state).toBe("alive");
});

test("owner-race: 不同 key 同时登记同一根只能成功一个", async () => {
  const results = await Promise.allSettled(["first", "second"].map((id) =>
    registerSandboxOwner(owners, { key: key(id), root, resources: [], dirs: [root] })));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(readdirSync(join(owners, "records"))).toHaveLength(1);
});


test("owner-race: 不同 key 同时补登记同一目录只能成功一个", async () => {
  const root2 = join(base, "root2"), place = join(base, "place");
  mkdirSync(root2); mkdirSync(place);
  for (const [id, dir] of [["first", root], ["second", root2]]) {
    await registerSandboxOwner(owners, { key: key(id), root: dir, resources: [], dirs: [dir] });
  }
  const results = await Promise.allSettled(["first", "second"].map((id) => addSandboxOwned(owners, key(id), { dir: place })));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});

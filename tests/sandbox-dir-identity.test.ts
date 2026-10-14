/**
 * LIFESBX2：目录身份补出生时间（src/lib/sandbox-dir-identity.ts）。同路径重建复用 inode 由注入 stat 构造：
 * 回收不删被替换 / 认不出的根外目录（保留、只报一次；执行器删前复核也按 delete），重启认出复用 inode 的重建根，旧登记（没有 birth）重启照旧。
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirIdentity, dirMismatch, dirStat, validDir, type OwnedDir } from "../src/lib/sandbox-dir-identity.ts";
import { sandboxOrderOwnership } from "../src/lib/sandbox-order-cleanup.ts";
import { readSandboxOwner, registerSandboxOwner, restartSandboxOwner, type SandboxOwnerKey } from "../src/lib/sandbox-order-owner.ts";

const key: SandboxOwnerKey = { orderId: "o-1", worker: "agent-lend-x", generation: 2, scope: "sandbox" };
const realRead = dirStat.read, bases: string[] = [];
afterEach(() => {
  dirStat.read = realRead;
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

/** 按真实路径改写 stat 的 ino / 出生时间（0n = 文件系统给不出）；其余字段与方法取真实 stat */
const fake = new Map<string, { ino?: bigint; birth?: bigint }>();
function injectStat(): void {
  fake.clear();
  dirStat.read = (p) => {
    const st = realRead(p), o = fake.get(p);
    if (!st || !o) return st;
    return Object.assign(Object.create(st), o.ino === undefined ? {} : { ino: o.ino }, o.birth === undefined ? {} : { birthtimeNs: o.birth });
  };
}

async function setup(withInner = false) {
  const base = realpathSync(mkdtempSync("/tmp/lsx-birth-")); bases.push(base);
  const root = join(base, "sandbox"), owners = join(base, "owners"), external = join(base, "external"), inner = join(root, "inner");
  for (const d of [root, external, ...(withInner ? [inner] : [])]) mkdirSync(d);
  return { base, root, owners, external, inner };
}

const ownership = (owners: string) => sandboxOrderOwnership({
  dir: owners, orderFacts: async () => ({ state: "cancelled", generation: key.generation, resultPending: false }),
  workerLiveness: async () => "no_window", withOrderCleanupLease: (_k, run) => run(() => true),
});

/** 删掉重建，并让新目录拿到旧 inode（ext4 上真实会发生） */
function rebuildReusingInode(path: string, old: OwnedDir, birth?: bigint): void {
  rmSync(path, { recursive: true });
  mkdirSync(path);
  fake.set(path, { ino: BigInt(old.ino), ...(birth === undefined ? {} : { birth }) });
}

test("比对规则：三项任一不同 / birth 不等不是同一个；一方没有 birth 时 keep 当同一个、delete 认不出", () => {
  const reg: OwnedDir = { path: "/x", dev: 1, ino: 2, birth: "100" };
  expect(dirMismatch(reg, { ...reg })).toBeNull();
  expect(dirMismatch(reg, { ...reg }, "delete")).toBeNull();
  expect(dirMismatch(reg, { ...reg, ino: 3 })).toContain("已不是登记的那个");
  expect(dirMismatch(reg, { ...reg, birth: "200" })).toContain("同路径重建");
  expect(dirMismatch(reg, { ...reg, birth: "200" }, "delete")).toContain("同路径重建");
  const legacy: OwnedDir = { path: "/x", dev: 1, ino: 2 };
  for (const [a, b] of [[legacy, reg], [reg, legacy], [legacy, legacy]] as const) {
    expect(dirMismatch(a, b)).toBeNull();
    expect(dirMismatch(a, b, "delete")).toContain("缺出生时间");
  }
  expect(validDir(legacy) && validDir(reg)).toBe(true);
  expect([{ ...reg, birth: 100 }, { ...reg, birth: "0" }, { ...reg, birth: "1e9" }].some(validDir)).toBe(false);
});

test("[验收线 1] 根外登记目录同路径重建、dev/ino 相同而 birth 不同：回收不删、保留，只报一次", async () => {
  injectStat();
  const f = await setup();
  fake.set(f.external, { birth: 1_000n });
  const rec = await registerSandboxOwner(f.owners, { key, root: f.root, resources: [], dirs: [f.root, f.external] });
  expect(rec.dirs[1]!.birth).toBe("1000");
  rebuildReusingInode(f.external, rec.dirs[1]!, 2_000n);
  writeFileSync(join(f.external, "unrelated-data.txt"), "not ours");
  const own = ownership(f.owners);
  const first = await own.cleanup(key);
  expect(first.status).toBe("done");
  expect(first.reason).toContain("同路径重建");
  expect(first.resources.find((r) => r.path === f.external)).toEqual({ kind: "dir", path: f.external, outcome: "retained", detail: expect.stringContaining("同路径重建") });
  const second = await own.cleanup(key);
  expect(second.status).toBe("done");
  expect(second.reason).toBeUndefined();
  expect(second.resources.find((r) => r.path === f.external)?.outcome).toBe("retained");
  expect(readFileSync(join(f.external, "unrelated-data.txt"), "utf8")).toBe("not ours");
});

test("交执行器后出生时间才变得拿不到：rmSync 前那次复核按 delete 判，不删", async () => {
  injectStat();
  const f = await setup();
  fake.set(f.external, { birth: 1_000n });
  await registerSandboxOwner(f.owners, { key, root: f.root, resources: [], dirs: [f.root, f.external] });
  // 第二次 lsof = 执行器的占用检查；它之后只剩删前最后一次同步复核：从这里起文件系统给不出出生时间
  const realSpawn = Bun.spawn;
  let lsof = 0;
  (Bun as { spawn: unknown }).spawn = ((cmd: string[], opts: unknown) => {
    if (cmd[0] === "lsof" && cmd.includes(f.external) && ++lsof === 2) fake.set(f.external, { birth: 0n });
    return realSpawn(cmd, opts as never);
  }) as never;
  let report;
  try { report = await ownership(f.owners).cleanup(key); } finally { (Bun as { spawn: unknown }).spawn = realSpawn; }
  expect(report.status).toBe("partial");
  expect(report.resources.find((r) => r.path === f.external)).toMatchObject({ outcome: "stop_failed", detail: expect.stringContaining("缺出生时间") });
  expect(existsSync(f.external)).toBe(true);
  const next = await ownership(f.owners).cleanup(key); // 下一轮在执行器之前就认出，保留并报一次
  expect(next).toMatchObject({ status: "done", reason: expect.stringContaining("缺出生时间") });
  expect(existsSync(f.external)).toBe(true);
});

test("[验收线 2] 登记了根内子目录、根 clean 后重建复用 inode：birth 不等进重建检查，正常重启并去掉旧子目录登记", async () => {
  injectStat();
  const f = await setup(true);
  fake.set(f.root, { birth: 1_000n });
  const rec = await registerSandboxOwner(f.owners, { key, root: f.root, resources: [], dirs: [f.root, f.inner, f.external] });
  rebuildReusingInode(f.root, rec.dirs[0]!, 2_000n);
  const again = await restartSandboxOwner(f.owners, key);
  expect(again.dirs).toEqual([{ ...rec.dirs[0]!, birth: "2000" }, rec.dirs[2]!]);
  expect(readSandboxOwner(f.owners, key)).toEqual({ status: "ok", record: again });
});

test("[验收线 3] 旧登记没有 birth：重启当同一个、记录原样；回收保留根外目录并只报一次", async () => {
  injectStat();
  const f = await setup(true);
  for (const p of [f.root, f.inner, f.external]) fake.set(p, { birth: 0n }); // 升级前登记 = 不带 birth
  const rec = await registerSandboxOwner(f.owners, { key, root: f.root, resources: [], dirs: [f.root, f.inner, f.external] });
  expect(rec.dirs.every((d) => d.birth === undefined)).toBe(true);
  fake.clear(); // 升级后：文件系统给得出出生时间，一方没有 birth
  expect((await restartSandboxOwner(f.owners, key)).dirs).toEqual(rec.dirs);

  const own = ownership(f.owners);
  const first = await own.cleanup(key);
  expect(first.status).toBe("done");
  expect(first.reason).toContain(`目录 ${f.external} 缺出生时间`);
  expect(first.resources.filter((r) => r.kind === "dir")).toEqual([
    { kind: "dir", path: f.root, outcome: "retained" }, { kind: "dir", path: f.inner, outcome: "retained" },
    { kind: "dir", path: f.external, outcome: "retained", detail: expect.stringContaining("保留不删") },
  ]);
  const second = await own.cleanup(key);
  expect(second.status).toBe("done");
  expect(second.reason).toBeUndefined();
  expect(second.resources.find((r) => r.path === f.external)?.outcome).toBe("retained");
  expect(existsSync(f.external)).toBe(true);
});

test("登记带 birth、此刻文件系统给不出：重启当同一个，回收同样保留不删", async () => {
  injectStat();
  const f = await setup();
  fake.set(f.external, { birth: 1_000n });
  const rec = await registerSandboxOwner(f.owners, { key, root: f.root, resources: [], dirs: [f.root, f.external] });
  fake.set(f.external, { birth: 0n });
  expect((await restartSandboxOwner(f.owners, key)).dirs).toEqual(rec.dirs);
  const report = await ownership(f.owners).cleanup(key);
  expect(report.status).toBe("done");
  expect(report.reason).toContain("缺出生时间");
  expect(existsSync(f.external)).toBe(true);
});

test("双方 birth 相等的根外目录照常回收删除", async () => {
  const f = await setup();
  const rec = await registerSandboxOwner(f.owners, { key, root: f.root, resources: [], dirs: [f.root, f.external] });
  if (rec.dirs[1]!.birth === undefined) return; // 文件系统给不出出生时间：上一条覆盖（保留不删）
  const report = await ownership(f.owners).cleanup(key);
  expect(report).toMatchObject({ status: "done", resources: [{ path: f.root, outcome: "retained" }, { path: f.external, outcome: "removed" }] });
  expect(report.reason).toBeUndefined();
  expect(existsSync(f.external)).toBe(false);
  expect(readdirSync(f.base)).toContain("sandbox");
});

test("本平台出生时间探测（只打印，CI 日志里核 Linux 能否拿到；拿不到按一方没有 birth 处理）", async () => {
  const f = await setup();
  const id = dirIdentity(f.root)!;
  console.log(`[LIFESBX2] ${process.platform} bun ${Bun.version} 目录出生时间：${id.birth === undefined ? "拿不到（不记 birth）" : `可得 ${id.birth}`}`);
  expect(id.birth === undefined || validDir(id)).toBe(true);
});

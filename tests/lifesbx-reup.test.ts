/**
 * LIFESBX1：on 模式同一订单同一代次 up → down → clean → 同根再 up。clean 删根后重建的根是新 inode，
 * restartSandboxOwner（sandbox-order-owner.ts）在旧进程全退、新根没有沙箱标记时只重新采集根的身份；根外登记目录换了照旧拒。
 * 前半是属主记录层的条件，后半经原入口 scripts/sandbox.ts 真的起、停、删、再起一遍。
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lendDeps } from "../src/lib/lend-deps.ts";
import { openLendJournal, patchOrder } from "../src/lib/lend-journal.ts";
import { sandboxOwnersDir } from "../src/lib/lend-sandbox.ts";
import { SANDBOX_MARKER } from "../src/lib/sandbox.ts";
import { listSandboxOwners, readSandboxOwner, registerSandboxOwner, restartSandboxOwner, type SandboxOwnerKey } from "../src/lib/sandbox-order-owner.ts";
import { sandboxOrderOwnership } from "../src/lib/sandbox-order-cleanup.ts";
import { harness, toStarted } from "./lend-harness.ts";
import { Fleet, type StartSpec } from "./sandbox-isolation-start-fixture.ts";
import { testChildEnv } from "./test-env.ts";

const fleet = new Fleet(), bases: string[] = [];
const SCRIPT = resolve(import.meta.dir, "../scripts/sandbox.ts");
afterEach(async () => {
  expect(await fleet.stopAll()).toEqual([]);
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const key: SandboxOwnerKey = { orderId: "o-1", worker: "agent-lend-x", generation: 2, scope: "sandbox" };

/**
 * 删根后建占位目录并留着：Linux（ext4）会把刚释放的 inode 给随后新建的目录，同路径重建的根就和登记的身份一样了。
 * 占位一直建到有一个拿走旧根的 inode 为止；建满还没人拿到的文件系统（APFS、tmpfs）本来就不马上复用。
 */
function removeRoot(f: { base: string; root: string }): void {
  const old = lstatSync(f.root).ino;
  rmSync(f.root, { recursive: true });
  for (let i = 0; i < 64; i++) if (lstatSync(mkdtempSync(join(f.base, "spacer-"))).ino === old) return;
}

async function registered() {
  const base = mkdtempSync("/tmp/lsx-reup-"); bases.push(base);
  const root = join(base, "sandbox"), owners = join(base, "owners");
  mkdirSync(root);
  const first = await registerSandboxOwner(owners, { key, root, resources: [], dirs: [root] });
  return { base, root, owners, first };
}

test("clean 删根后同路径重建：重启登记采到新目录身份，旧身份留在证据里", async () => {
  const f = await registered();
  removeRoot(f);
  mkdirSync(f.root);
  const again = await restartSandboxOwner(f.owners, key);
  expect(again.dirs).toHaveLength(1);
  expect(again.dirs[0]!.path).toBe(f.first.dirs[0]!.path);
  expect(again.dirs[0]!.ino).not.toBe(f.first.dirs[0]!.ino);
  expect(again.createdAt).toBe(f.first.createdAt);
  expect(readSandboxOwner(f.owners, key)).toEqual({ status: "ok", record: again });
  const archived = readdirSync(join(f.owners, "archive")).map((n) => JSON.parse(readFileSync(join(f.owners, "archive", n), "utf8")));
  expect(archived).toHaveLength(1);
  expect(archived[0].record.dirs).toEqual(f.first.dirs);
  expect(archived[0].snapshot.phase).toBe("restart");
});

test("没 clean 的重启目录身份原样不动", async () => {
  const f = await registered();
  writeFileSync(join(f.root, SANDBOX_MARKER), "{}");
  expect((await restartSandboxOwner(f.owners, key)).dirs).toEqual(f.first.dirs);
});

test("换来的目录带沙箱标记、是软链、或根不在：都不追认，记录不变", async () => {
  const swaps: Array<(root: string, base: string) => void> = [
    (root) => { mkdirSync(root); writeFileSync(join(root, SANDBOX_MARKER), "{}"); },
    (root, base) => { mkdirSync(join(base, "elsewhere")); symlinkSync(join(base, "elsewhere"), root); },
    () => {},
  ];
  for (const swap of swaps) {
    const f = await registered();
    const before = readFileSync(join(f.owners, "records", readdirSync(join(f.owners, "records"))[0]!), "utf8");
    removeRoot(f);
    swap(f.root, f.base);
    await expect(restartSandboxOwner(f.owners, key)).rejects.toThrow();
    expect(readFileSync(join(f.owners, "records", readdirSync(join(f.owners, "records"))[0]!), "utf8")).toBe(before);
  }
});

/** 根 + 一个根外登记目录 + 一个根内登记目录；根里带沙箱标记（起过） */
async function withExternal() {
  const base = mkdtempSync("/tmp/lsx-reup-"); bases.push(base);
  const root = join(base, "sandbox"), owners = join(base, "owners"), external = join(base, "external"), inner = join(root, "inner");
  for (const d of [root, external, inner]) mkdirSync(d);
  writeFileSync(join(root, SANDBOX_MARKER), "{}");
  const first = await registerSandboxOwner(owners, { key, root, resources: [], dirs: [root, external, inner] });
  const file = join(owners, "records", readdirSync(join(owners, "records"))[0]!);
  return { base, root, owners, external, inner, first, file };
}

/** 把根外登记目录挪到旁边（原 inode 还占着），同路径上放别人的目录和数据 */
function swapExternal(f: { base: string; external: string }): string {
  renameSync(f.external, join(f.base, "external-moved"));
  mkdirSync(f.external);
  const data = join(f.external, "unrelated-data.txt");
  writeFileSync(data, "not ours");
  return data;
}

test("根没 clean、根外登记目录被换成无标记的普通目录：不追认，记录不变，随后的终态回收拒绝、别人的数据还在", async () => {
  const f = await withExternal(), before = readFileSync(f.file, "utf8");
  const data = swapExternal(f);
  await expect(restartSandboxOwner(f.owners, key)).rejects.toThrow("自有目录身份已变");
  expect(readFileSync(f.file, "utf8")).toBe(before);
  const own = sandboxOrderOwnership({
    dir: f.owners, orderFacts: async () => ({ state: "cancelled", generation: key.generation, resultPending: false }),
    workerLiveness: async () => "no_window", withOrderCleanupLease: (_k, run) => run(() => true),
  });
  const report = await own.cleanup(key);
  expect(report.status).toBe("refused");
  expect(readFileSync(data, "utf8")).toBe("not ours");
  expect(existsSync(join(f.base, "external-moved")) && existsSync(f.root)).toBe(true);
});

test("根真的 clean 重建了：根外目录换了仍拒；根外目录没动时采新根、去掉随旧根没了的根内目录", async () => {
  const rebuild = (f: { base: string; root: string }) => { removeRoot(f); mkdirSync(f.root); };
  const swapped = await withExternal(), before = readFileSync(swapped.file, "utf8");
  rebuild(swapped);
  const data = swapExternal(swapped);
  await expect(restartSandboxOwner(swapped.owners, key)).rejects.toThrow("自有目录身份已变");
  expect(readFileSync(swapped.file, "utf8")).toBe(before);
  expect(existsSync(data)).toBe(true);

  const f = await withExternal();
  rebuild(f);
  const again = await restartSandboxOwner(f.owners, key);
  expect(again.dirs.map((d) => d.path)).toEqual([f.first.dirs[0]!.path, f.first.dirs[1]!.path]);
  expect(again.dirs[0]!.ino).not.toBe(f.first.dirs[0]!.ino);
  expect(again.dirs[1]).toEqual(f.first.dirs[1]!);

  const reborn = await withExternal(); // 根内登记目录同路径又出现（不是登记的那个）：不追认
  rebuild(reborn); mkdirSync(reborn.inner);
  await expect(restartSandboxOwner(reborn.owners, key)).rejects.toThrow("自有目录身份已变");
});

test("挪进来的旧目录不算重建的根：创建时间早于登记的拒", async () => {
  const base = mkdtempSync("/tmp/lsx-reup-"); bases.push(base);
  const root = join(base, "sandbox"), owners = join(base, "owners"), old = join(base, "old");
  mkdirSync(old); mkdirSync(root);
  const born = lstatSync(old).birthtimeMs;
  await registerSandboxOwner(owners, { key, root, resources: [], dirs: [root] }, Date.now() + 5_000);
  rmSync(root, { recursive: true });
  renameSync(old, root);
  // 文件系统报不出创建时间、或 rename 后不保留的平台上这条核不了（实现按报不出放行，靠标记与根外拒绝兜住）
  if (!(born > 0) || lstatSync(root).birthtimeMs !== born) return;
  await expect(restartSandboxOwner(owners, key)).rejects.toThrow("自有目录身份已变");
});

test("on 同单同代经原入口 up → down → clean → 同根再 up：登记的是新根和新进程", async () => {
  const base = mkdtempSync("/tmp/lsx-e2e-"); bases.push(base);
  const home = join(base, "home"), clone = join(base, "clone"), state = join(base, "state"), runtime = join(base, "runtime");
  for (const d of [home, join(clone, ".git"), state, runtime, join(base, "tmp")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: false, projects: {}, lifecycle: "on" }));
  const journal = join(state, "lend", "journal.sqlite"), h = harness();
  h.db.close(); h.db = openLendJournal(journal); h.d.db = h.db;
  try {
    h.d.clone = async () => ({ ok: true, dir: clone });
    const production = lendDeps(h.db, { get: () => undefined } as never, () => {}, undefined, () => async (...args) => {
      if (args[0] === "create") h.registry.set(args[1]!, { sessionId: "fake-session", cwd: clone });
      return { ok: true };
    });
    h.d.worker.create = production.worker.create;
    await toStarted(h);
    patchOrder(h.db, "o1", ["started"], { leaseUntil: Date.now() + 300_000 }, h.d.now());
    const env = testChildEnv({ HOME: home, TMPDIR: join(base, "tmp"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime,
      CLAUDESTRA_SANDBOX_PARENT_PID: String(process.pid) });
    const root = join(base, "reup");
    const argv = (sub: string, port: number) => [process.execPath, "--no-env-file", "--config=/dev/null", SCRIPT, sub, "--root", root, "--port", String(port)];
    const spec: StartSpec = { root, cwd: clone, env: () => env, avoid: [3847, 23998, 23999], maxAttempts: 1, deadline: Date.now() + 50_000, argv };
    const owner = () => {
      const all = listSandboxOwners(sandboxOwnersDir(journal));
      if (all.status !== "ok" || all.entries.length !== 1 || all.entries[0]!.read.status !== "ok") throw new Error("属主记录读不了");
      return all.entries[0]!.read.record;
    };
    const first = await fleet.start(spec), before = owner();
    expect(await fleet.stop(root)).toEqual([]);
    const clean = Bun.spawn(argv("clean", first.port), { cwd: clone, env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(clean.stdout).text(), new Response(clean.stderr).text()]);
    expect(`${await clean.exited} ${out}${err}`).toStartWith("0 ");
    expect(existsSync(root)).toBe(false);
    const second = await fleet.start(spec), after = owner();
    expect(second.pid).not.toBe(first.pid);
    expect(after.key).toEqual(before.key);
    expect(after.dirs[0]!.path).toBe(before.dirs[0]!.path);
    expect(after.dirs[0]!.ino).not.toBe(before.dirs[0]!.ino);
    expect(after.resources.map((r) => r.pid)).toContain(second.pid);
    expect(after.resources.map((r) => r.pid)).not.toContain(first.pid);
    expect(after.cleanup).toBeUndefined();
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { h.db.close(); } }
}, 60_000);

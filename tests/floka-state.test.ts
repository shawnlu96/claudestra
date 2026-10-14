import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import { nodeStateFs } from "../src/lib/floka-migration/state/fs-adapter.ts";
import { inspectLayout } from "../src/lib/floka-migration/state/layout.ts";
import { migrateState, recoverState, rollbackState } from "../src/lib/floka-migration/state/migrate.ts";
import type { StateFs, StateMigrationOptions } from "../src/lib/floka-migration/state/types.ts";
import { stateDirIn } from "../src/lib/state-dir.ts";

class Crash extends Error {}

/** 夹具私钥只生成一次:测试自己造身份,被测库只能读 */
const PEM = String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));

interface Fx { base: string; home: string; oldRoot: string; newRoot: string; journal: string; active: string[] }

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); });

function fixture(): Fx {
  const base = mkdtempSync(join(tmpdir(), "floka-state-"));
  bases.push(base);
  const home = join(base, "home");
  mkdirSync(home);
  return { base, home, oldRoot: stateDirIn(home), newRoot: join(home, ".floka"), journal: join(base, "journal"), active: [] };
}

/** 一个带身份 / peer / token / pin / 撤销记录 / 锁目录 / 各种权限的状态根 */
function seed(root: string, id = "a1b2c3d4e5f6a7b8c9d0e1f2"): void {
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  writeFileSync(join(root, "instance-id"), `${id}\n`, { mode: 0o600 });
  writeFileSync(join(root, "instance-key.pem"), PEM, { mode: 0o600 });
  writeFileSync(join(root, "peers.json"), JSON.stringify({ httpPeers: { sekai: { url: "https://peer.invalid", token: "tok_fixture", pin: "abcd-ef01", revoked: [] } } }), { mode: 0o600 });
  writeFileSync(join(root, "principals.json"), JSON.stringify({ tokens: [{ id: "tok_1", hash: "h1" }], revoked: ["tok_0"] }), { mode: 0o600 });
  writeFileSync(join(root, "peer-revocations.json"), JSON.stringify({ revoked: ["tok_old"] }), { mode: 0o640 });
  mkdirSync(join(root, "ledger", "tasks"), { recursive: true, mode: 0o750 });
  chmodSync(join(root, "ledger"), 0o750);
  writeFileSync(join(root, "ledger", "tasks", "t1.json"), "{\"id\":\"t1\"}", { mode: 0o644 });
  mkdirSync(join(root, "update.lock"));
  writeFileSync(join(root, "update.lock", "owner"), "123.abc");
}

type Snap = Record<string, string>;

/** 相对路径 → 类型 / 权限 / 属主 / 内容哈希;迁移前后逐项相同才算保留 */
function snap(root: string): Snap {
  const out: Snap = {};
  const walk = (p: string) => {
    const st = lstatSync(p);
    const rel = relative(root, p) || ".";
    const meta = `${(st.mode & 0o7777).toString(8)}:${st.uid}:${st.gid}`;
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(p)}`;
    else if (st.isDirectory()) {
      out[rel] = `dir:${meta}`;
      for (const n of readdirSync(p)) walk(join(p, n));
    } else out[rel] = `file:${meta}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
  };
  walk(root);
  return out;
}

const probe = (fx: Fx) => ({ activeWriters: async () => [...fx.active] });

function opts(fx: Fx, over: Partial<StateMigrationOptions> = {}): StateMigrationOptions {
  return {
    mode: "on", oldRoot: fx.oldRoot, newRoot: fx.newRoot, home: fx.home, writers: probe(fx),
    fs: nodeStateFs, journalDir: fx.journal, txId: "state-1", lockWaitMs: 200, ...over,
  };
}

const crashAt = (point: string) => (p: string) => { if (p === point) throw new Crash(p); };
const layoutOf = async (fx: Fx) => (await inspectLayout(nodeStateFs, fx.oldRoot, fx.newRoot)).kind;

/** 记录所有写调用的适配器;可按名字注入一次性故障 */
function spyFs(fail: Partial<Record<keyof StateFs, Error>> = {}): { fs: StateFs; calls: string[] } {
  const calls: string[] = [];
  const fs = Object.fromEntries(Object.entries(nodeStateFs).map(([k, fn]) => [k, async (...a: unknown[]) => {
    calls.push(k);
    const err = fail[k as keyof StateFs];
    if (err) throw err;
    return (fn as (...x: unknown[]) => Promise<unknown>)(...a);
  }])) as unknown as StateFs;
  return { fs, calls };
}
const WRITES = ["rename", "symlink", "unlink", "mkdir"];

describe("[验收线 1] 身份与权限原样迁移", () => {
  test("迁移后新根逐字节、逐权限等于旧根,旧路径是指向新根的别名", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("committed");
    expect(r.layout).toBe("migrated");
    expect(snap(fx.newRoot)).toEqual(before);
    expect(lstatSync(fx.oldRoot).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fx.oldRoot)).toBe(resolve(fx.newRoot));
    expect(readFileSync(join(fx.oldRoot, "instance-key.pem"), "utf8")).toBe(PEM);
    expect(statSync(fx.newRoot).mode & 0o7777).toBe(0o700);
  });

  test("回滚后旧根同样逐字节、逐权限复原,别名撤掉、新根不留", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    expect((await migrateState(opts(fx))).status).toBe("committed");
    const r = await rollbackState(opts(fx, { txId: "state-rb-1" }));
    expect(r.status).toBe("committed");
    expect(r.layout).toBe("legacy");
    expect(lstatSync(fx.oldRoot).isDirectory()).toBe(true);
    expect(existsSync(fx.newRoot)).toBe(false);
    expect(snap(fx.oldRoot)).toEqual(before);
  });
});

describe("[验收线 2] 拒绝情形与零身份生成", () => {
  test("新根是空目录:旧根改名盖过空目录,空根不覆盖旧根、不生成身份", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    mkdirSync(fx.newRoot, { mode: 0o755 });
    const before = snap(fx.oldRoot);
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("committed");
    expect(snap(fx.newRoot)).toEqual(before);
  });

  test("空新根 + 旧根缺身份:拒绝,两边都不出现身份文件", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    rmSync(join(fx.oldRoot, "instance-key.pem"));
    mkdirSync(fx.newRoot);
    const before = snap(fx.home);
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("refused");
    expect(JSON.stringify(r)).toContain("缺失身份文件 instance-key.pem");
    expect(snap(fx.home)).toEqual(before);
    expect(readdirSync(fx.newRoot)).toEqual([]);
  });

  test("旧根不在、新根为空:拒绝,不在空根里生成身份", async () => {
    const fx = fixture();
    mkdirSync(fx.newRoot);
    for (const run of [migrateState, rollbackState]) {
      const r = await run(opts(fx));
      expect(r.status).toBe("refused");
      expect(JSON.stringify(r)).toContain("缺失身份文件 instance-id");
    }
    expect(readdirSync(fx.newRoot)).toEqual([]);
    expect(existsSync(fx.oldRoot)).toBe(false);
  });

  test("两个根都有数据:拒绝自动合并,两边原样", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    seed(fx.newRoot, "ffffeeeeddddccccbbbbaaaa");
    const before = snap(fx.home);
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("refused");
    expect(JSON.stringify(r)).toContain("都有数据");
    expect(snap(fx.home)).toEqual(before);
  });

  test("旧根是未知 symlink / 新根是 symlink:拒绝", async () => {
    const fx = fixture();
    const elsewhere = join(fx.base, "elsewhere");
    seed(elsewhere);
    symlinkSync(elsewhere, fx.oldRoot);
    expect((await migrateState(opts(fx))).error).toBeDefined();
    expect(JSON.stringify(await rollbackState(opts(fx)))).toContain("未知 symlink");
    rmSync(fx.oldRoot);
    seed(fx.oldRoot);
    symlinkSync(elsewhere, fx.newRoot);
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("refused");
    expect(JSON.stringify(r)).toContain("新根是 symlink");
    expect(readlinkSync(fx.newRoot)).toBe(elsewhere);
  });

  test("自定义根:未批准拒绝且不动磁盘;逐字批准后才迁移", async () => {
    const fx = fixture();
    const oldRoot = join(fx.base, "custom-state");
    const newRoot = join(fx.base, "custom-floka");
    seed(oldRoot);
    const before = snap(oldRoot);
    const denied = await migrateState(opts(fx, { oldRoot, newRoot }));
    expect(denied.status).toBe("refused");
    expect(denied.error).toContain("自定义根未明确批准");
    expect(existsSync(fx.journal)).toBe(false);
    const wrong = await migrateState(opts(fx, { oldRoot, newRoot, approvedCustom: { oldRoot, newRoot: fx.newRoot } }));
    expect(wrong.status).toBe("refused");
    const ok = await migrateState(opts(fx, { oldRoot, newRoot, approvedCustom: { oldRoot, newRoot } }));
    expect(ok.status).toBe("committed");
    expect(snap(newRoot)).toEqual(before);
  });

  test("事务日志放在根里面:拒绝", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const r = await migrateState(opts(fx, { journalDir: join(fx.oldRoot, "migration") }));
    expect(r.status).toBe("refused");
    expect(r.error).toContain("事务日志目录");
  });

  test("跨设备:预检拒绝;改名时才报 EXDEV 也补偿回原样,绝不复制", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    const crossDev: StateFs = { ...nodeStateFs, lstat: async (p) => {
      const st = await nodeStateFs.lstat(p);
      return st && resolve(p) === resolve(dirname(fx.newRoot)) ? { ...st, dev: st.dev + 1 } : st;
    } };
    const r = await migrateState(opts(fx, { fs: crossDev }));
    expect(r.status).toBe("refused");
    expect(JSON.stringify(r)).toContain("同一文件系统");
    const exdev = Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    const spy = spyFs({ rename: exdev });
    const r2 = await migrateState(opts(fx, { fs: spy.fs, txId: "state-2" }));
    expect(r2.status).toBe("rolled_back");
    expect(r2.error).toContain("EXDEV");
    expect(spy.calls.filter((c) => WRITES.includes(c))).toEqual(["rename"]);
    expect(snap(fx.oldRoot)).toEqual(before);
    expect(existsSync(fx.newRoot)).toBe(false);
  });

  test("写者未停:拒绝;检查后才冒出的写者在动手前被拦下并补偿", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    fx.active.push("bridge pid 4242");
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("refused");
    expect(JSON.stringify(r)).toContain("仍有写者未停:bridge pid 4242");
    fx.active.length = 0;
    let asks = 0;
    // 准备问 2 次、搬根前复核 2 次;建别名前复核时冒出写者 → 补偿也不能在写者在时搬回,停在 rollback_failed
    const late = { activeWriters: async () => (++asks > 4 ? ["cron pid 7"] : []) };
    const spy = spyFs();
    const r2 = await migrateState(opts(fx, { writers: late, txId: "state-2", fs: spy.fs }));
    expect(r2.status).toBe("rollback_failed");
    expect(r2.error).toContain("cron pid 7");
    expect(r2.failedStep).toBe("state-alias");
    expect(r2.layout).toBe("moved");
    expect(spy.calls.filter((c) => WRITES.includes(c))).toEqual(["rename"]);
    expect(snap(fx.newRoot)).toEqual(before);
    const done = await recoverState(opts(fx, { txId: "state-2" }), "migrate");
    expect(done.status).toBe("rolled_back");
    expect(snap(fx.oldRoot)).toEqual(before);
    expect(existsSync(fx.newRoot)).toBe(false);
  });

  test("准备之后、动手之前身份被换:核对不一致,停下并保持旧根", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    let asks = 0;
    // 准备阶段问两次(旧根 / 新根);第 3 次是 apply 动手前的复核,此时换掉身份
    const swapping = { activeWriters: async () => {
      if (++asks === 3) writeFileSync(join(fx.oldRoot, "instance-id"), "0000000000000000deadbeef\n", { mode: 0o600 });
      return [];
    } };
    const r = await migrateState(opts(fx, { writers: swapping }));
    expect(r.status).toBe("rolled_back");
    expect(r.error).toContain("身份");
    expect(lstatSync(fx.oldRoot).isDirectory()).toBe(true);
    expect(existsSync(fx.newRoot)).toBe(false);
  });

  test("迁移库的导入图里没有身份生成器", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/generateKeyPair|randomBytes|randomUUID|instanceIdSync|instanceKeySync|readOrCreateKeyFile/);
      for (const m of src.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) visit(resolve(dirname(file), m[1]!));
    };
    visit(resolve(import.meta.dir, "../src/lib/floka-migration/state/migrate.ts"));
    visit(resolve(import.meta.dir, "../src/lib/floka-migration/state/fs-adapter.ts"));
    const mods = [...seen].map((f) => relative(resolve(import.meta.dir, ".."), f));
    expect(mods.some((m) => /instance-(id|key)|key-file|lib\/paths\.ts/.test(m))).toBe(false);
    expect(mods).toContain("src/lib/floka-migration/transaction/executor.ts");
  });
});

const LIVE = (fx: Fx) => ({ ...probe(fx), activeWriters: async () => ["live-writer"] });
const writesOf = (calls: string[]) => calls.filter((c) => WRITES.includes(c));

describe("[验收线 2] 续跑以日志身份为准,补偿同样要求停写", () => {
  const swaps: [string, (root: string) => void][] = [
    ["instance-id", (root) => writeFileSync(join(root, "instance-id"), "identity-replaced\n", { mode: 0o600 })],
    ["私钥", (root) => writeFileSync(join(root, "instance-key.pem"), String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" })), { mode: 0o600 })],
    ["根权限", (root) => chmodSync(root, 0o755)],
  ];
  for (const [what, swap] of swaps) {
    test(`journaled:state-move 中断后${what}被换:同 txId 续跑拒绝,不动任何根`, async () => {
      const fx = fixture();
      seed(fx.oldRoot);
      await expect(migrateState(opts(fx, { crashAt: crashAt("journaled:state-move") }))).rejects.toBeInstanceOf(Crash);
      swap(fx.oldRoot);
      const replaced = snap(fx.oldRoot);
      const spy = spyFs();
      const r = await migrateState(opts(fx, { fs: spy.fs }));
      expect(r.status).toBe("refused");
      expect(r.error).toContain("续跑时两个根都没有事务开始时的身份");
      expect(r.layout).toBe("legacy");
      expect(writesOf(spy.calls)).toEqual([]);
      expect(snap(fx.oldRoot)).toEqual(replaced);
      expect(existsSync(fx.newRoot)).toBe(false);
      expect((await recoverState(opts(fx), "migrate")).status).toBe("refused");
    });
  }

  test("搬根后中断、新根身份被换:续跑拒绝;换回原身份后续完", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    await expect(migrateState(opts(fx, { crashAt: crashAt("committed:state-move") }))).rejects.toBeInstanceOf(Crash);
    const original = readFileSync(join(fx.newRoot, "instance-id"));
    writeFileSync(join(fx.newRoot, "instance-id"), "identity-replaced\n", { mode: 0o600 });
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("refused");
    expect(r.layout).toBe("moved");
    writeFileSync(join(fx.newRoot, "instance-id"), original, { mode: 0o600 });
    const ok = await migrateState(opts(fx));
    expect(ok.status).toBe("committed");
    expect(snap(fx.newRoot)).toEqual(before);
  });

  test("搬根后中断、续跑时写者在:不建别名也不搬回(含空新根重建),写者停后续补偿", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    mkdirSync(fx.newRoot, { mode: 0o755 });
    chmodSync(fx.newRoot, 0o755);
    const before = snap(fx.oldRoot);
    await expect(migrateState(opts(fx, { crashAt: crashAt("committed:state-move") }))).rejects.toBeInstanceOf(Crash);
    const spy = spyFs();
    const r = await migrateState(opts(fx, { writers: LIVE(fx), fs: spy.fs }));
    expect(r.status).toBe("rollback_failed");
    expect(r.layout).toBe("moved");
    expect(writesOf(spy.calls)).toEqual([]);
    expect(JSON.stringify(r.steps)).toContain("live-writer");
    const again = await recoverState(opts(fx, { writers: LIVE(fx), fs: spy.fs }), "migrate");
    expect(again.status).toBe("rollback_failed");
    expect(writesOf(spy.calls)).toEqual([]);
    const done = await recoverState(opts(fx), "migrate");
    expect(done.status).toBe("rolled_back");
    expect(done.layout).toBe("legacy");
    expect(snap(fx.oldRoot)).toEqual(before);
    expect(readdirSync(fx.newRoot)).toEqual([]);
    expect(statSync(fx.newRoot).mode & 0o7777).toBe(0o755);
  });

  test("建别名后中断、续补偿时写者在:不删别名;写者停后撤别名并搬回", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    await expect(migrateState(opts(fx, { crashAt: crashAt("applied:state-alias") }))).rejects.toBeInstanceOf(Crash);
    const spy = spyFs();
    const r = await recoverState(opts(fx, { writers: LIVE(fx), fs: spy.fs }), "migrate");
    expect(r.status).toBe("rollback_failed");
    expect(r.layout).toBe("migrated");
    expect(writesOf(spy.calls)).toEqual([]);
    const done = await recoverState(opts(fx), "migrate");
    expect(done.status).toBe("rolled_back");
    expect(snap(fx.oldRoot)).toEqual(before);
  });

  test("回滚撤别名后中断、续补偿时写者在:不重建别名;写者停后恢复迁移后形态", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    expect((await migrateState(opts(fx))).status).toBe("committed");
    const mid = snap(fx.newRoot);
    await expect(rollbackState(opts(fx, { txId: "rb", crashAt: crashAt("applied:state-unalias") }))).rejects.toBeInstanceOf(Crash);
    const spy = spyFs();
    const r = await recoverState(opts(fx, { txId: "rb", writers: LIVE(fx), fs: spy.fs }), "rollback");
    expect(r.status).toBe("rollback_failed");
    expect(r.layout).toBe("moved");
    expect(writesOf(spy.calls)).toEqual([]);
    const done = await recoverState(opts(fx, { txId: "rb" }), "rollback");
    expect(done.status).toBe("rolled_back");
    expect(done.layout).toBe("migrated");
    expect(snap(fx.newRoot)).toEqual(mid);
  });
});

const MIGRATE_POINTS = ["state-move", "state-alias"].flatMap((s) => ["before", "journaled", "applied", "committed"].map((p) => `${p}:${s}`));
const ROLLBACK_POINTS = ["state-unalias", "state-return"].flatMap((s) => ["before", "journaled", "applied", "committed"].map((p) => `${p}:${s}`));

describe("[验收线 3] 中断可续,回滚保留迁移后的新任务", () => {
  for (const point of MIGRATE_POINTS) {
    test(`迁移在 ${point} 中断,同一 txId 重跑续完`, async () => {
      const fx = fixture();
      seed(fx.oldRoot);
      const before = snap(fx.oldRoot);
      await expect(migrateState(opts(fx, { crashAt: crashAt(point) }))).rejects.toBeInstanceOf(Crash);
      const r = await migrateState(opts(fx));
      expect(r.status).toBe("committed");
      expect(r.layout).toBe("migrated");
      expect(snap(fx.newRoot)).toEqual(before);
    });
  }

  for (const point of ROLLBACK_POINTS) {
    test(`回滚在 ${point} 中断,重跑续完且新任务还在`, async () => {
      const fx = fixture();
      seed(fx.oldRoot);
      expect((await migrateState(opts(fx))).status).toBe("committed");
      writeFileSync(join(fx.oldRoot, "ledger", "tasks", "new.json"), "{\"id\":\"new\"}");
      const mid = snap(fx.newRoot);
      await expect(rollbackState(opts(fx, { txId: "rb", crashAt: crashAt(point) }))).rejects.toBeInstanceOf(Crash);
      const r = await rollbackState(opts(fx, { txId: "rb" }));
      expect(r.status).toBe("committed");
      expect(r.layout).toBe("legacy");
      expect(snap(fx.oldRoot)).toEqual(mid);
    });
  }

  test("迁移后经旧路径和新路径各写一条新任务,回滚后两条都在、身份不变", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const id = readFileSync(join(fx.oldRoot, "instance-id"));
    expect((await migrateState(opts(fx))).status).toBe("committed");
    writeFileSync(join(fx.oldRoot, "ledger", "tasks", "via-old.json"), "{\"id\":\"a\"}");
    writeFileSync(join(fx.newRoot, "ledger", "tasks", "via-new.json"), "{\"id\":\"b\"}");
    expect((await rollbackState(opts(fx, { txId: "rb" }))).status).toBe("committed");
    expect(readdirSync(join(fx.oldRoot, "ledger", "tasks")).sort()).toEqual(["t1.json", "via-new.json", "via-old.json"]);
    expect(readFileSync(join(fx.oldRoot, "instance-id"))).toEqual(id);
  });

  test("建别名失败:逆序补偿把数据搬回旧根;补偿中途中断也能续完", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    const spy = spyFs({ symlink: new Error("symlink denied") });
    await expect(migrateState(opts(fx, { fs: spy.fs, crashAt: crashAt("compensate:state-move") }))).rejects.toBeInstanceOf(Crash);
    expect(await layoutOf(fx)).toBe("moved");
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("rolled_back");
    expect(r.failedStep).toBe("state-alias");
    expect(snap(fx.oldRoot)).toEqual(before);
    expect(existsSync(fx.newRoot)).toBe(false);
  });

  test("搬根后、建别名前旧路径被重建:不覆盖任何一边,回滚失败留现场", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.oldRoot);
    await expect(migrateState(opts(fx, { crashAt: crashAt("before:state-alias") }))).rejects.toBeInstanceOf(Crash);
    seed(fx.oldRoot, "ffffeeeeddddccccbbbbaaaa");
    const intruder = snap(fx.oldRoot);
    const r = await migrateState(opts(fx));
    expect(r.status).toBe("rollback_failed");
    expect(r.error).toContain("EEXIST");
    expect(r.steps.find((x) => x.id === "state-move")!.error).toContain("需人工核查");
    expect(snap(fx.newRoot)).toEqual(before);
    expect(snap(fx.oldRoot)).toEqual(intruder);
    expect((await migrateState(opts(fx))).status).toBe("refused");
  });

  test("回滚后用同一迁移 txId 不会被当成已迁移;换新 txId 可再迁", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    expect((await migrateState(opts(fx))).status).toBe("committed");
    expect((await rollbackState(opts(fx, { txId: "rb" }))).status).toBe("committed");
    const same = await migrateState(opts(fx));
    expect(same.status).toBe("refused");
    expect(same.error).toContain("早已提交");
    expect((await migrateState(opts(fx, { txId: "state-again" }))).layout).toBe("migrated");
  });

  test("回滚搬回失败:补偿重建别名,仍是迁移后形态、数据在新根", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    expect((await migrateState(opts(fx))).status).toBe("committed");
    const mid = snap(fx.newRoot);
    const spy = spyFs({ rename: new Error("rename denied") });
    const r = await rollbackState(opts(fx, { txId: "rb", fs: spy.fs }));
    expect(r.status).toBe("rolled_back");
    expect(r.failedStep).toBe("state-return");
    expect(r.layout).toBe("migrated");
    expect(snap(fx.newRoot)).toEqual(mid);
  });

  test("没有迁移可回滚:数据仍在旧根时拒绝", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const r = await rollbackState(opts(fx));
    expect(r.status).toBe("refused");
    expect(JSON.stringify(r)).toContain("没有可回滚的迁移");
  });
});

describe("[验收线 4] off / observe 零写入", () => {
  test("off(含缺省与不认识的值)连磁盘都不看", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    const before = snap(fx.base);
    for (const mode of ["off", undefined, "ON", "true"]) {
      const spy = spyFs();
      const r = await migrateState(opts(fx, { mode, fs: spy.fs }));
      expect(r.status).toBe("off");
      expect((await rollbackState(opts(fx, { mode, fs: spy.fs }))).status).toBe("off");
      expect(spy.calls).toEqual([]);
    }
    expect(snap(fx.base)).toEqual(before);
  });

  test("observe 报出计划与冲突,不建日志和锁、不调任何写接口", async () => {
    const fx = fixture();
    seed(fx.oldRoot);
    fx.active.push("bridge pid 1");
    const before = snap(fx.base);
    const spy = spyFs();
    const r = await migrateState(opts(fx, { mode: "observe", fs: spy.fs }));
    expect(r.status).toBe("observed");
    expect(r.steps.map((s) => s.id)).toEqual(["state-move", "state-alias"]);
    expect(r.steps[0]!.conflicts).toEqual(["仍有写者未停:bridge pid 1"]);
    fx.active.length = 0;
    const clean = await migrateState(opts(fx, { mode: "observe", fs: spy.fs }));
    expect(clean.steps.every((s) => s.state === "planned" && !s.conflicts?.length)).toBe(true);
    expect((await rollbackState(opts(fx, { mode: "observe", fs: spy.fs }))).status).toBe("observed");
    expect(spy.calls.filter((c) => WRITES.includes(c))).toEqual([]);
    expect(snap(fx.base)).toEqual(before);
    expect(existsSync(fx.journal)).toBe(false);
  });
});

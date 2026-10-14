import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nodeAliasFs, tmuxServerProbe } from "../src/lib/floka-migration/runtime/adapters.ts";
import { applyRuntimeAlias, planRuntimeAlias, rollbackRuntimeAlias, RUNTIME_ITEM, runtimeAliasStep } from "../src/lib/floka-migration/runtime/alias.ts";
import type { AliasFs, RuntimeAliasInput, ServerProbe } from "../src/lib/floka-migration/runtime/types.ts";
import { runTransaction, type TxStep } from "../src/lib/floka-migration/transaction/executor.ts";

// 全程只在临时根里:socket 是一个普通文件充当的 fake,server 是一张「socket 文件标识 → server 标识」的表,不连真实 tmux。
const SOCK = "master.sock";
const SERVER = "fake-server:4242:1700000000";

interface World {
  root: string;
  current: string;
  alias: string;
  /** socket 文件标识(dev:ino)→ 后面的 server */
  servers: Map<string, string>;
  fsLog: string[];
  probeLog: string[];
  fs: AliasFs;
  probe: ServerProbe;
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const fileId = (p: string) => { const s = statSync(p); return `${s.dev}:${s.ino}`; };

/** 记录每一次文件系统调用与 server 查询;接口之外的操作(复制、起 server)根本没有入口 */
function world(names: { current?: string; alias?: string } = {}): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "floka-runtime-")));
  roots.push(root);
  const current = join(root, names.current ?? "claude-runtime");
  mkdirSync(current);
  writeFileSync(join(current, SOCK), "fake socket");
  writeFileSync(join(current, "shot.png"), "x");
  const w: World = { root, current, alias: join(root, names.alias ?? "floka"), servers: new Map(), fsLog: [], probeLog: [], fs: nodeAliasFs, probe: { identify: async () => null } };
  w.servers.set(fileId(join(current, SOCK)), SERVER);
  const logged = <K extends keyof AliasFs>(k: K): AliasFs[K] => ((...a: string[]) => {
    w.fsLog.push(`${k} ${a.join(" -> ")}`);
    return (nodeAliasFs[k] as (...x: string[]) => unknown)(...a);
  }) as AliasFs[K];
  w.fs = { kind: logged("kind"), resolve: logged("resolve"), fileId: logged("fileId"), symlink: logged("symlink"), unlink: logged("unlink") };
  w.probe = {
    identify: async (socketPath) => {
      w.probeLog.push(`identify ${socketPath}`);
      try { return w.servers.get(fileId(socketPath)) ?? null; } catch { return null; }
    },
  };
  return w;
}

const input = (w: World, mode: unknown = "on", over: Partial<RuntimeAliasInput> = {}): RuntimeAliasInput =>
  ({ mode, currentDir: w.current, aliasDir: w.alias, socketName: SOCK, fs: w.fs, probe: w.probe, ...over });

const writes = (w: World) => w.fsLog.filter((l) => /^(symlink|unlink) /.test(l));

/** 临时根下每一项的形态(软链带目标、文件带 inode),用来证明「没动」 */
function tree(dir: string, base = dir): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    const s = lstatSync(p);
    const rel = p.slice(base.length + 1);
    if (s.isSymbolicLink()) return [`${rel} -> ${readlinkSync(p)}`];
    if (s.isDirectory()) return [`${rel}/`, ...tree(p, base)];
    return [`${rel} #${s.ino}`];
  });
}

const socketFiles = (w: World) => tree(w.root).filter((l) => l.includes(SOCK) && !l.includes("->"));
const kindOf = (p: string) => { try { const s = lstatSync(p); return s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : "file"; } catch { return "missing"; } };
const codes = (r: { refusals?: { code: string }[] }) => (r.refusals ?? []).map((x) => x.code);

describe("[验收线 1] 迁移前后是同一个 server", () => {
  test("[验收线 1] on 建别名后,经新旧两条路径看到的 server 身份相同;只有一次 symlink,没有复制 socket", async () => {
    const w = world();
    const before = tree(w.current);
    const r = await applyRuntimeAlias(input(w));
    expect(r.status).toBe("aliased");
    expect(r.changed).toBe(true);
    expect(r.identityBefore).toBe(`${SERVER}@${fileId(join(w.current, SOCK))}`);
    expect(r.identityAfter).toBe(r.identityBefore!);
    expect(await w.probe.identify(join(w.alias, SOCK))).toBe(SERVER);
    expect(fileId(join(w.alias, SOCK))).toBe(fileId(join(w.current, SOCK)));
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`]);
    expect(tree(w.current)).toEqual(before); // socket 文件名、inode、目录内容都没变
    expect(socketFiles(w)).toHaveLength(1); // 根下仍只有一份 socket 文件
    expect(readlinkSync(w.alias)).toBe(w.current);
  });

  test("[验收线 1] 对 server 只有查询:probe 只收到 identify,且只问现路径和别名路径下的同名 socket", async () => {
    const w = world();
    await applyRuntimeAlias(input(w));
    await rollbackRuntimeAlias(input(w));
    expect(w.probeLog.length).toBeGreaterThan(0);
    expect(new Set(w.probeLog)).toEqual(new Set([`identify ${join(w.current, SOCK)}`, `identify ${join(w.alias, SOCK)}`]));
    expect(new Set(w.fsLog.map((l) => l.split(" ")[0]))).toEqual(new Set(["kind", "resolve", "fileId", "symlink", "unlink"]));
  });

  test("[验收线 1] 经别名看到的是另一个 server:拒绝并撤掉刚建的别名", async () => {
    const w = world();
    const real = w.probe;
    w.probe = { identify: async (p) => (p.startsWith(w.alias) ? "fake-server:9999:1" : real.identify(p)) };
    const r = await applyRuntimeAlias(input(w));
    expect(r.status).toBe("refused");
    expect(codes(r)).toEqual(["identity-mismatch"]);
    expect(r.identityAfter).not.toBe(r.identityBefore);
    expect(kindOf(w.alias)).toBe("missing");
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`, `unlink ${w.alias}`]);
  });

  test("[验收线 1] 已有别名但 server 身份对不上:拒绝,别名不是这次建的所以不删", async () => {
    const w = world();
    symlinkSync(w.current, w.alias);
    const real = w.probe;
    w.probe = { identify: async (p) => (p.startsWith(w.alias) ? null : real.identify(p)) };
    const r = await applyRuntimeAlias(input(w));
    expect(codes(r)).toEqual(["identity-mismatch"]);
    expect(writes(w)).toEqual([]);
    expect(kindOf(w.alias)).toBe("symlink");
  });

  test("[验收线 1] socket 不在 / server 查不到:拒绝,不建别名也不去启动 server", async () => {
    const down = world();
    down.servers.clear();
    const r1 = await applyRuntimeAlias(input(down));
    expect([r1.status, codes(r1)]).toEqual(["refused", ["server-unreachable"]]);
    const gone = world();
    rmSync(join(gone.current, SOCK));
    const r2 = await applyRuntimeAlias(input(gone));
    expect([r2.status, codes(r2)]).toEqual(["refused", ["socket-missing"]]);
    for (const w of [down, gone]) {
      expect(writes(w)).toEqual([]);
      expect(kindOf(w.alias)).toBe("missing");
      expect(w.probeLog.every((l) => l.startsWith("identify "))).toBe(true);
    }
  });

  test("[验收线 1] tmux 适配器只发只读的 display-message;别名路径与现路径认成同一个 server", async () => {
    const w = world();
    symlinkSync(w.current, w.alias);
    const calls: string[][] = [];
    const query = async (args: string[]) => { calls.push(args); return `4242\t1700000000\t${join(w.current, SOCK)}`; };
    const probe = tmuxServerProbe(query);
    expect(await probe.identify(join(w.current, SOCK))).toBe("tmux:4242:1700000000");
    expect(await probe.identify(join(w.alias, SOCK))).toBe("tmux:4242:1700000000");
    expect(await probe.identify(join(w.root, "elsewhere", SOCK))).toBeNull();
    expect(await probe.identify(join(w.current, "other.sock"))).toBeNull();
    expect(calls.every((a) => a[0] === "display-message" && a[1] === "-p" && a.length === 3)).toBe(true);
    expect(await tmuxServerProbe(async () => "").identify(join(w.current, SOCK))).toBeNull(); // 没有 server:tmuxRaw 回空串
    expect(await tmuxServerProbe(async () => "no server running").identify(join(w.current, SOCK))).toBeNull();
  });
});

describe("[验收线 2] off / observe / on、冲突与回滚", () => {
  test("[验收线 2] 缺省与不认识的开关值都是 off:不读不写不查询", async () => {
    const w = world();
    for (const mode of [undefined, "off", "ON", "yes", 1, null]) {
      const r = await applyRuntimeAlias(input(w, mode));
      expect([r.mode, r.status, r.changed]).toEqual(["off", "off", false]);
    }
    expect(w.fsLog).toEqual([]);
    expect(w.probeLog).toEqual([]);
    expect(kindOf(w.alias)).toBe("missing");
  });

  test("[验收线 2] observe 零写入:只出计划和维护计划,临时根逐项不变", async () => {
    const w = world();
    const before = tree(w.root);
    const r = await applyRuntimeAlias(input(w, "observe"));
    expect([r.status, r.changed]).toEqual(["observed", false]);
    expect(r.plan).toMatchObject({ action: "create-alias", aliasState: "absent", currentReal: w.current, aliasSocket: join(w.alias, SOCK), refusals: [] });
    expect(r.plan!.maintenance.length).toBeGreaterThan(0);
    expect(r.plan!.maintenance.join("\n")).toContain(w.alias);
    expect(writes(w)).toEqual([]);
    expect(tree(w.root)).toEqual(before);
  });

  test("[验收线 2] observe 遇到冲突也只报告,不写", async () => {
    const w = world();
    mkdirSync(w.alias);
    const before = tree(w.root);
    const r = await applyRuntimeAlias(input(w, "observe"));
    expect([r.status, codes(r), r.plan!.action]).toEqual(["observed", ["conflict-entry"], "none"]);
    expect(writes(w)).toEqual([]);
    expect(tree(w.root)).toEqual(before);
  });

  test("[验收线 2] on 幂等:第二次是 already,不再写", async () => {
    const w = world();
    const first = await applyRuntimeAlias(input(w));
    const after = tree(w.root);
    const second = await applyRuntimeAlias(input(w));
    expect([first.status, second.status, second.changed]).toEqual(["aliased", "already", false]);
    expect(second.identityAfter).toBe(first.identityBefore!);
    expect(writes(w)).toHaveLength(1);
    expect(tree(w.root)).toEqual(after);
  });

  test("[验收线 2] 冲突目录 / 冲突文件 / 指向别处的别名:拒绝且原样保留", async () => {
    const dir = world();
    mkdirSync(dir.alias);
    writeFileSync(join(dir.alias, "keep.txt"), "keep");
    const file = world();
    writeFileSync(file.alias, "i am a file");
    const wrong = world();
    mkdirSync(join(wrong.root, "elsewhere"));
    symlinkSync(join(wrong.root, "elsewhere"), wrong.alias);
    for (const [w, code] of [[dir, "conflict-entry"], [file, "conflict-entry"], [wrong, "wrong-alias"]] as const) {
      const before = tree(w.root);
      const r = await applyRuntimeAlias(input(w));
      expect([r.status, codes(r), r.changed]).toEqual(["refused", [code], false]);
      expect(writes(w)).toEqual([]);
      expect(tree(w.root)).toEqual(before);
      const back = await rollbackRuntimeAlias(input(w));
      expect([back.status, codes(back)]).toEqual(["refused", [code]]); // 不是本库建的,回滚也不碰
      expect(tree(w.root)).toEqual(before);
    }
  });

  test("[验收线 2] 回滚恢复原路径解析,server 还是同一个;再回滚一次无事可做", async () => {
    const w = world();
    const before = tree(w.root);
    const up = await applyRuntimeAlias(input(w));
    const back = await rollbackRuntimeAlias(input(w));
    expect([back.status, back.changed]).toEqual(["rolled_back", true]);
    expect(back.identityAfter).toBe(up.identityBefore!);
    expect(await w.probe.identify(join(w.current, SOCK))).toBe(SERVER);
    expect(tree(w.root)).toEqual(before); // 别名没了,现存目录与 socket 逐项如初
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`, `unlink ${w.alias}`]);
    const again = await rollbackRuntimeAlias(input(w));
    expect([again.status, again.changed]).toEqual(["absent", false]);
    expect(writes(w)).toHaveLength(2);
  });

  test("[验收线 2] 开关不是 on 不回滚;server 掉了不拦回滚", async () => {
    const w = world();
    await applyRuntimeAlias(input(w));
    for (const mode of ["off", "observe", undefined]) {
      const r = await rollbackRuntimeAlias(input(w, mode));
      expect([r.status, codes(r)]).toEqual(["refused", ["mode-not-on"]]);
    }
    expect(kindOf(w.alias)).toBe("symlink");
    w.servers.clear();
    const r = await rollbackRuntimeAlias(input(w));
    expect([r.status, r.identityBefore, r.identityAfter]).toEqual(["rolled_back", null, null]);
    expect(kindOf(w.alias)).toBe("missing");
  });

  test("[验收线 2] 接进迁移事务:后一步失败时补偿删掉本步建的别名,原先就有的别名保留", async () => {
    const boom: TxStep<unknown> = {
      id: "later", item: RUNTIME_ITEM, recovery: "无", read: async () => null, done: async () => false,
      apply: async () => { throw new Error("later step failed"); }, verify: async () => true, compensate: async () => {},
    };
    const run = (w: World, txId: string, steps: TxStep<unknown>[]) =>
      runTransaction({ txId, mode: "on", items: { [RUNTIME_ITEM]: "on" }, steps, adapter: null, stateDir: join(w.root, "tx-state") });
    const w = world();
    const step = () => runtimeAliasStep({ currentDir: w.current, aliasDir: w.alias, socketName: SOCK, fs: w.fs, probe: w.probe });
    const failed = await run(w, "tx-fail", [step(), boom]);
    expect(failed.status).toBe("rolled_back");
    expect(kindOf(w.alias)).toBe("missing");
    const ok = await run(w, "tx-ok", [step()]);
    expect(ok.status).toBe("committed");
    expect(realpathSync(w.alias)).toBe(w.current);
    const kept = await run(w, "tx-kept", [step(), boom]);
    expect(kept.status).toBe("rolled_back");
    expect(kindOf(w.alias)).toBe("symlink"); // 事务开始前就有,补偿不删
    expect(await w.probe.identify(join(w.current, SOCK))).toBe(SERVER);
  });

  test("[验收线 2] 分项开关没批准时事务不执行本步", async () => {
    const w = world();
    const step = runtimeAliasStep({ currentDir: w.current, aliasDir: w.alias, socketName: SOCK, fs: w.fs, probe: w.probe });
    const r = await runTransaction({ txId: "tx-off", mode: "on", items: {}, steps: [step], adapter: null, stateDir: join(w.root, "tx-state") });
    expect(r.steps.map((s) => s.state)).toEqual(["skipped"]);
    expect(writes(w)).toEqual([]);
  });
});

describe("[验收线 3] 带空格的路径、symlink 链、失效别名", () => {
  test("[验收线 3] 路径带空格:建别名、幂等、回滚都成立", async () => {
    const w = world({ current: "claude run time", alias: "floka new dir" });
    const up = await applyRuntimeAlias(input(w));
    expect(up.status).toBe("aliased");
    expect(readlinkSync(w.alias)).toBe(join(w.root, "claude run time"));
    expect(up.plan!.aliasSocket).toBe(join(w.root, "floka new dir", SOCK));
    expect(up.identityAfter).toBe(up.identityBefore!);
    expect((await applyRuntimeAlias(input(w))).status).toBe("already");
    expect((await rollbackRuntimeAlias(input(w))).status).toBe("rolled_back");
    expect(kindOf(w.alias)).toBe("missing");
  });

  test("[验收线 3] 现存 runtime 目录本身是 symlink 链:别名直接指向链尾的真实目录,server 相同", async () => {
    const w = world({ current: "real runtime" });
    const [hop1, hop2] = [join(w.root, "hop1"), join(w.root, "hop2")];
    symlinkSync(w.current, hop1);
    symlinkSync(hop1, hop2);
    const r = await applyRuntimeAlias(input(w, "on", { currentDir: hop2 }));
    expect(r.status).toBe("aliased");
    expect(r.plan!.currentReal).toBe(w.current);
    expect(readlinkSync(w.alias)).toBe(w.current); // 不经 hop1 / hop2,链上哪一环被改都不影响别名
    expect(r.identityAfter).toBe(r.identityBefore!);
    expect([readlinkSync(hop1), readlinkSync(hop2)]).toEqual([w.current, hop1]);
  });

  test("[验收线 3] 别名经多级 symlink 最终到现存目录:算已建好;回滚只删别名这一环", async () => {
    const w = world();
    const mid = join(w.root, "mid");
    symlinkSync(w.current, mid);
    symlinkSync(mid, w.alias);
    const r = await applyRuntimeAlias(input(w));
    expect([r.status, r.changed]).toEqual(["already", false]);
    expect(writes(w)).toEqual([]);
    expect((await rollbackRuntimeAlias(input(w))).status).toBe("rolled_back");
    expect([kindOf(w.alias), readlinkSync(mid)]).toEqual(["missing", w.current]);
  });

  test("[验收线 3] 失效别名(目标已不存在):明确拒绝 dangling-alias,不替换不删除", async () => {
    const w = world();
    symlinkSync(join(w.root, "gone"), w.alias);
    const before = tree(w.root);
    const plan = await planRuntimeAlias(input(w));
    expect([plan.aliasState, plan.action]).toEqual(["dangling-alias", "none"]);
    for (const r of [await applyRuntimeAlias(input(w)), await rollbackRuntimeAlias(input(w))]) {
      expect([r.status, codes(r)]).toEqual(["refused", ["dangling-alias"]]);
      expect(r.refusals![0]!.detail).toContain(w.alias);
    }
    expect(writes(w)).toEqual([]);
    expect(tree(w.root)).toEqual(before);
  });

  test("[验收线 3] 链中间断掉的别名同样按失效处理;成环的别名报 alias-loop", async () => {
    const broken = world();
    symlinkSync(join(broken.root, "gone"), join(broken.root, "mid"));
    symlinkSync(join(broken.root, "mid"), broken.alias);
    expect(codes(await applyRuntimeAlias(input(broken)))).toEqual(["dangling-alias"]);
    const loop = world();
    symlinkSync(loop.alias, join(loop.root, "back"));
    symlinkSync(join(loop.root, "back"), loop.alias);
    expect(codes(await applyRuntimeAlias(input(loop)))).toEqual(["alias-loop"]);
    for (const w of [broken, loop]) expect(writes(w)).toEqual([]);
  });

  test("[验收线 3] 入参与位置不成立的明确结果:相对路径、带目录的 socket 名、同一路径、嵌套、父目录不存在、现存目录不存在", async () => {
    const w = world();
    writeFileSync(join(w.root, "plain-file"), "x");
    symlinkSync(w.root, join(w.root, "loopback")); // loopback/claude-runtime 解析后就是现存目录
    const cases: [Partial<RuntimeAliasInput>, string][] = [
      [{ aliasDir: "floka" }, "invalid-path"],
      [{ currentDir: "./runtime" }, "invalid-path"],
      [{ socketName: "sub/master.sock" }, "invalid-path"],
      [{ socketName: ".." }, "invalid-path"],
      [{ socketName: "" }, "invalid-path"],
      [{ aliasDir: `${w.current}/` }, "same-path"],
      [{ aliasDir: join(w.root, "loopback", "claude-runtime") }, "same-path"],
      [{ aliasDir: join(w.current, "floka") }, "nested-path"],
      [{ aliasDir: join(w.root, "no-such-parent", "floka") }, "alias-parent-missing"],
      [{ currentDir: join(w.root, "no-such-runtime") }, "current-missing"],
      [{ currentDir: join(w.root, "plain-file") }, "current-not-dir"],
    ];
    const before = tree(w.root);
    for (const [over, code] of cases) {
      const r = await applyRuntimeAlias(input(w, "on", over));
      expect([JSON.stringify(over), r.status, codes(r)]).toEqual([JSON.stringify(over), "refused", [code]]);
    }
    expect(writes(w)).toEqual([]);
    expect(tree(w.root)).toEqual(before);
  });
});

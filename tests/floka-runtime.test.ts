import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { holdWith, type HoldIo, nodeAliasFs, tmuxServerProbe } from "../src/lib/floka-migration/runtime/adapters.ts";
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
  w.fs = {
    kind: logged("kind"), resolve: logged("resolve"), fileId: logged("fileId"), entryId: logged("entryId"), hold: logged("hold"), readlink: logged("readlink"),
    symlink: logged("symlink"), unlink: logged("unlink"), rename: logged("rename"), link: logged("link"),
  };
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

const writes = (w: World) => w.fsLog.filter((l) => /^(symlink|unlink|rename|link) /.test(l));
/** 删别名的写序列:先原子挪到同目录的暂存名,核对后删暂存名 */
const removed = (w: World) => {
  const moved = writes(w).find((l) => l.startsWith(`rename ${w.alias} -> `));
  expect(moved).toBeDefined();
  const parked = moved!.split(" -> ")[1]!;
  return [moved!, `unlink ${parked}`];
};
/** 临时根下所有内容为 text 的普通文件(找外来文件被挪去了哪) */
const filesWith = (w: World, text: string) => tree(w.root).filter((l) => l.includes(" #")).map((l) => l.split(" #")[0]!).filter((rel) => readFileSync(join(w.root, rel), "utf8") === text);

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
    expect(new Set(w.fsLog.map((l) => l.split(" ")[0]))).toEqual(new Set(["kind", "resolve", "fileId", "entryId", "hold", "symlink", "rename", "unlink"]));
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
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`, ...removed(w)]);
    expect(tree(w.root).filter((l) => !l.startsWith("claude-runtime"))).toEqual([]); // 暂存名也删干净了
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
      const r = await applyRuntimeAlias(input(w, "on", { mode })); // 经 over 传,undefined 不会被默认参数换成 on
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
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`, ...removed(w)]);
    const again = await rollbackRuntimeAlias(input(w));
    expect([again.status, again.changed]).toEqual(["absent", false]);
    expect(writes(w)).toHaveLength(3);
  });

  test("[验收线 2] 回滚期间别名被换成外来文件:拒绝,不删替代项", async () => {
    const w = world();
    await applyRuntimeAlias(input(w));
    const real = w.probe;
    w.probe = {
      identify: async (p) => {
        if (p.startsWith(w.current) && kindOf(w.alias) === "symlink") { rmSync(w.alias); writeFileSync(w.alias, "foreign important"); }
        return real.identify(p);
      },
    };
    const r = await rollbackRuntimeAlias(input(w));
    expect([r.status, r.changed, codes(r)]).toEqual(["refused", false, ["conflict-entry"]]);
    expect(readFileSync(w.alias, "utf8")).toBe("foreign important");
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`]);
  });

  test("[验收线 2] 建别名后核身份期间别名被换成外来文件:拒绝,如实报告已建过别名,不删替代项", async () => {
    const w = world();
    const real = w.probe;
    w.probe = {
      identify: async (p) => {
        if (!p.startsWith(w.alias)) return real.identify(p);
        rmSync(w.alias);
        writeFileSync(w.alias, "foreign important");
        return null;
      },
    };
    const r = await applyRuntimeAlias(input(w));
    expect([r.status, r.changed, codes(r)]).toEqual(["refused", true, ["identity-mismatch", "conflict-entry"]]);
    expect(readFileSync(w.alias, "utf8")).toBe("foreign important");
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`]);
  });

  test("[验收线 2] 建别名后被换成另一条同样指向现存目录的软链:不是本次建的那一条,不删", async () => {
    const w = world();
    const real = w.probe;
    w.probe = {
      identify: async (p) => {
        if (!p.startsWith(w.alias)) return real.identify(p);
        rmSync(w.alias);
        symlinkSync(w.current, w.alias);
        return null;
      },
    };
    const r = await applyRuntimeAlias(input(w));
    expect([r.status, r.changed, codes(r)]).toEqual(["refused", true, ["identity-mismatch", "conflict-entry"]]);
    expect(realpathSync(w.alias)).toBe(w.current);
    expect(writes(w)).toEqual([`symlink ${w.current} -> ${w.alias}`]);
  });

  /** 在动别名的那一次写调用(rename / unlink 以别名为源)之前一刻,把别名换成外来文件 */
  const swapRightBeforeWrite = (w: World) => {
    let fired = false;
    const swap = () => { if (!fired && kindOf(w.alias) === "symlink") { fired = true; rmSync(w.alias); writeFileSync(w.alias, "foreign important"); } };
    const base = w.fs;
    w.fs = {
      ...base,
      rename: async (from, to) => { if (from === w.alias) swap(); return base.rename(from, to); },
      unlink: async (p) => { if (p === w.alias) swap(); return base.unlink(p); },
    };
    return () => fired;
  };

  test("[验收线 2] 回滚:核对已过、删之前一刻别名被换成外来文件:拒绝,替代项原样留在别名位置", async () => {
    const w = world();
    await applyRuntimeAlias(input(w));
    const fired = swapRightBeforeWrite(w);
    const r = await rollbackRuntimeAlias(input(w));
    expect(fired()).toBe(true);
    expect([r.status, r.changed, codes(r)]).toEqual(["refused", false, ["conflict-entry"]]);
    expect(readFileSync(w.alias, "utf8")).toBe("foreign important");
    expect(filesWith(w, "foreign important")).toEqual(["floka"]); // 没有被留在暂存名
  });

  test("[验收线 2] apply 失败清理:删之前一刻别名被换成外来文件:拒绝,如实报告已建过别名,替代项原样保留", async () => {
    const w = world();
    const real = w.probe;
    w.probe = { identify: async (p) => (p.startsWith(w.alias) ? null : real.identify(p)) };
    const fired = swapRightBeforeWrite(w);
    const r = await applyRuntimeAlias(input(w));
    expect(fired()).toBe(true);
    expect([r.status, r.changed, codes(r)]).toEqual(["refused", true, ["identity-mismatch", "conflict-entry"]]);
    expect(readFileSync(w.alias, "utf8")).toBe("foreign important");
    expect(filesWith(w, "foreign important")).toEqual(["floka"]);
  });

  test("[验收线 2] 删前最后一次解析读到正确目标后、返回前别名被换成外来文件(r2 探针时序):外来文件不丢", async () => {
    for (const op of ["rollback", "apply"] as const) {
      const w = world();
      if (op === "rollback") await applyRuntimeAlias(input(w));
      const real = w.probe;
      let probed = false;
      w.probe = { identify: async (p) => { probed = true; return op === "apply" && p.startsWith(w.alias) ? null : real.identify(p); } };
      const base = w.fs;
      w.fs = {
        ...base,
        resolve: async (p) => {
          const got = await base.resolve(p);
          // 删前那次解析:旧实现解析别名本身,新实现解析暂存名(此时别名位置已空,外来文件落在空位上)
          if (probed && !fired && (p === w.alias || p.includes("floka-unlink"))) {
            fired = true;
            rmSync(w.alias, { force: true });
            writeFileSync(w.alias, "foreign important");
          }
          return got;
        },
      };
      let fired = false;
      const r = await (op === "rollback" ? rollbackRuntimeAlias(input(w)) : applyRuntimeAlias(input(w)));
      expect([op, fired]).toEqual([op, true]);
      // 换在取走之前 → 拒绝;换在取走之后 → 本库那条已删,外来文件在空位上。两种都不能丢外来文件、不能留暂存名
      expect([op, readFileSync(w.alias, "utf8")]).toEqual([op, "foreign important"]);
      expect([op, tree(w.root).filter((l) => l.includes("floka-unlink") || l.includes("->"))]).toEqual([op, []]);
      if (op === "apply") expect(r.status).toBe("refused");
    }
  });

  test("[验收线 2] 暂存后别名位置又被别人占了:不覆盖对方,外来项留在暂存名并在拒绝里写明", async () => {
    const w = world();
    await applyRuntimeAlias(input(w));
    const base = w.fs;
    w.fs = {
      ...base,
      rename: async (from, to) => {
        if (from !== w.alias) return base.rename(from, to);
        rmSync(w.alias);
        writeFileSync(w.alias, "foreign important");
        await base.rename(from, to);
        writeFileSync(w.alias, "second comer");
      },
    };
    const r = await rollbackRuntimeAlias(input(w));
    expect([r.status, r.changed, codes(r)]).toEqual(["refused", true, ["conflict-entry"]]); // 外来项被挪过,如实报告
    expect(readFileSync(w.alias, "utf8")).toBe("second comer");
    const [parked] = filesWith(w, "foreign important");
    expect(parked).toBeDefined();
    expect(r.refusals![0]!.detail).toContain(join(w.root, parked!));
  });

  test("[验收线 2] 暂存后核出是外来目录 / 外来软链:同样原样放回", async () => {
    for (const kind of ["dir", "symlink"] as const) {
      const w = world();
      await applyRuntimeAlias(input(w));
      const other = join(w.root, "elsewhere");
      mkdirSync(other);
      const base = w.fs;
      w.fs = {
        ...base,
        rename: async (from, to) => {
          if (from === w.alias) {
            rmSync(w.alias);
            if (kind === "dir") { mkdirSync(w.alias); writeFileSync(join(w.alias, "keep"), "k"); } else symlinkSync(other, w.alias);
          }
          return base.rename(from, to);
        },
      };
      const r = await rollbackRuntimeAlias(input(w));
      expect([kind, r.status, codes(r)]).toEqual([kind, "refused", ["conflict-entry"]]);
      if (kind === "dir") expect(readFileSync(join(w.alias, "keep"), "utf8")).toBe("k");
      else expect(readlinkSync(w.alias)).toBe(other);
      expect(tree(w.root).filter((l) => l.includes("floka-unlink"))).toEqual([]);
    }
  });

  test("[验收线 2] 开关不是 on 不回滚;server 掉了不拦回滚", async () => {
    const w = world();
    await applyRuntimeAlias(input(w));
    for (const mode of ["off", "observe", undefined]) {
      const r = await rollbackRuntimeAlias(input(w, "on", { mode }));
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

  test("[验收线 2] 占住期间别名被删掉再建同目标软链:新一条标识不同(Linux 立刻复用 inode 号也认得出)", async () => {
    const w = world();
    symlinkSync(w.current, w.alias);
    const held = await nodeAliasFs.hold(w.alias);
    try {
      rmSync(w.alias);
      symlinkSync(w.current, w.alias);
      expect(held!.id).not.toBe(await nodeAliasFs.entryId(w.alias));
    } finally {
      await held!.release();
    }
    expect(await nodeAliasFs.hold(join(w.root, "nope"))).toBeNull();
  });

  test("[验收线 2] open 与路径查询之间别名被换:标识取自占住的描述符,不是路径上的替代项", async () => {
    const closed: string[] = [];
    // 描述符占住 1:100,路径此刻已是另一项 1:200
    const io: HoldIo = { open: async () => ({ stat: async () => ({ dev: 1, ino: 100 }), close: async () => { closed.push("fd"); } }), entryId: async () => "1:200" };
    const held = await holdWith(io, "/x/alias");
    expect([held!.id, held!.pinned]).toEqual(["1:100", true]);
    await held!.release();
    const broken: HoldIo = { ...io, open: async () => ({ stat: async () => { throw new Error("EBADF"); }, close: async () => { closed.push("bad"); } }) };
    await expect(holdWith(broken, "/x/alias")).rejects.toThrow("EBADF");
    expect(closed).toEqual(["fd", "bad"]); // 释放关掉占位;stat 失败也先关再抛
  });

  test("[验收线 2] 占不住时 pinned=false;真实适配器占住的标识就是这一项自身", async () => {
    expect((await holdWith({ open: async () => null, entryId: async () => "1:300" }, "/x/alias"))!.pinned).toBe(false);
    expect(await holdWith({ open: async () => null, entryId: async () => null }, "/x/alias")).toBeNull();
    const w = world();
    symlinkSync(w.current, w.alias);
    const held = await nodeAliasFs.hold(w.alias);
    try {
      expect(held!.pinned).toBe(process.platform === "linux" || process.platform === "darwin");
      expect(held!.id).toBe((await nodeAliasFs.entryId(w.alias))!);
    } finally {
      await held!.release();
    }
  });

  test("[验收线 2] 回滚时别名占不住:拒绝且不删,不凭可能被复用的标识动手", async () => {
    const w = world();
    expect((await applyRuntimeAlias(input(w))).status).toBe("aliased");
    const before = tree(w.root);
    w.fsLog.length = 0;
    const fs: AliasFs = { ...w.fs, hold: async (p) => { const h = await w.fs.hold(p); return h && { ...h, pinned: false }; } };
    const back = await rollbackRuntimeAlias(input(w, "on", { fs }));
    expect([back.status, back.changed, back.refusals!.map((r) => r.code)]).toEqual(["refused", false, ["conflict-entry"]]);
    expect(writes(w)).toEqual([]);
    expect(tree(w.root)).toEqual(before);
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

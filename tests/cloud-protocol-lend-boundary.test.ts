/**
 * cloud-PP2 出借 offer 协议解耦的边界：用 guard 的真实 import 图（scripts/guard/rules/deps.ts collectEdges，含 type-only 边）求传递闭包，
 * 同一条规则对新纯入口（lend-offer-protocol / lend-wire-types / lend-wire-v2-schema）判绿、对仍在用的旧入口（lend-wire-v2 / lend-wire）判红；
 * 类型与 literal 集合新旧路径一致；导入新入口不读环境、不碰文件系统、不留本机状态。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { collectEdges, type Edge } from "../scripts/guard/rules/deps.js";
import type { LendFamily as ConfigFamily } from "../src/lib/lend-config.js";
import type { LendStep as GitStep } from "../src/lib/lend-git.js";
import type { LeaseState as OldLease, OfferSummary as OldSummary } from "../src/lib/lend-wire.js";
import { LEASE_MS_DEFAULT as OLD_LEASE_MS } from "../src/lib/lend-wire.js";
import { LEND_FAMILIES as CONFIG_FAMILIES } from "../src/lib/lend-config.js";
import { testChildEnv } from "./test-env.js";
import { LEASE_MS_DEFAULT, LEND_FAMILIES, LEND_STEPS, type LeaseState, type LendFamily, type LendStep, type OfferSummary } from "../src/lib/lend-wire-types.js";

const ROOT = resolve(import.meta.dir, "..");
/** 本机状态 / 配置 / 台账 / git / 订单线协议 / 进程入口：新纯入口的闭包里一个都不许有 */
const FORBIDDEN = /^src\/(?:lib\/(?:paths|registry|config-store|ledger-store|lend-git|lend-config|order-wire|scheduler(?:-[\w-]+)?)\.ts|(?:scheduler|bridge|manager)\.ts|(?:bridge|manager)\/)/;
const NEW_ENTRIES = ["src/lib/lend-offer-protocol.ts", "src/lib/lend-wire-types.ts", "src/lib/lend-wire-v2-schema.ts"];

function loadSrc(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.set(relative(ROOT, p), readFileSync(p, "utf8"));
    }
  };
  walk(join(ROOT, "src"));
  return files;
}

function closure(edges: Edge[], entry: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>([entry]);
  for (const f of seen) for (const to of out.get(f) ?? []) seen.add(to);
  return seen;
}
/** 同一条边界规则：闭包里落在 FORBIDDEN 的文件（空 = 绿） */
const violations = (edges: Edge[], entry: string): string[] => [...closure(edges, entry)].filter((f) => FORBIDDEN.test(f)).sort();

const FILES = loadSrc();
const EDGES = collectEdges(FILES);

describe("import 图边界（runtime + type 闭包）", () => {
  test("新纯入口闭包只有这三个文件，规则判绿", () => {
    for (const e of NEW_ENTRIES) expect({ e, bad: violations(EDGES, e) }).toEqual({ e, bad: [] });
    expect([...closure(EDGES, "src/lib/lend-offer-protocol.ts")].sort()).toEqual([...NEW_ENTRIES].sort());
    expect([...closure(EDGES, "src/lib/lend-wire-types.ts")]).toEqual(["src/lib/lend-wire-types.ts"]);
    expect([...closure(EDGES, "src/lib/lend-wire-v2-schema.ts")]).toEqual(["src/lib/lend-wire-v2-schema.ts"]);
  });

  test("旧入口仍是本机链：同一规则判红（lend-wire-v2 经 order-wire；lend-wire 经 lend-git / order-wire）", () => {
    const v2 = violations(EDGES, "src/lib/lend-wire-v2.ts");
    expect(v2).toContain("src/lib/order-wire.ts");
    expect(v2).toContain("src/lib/paths.ts");
    const v1 = violations(EDGES, "src/lib/lend-wire.ts");
    expect(v1).toEqual(expect.arrayContaining(["src/lib/lend-git.ts", "src/lib/order-wire.ts", "src/lib/paths.ts"]));
    // 原 lend-config 仍带本机 paths（配置读写逻辑留原处）
    expect(violations(EDGES, "src/lib/lend-config.ts")).toContain("src/lib/paths.ts");
  });

  test("规则不是摆设：新入口若回头 import 原三者 / order-wire，同一规则立刻判红", () => {
    for (const back of ["./lend-config.js", "./lend-git.js", "./lend-wire.js", "./order-wire.js"]) {
      const files = new Map(FILES);
      files.set("src/lib/lend-wire-types.ts", `import type { X } from "${back}";\n${FILES.get("src/lib/lend-wire-types.ts")}`);
      expect(violations(collectEdges(files), "src/lib/lend-offer-protocol.ts").length).toBeGreaterThan(0);
    }
  });

  test("新入口源码不触环境 / 文件系统 / 进程：没有 node: / bun 内建 import，也没有 process. / Bun. / require", () => {
    for (const f of NEW_ENTRIES) {
      const src = FILES.get(f) ?? "";
      expect({ f, hit: src.match(/from\s+["'](?:node:|bun|fs|os|path)|\bprocess\.|\bBun\.|\brequire\(|\bimport\(/g) }).toEqual({ f, hit: null });
    }
  });
});

describe("导入新入口不生成本机状态", () => {
  const home = mkdtempSync(join(tmpdir(), "cloud-pp2-home-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  test("空 HOME / 状态目录里 import 三个新入口：目录仍是空的", () => {
    const code = NEW_ENTRIES.map((f) => `await import(${JSON.stringify(join(ROOT, f))});`).join("") + "console.log('ok')";
    const env = testChildEnv({ HOME: home, TMPDIR: home, CLAUDESTRA_STATE_DIR: join(home, "state") });
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], { env, cwd: home });
    expect(r.stdout.toString().trim()).toBe("ok");
    expect(readdirSync(home)).toEqual([]);
  });
});

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const same = <T extends true>(): T => true as T;

describe("类型与 literal 集合不扩不缩，旧路径照用", () => {
  test("literal 与常量", () => {
    expect([...LEND_FAMILIES]).toEqual(["codex", "claude"]);
    expect([...LEND_STEPS]).toEqual(["review", "write", "fix"]);
    expect(CONFIG_FAMILIES).toBe(LEND_FAMILIES);
    expect(OLD_LEASE_MS).toBe(LEASE_MS_DEFAULT);
    expect(LEASE_MS_DEFAULT).toBe(600_000);
  });
  test("类型逐项相等（typecheck 断言，tsc 跑到这里）", () => {
    expect([
      same<Eq<LendFamily, "codex" | "claude">>(), same<Eq<ConfigFamily, LendFamily>>(),
      same<Eq<LendStep, "review" | "write" | "fix">>(), same<Eq<GitStep, LendStep>>(),
      same<Eq<OldSummary, OfferSummary>>(), same<Eq<OldLease, LeaseState>>(),
      same<Eq<LeaseState, { gen: number; expiresAt: number; ms: number }>>(),
      same<Eq<keyof OfferSummary, "orderId" | "taskId" | "step" | "family" | "repo" | "pr" | "head" | "round" | "specRev" | "offeredAt">>(),
      same<Eq<OfferSummary["pr"], number | null>>(),
    ]).toEqual(Array(9).fill(true));
  });
});

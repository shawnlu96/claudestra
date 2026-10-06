/**
 * Public consumers keep the pure address predicates and legacy import compatibility.
 * The import graph and isolated import checks reject local environment access.
 * Center URL rejection and its graph mutations run in the private migration counterpart.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { collectEdges, type Edge } from "../scripts/guard/rules/deps.js";
import * as pure from "../src/lib/address-predicates.js";
import * as legacy from "../src/lib/net-addr.js";
import * as legacyHost from "../src/lib/same-host.js";
import { testChildEnv } from "./test-env.js";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = "src/lib/address-predicates.ts";
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
const FILES = loadSrc();
const EDGES = collectEdges(FILES);

describe("import 图边界（runtime + type 闭包）", () => {
  test("纯谓词模块闭包只有自己，源码没有任何 import / 环境访问", () => {
    expect([...closure(EDGES, ENTRY)]).toEqual([ENTRY]);
    const src = FILES.get(ENTRY) ?? "";
    expect(src.match(/^\s*(?:import|export)\b[^\n]*\bfrom\b|\bimport\(|\brequire\(|\bprocess\.|\bBun\./gm)).toBeNull();
  });


});

describe("行为不变", () => {
  // 搬移前 net-addr.ts 里的原算法，作为固定语料的对照基准
  const oldTailscale = (ip: string): boolean => {
    const m = /^100\.(\d{1,3})\./.exec(ip);
    return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
  };
  const oldPrivate = (ip: string): boolean => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const CORPUS = [
    "100.64.0.1", "100.101.102.103", "100.127.255.254", "100.0.0.1", "100.63.255.255", "100.128.0.1", "100.255.0.1", "1.100.64.1",
    "100.0064.1.1", "100.999.1.1", "100.64", "192.168.3.168", "192.168.0.0", "192.169.1.1", "10.1.2.3", "10.0.0.0", "110.1.1.1",
    "172.16.0.1", "172.31.255.254", "172.15.0.1", "172.32.0.1", "172.2.0.1", "172.20.1.1", "8.8.8.8", "127.0.0.1", "0.0.0.0",
    "169.254.1.1", "::1", "::ffff:192.168.1.1", "fc00::1", "", " 10.0.0.1", "10.0.0.1 ", "peer-a.local", "localhost",
  ];

  // 搬移前 same-host.ts 里的原环回算法
  const oldLoopback = (addr: string | null | undefined): boolean => {
    if (!addr) return false;
    const a = addr.toLowerCase();
    return a === "::1" || a === "::ffff:127.0.0.1" || a === "::ffff:7f00:1" || a === "0:0:0:0:0:ffff:7f00:1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
  };
  const LOOPBACK_CORPUS = [
    "127.0.0.1", "127.255.255.254", "127.", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1", "::FFFF:7F00:1",
    "0:0:0:0:0:ffff:7f00:1", "::ffff:127.1.2.3", "128.0.0.1", "1.127.0.0", "::2", "::ffff:7f00:2", "0:0:0:0:0:0:0:1", " 127.0.0.1",
    "localhost", "10.0.0.1", "", null, undefined,
  ];

  test("环回谓词与原算法在固定正负语料上逐项相同", () => {
    for (const ip of LOOPBACK_CORPUS) expect({ ip, lo: pure.isLoopbackAddress(ip) }).toEqual({ ip, lo: oldLoopback(ip) });
    expect(LOOPBACK_CORPUS.filter(pure.isLoopbackAddress).length).toBeGreaterThan(0);
    expect(LOOPBACK_CORPUS.filter((ip) => !pure.isLoopbackAddress(ip)).length).toBeGreaterThan(0);
  });

  test("新谓词与原算法在固定正负语料上逐项相同", () => {
    for (const ip of CORPUS) {
      expect({ ip, ts: pure.isTailscaleAddr(ip), lan: pure.isPrivateAddr(ip) }).toEqual({ ip, ts: oldTailscale(ip), lan: oldPrivate(ip) });
    }
    expect(CORPUS.filter(pure.isTailscaleAddr).length).toBeGreaterThan(0);
    expect(CORPUS.filter(pure.isPrivateAddr).length).toBeGreaterThan(0);
  });

  test("旧 import 路径兼容：net-addr / same-host 导出的就是同一函数", () => {
    expect(legacy.isTailscaleAddr).toBe(pure.isTailscaleAddr);
    expect(legacy.isPrivateAddr).toBe(pure.isPrivateAddr);
    expect(legacyHost.isLoopbackAddress).toBe(pure.isLoopbackAddress);
  });


});

describe("隔离 import", () => {
  test("在临时 HOME / TMPDIR 里加载纯谓词，不生成任何文件", () => {
    const home = mkdtempSync(join(tmpdir(), "pp3-home-"));
    const tmp = mkdtempSync(join(tmpdir(), "pp3-tmp-"));
    try {
      const script = `import * as p from ${JSON.stringify(resolve(ROOT, ENTRY))};
console.log(JSON.stringify({ ts: p.isTailscaleAddr("100.64.0.1"), lan: p.isPrivateAddr("10.0.0.1") }));`;
      const proc = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: tmp, env: testChildEnv({ HOME: home, TMPDIR: tmp }) });
      expect(proc.stderr.toString()).toBe("");
      expect(JSON.parse(proc.stdout.toString())).toEqual({ ts: true, lan: true });
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

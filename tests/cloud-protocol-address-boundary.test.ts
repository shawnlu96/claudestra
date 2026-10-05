/**
 * cloud-PP3 纯地址谓词：isPrivateAddr / isTailscaleAddr 搬进无 import 的叶子 address-predicates.ts，
 * 中心 artifacts/urls.ts 只依赖它，不再经 net-addr 把网卡查询 / tailscale CLI（动态 import）带进闭包。
 * 图用 guard 的真实 import 边（scripts/guard/rules/deps.ts collectEdges，含 type-only 与动态 import）；
 * 同一规则在把 urls 改回旧 import 的合成图上判红，证明扫描器认得出；新旧谓词在固定语料上逐项相同；旧 import 路径仍可用。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { collectEdges, type Edge } from "../scripts/guard/rules/deps.js";
import * as pure from "../src/lib/address-predicates.js";
import * as legacy from "../src/lib/net-addr.js";
import { withoutPublicWebLinks } from "../src/shared-ledger/artifacts/urls.js";
import { testChildEnv } from "./test-env.js";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = "src/lib/address-predicates.ts";
const URLS = "src/shared-ledger/artifacts/urls.ts";
/** 网卡查询 / tailscale CLI / 本机状态 / 配置 / 中心 / bridge：纯谓词与中心 URL 规则的闭包里一个都不许有 */
const FORBIDDEN_LIB = "net-addr|tailscale|paths|state-dir|registry|config-store|ledger-store|shared-ledger-client|shared-ledger-mode|bridge-[\\w-]+";
const FORBIDDEN = new RegExp(`^src/(?:lib/(?:${FORBIDDEN_LIB})\\.ts|(?:bridge|manager)\\.ts|(?:bridge|manager)/)`);

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
const violations = (edges: Edge[], entry: string): string[] => [...closure(edges, entry)].filter((f) => FORBIDDEN.test(f)).sort();

const FILES = loadSrc();
const EDGES = collectEdges(FILES);

describe("import 图边界（runtime + type 闭包）", () => {
  test("纯谓词模块闭包只有自己，源码没有任何 import / 环境访问", () => {
    expect([...closure(EDGES, ENTRY)]).toEqual([ENTRY]);
    const src = FILES.get(ENTRY) ?? "";
    expect(src.match(/^\s*(?:import|export)\b[^\n]*\bfrom\b|\bimport\(|\brequire\(|\bprocess\.|\bBun\./gm)).toBeNull();
  });

  test("中心 urls.ts 闭包不再含 net-addr / tailscale / 本机状态", () => {
    expect(closure(EDGES, URLS).has(ENTRY)).toBe(true);
    expect(violations(EDGES, URLS)).toEqual([]);
  });

  test("规则不是摆设：旧 net-addr 闭包含 tailscale；把 urls 改回旧 import，同一规则立刻判红", () => {
    expect(violations(EDGES, "src/lib/net-addr.ts")).toEqual(["src/lib/net-addr.ts", "src/lib/tailscale.ts"]);
    const files = new Map(FILES);
    files.set(URLS, FILES.get(URLS)!.replace('"../../lib/address-predicates.js"', '"../../lib/net-addr.js"'));
    expect(violations(collectEdges(files), URLS)).toEqual(expect.arrayContaining(["src/lib/net-addr.ts", "src/lib/tailscale.ts"]));
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

  test("新谓词与原算法在固定正负语料上逐项相同", () => {
    for (const ip of CORPUS) {
      expect({ ip, ts: pure.isTailscaleAddr(ip), lan: pure.isPrivateAddr(ip) }).toEqual({ ip, ts: oldTailscale(ip), lan: oldPrivate(ip) });
    }
    expect(CORPUS.filter(pure.isTailscaleAddr).length).toBeGreaterThan(0);
    expect(CORPUS.filter(pure.isPrivateAddr).length).toBeGreaterThan(0);
  });

  test("旧 import 路径兼容：net-addr 导出的就是同一函数", () => {
    expect(legacy.isTailscaleAddr).toBe(pure.isTailscaleAddr);
    expect(legacy.isPrivateAddr).toBe(pure.isPrivateAddr);
  });

  test("中心 URL 规则：公共放行，私有 / 环回 / 映射 / 控制字符 / 登录信息仍拒绝", () => {
    for (const ok of ["https://example.invalid/docs", "http://172.32.0.1/docs", "https://192.169.1.1/docs", "http://100.128.0.1/x", "https://[2001:db8::1]/docs"]) {
      expect({ ok, out: withoutPublicWebLinks(`see ${ok} end`) }).toEqual({ ok, out: "see  end" });
    }
    for (const bad of [
      "http://10.0.0.1/x", "http://172.16.0.1/x", "http://192.168.1.1/x", "http://100.64.0.1/x", "http://100.127.0.1/x",
      "http://127.0.0.1/x", "http://localhost/x", "http://[::1]/x", "http://[::ffff:192.168.1.1]/x", "http://[::ffff:100.64.0.1]/x",
      "http://[::ffff:127.0.0.1]/x", "http://exa\u0000mple.invalid/x", "https://user:pw@example.invalid/x", "https://user@example.invalid/x",
    ]) expect(() => withoutPublicWebLinks(bad)).toThrow();
  });
});

describe("隔离 import", () => {
  test("在临时 HOME / TMPDIR 里加载纯谓词与中心 URL 规则，不生成任何文件", () => {
    const home = mkdtempSync(join(tmpdir(), "pp3-home-"));
    const tmp = mkdtempSync(join(tmpdir(), "pp3-tmp-"));
    try {
      const script = `import * as p from ${JSON.stringify(resolve(ROOT, ENTRY))};
import { withoutPublicWebLinks } from ${JSON.stringify(resolve(ROOT, URLS))};
console.log(JSON.stringify({ ts: p.isTailscaleAddr("100.64.0.1"), lan: p.isPrivateAddr("10.0.0.1"), out: withoutPublicWebLinks("https://example.invalid/a") }));`;
      const proc = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: tmp, env: testChildEnv({ HOME: home, TMPDIR: tmp }) });
      expect(proc.stderr.toString()).toBe("");
      expect(JSON.parse(proc.stdout.toString())).toEqual({ ts: true, lan: true, out: "" });
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

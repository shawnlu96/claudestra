/**
 * cloud-PP1 公共协议核心的模块边界：三个纯入口（canonical-json / instance-signature / shared-ledger-join-protocol）以及
 * shared-ledger-auth / contract-transfer / contract-v2-integrity 的 import 递归图，runtime 边与 type 边分开扫（oxc AST，真实 import 语句），
 * 不得触及本机状态（paths / registry / config-store / ledger-store / ledger-asks / 本机凭据 IO / bridge / manager）。
 * 同一断言先在旧入口（ask-bind / instance-key / shared-ledger-join）上检出真实穿透链，证明扫描器认得出；再隔离 import 新入口，确认不落任何文件。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { testChildEnv } from "./test-env.ts";

const ROOT = resolve(import.meta.dir, "..");
const PURE_ENTRIES = [
  "src/lib/canonical-json.ts", "src/lib/instance-signature.ts", "src/lib/shared-ledger-join-protocol.ts",
  "src/lib/shared-ledger-auth.ts", "src/lib/shared-ledger-contract-transfer.ts", "src/lib/shared-ledger-contract-v2-integrity.ts",
];
/** 本机状态 / 凭据 IO / 常驻进程：纯协议核心一条边都不许到（type-only 也不行，私仓拆分时类型图同样要搬） */
const LOCAL_STATE = /^src\/(?:lib\/(?:paths|state-dir|registry|config-store|ledger-store|ledger-asks(?:-[\w-]+)?|key-file|state-file|shared-ledger-mode|shared-ledger-client|shared-ledger-gate-[\w-]+|quota-credentials|bridge-[\w-]+)\.ts|bridge\/|manager\/|bridge\.ts|manager\.ts)/;

type Kind = "runtime" | "type";
interface Edge { to: string; kind: Kind }

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // node: / 包：不是仓库内模块
  const base = resolve(dirname(from), spec);
  for (const p of [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base, `${base}.ts`, join(base, "index.ts")]) if (existsSync(p)) return p;
  throw new Error(`unresolved import ${spec} in ${relative(ROOT, from)}`);
}

/** 一个文件的仓库内 import 边：import / export…from / import() / import("x").T；整条语句或每个说明符都是 type 的算 type 边 */
function edgesOf(file: string): Edge[] {
  const parsed = parseSync(file, readFileSync(file, "utf8"));
  if (parsed.errors.length) throw new Error(`parse ${file}: ${parsed.errors[0]!.message}`);
  const out: Edge[] = [];
  const add = (spec: unknown, type: boolean) => {
    const to = typeof spec === "string" ? resolveSpec(file, spec) : null;
    if (to) out.push({ to, kind: type ? "type" : "runtime" });
  };
  const allType = (list: { importKind?: string; exportKind?: string }[] | undefined, key: "importKind" | "exportKind") =>
    !!list?.length && list.every((s) => s[key] === "type");
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    const node = n as Record<string, any>;
    if (node.type === "ImportDeclaration") add(node.source.value, node.importKind === "type" || allType(node.specifiers, "importKind"));
    else if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) {
      add(node.source.value, node.exportKind === "type" || allType(node.specifiers, "exportKind"));
    } else if (node.type === "ImportExpression") add(node.source?.value, false);
    else if (node.type === "TSImportType") add(node.source?.value ?? node.argument?.value ?? node.argument?.literal?.value, true);
    for (const v of Object.values(node)) visit(v);
  };
  visit(parsed.program);
  return out;
}

/** runtime 图只走 runtime 边；type 图走全部边（type-only 也得能单独搬走）。命中返回从入口到违规模块的链 */
function closure(entry: string, kind: Kind): { files: string[]; hits: string[][] } {
  const start = resolve(ROOT, entry);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const f = queue.shift()!;
    for (const e of edgesOf(f)) {
      if (kind === "runtime" && e.kind === "type") continue;
      if (!parent.has(e.to)) { parent.set(e.to, f); queue.push(e.to); }
    }
  }
  const rel = (p: string) => relative(ROOT, p);
  const chain = (p: string): string[] => { const out: string[] = []; for (let c: string | null = p; c; c = parent.get(c) ?? null) out.unshift(rel(c)); return out; };
  const files = [...parent.keys()].map(rel).sort();
  return { files, hits: [...parent.keys()].filter((p) => LOCAL_STATE.test(rel(p))).map(chain) };
}

describe("协议核心 import 图：runtime 与 type 分报", () => {
  for (const entry of PURE_ENTRIES) {
    for (const kind of ["runtime", "type"] as const) {
      test(`${entry} ${kind} 图不触及本机状态`, () => {
        expect(closure(entry, kind).hits).toEqual([]);
      });
    }
  }

  test("纯入口的完整闭包只有协议核心自己（type 图）", () => {
    const all = new Set(PURE_ENTRIES.flatMap((e) => closure(e, "type").files));
    expect([...all].sort()).toEqual([
      "src/lib/canonical-json.ts", "src/lib/instance-signature.ts", "src/lib/shared-ledger-auth.ts",
      "src/lib/shared-ledger-contract-schema.ts", "src/lib/shared-ledger-contract-source-dag.ts", "src/lib/shared-ledger-contract-transfer.ts",
      "src/lib/shared-ledger-contract-v2-integrity.ts", "src/lib/shared-ledger-contract-v2-validation.ts",
      "src/lib/shared-ledger-contract-validation.ts", "src/lib/shared-ledger-contract.ts", "src/lib/shared-ledger-join-protocol.ts",
    ]);
  });

  test("同一断言在旧入口上检出真实穿透链（扫描器不是摆设）", () => {
    const first = (entry: string, kind: Kind) => closure(entry, kind).hits.map((c) => c.join(" → "));
    // ask-bind 的 runtime 本来就干净，穿透只在 type 图：import type { Ask } from ledger-asks
    expect(first("src/lib/ask-bind.ts", "runtime")).toEqual([]);
    expect(first("src/lib/ask-bind.ts", "type")).toContain("src/lib/ask-bind.ts → src/lib/ledger-asks.ts");
    expect(first("src/lib/instance-key.ts", "runtime")).toContain("src/lib/instance-key.ts → src/lib/paths.ts");
    expect(first("src/lib/instance-key.ts", "runtime")).toContain("src/lib/instance-key.ts → src/lib/key-file.ts");
    expect(first("src/lib/shared-ledger-join.ts", "runtime")).toContain("src/lib/shared-ledger-join.ts → src/lib/shared-ledger-mode.ts");
  });

  test("type-only 与 runtime 边分得开（合成样本）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp1-edges-"));
    try {
      const f = join(dir, "a.ts");
      for (const n of ["b", "c", "d", "e", "g"]) writeFileSync(join(dir, `${n}.ts`), "export {};");
      writeFileSync(f, [`import type { X } from "./b.js";`, `import { type Y, z } from "./c.js";`, `import { type W } from "./d.js";`,
        `export type { V } from "./e.js";`, `type Q = import("./g.js").Q;`].join("\n"));
      const got = edgesOf(f).map((e) => `${relative(dir, e.to)}:${e.kind}`);
      expect(got).toEqual(["b.ts:type", "c.ts:runtime", "d.ts:type", "e.ts:type", "g.ts:type"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("隔离 import", () => {
  test("在临时 HOME / TMPDIR 里加载纯入口并签验一次，不生成任何文件", () => {
    const home = mkdtempSync(join(tmpdir(), "pp1-home-"));
    const tmp = mkdtempSync(join(tmpdir(), "pp1-tmp-"));
    try {
      const imports = PURE_ENTRIES.map((e, i) => `import * as m${i} from ${JSON.stringify(resolve(ROOT, e))};`).join("\n");
      const script = `${imports}
import { generateKeyPairSync } from "node:crypto";
const pair = generateKeyPairSync("ed25519");
const key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const s = m1.signPurpose("claudestra-shared-ledger-v1", ["a"], key);
console.log(JSON.stringify({ ok: m1.verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", ["a"], s.sig), json: m0.canonicalJson({ b: 1, a: [null] }) }));`;
      const proc = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: tmp, env: testChildEnv({ HOME: home, TMPDIR: tmp }) });
      expect(proc.stderr.toString()).toBe("");
      expect(JSON.parse(proc.stdout.toString())).toEqual({ ok: true, json: `{"a":[null],"b":1}` });
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * codex app-server 的 schema 锁（tests/fixtures/codex-app-server/）。只跑离线子命令 `generate-json-schema --experimental`，
 * 每次 mkdtemp 一个空目录当 CODEX_HOME 和 HOME，环境只给 PATH，碰不到 ~/.codex 和任何凭据。产出：
 *   inbound.json 入站投影；outbound.json 出站请求参数 / 反向回包的完整 $ref 闭包 + 我们发的字段的投影；
 *   methods.json method ↔ 定义名与全部通知 / 反向请求 method；lock.json CLI 版本、哈希、全量指纹。
 * 用法：bun scripts/codex-schema/lock.ts [--cli <codex>] [--out <dir>] [--check]（--check 只在临时目录生成，按 drift.ts 和已提交的锁分级）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { USED } from "../../src/lib/acp/codex-adapter/protocol.ts";
import { nativeCodexCandidates } from "../../src/lib/codex-launch.ts";
import { classify, type LockSet, methodProblems, type Methods } from "./drift.ts";
import { canon, compat, type Defs, oursPaths, project, type Projection, sortKeys } from "./project.ts";

const FIXTURE_DIR = join(import.meta.dir, "../../tests/fixtures/codex-app-server");
const FLAGS = ["--experimental"];
const PROVENANCE = "由 codex-cli 的 `app-server generate-json-schema` 产物（openai/codex，Apache-2.0）投影、摘录而来；生成器见 generator";
const CLOSED = new Set(USED.closed);
type Root = [def: string, schema: z.ZodType];

const inboundRoots = (): Root[] => [
  ...Object.values(USED.client).map((e): Root => [e.result.def, e.result.schema]),
  ...Object.values(USED.server).map((e): Root => [e.params.def, e.params.schema]),
  ...Object.values(USED.notifications).map((e): Root => [e.params.def, e.params.schema]),
  ...Object.entries(USED.extraInbound),
];
const outboundRoots = (): [method: string, ...Root][] => [
  ...Object.entries(USED.client).map(([m, e]): [string, ...Root] => [m, e.params.def, e.params.schema]),
  ...Object.entries(USED.server).map(([m, e]): [string, ...Root] => [m, e.result.def, e.result.schema]),
];

/** 入站看我们收什么（io:input），出站看我们发出去的是什么（io:output） */
function projectAll(defs: Defs, roots: Root[], io: "input" | "output"): Projection {
  const out: Projection = {};
  for (const [def, schema] of roots) {
    if (out[def]) throw new Error(`${def} 在 USED 里登记了两次，投影会互相覆盖`);
    out[def] = project(defs, def, z.toJSONSchema(schema, { io }), CLOSED);
  }
  return sortKeys(out);
}

const buildInbound = (defs: Defs): Projection => projectAll(defs, inboundRoots(), "input");

/**
 * 离线对照用：codex 一侧照锁里记的，「我们」一侧换成当前 IN 重新算。IN 改了却没重新生成锁，路径集合或兼容性就对不上；
 * 锁里没有的路径记成 missing。
 */
export function overlayInbound(locked: Projection): Projection {
  const out: Projection = {};
  for (const [def, schema] of inboundRoots()) {
    out[def] = {};
    for (const p of oursPaths(z.toJSONSchema(schema, { io: "input" }))) {
      const n = locked[def]?.[p.path];
      if (!n) {
        out[def][p.path] = { missing: true, ours: p.ours };
        continue;
      }
      const { closed: _locked, ...rest } = n;
      out[def][p.path] = { ...rest, ...(n.ref && CLOSED.has(n.ref) ? { closed: true as const } : {}), ours: p.ours };
    }
  }
  return out;
}

/** 从这些根出发的完整 $ref 闭包（规范化后原样保存，包括描述文字） */
function closure(defs: Defs, roots: string[]): Defs {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    if (defs[name] === undefined) throw new Error(`schema 里找不到定义 ${name}`);
    seen.add(name);
    for (const m of JSON.stringify(defs[name]).matchAll(/"\$ref":"#\/definitions\/([^"]+)"/g)) queue.push(m[1]!);
  }
  return Object.fromEntries([...seen].sort().map((n) => [n, sortKeys(defs[n])]));
}

/** 出站：闭包 + 在闭包上算的投影。测试改了闭包里的定义后也用它重算投影，和换了新 CLI 重新生成是同一条路 */
export function buildOutbound(defs: Defs): LockSet["outbound"] {
  const roots = outboundRoots();
  const closureDefs = closure(defs, roots.map((r) => r[1]));
  return { roots: Object.fromEntries(roots.map(([m, d]) => [m, d])), defs: closureDefs, sends: projectAll(closureDefs, roots.map(([, d, s]) => [d, s]), "output") };
}

const refName = (ref: string) => ref.replace(/^#\/definitions\//, "");
function methodTable(defs: Defs, union: string): Map<string, string | null> {
  const rows: any[] = defs[union]?.oneOf ?? [];
  return new Map(rows.map((o) => [o.properties.method.enum[0], o.properties.params?.$ref ? refName(o.properties.params.$ref) : null]));
}

function buildMethods(defs: Defs): Methods {
  const [cr, sr, sn, cn] = [methodTable(defs, "ClientRequest"), methodTable(defs, "ServerRequest"), methodTable(defs, "ServerNotification"), methodTable(defs, "ClientNotification")];
  const row = (t: Map<string, string | null>, m: string, params: string, result?: string) => ({
    params,
    schemaParams: t.get(m) ?? null,
    ...(result ? { result, resultExists: defs[result] !== undefined } : {}),
  });
  return {
    client: Object.fromEntries(Object.entries(USED.client).map(([m, e]) => [m, row(cr, m, e.params.def, e.result.def)])),
    server: Object.fromEntries(Object.entries(USED.server).map(([m, e]) => [m, row(sr, m, e.params.def, e.result.def)])),
    notifications: Object.fromEntries(Object.entries(USED.notifications).map(([m, e]) => [m, row(sn, m, e.params.def)])),
    clientNotifications: Object.fromEntries(USED.clientNotifications.map((m) => [m, cn.has(m)])),
    allNotifications: [...sn.keys()].sort(),
    allServerRequests: [...sr.keys()].sort(),
  };
}

/** bundle 的 definitions 摊平成一层：顶层定义原名，v2 命名空间下的叫 `v2/<名字>`（和 $ref 的路径一致） */
function flattenDefs(bundle: any): Defs {
  const out: Defs = {};
  for (const [k, v] of Object.entries<any>(bundle.definitions ?? {})) {
    if (/^v\d+$/.test(k) && !v.type && !v.properties && !v.oneOf) for (const [k2, v2] of Object.entries(v)) out[`${k}/${k2}`] = v2;
    else out[k] = v;
  }
  return out;
}

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function buildLockSet(defs: Defs, meta: { cliVersion: string; cliSha256: unknown; schemaFullSha256: string }): LockSet {
  const inbound = buildInbound(defs);
  const outbound = buildOutbound(defs);
  const methods = buildMethods(defs);
  const files = { "inbound.json": sha(canon(inbound)), "outbound.json": sha(canon(outbound)), "methods.json": sha(canon(methods)) };
  const outboundClosure = { defs: Object.keys(outbound.defs).length, bytes: canon(outbound.defs).length };
  return { lock: { generator: "scripts/codex-schema/lock.ts", provenance: PROVENANCE, ...meta, flags: FLAGS, files, outboundClosure }, inbound, outbound, methods };
}

/** 一份锁能不能提交：入站 / 出站投影都兼容，method 表自洽 */
export const lockProblems = (s: LockSet): string[] => [...compat(s.inbound, "in"), ...compat(s.outbound.sends, "out"), ...methodProblems(s.methods)];

/** 产物目录的全量指纹：按相对路径排序，逐个喂「路径 \0 键排序后的紧凑 JSON \0」 */
function fullSha(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (p: string) => files.push(p))(join(d, e.name));
  };
  walk(dir);
  const h = createHash("sha256");
  for (const rel of files.map((f) => relative(dir, f)).sort()) h.update(`${rel}\0${canon(JSON.parse(readFileSync(join(dir, rel), "utf8")))}\0`);
  return h.digest("hex");
}

/** CLI 入口文件（realpath）和 npm 壳背后的原生二进制各自的 sha256；只记哈希，不记本机路径 */
function cliHashes(cli: string): { platform: string; entry: string; native: string | null } {
  const entry = realpathSync(Bun.which(cli) ?? cli);
  const native = nativeCodexCandidates(entry).find((p) => existsSync(p)) ?? null;
  return { platform: `${process.platform}-${process.arch}`, entry: sha(readFileSync(entry)), native: native ? sha(readFileSync(native)) : null };
}

function run(cmd: string[], env: Record<string, string>): string {
  const p = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} 失败（exit ${p.exitCode}）：${p.stderr.toString().slice(-400)}`);
  return p.stdout.toString();
}

/** 用指定的 codex 生成一份锁（不落盘）。临时目录用完就删 */
export function generateLockSet(cli: string): LockSet {
  const home = mkdtempSync(join(tmpdir(), "codex-schema-home-"));
  const out = mkdtempSync(join(tmpdir(), "codex-schema-out-"));
  try {
    const env = { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home };
    const cliVersion = run([cli, "--version"], env).trim().replace(/^codex-cli\s+/, "");
    run([cli, "app-server", "generate-json-schema", ...FLAGS, "--out", out], env);
    const bundle = JSON.parse(readFileSync(join(out, "codex_app_server_protocol.schemas.json"), "utf8"));
    return buildLockSet(flattenDefs(bundle), { cliVersion, cliSha256: cliHashes(cli), schemaFullSha256: fullSha(out) });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

const PARTS = { lock: "lock.json", inbound: "inbound.json", outbound: "outbound.json", methods: "methods.json" } as const;

export function readLockSet(dir = FIXTURE_DIR): LockSet {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  return { lock: read(PARTS.lock), inbound: read(PARTS.inbound), outbound: read(PARTS.outbound), methods: read(PARTS.methods) };
}

function writeLockSet(dir: string, s: LockSet): void {
  mkdirSync(dir, { recursive: true });
  for (const [k, f] of Object.entries(PARTS)) writeFileSync(join(dir, f), `${JSON.stringify(sortKeys(s[k as keyof LockSet]), null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const say = (s: string) => void process.stdout.write(`${s}\n`);
  const set = generateLockSet(arg("--cli") ?? process.env.CODEX_SCHEMA_CLI ?? "codex");
  if (argv.includes("--check")) {
    const r = classify(readLockSet(arg("--out")), set);
    for (const f of r.findings) say(`[${f.level}] ${f.where}：${f.why}`);
    say(`漂移等级：${r.level}（新 CLI ${set.lock.cliVersion}）`);
    return r.level === "red" ? 1 : 0;
  }
  const problems = lockProblems(set);
  if (problems.length) {
    for (const p of problems) say(`不兼容：${p}`);
    say("protocol.ts 和这版 schema 对不上，锁文件没写；先改 protocol.ts");
    return 1;
  }
  writeLockSet(arg("--out") ?? FIXTURE_DIR, set);
  say(`已写入锁文件：codex-cli ${set.lock.cliVersion}，schemaFullSha256 ${set.lock.schemaFullSha256}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

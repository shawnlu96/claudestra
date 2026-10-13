/**
 * CI 实测读取图的记录器（merge-arch-SELECT2）：环境变量 CI_IO_TRACE=<输出文件> 设了才装，不设 = 什么都不碰。装上后记下仓库内模块
 * 实际读了 / 扫了 / 起进程跑了仓库里的哪些文件，每条一行 JSONL {module, kind: read|walk|spawn, path}，同进程去重、追加写（多进程共用
 * 一个文件，单行一次 write）。scripts/ci-io-map.ts 把各片的输出合成 io-map.json，SELECT3 拿它代替手工登记的 IMPLICIT_INPUTS。
 * 记的调用：node:fs 同步 / 回调 / promises 三套读类与目录类 API，Bun.file，Bun.Glob 的 scan / scanSync，Bun.spawn / spawnSync 与
 * child_process（argv 里落在仓库内的文件记 spawn；cwd 在仓库内的 git 记该目录的 walk）。只记仓库根之内的路径（先 realpath 再判断），
 * .git/、node_modules/、临时目录一律不记；判断在取调用栈之前。归属：调用栈里每个仓库模块帧（滤掉本文件）各记一条——bun test 同进程
 * 共享模块缓存，按模块归属，SELECT3 再用静态依赖闭包推到测试。
 * 装的时机同 src/lib/sync-fs-trace.ts 文件头：bun 的 ESM 对内置模块的具名导入在链接时绑死，所以本文件不能静态 import node:fs /
 * node:child_process，装的入口（tests/preload.ts、sync-fs-trace.ts 的顶层 preload）也不能先静态导入它们。tests/ci-io-trace.test.ts。
 */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IO_TRACE_ENV = "CI_IO_TRACE";
type IoKind = "read" | "walk" | "spawn";
export interface IoRecord { module: string; kind: IoKind; path: string }

const INSTALLED = Symbol.for("claudestra.ciIoTrace");
const SELF = fileURLToPath(import.meta.url);
const STACK_LIMIT = 100;
const MODULE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const FS_READ = ["readFile", "readFileSync", "open", "openSync", "stat", "statSync", "lstat", "lstatSync", "exists", "existsSync", "access",
  "accessSync", "realpath", "realpathSync", "readlink", "readlinkSync", "createReadStream", "openAsBlob"] as const;
const FS_WALK = ["readdir", "readdirSync", "opendir", "opendirSync"] as const;
const FSP_READ = ["readFile", "open", "stat", "lstat", "access", "realpath", "readlink"] as const;
const FSP_WALK = ["readdir", "opendir"] as const;
const CP = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

type Obj = Record<string, unknown>;
export interface IoTraceDeps {
  /** the node:fs module object (its functions get replaced) */
  fs: Obj;
  /** node:fs/promises */
  fsp: Obj;
  /** node:child_process */
  cp: Obj;
  /** holder of file / spawn / spawnSync (the Bun global) */
  bun: Obj;
  /** Bun.Glob.prototype (scan / scanSync) */
  glob: Obj;
  /** repo root (absolute) */
  root: string;
  /** one JSONL line, newline included */
  write: (line: string) => void;
  /** untraced originals the recorder uses itself */
  realpath: (p: string) => string;
  isFile: (p: string) => boolean;
}

/** Repo-relative POSIX path of an absolute one ("." for the root), or null when it is outside or under .git / node_modules. */
function inRepo(roots: readonly string[], abs: string): string | null {
  for (const root of roots) {
    if (!under(abs, root)) continue;
    const rel = relative(root, abs);
    if (rel === "") return ".";
    const parts = rel.split(sep);
    if (parts.includes(".git") || parts.includes("node_modules")) return null;
    return parts.join("/");
  }
  return null;
}

function tempRoots(): string[] {
  const out = [tmpdir(), process.env.RUNNER_TEMP ?? "", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  return out.filter((x) => x.length > 1);
}
const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** A path argument (string / Buffer / URL) → absolute path; fds, FileHandles, Blobs → null. */
function pathArg(x: unknown, cwd: string): string | null {
  let s: string;
  if (typeof x === "string") s = x;
  else if (x instanceof URL) { if (x.protocol !== "file:") return null; s = fileURLToPath(x); }
  else if (x instanceof Uint8Array) s = new TextDecoder().decode(x);
  else return null;
  if (!s || s.includes("\0")) return null;
  return resolve(cwd, s);
}

interface Spawn { argv: string[]; cwd: string }
const strs = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
const cwdOf = (o: unknown): string => {
  const c = o && typeof o === "object" ? (o as { cwd?: unknown }).cwd : undefined;
  return typeof c === "string" ? resolve(c) : c instanceof URL ? fileURLToPath(c) : process.cwd();
};

/** Every child_process / Bun.spawn call shape → argv and cwd. */
function spawnShape(api: string, args: unknown[]): Spawn {
  if (api === "bun") {
    const [a, b] = args;
    if (Array.isArray(a)) return { argv: strs(a), cwd: cwdOf(b) };
    return { argv: strs((a as { cmd?: unknown } | undefined)?.cmd), cwd: cwdOf(a) };
  }
  const [file, rest, more] = args;
  if (api === "exec" || api === "execSync") return { argv: String(file ?? "").split(/\s+/).filter(Boolean), cwd: cwdOf(rest) };
  const list = Array.isArray(rest) ? strs(rest) : [];
  const opts = Array.isArray(rest) ? more : rest;
  const head = typeof file === "string" ? [file] : [];
  return { argv: api === "fork" ? [process.execPath, ...head, ...list] : [...head, ...list], cwd: cwdOf(opts) };
}

interface IoTracer {
  /** records one touched path against every repo module frame on the current stack */
  note: (kind: IoKind, abs: string) => void;
  spawned: (s: Spawn) => void;
}

function createTracer(d: Pick<IoTraceDeps, "root" | "write" | "realpath" | "isFile">): IoTracer {
  const roots = [...new Set([d.root, safe(() => d.realpath(d.root)) ?? d.root])];
  const seen = new Set<string>(), real = new Map<string, string | null>();
  let busy = false;
  const realish = (abs: string): string => {
    const hit = real.get(abs);
    if (hit !== undefined) return hit ?? abs;
    let out = safe(() => d.realpath(abs));
    if (out === null) { const parent = dirname(abs); out = parent === abs ? abs : join(realish(parent), basename(abs)); }
    real.set(abs, out);
    return out;
  };
  const target = (abs: string): string | null => {
    // a temp dir that holds the repo itself (a clone under /tmp) does not hide the repo
    const temps = tempRoots().filter((t) => !roots.some((r) => under(r, t)));
    if (temps.some((t) => under(abs, t))) return null; // the hot path: tests' own temp files, before any realpath
    const r = realish(abs);
    return temps.some((t) => under(r, t)) ? null : inRepo(roots, r);
  };
  const modules = (): string[] => {
    const prev = Error.stackTraceLimit;
    Error.stackTraceLimit = STACK_LIMIT;
    const stack = new Error().stack ?? "";
    Error.stackTraceLimit = prev;
    const out = new Set<string>();
    for (const line of stack.split("\n").slice(1)) {
      const m = /\(?((?:file:\/\/)?\/[^()]*?):\d+(?::\d+)?\)?\s*$/.exec(line.trim());
      if (!m) continue;
      const file = m[1]!.startsWith("file://") ? fileURLToPath(m[1]!) : m[1]!;
      if (file === SELF || !MODULE_EXT.test(file)) continue;
      const rel = inRepo(roots, file);
      if (rel && rel !== ".") out.add(rel);
    }
    return [...out];
  };
  const emit = (kind: IoKind, path: string) => {
    for (const module of modules()) {
      const key = `${module}\0${kind}\0${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      d.write(`${JSON.stringify({ module, kind, path } satisfies IoRecord)}\n`);
    }
  };
  const guarded = (fn: () => void) => {
    if (busy) return;
    busy = true;
    try { fn(); } catch { /* recording never breaks the call it watches */ } finally { busy = false; }
  };
  return {
    note: (kind, abs) => guarded(() => { const p = target(abs); if (p) emit(kind, p); }),
    spawned: (s) => guarded(() => {
      const exe = basename(s.argv[0] ?? "");
      if (exe === "git") { const p = target(s.cwd); if (p) emit("walk", p); }
      for (const a of s.argv.slice(exe === "git" ? 1 : 0)) {
        if (a.startsWith("-") || a.includes("\0")) continue;
        const abs = resolve(s.cwd, a), p = target(abs);
        if (p && p !== "." && d.isFile(abs)) emit("spawn", p);
      }
    }),
  };
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

/**
 * Replaces holder[name] by a Proxy that calls before() first. The function's own props (promisify.custom …) stay reachable; over
 * replaces some of them (realpathSync.native) without writing to the shared original.
 */
function wrap(holder: Obj, name: string, before: (args: unknown[]) => void, over?: Obj): void {
  const fn = holder[name];
  if (typeof fn !== "function") return;
  const proxy = new Proxy(fn, {
    apply(t, self, args) { before(args); return Reflect.apply(t, self, args); },
    construct(t, args, nt) { before(args); return Reflect.construct(t, args, nt); },
    get(t, p, r) { return over && Object.hasOwn(over, p) ? over[p as string] : Reflect.get(t, p, r); },
  });
  try { holder[name] = proxy; } catch { /* a frozen export stays untraced */ }
}

function patch(d: IoTraceDeps, t: IoTracer): void {
  const path = (kind: IoKind) => (args: unknown[]) => { const abs = pathArg(args[0], process.cwd()); if (abs) t.note(kind, abs); };
  for (const k of FS_READ) {
    const native = (d.fs[k] as Obj | undefined)?.native, over: Obj = {};
    if (typeof native === "function") wrap(Object.assign(over, { native }), "native", path("read"));
    wrap(d.fs, k, path("read"), Object.keys(over).length ? over : undefined);
  }
  for (const k of FS_WALK) wrap(d.fs, k, path("walk"));
  for (const k of FSP_READ) wrap(d.fsp, k, path("read"));
  for (const k of FSP_WALK) wrap(d.fsp, k, path("walk"));
  for (const k of CP) wrap(d.cp, k, (args) => t.spawned(spawnShape(k, args)));
  wrap(d.bun, "spawn", (args) => t.spawned(spawnShape("bun", args)));
  wrap(d.bun, "spawnSync", (args) => t.spawned(spawnShape("bun", args)));
  wrap(d.bun, "file", path("read"));
  for (const k of ["scan", "scanSync"]) {
    wrap(d.glob, k, (args) => {
      const a = args[0], cwd = typeof a === "string" ? a : (a as { cwd?: unknown } | undefined)?.cwd;
      t.note("walk", typeof cwd === "string" ? resolve(cwd) : process.cwd());
    });
  }
}

function defaultDeps(out: string): IoTraceDeps {
  const req = createRequire(import.meta.url);
  const fs = req("node:fs") as Obj & typeof import("node:fs");
  const realpath = fs.realpathSync.bind(fs), statSync = fs.statSync.bind(fs), writeSync = fs.writeSync.bind(fs);
  fs.mkdirSync(dirname(out), { recursive: true });
  const fd = fs.openSync(out, "a");
  const root = resolve(dirname(SELF), "..", "..");
  return { fs, fsp: req("node:fs/promises") as Obj, cp: req("node:child_process") as Obj, bun: Bun as unknown as Obj,
    glob: Bun.Glob.prototype as unknown as Obj, root, write: (line) => { writeSync(fd, line); }, realpath,
    isFile: (p) => safe(() => statSync(p).isFile()) === true };
}

/** CI_IO_TRACE 没设返回 false、什么都不碰；deps 是测试接缝（不传 = 改本进程真的 node:fs 等，只装一次）。 */
export function installCiIoTrace(env: Record<string, string | undefined> = process.env, deps?: IoTraceDeps): boolean {
  const out = env[IO_TRACE_ENV];
  if (!out) return false;
  const g = globalThis as Record<symbol, unknown>;
  if (!deps) {
    if (g[INSTALLED]) return false; // tests/preload.ts 与 sync-fs-trace.ts 各进来一次
    g[INSTALLED] = true;
  }
  let d = deps;
  try { d ??= defaultDeps(resolve(out)); } catch (e) {
    // 打不开输出文件只是这次没有记录，不能让装它的 preload 把所有测试 / 子进程带崩
    console.warn(`[ci-io-trace] 打不开 ${out}，本进程不记录：${(e as Error).message}`);
    return false;
  }
  patch(d, createTracer(d));
  return true;
}

/**
 * 诊断开关 CLAUDESTRA_SYNC_FS_TRACE=1：node:fs 常用同步 API 与 bun:sqlite 的 new Database 单次 ≥1s 打一行（路径 / 耗时 / 栈前 12 帧），
 * 事件循环每 500ms 打点、偏差 >2s 记一行。不设 = 什么都不装。子进程会继承开关（bun 默认 spawn 用启动时的环境，改 process.env 管不到），
 * 仓库根目录下起的 `bun <file>` 子进程（manager 等）也各自追踪、写进各自的 stderr。装的时机：bun 里 ESM 对内置模块的具名导入在模块图
 * 链接时就绑死了函数，入口里再 patch 已晚，所以 bunfig.toml 顶层 preload 本文件（bun test 不吃）；bridge.ts 首行 import 是兜底（只剩卡顿
 * 监视 + CJS / 动态 import）。本文件不能静态 import node:fs / bun:sqlite，否则 preload 自己先把它们绑死。验证：tests/sync-fs-trace.test.ts。
 */
import { createRequire } from "node:module";

const FLAG = "CLAUDESTRA_SYNC_FS_TRACE";
const SLOW_MS = 1000;
const LAG_EVERY_MS = 500;
const LAG_WARN_MS = 2000;
const STACK_FRAMES = 12;
const FS_SYNC = [
  "openSync", "readFileSync", "writeFileSync", "appendFileSync", "statSync", "lstatSync", "readdirSync", "existsSync", "accessSync",
  "mkdirSync", "renameSync", "rmSync", "unlinkSync", "copyFileSync", "cpSync", "chmodSync", "readlinkSync", "realpathSync", "opendirSync",
] as const;
const INSTALLED = Symbol.for("claudestra.syncFsTrace");
const SELF = import.meta.path; // 栈里滤掉本文件自己的帧（代理陷阱 / report）

export interface TraceDeps {
  fs: Record<string, unknown>;
  sqlite: Record<string, unknown>;
  warn: (line: string) => void;
  now: () => number;
  every: (fn: () => void, ms: number) => void;
}

function describeTarget(x: unknown): string {
  if (typeof x === "number") return `fd ${x}`;
  const s = String(x ?? "");
  return JSON.stringify(s.length > 300 ? `${s.slice(0, 300)}…` : s);
}

function callerStack(): string {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES + 8;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = prev;
  const frames = stack.split("\n").slice(1).map((l) => l.trim()).filter((l) => l && l !== "at unknown" && !l.includes(SELF));
  return frames.slice(0, STACK_FRAMES).join(" ← ");
}

let reporting = false; // warn 自己可能走同步写：报告途中再慢也不再报，免得递归

function traced<T extends object>(name: string, target: T, d: TraceDeps): T {
  const report = (t0: number, args: unknown[]) => {
    const ms = d.now() - t0;
    if (ms < SLOW_MS || reporting) return;
    reporting = true;
    try {
      d.warn(`⏱ [sync-fs-trace] ${name}(${describeTarget(args[0])}) ${Math.round(ms)}ms @ ${callerStack()}`);
    } finally {
      reporting = false;
    }
  };
  return new Proxy(target, {
    apply(t, self, args) {
      const t0 = d.now();
      try { return Reflect.apply(t as (...a: unknown[]) => unknown, self, args); } finally { report(t0, args); }
    },
    construct(t, args, newTarget) {
      const t0 = d.now();
      try { return Reflect.construct(t as new (...a: unknown[]) => object, args, newTarget); } finally { report(t0, args); }
    },
  });
}

function watchLag(d: TraceDeps): void {
  let last = d.now();
  d.every(() => {
    const now = d.now();
    const lag = now - last - LAG_EVERY_MS;
    last = now;
    if (lag > LAG_WARN_MS) d.warn(`⏱ [sync-fs-trace] 事件循环卡了 ${Math.round(lag)}ms（每 ${LAG_EVERY_MS}ms 打点）`);
  }, LAG_EVERY_MS);
}

function defaultDeps(): TraceDeps {
  const req = createRequire(import.meta.url);
  const every = (fn: () => void, ms: number) => { setInterval(fn, ms).unref(); };
  return { fs: req("node:fs"), sqlite: req("bun:sqlite"), warn: (line) => console.warn(line), now: () => performance.now(), every };
}

/** 开关没开返回 false、什么都不碰；deps 是测试接缝（不传 = 改本进程真的 node:fs / bun:sqlite，只装一次） */
export function installSyncFsTrace(env: Record<string, string | undefined> = process.env, deps?: TraceDeps): boolean {
  if (env[FLAG] !== "1") return false;
  const g = globalThis as Record<symbol, unknown>;
  if (!deps) {
    if (g[INSTALLED]) return false; // preload 和 bridge.ts 首行各进来一次
    g[INSTALLED] = true;
  }
  const d = deps ?? defaultDeps();
  const nativeRealpath = (d.fs.realpathSync as { native?: object } | undefined)?.native;
  for (const k of FS_SYNC) if (typeof d.fs[k] === "function") d.fs[k] = traced(k, d.fs[k] as object, d);
  if (nativeRealpath) (d.fs.realpathSync as { native?: object }).native = traced("realpathSync.native", nativeRealpath, d);
  if (typeof d.sqlite.Database === "function") d.sqlite.Database = traced("new Database", d.sqlite.Database as object, d);
  watchLag(d);
  const who = `pid ${process.pid} ${process.argv[1] ?? "?"}`;
  d.warn(`⏱ [sync-fs-trace] 已开启（${who}）：同步 fs / new Database 单次 ≥${SLOW_MS}ms、事件循环卡顿 >${LAG_WARN_MS}ms 记一行；子进程会继承本开关`);
  return true;
}

installSyncFsTrace();

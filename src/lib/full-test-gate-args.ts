/**
 * 全量 bun test 的判定（docs/architecture/full-test-gate.md）：没有位置参数（测试文件 / 路径过滤）= 全量。
 * 选项的取值（`--timeout 10000`、`-t name`）不是位置参数；认不出的选项直接报错，不猜——猜错一边是漏闸，另一边是把带文件的调用排队。
 * 本文件不碰 node:fs（静态导入）：tests/preload.ts 在 CI_IO_TRACE 记录器装好之前不许链接 node:fs 的具名绑定。
 * tests/full-test-gate.test.ts。
 */

/** 经闸放行的 bun test 子进程带的标记（许可 ID 或放行原因）：tests/preload.ts 认出它就不再申请，不双占 */
export const FULL_TEST_PERMIT_ENV = "CLAUDESTRA_FULL_TEST_PERMIT";

/** 后面必须跟一个值（`--x=v` 或下一个词） */
const VALUE_OPTIONS = new Set([
  "--timeout", "--rerun-each", "--retry", "--seed", "--coverage-reporter", "--coverage-dir", "-t", "--test-name-pattern", "--reporter",
  "--reporter-outfile", "--max-concurrency", "--path-ignore-patterns", "--shard", "--parallel-delay",
  "--preload", "-r", "--env-file", "--config", "-c", "--cwd", "--tsconfig-override", "--conditions",
]);
/** 值可省：只认 `--x=v`，裸写时下一个词照 bun 的规矩算位置参数 */
const OPTIONAL_VALUE_OPTIONS = new Set(["--bail", "--changed", "--parallel"]);
const FLAG_OPTIONS = new Set([
  "--no-orphans", "-u", "--update-snapshots", "--todo", "--only", "--pass-with-no-tests", "--concurrent", "--randomize", "--coverage",
  "--dots", "--only-failures", "--isolate", "--watch", "--hot", "--no-clear-screen", "--smol", "--silent", "--no-env-file", "--bun",
  "--test-worker",
]);

export type BunTestRun =
  | { kind: "full"; args: string[] }
  | { kind: "focused"; args: string[] }
  /** --parallel 的工作进程：父进程已经过准入 */
  | { kind: "worker"; args: string[] }
  | { kind: "error"; message: string };

/** `bun test` 之后的参数（scripts/test.ts 收到的就是这些） */
export function classifyTestArgs(args: readonly string[]): BunTestRun {
  let positional = false;
  let worker = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) { positional = true; continue; }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_OPTIONS.has(name)) {
      if (eq > 0) continue;
      if (i + 1 >= args.length) return { kind: "error", message: `${a} 缺少取值` };
      i++;
    } else if (OPTIONAL_VALUE_OPTIONS.has(name)) continue;
    else if (FLAG_OPTIONS.has(name) && eq < 0) worker ||= name === "--test-worker";
    else return { kind: "error", message: `认不出的 bun test 参数 ${JSON.stringify(a)}（不猜它是选项还是文件）` };
  }
  const rest = [...args];
  return worker ? { kind: "worker", args: rest } : { kind: positional ? "focused" : "full", args: rest };
}

/** 整条命令行（argv[0] 是 bun 本身）：`test` 之前只许出现选项，`test` 之后同 classifyTestArgs；去掉 `test` 后的参数原样保留 */
export function classifyBunArgv(argv: readonly string[]): BunTestRun {
  const tokens = argv.slice(1);
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a === "test") {
      const before = classifyTestArgs(tokens.slice(0, i));
      if (before.kind === "error") return before;
      return classifyTestArgs([...tokens.slice(0, i), ...tokens.slice(i + 1)]);
    }
    if (!a.startsWith("-")) return { kind: "error", message: `命令行不是 bun test：${JSON.stringify(a)}` };
    if (VALUE_OPTIONS.has(a)) i++;
  }
  return { kind: "error", message: "命令行里没有 test 子命令" };
}

export function isCiEnv(env: Record<string, string | undefined>): boolean {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}

/**
 * 本进程的原始命令行。preload 里 process.argv 已被 bun test 改写成首个测试文件，看不出调用者带没带文件；
 * Linux 读 /proc/self/cmdline，macOS 用 sysctl(KERN_PROCARGS2)，两者都是内核记的逐词原样。读不出返回 null。
 */
export async function readOwnArgv(platform = process.platform): Promise<string[] | null> {
  try {
    if (platform === "linux") {
      const { readFileSync } = await import("node:fs");
      const parts = readFileSync("/proc/self/cmdline", "utf8").split("\0");
      if (parts.at(-1) === "") parts.pop();
      return parts.length ? parts : null;
    }
    if (platform === "darwin") return await darwinArgv(process.pid);
  } catch (e) {
    console.error(`[full-test-gate] 读不出本进程命令行：${String(e)}`);
  }
  return null;
}

async function darwinArgv(pid: number): Promise<string[] | null> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  try {
    const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2
    const size = new BigUint64Array([0n]);
    if (lib.symbols.sysctl(ptr(mib), 3, null, ptr(size), null, 0) !== 0 || size[0] === 0n) return null;
    const buf = new Uint8Array(Number(size[0]));
    if (lib.symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null, 0) !== 0) return null;
    // 布局：int32 argc，可执行文件路径，若干 NUL 填充，然后 argc 个以 NUL 结尾的参数
    const argc = new DataView(buf.buffer).getInt32(0, true);
    const end = Number(size[0]);
    let i = 4;
    while (i < end && buf[i] !== 0) i++;
    while (i < end && buf[i] === 0) i++;
    const out: string[] = [];
    const decoder = new TextDecoder();
    for (let k = 0; k < argc && i < end; k++) {
      let j = i;
      while (j < end && buf[j] !== 0) j++;
      out.push(decoder.decode(buf.subarray(i, j)));
      i = j + 1;
    }
    return out.length === argc ? out : null;
  } finally {
    lib.close();
  }
}

// merge-arch-TMPLEAK2：测试跑完系统临时目录顶层不许留东西。在新建的空目录当 TMPDIR 跑 bun test（参数原样透传，可只跑部分文件），
// 跑完该目录顶层必须为空（tests/test-tmp-root.ts 的运行临时根自己会删），否则按前缀列出残留、非零退出。
//   bun scripts/test-tmp-leak.ts [bun test 参数...]   新建检查目录 → 跑 → 查 → 删掉检查目录本身（--keep 留着排查）
//   bun scripts/test-tmp-leak.ts --check <dir>          只查已跑完的目录（CI：单元测试那一步已把 TMPDIR 指到它），不跑、不删
// 只删自己 mkdtemp 出来的那一个检查目录（rmSync 不跟随里面的软链），检查目录以外的东西一概不碰。
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** mkdtemp 的随机尾巴去掉，按前缀归并：`cstra-test-state-AbC123` → `cstra-test-state-` */
export const leakPrefix = (name: string): string => /^(.*[-_.])[^-_.]+$/.exec(name)?.[1] ?? name;

export function leftovers(dir: string): Map<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const name of readdirSync(dir).sort()) {
    const key = leakPrefix(name);
    byPrefix.set(key, [...(byPrefix.get(key) ?? []), name]);
  }
  return byPrefix;
}

/** 残留数；有残留时按前缀计数打到 stderr */
export function report(dir: string): number {
  const byPrefix = leftovers(dir);
  const total = [...byPrefix.values()].reduce((n, names) => n + names.length, 0);
  if (total === 0) {
    console.error(`[test-tmp-leak] ${dir} 顶层为空`);
    return 0;
  }
  console.error(`[test-tmp-leak] ${dir} 顶层留下 ${total} 项（测试或其子进程往启动时的 TMPDIR 写了东西没删）：`);
  for (const [prefix, names] of [...byPrefix].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    console.error(`  ${String(names.length).padStart(5)}  ${prefix}*   例：${names[0]}`);
  }
  return total;
}

const RUN_ROOT_OWNER = /^cstra-test-run-(\d+)-/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 没 preload 的 runner 的运行临时根由看门子进程在 runner 退出后删（src/lib/test-guard.ts 的 reapOnExit），比 runner 晚几毫秒：
 * 属主已退出的根最多等 waitMs 再查，超时还在就照常算残留。属主还活着的根、其他前缀不等。
 */
export async function settle(dir: string, waitMs = 5_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  const pending = () => readdirSync(dir).some((name) => {
    const pid = Number(RUN_ROOT_OWNER.exec(name)?.[1]);
    return pid > 0 && !alive(pid);
  });
  while (pending() && Date.now() < deadline) await Bun.sleep(50);
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--check") {
    if (!argv[1]) throw new Error("用法：--check <dir>");
    await settle(argv[1]);
    return report(argv[1]) === 0 ? 0 : 1;
  }
  const keep = argv[0] === "--keep";
  const args = keep ? argv.slice(1) : argv;
  // realpath：macOS 的 /var/folders 是软链，preload 也按 realpath 建运行临时根
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cstra-tmpleak-")));
  try {
    const proc = Bun.spawn([process.execPath, "test", ...args], {
      env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    await settle(dir);
    const leaked = report(dir);
    if (code !== 0) console.error(`[test-tmp-leak] bun test 退出码 ${code}`);
    return leaked > 0 ? 1 : code;
  } finally {
    if (keep) console.error(`[test-tmp-leak] 检查目录保留在 ${dir}`);
    else rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

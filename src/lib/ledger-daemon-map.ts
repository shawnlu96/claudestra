/**
 * 改了哪个文件要重启哪个 daemon：按三个 launchd 入口（bridge / cron / launcher）的静态 import 闭包判，
 * 不按目录前缀猜——src/lib 里的文件 cron、launcher 也会加载，只映射到 bridge 会漏掉它们的重启。
 * 只认相对路径的 import / export from / import()（包名不属于本仓库）；type-only import 也算进来，宁可多要求一次重启。
 * 纯函数加注入的读文件（tests/ledger-daemon-map.test.ts）。
 */
import { dirname, join, normalize } from "node:path";
import type { Daemon } from "./ledger-probes.js";

const DAEMON_ENTRIES: Record<Daemon, string> = {
  bridge: "src/bridge.ts", cron: "src/cron.ts", scheduler: "src/scheduler.ts", launcher: "src/launcher.ts",
};

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

export function relativeSpecs(src: string): string[] {
  return [...src.matchAll(SPEC_RE)].map((m) => m[1]);
}

/** ./x.js → x.ts / x.tsx / x/index.ts（仓库是 TS，import 写 .js 后缀）；都不存在返回 null */
export function resolveSpec(fromFile: string, spec: string, exists: (rel: string) => boolean): string | null {
  const base = normalize(join(dirname(fromFile), spec));
  const stem = base.replace(/\.(js|ts|tsx|mjs)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts")]) {
    if (/\.(ts|tsx)$/.test(c) && exists(c)) return c;
  }
  return null;
}

/** 入口文件的 import 闭包（仓库相对路径，含入口自己） */
export function importClosure(entry: string, read: (rel: string) => string | null): Set<string> {
  const seen = new Set<string>();
  const exists = (rel: string) => read(rel) !== null;
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    const src = read(file);
    if (src === null) continue;
    seen.add(file);
    for (const spec of relativeSpecs(src)) {
      const dep = resolveSpec(file, spec, exists);
      if (dep && !seen.has(dep)) stack.push(dep);
    }
  }
  return seen;
}

export type DaemonsOf = (file: string) => Daemon[];

/** 三个入口各算一次闭包，返回「这个文件归哪些 daemon」；入口读不到（仓库结构变了）就退回保守规则：src/lib 算三个都要重启 */
export function daemonsOfFromRepo(read: (rel: string) => string | null): DaemonsOf {
  const closures = (Object.keys(DAEMON_ENTRIES) as Daemon[]).map((d) => [d, importClosure(DAEMON_ENTRIES[d], read)] as const);
  if (closures.some(([, c]) => c.size === 0)) return conservativeDaemonsOf;
  return (file) => closures.filter(([, c]) => c.has(file)).map(([d]) => d);
}

export const conservativeDaemonsOf: DaemonsOf = (f) => {
  if (f.startsWith("src/lib/")) return ["bridge", "cron", "scheduler", "launcher"];
  if (f === "src/bridge.ts" || f.startsWith("src/bridge/")) return ["bridge"];
  if (f === "src/cron.ts") return ["cron"];
  if (f === "src/scheduler.ts") return ["scheduler"];
  if (f === "src/launcher.ts") return ["launcher"];
  return [];
};

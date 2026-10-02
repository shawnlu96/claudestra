#!/usr/bin/env bun
/**
 * 打印共享台账中心入口（src/shared-ledger.ts）的本地 import 闭包，每行一个相对仓库根的路径，供 deploy.sh 的 rsync --files-from 用。
 * 用 Bun 自己的转译器扫 import，清单随代码走，不手写。闭包里出现 npm 包（非 bun:/node: 内建）就报错退出：
 * 中心目前只靠 bun 内建运行，远端不装 node_modules；以后真要依赖 npm 包，先改部署包。
 * 用法：bun deploy/shared-ledger/closure.ts [入口，默认 src/shared-ledger.ts]
 */
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

function resolveLocal(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}/index.ts`];
  const hit = candidates.find((c) => existsSync(c) && !c.endsWith("/"));
  if (!hit) throw new Error(`无法解析 ${spec}（来自 ${relative(ROOT, from)}）`);
  return hit;
}

export function importClosure(entry: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [resolve(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    for (const { path } of new Bun.Transpiler({ loader }).scanImports(readFileSync(file, "utf8"))) {
      if (path.startsWith("bun:") || isBuiltin(path)) continue;
      if (path.startsWith(".")) queue.push(resolveLocal(file, path));
      else packages.add(path);
    }
  }
  return { files: [...seen].map((f) => relative(ROOT, f)).sort(), packages: [...packages].sort() };
}

if (import.meta.main) {
  const { files, packages } = importClosure(Bun.argv[2] ?? "src/shared-ledger.ts");
  if (packages.length) {
    console.error(`中心 import 闭包里出现 npm 包：${packages.join(", ")}；部署包不装 node_modules，先改 deploy/shared-ledger`);
    process.exit(1);
  }
  console.log(files.join("\n"));
}

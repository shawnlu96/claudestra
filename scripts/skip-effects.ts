// 效果点清单（src/lib/scheduler-v2-skip-effects.ts）的计数自动更新。合并后某个已登记文件的计数变了时用：
//   bun run skip-effects           扫一次，已登记文件的计数原位改成扫描值、不再有效果点的条目删掉；未登记的新文件只列出来，由人定组
//   bun run skip-effects --check   只打印将要做的改动，不写文件
// 退出码：有未登记文件为 1（--check 下有任何改动也为 1），清单原文和 SKIP_EFFECT_FILES 对不上为 2（什么都不写），否则 0。
// 扫描规则和 tests/shared-ledger-v2-stage2-skip-paths.test.ts 共用这一份。tests/skip-effects.test.ts。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKIP_EFFECT_FILES } from "../src/lib/scheduler-v2-skip-effects.ts";
import { countOnlyChanges, EFFECTS, effectSites, inventoryGates, isGate, parseInventory, passGraph as passGraphOf, stripComments, type Src }
  from "../src/lib/skip-effects-auto-scope-scan.ts";
import { rewriteInventory, type SkipEffectsRewrite } from "../src/lib/skip-effects-rewrite.ts";

const LIB = join(import.meta.dir, "..", "src", "lib");
const source = (file: string) => readFileSync(join(LIB, file), "utf8");

// 扫描与解析的纯函数在 src/lib/skip-effects-auto-scope-scan.ts（规则未变），这里照旧导出给测试与脚本入口
export { countOnlyChanges, EFFECTS, effectSites, inventoryGates, isGate, parseInventory, stripComments, type Src };
// 改写纯函数在 src/lib/skip-effects-rewrite.ts（调度器进程内刷新也用它），这里照旧导出
export { rewriteInventory, type SkipEffectsRewrite };

/** Files reachable from schedulerPass and its injected steps through value imports (`import type` carries no code). */
export function passGraph(read: (f: string) => string = source, exists = (f: string) => existsSync(join(LIB, f))): Src[] {
  return passGraphOf(read, exists);
}

export type SkipEffectsIo = {
  /** 清单文件路径（测试指向临时副本） */
  inventory?: string;
  read?: (f: string) => string;
  exists?: (f: string) => boolean;
  log?: (line: string) => void;
};

/** 脚本入口：只管读写文件和打印，返回退出码。 */
export function runSkipEffects(argv: string[], io: SkipEffectsIo = {}): number {
  const log = io.log ?? ((l: string) => console.log(l)), check = argv.includes("--check");
  const path = io.inventory ?? join(LIB, "scheduler-v2-skip-effects.ts");
  const text = readFileSync(path, "utf8");
  const parsed = parseInventory(text), imported = new Map(Object.values(SKIP_EFFECT_FILES).flatMap((byFile) => Object.entries(byFile)));
  const drift = [...new Set([...parsed.keys(), ...imported.keys()])].filter((f) => parsed.get(f) !== imported.get(f));
  if (drift.length) {
    log(`✗ 清单原文和 SKIP_EFFECT_FILES 对不上（${drift.join(", ")}），什么都没写`);
    return 2;
  }
  const r = rewriteInventory(text, effectSites(passGraph(io.read, io.exists)));
  for (const c of r.changed) log(`改 ${c.file}: "${c.from}" → "${c.to}"`);
  for (const c of r.removed) log(`删 ${c.file}: "${c.was}"（扫描里没有了）`);
  for (const c of r.comments) log(`⚠ ${c.file} 在清单第 ${c.line} 行的注释里被提到，请人工核那段注释`);
  for (const u of r.unregistered) log(`未登记 ${u.file}: "${u.sites}" —— 要人定放哪一组 gate`);
  const edits = r.changed.length + r.removed.length;
  if (!check && r.text !== text) writeFileSync(path, r.text);
  log(edits || r.unregistered.length ? `${check ? "将" : "已"}改 ${r.changed.length} 条、删 ${r.removed.length} 条；未登记 ${r.unregistered.length} 个` : "效果点清单和代码一致");
  return r.unregistered.length || (check && edits) ? 1 : 0;
}

if (import.meta.main) process.exit(runSkipEffects(process.argv.slice(2)));

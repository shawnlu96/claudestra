/**
 * 临时调试分区守卫(v2.24+,docs/web-dev-mode.md 范式一第 4 步):
 * features/devtools 之外的任何 registerDevSection( 调用,上方 3 行内必须有
 * `dev-section: YYYY-MM-DD` 注释——让遗留的临时分区在 CI 上显形。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const WEB = join(import.meta.dir, "..", "web");
const SCAN_DIRS = ["app", "components", "features", "lib"];
const EXCLUDE = [join(WEB, "features", "devtools")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (EXCLUDE.some((e) => p.startsWith(e))) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

export function findUnannotatedSections(files: { path: string; text: string }[]): string[] {
  const bad: string[] = [];
  for (const { path, text } of files) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!/\bregisterDevSection\s*\(/.test(line)) return;
      if (/^\s*(import|export)\b/.test(line)) return;
      const above = lines.slice(Math.max(0, i - 3), i).join("\n");
      if (!/dev-section:\s*\d{4}-\d{2}-\d{2}/.test(above)) bad.push(`${path}:${i + 1}`);
    });
  }
  return bad;
}

describe("registerDevSection 注释守卫", () => {
  test("规则本身:有日期注释放行,没有 / 太远 / 只有 import 的不算", () => {
    const ok = "// dev-section: 2026-09-22 追 xx\nregisterDevSection(\"a\", () => {});";
    const noDate = "// dev-section: 追 xx\nregisterDevSection(\"a\", () => {});";
    const tooFar = "// dev-section: 2026-09-22\n\n\n\nregisterDevSection(\"a\", () => {});";
    const importOnly = 'import { registerDevSection } from "@/features/devtools/dev-registry";';
    expect(findUnannotatedSections([{ path: "ok.ts", text: ok }])).toEqual([]);
    expect(findUnannotatedSections([{ path: "nd.ts", text: noDate }])).toEqual(["nd.ts:2"]);
    expect(findUnannotatedSections([{ path: "far.ts", text: tooFar }])).toEqual(["far.ts:5"]);
    expect(findUnannotatedSections([{ path: "imp.ts", text: importOnly }])).toEqual([]);
  });

  test("web/ 里 features/devtools 之外的每个临时分区都带日期注释", () => {
    const files = SCAN_DIRS.flatMap((d) => {
      try {
        return walk(join(WEB, d));
      } catch {
        return [];
      }
    }).map((p) => ({ path: p.slice(WEB.length + 1), text: readFileSync(p, "utf8") }));
    expect(files.length).toBeGreaterThan(0);
    expect(findUnannotatedSections(files)).toEqual([]);
  });
});

/**
 * 验收线 4（agents-NOTICETYPE1）：扫 src 下对 PM 通知入口的调用，不许用 `level: undefined` / `pmLevel: undefined`，
 * 也不许用 `as any` / `as never` 绕过必填级别（类型检查管不住这两种写法）。
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY = /\b(?:notifyProjectPm|sendLedgerNotice|sendToPm|notifyTaskPm|notifyPm!?)\s*\(/g;
const BYPASS = [/\b(?:pm)?[lL]evel\s*:\s*undefined\b/, /\bas\s+any\b/, /\bas\s+never\b/];

/** 从 open（左括号下标）起找配对的右括号，返回括号里的实参原文 */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

export function levelBypasses(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(ENTRY)) {
    const args = argsAt(src, m.index! + m[0].length - 1);
    if (BYPASS.some((re) => re.test(args))) out.push(`${m[0]}${args.split("\n")[0]})`);
  }
  return out;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? tsFiles(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []);
}

test("the guard catches level: undefined and as any / as never at a notice entry", () => {
  expect(levelBypasses(`await notifyProjectPm(db, p, t, { fromName: "scheduler", level: undefined });`)).toHaveLength(1);
  expect(levelBypasses(`void sendLedgerNotice({ to, text, messageId, pmLevel: undefined });`)).toHaveLength(1);
  expect(levelBypasses(`await deps.notifyPm(task, text, undefined as any);`)).toHaveLength(1);
  expect(levelBypasses(`await sendToPm(env, p, to, text, null as never);`)).toHaveLength(1);
  expect(levelBypasses(`await notifyProjectPm(db, p, t, { fromName: "x" } as any);`)).toHaveLength(1);
  expect(levelBypasses(`await deps.notifyPm!(a, text, "action"); await notifyProjectPm(db, p, t, { fromName: "x", level });`)).toEqual([]);
});

test("no call to a PM notice entry under src bypasses the required level", () => {
  const hits = tsFiles("src").flatMap((f) => levelBypasses(readFileSync(f, "utf8")).map((h) => `${f}: ${h}`));
  expect(hits).toEqual([]);
});

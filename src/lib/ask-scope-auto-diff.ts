import { posix } from "node:path";
import type { ScopeGrant } from "./ask-scope-registry.js";
import { scopeMatches } from "./ask-scope-auto-plan.js";
import { recoveryKeysOrderProblem } from "./registry-order.js";
import { inventoryGates, inventoryLines, parseInventory } from "./skip-effects-auto-scope-scan.js";
import { judgeCommandRegistry } from "./ask-scope-auto-commands.js";

import { additions, codeLines, escapeRx, ownDefinition, scopeParser as parser, validModule, type ScopeProof } from "./ask-scope-auto-proof.js";

function wireDiff(grant: ScopeGrant, base: string, head: string, proof: ScopeProof): string | null {
  const added = additions(base, head), code = codeLines(head);
  if (!base || !added || added.length < 2 || added.length > 4 || !added.every((l) => code.has(l.line))) return "不是纯新增 import 一行 + 调用 ≤3 行";
  const imports = added.filter((l) => /^import /.test(l.text));
  const m = imports.length === 1 ? /^import \{ ([\w$]+)(?: as ([\w$]+))? \} from ["'](\.[^"']+)["'];$/.exec(imports[0]!.text) : null;
  if (!m) return "必须是单行具名 import";
  const source = posix.normalize(posix.join(posix.dirname(grant.path), m[3]!)).replace(/\.js$/, ".ts");
  if (source !== grant.source || !proof.newFiles.has(source) || !scopeMatches(source, proof.globs)) return "判定逻辑不在本卡 fileGlobs 内的新文件";
  const body = proof.sources.get(source);
  if (!body || !validModule(body) || !parser.scan(body).exports.includes(m[1]!)) return "新文件没有定义所接函数";
  const name = escapeRx(m[2] ?? m[1]!);
  const atom = "(?:[A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*)*|true|false|null|[0-9]+)";
  const call = new RegExp(`^\\s*(?:(?:const ([\\w$]+) = |return )?(?:await )?)${name}\\(\\s*(?:${atom}(?:\\s*,\\s*${atom})*)?\\s*\\);$`);
  const calls = added.filter((l) => l !== imports[0]);
  let result: string | undefined, count = 0;
  for (const line of calls) {
    const match = call.exec(line.text);
    if (match) { count++; result = match[1]; continue; }
    if (result && new RegExp(`^\\s*if \\(${escapeRx(result)}\\) return ${escapeRx(result)};$`).test(line.text)) { result = undefined; continue; }
    return "新增行含接线之外的判断或效果";
  }
  return count ? null : "没有所接函数调用";
}

function keyDiff(base: string, head: string, proof: ScopeProof): string | null {
  const problem = recoveryKeysOrderProblem(head);
  if (problem) return problem;
  const key = /^ {2}"([^"\n]+)",$/;
  const reduce = (text: string) => {
    const lines = text.split("\n"), headers = lines.flatMap((l, i) => l === "export const RECOVERY_KEYS = [" ? [i] : []);
    const start = headers[0] ?? -1, end = lines.findIndex((l, i) => i > start && l.startsWith("]"));
    if (headers.length !== 1 || !codeLines(text).has(start) || end < 0) throw new Error("键表边界不明确");
    return lines.filter((line, i) => {
      const m = i > start && i < end ? key.exec(line) : null;
      return !m || !ownDefinition(m[1]!, proof);
    }).join("\n");
  };
  return reduce(base) === reduce(head) ? null : "改了本卡定义之外的键或表结构";
}

function effectDiff(base: string, head: string, proof: ScopeProof): string | null {
  if (!proof.scan) return "缺少 skip-effects 同源扫描";
  const before = parseInventory(base), after = parseInventory(head), gates = inventoryGates(head), oldGates = inventoryGates(base);
  const own = (file: string) => scopeMatches(`src/lib/${file}`, proof.globs) && proof.sources.has(`src/lib/${file}`);
  const erase = (text: string) => {
    const lines = text.split("\n"), { start, end } = inventoryLines(lines);
    if (!codeLines(text).has(start - 1) || lines.filter((l) => l.startsWith("export const SKIP_EFFECT_FILES")).length !== 1) throw new Error("效果表边界不明确");
    return lines.filter((line, i) => {
      const m = i >= start && i < end ? /^ {4}"([\w.-]+\.ts)": "[a-z0-9= ]*",(?:\s*\/\/.*)?$/.exec(line) : null;
      return !m || !own(m[1]!);
    }).join("\n");
  };
  if (erase(base) !== erase(head)) return "改了本卡之外的条目、注释或结构";
  const ownLines = (text: string) => new Map(text.split("\n").flatMap((line) => {
    const m = /^ {4}"([\w.-]+\.ts)": "[a-z0-9= ]*"(,.*)$/.exec(line);
    return m && own(m[1]!) ? [[m[1]!, m[2]!]] : [];
  }));
  const was = ownLines(base), now = ownLines(head);
  if ([...was].some(([file, tail]) => now.has(file) && now.get(file) !== tail)) return "改了既有条目的注释";
  for (const [file, count] of after) {
    if (proof.scan.get(file) !== count) return "计数与 skip-effects 扫描不符";
    if (before.has(file) && oldGates.get(file) !== gates.get(file)) return "条目移组";
  }
  if (after.size !== proof.scan.size) return "效果点清单与扫描不一致";
  const byGate = new Map<string, string[]>();
  for (const file of after.keys()) byGate.set(gates.get(file)!, [...(byGate.get(gates.get(file)!) ?? []), file]);
  for (const names of byGate.values()) {
    for (let i = 0; i < names.length; i++) if (own(names[i]!) && names.some((n, j) => j < i ? n > names[i]! : j > i && n < names[i]!)) return "本卡条目不在字母序位置";
  }
  return null;
}

/** Exact Git blobs only. No code from a delivered branch is imported or executed. Unknown syntax is outside scope. */
export function judgeScopeFile(grant: ScopeGrant, base: string, head: string, proof: ScopeProof): string | null {
  try {
    if (!validModule(base) || !validModule(head) || base === head) return "不是有效的源码改动";
    if (grant.kind === "wire") return wireDiff(grant, base, head, proof);
    if (grant.kind === "keys") return keyDiff(base, head, proof);
    if (grant.kind === "effects") return effectDiff(base, head, proof);
    return judgeCommandRegistry(grant, base, head, proof);
  } catch (e) { return `无法核对改动：${(e as Error).message}`; }
}

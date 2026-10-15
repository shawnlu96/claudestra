import { posix } from "node:path";
import type { ScopeGrant } from "./ask-scope-registry.js";
import { scopeMatches } from "./ask-scope-auto-plan.js";
import { additions, codeLines, ownDefinition, scopeParser, type ScopeProof } from "./ask-scope-auto-proof.js";

const TABLES = { "skip-commands": "SKIP_LEDGER_COMMANDS", "command-rules": "SCHEDULER_V2_LEDGER_COMMANDS", services: "SCHEDULER_SERVICE_COMMANDS" };

function managerDiff(grant: ScopeGrant, base: string, head: string, proof: ScopeProof): string | null {
  const added = additions(base, head);
  if (!added || added.length !== 2) return "命令汇总只允许新增 import 和展开各一行";
  const imp = added.find((l) => l.text.startsWith("import "));
  const m = imp && /^import \{ ([A-Z][A-Z_0-9]*_CMDS) \} from ["'](\.[^"']+)["'];$/.exec(imp.text);
  if (!m) return "没有单行命令表 import";
  const path = posix.normalize(posix.join(posix.dirname(grant.path), m[2]!)).replace(/\.js$/, ".ts");
  const source = proof.sources.get(path);
  if (!scopeMatches(path, proof.globs) || !source || !scopeParser.scan(source).exports.includes(m[1]!)) return "命令表未在本卡文件定义";
  const spread = added.find((l) => l !== imp)!;
  if (spread.text.trim() !== `...${m[1]},`) return "不是单行命令表展开";
  const lines = head.split("\n"), code = codeLines(head);
  const start = lines.findIndex((line, i) => /^const COMMANDS\b/.test(line) && code.has(i));
  const end = lines.findIndex((line, i) => i > start && line === "};");
  return start >= 0 && spread.line > start && spread.line < end ? null : "展开不在 COMMANDS 汇总表内";
}

export function judgeCommandRegistry(grant: ScopeGrant, base: string, head: string, proof: ScopeProof): string | null {
  const added = additions(base, head), code = codeLines(head);
  if (!added?.length || !added.every((l) => code.has(l.line))) return "只能添加命令条目";
  if (grant.kind === "manager") return managerDiff(grant, base, head, proof);
  if (!(grant.kind in TABLES)) return "未登记的表";
  const table = TABLES[grant.kind as keyof typeof TABLES];
  const lines = head.split("\n"), start = lines.findIndex((l) => l.startsWith(`export const ${table}`));
  const end = lines.findIndex((l, i) => i > start && /^(?:\}|\])/.test(l));
  if (start < 0 || end < 0 || !code.has(start)) return "找不到命令表边界";
  const seen = new Set<string>();
  for (const line of added) {
    if (line.line <= start || line.line >= end) return "新增内容在登记表之外";
    const m = /^ {2}"([\w-]+)"(?:: (.*))?,$/.exec(line.text);
    if (!m || seen.has(m[1]!) || base.includes(`"${m[1]}"`) || !ownDefinition(m[1]!, proof, true)) return "不是本卡新命令或重复条目";
    seen.add(m[1]!);
    if (grant.kind === "services" && m[2] !== undefined) return "允许名单只接受命令名";
    if (grant.kind === "skip-commands" && !/^"(?:task|foreign|lend-order|manual-claim|project|intent|task-or-none|autostart|supervise|worker-retire)"$/.test(m[2] ?? "")) {
      return "不是静态命令目标登记";
    }
    if (grant.kind === "command-rules" && !/^rule\("(?:task|intent|session-intent|order)", "(?:central|executor|mixed|unmapped)"\)$/.test(m[2] ?? "")) {
      return "不是静态命令路由登记";
    }
  }
  return null;
}

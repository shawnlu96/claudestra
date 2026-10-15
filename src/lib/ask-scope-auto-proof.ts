import { scopeMatches } from "./ask-scope-auto-plan.js";
import { stripComments } from "./skip-effects-auto-scope-scan.js";

export interface ScopeProof { globs: string[]; sources: Map<string, string>; baseSources?: Map<string, string>; newFiles: Set<string>; scan?: Map<string, string> }
export const scopeParser = new Bun.Transpiler({ loader: "ts" });
export const validModule = (text: string): boolean => { try { scopeParser.scan(text); return !text.includes("\0"); } catch { return false; } };

/** Locations in string/template literals are not executable lines, including multi-line templates and continuations. */
export function codeLines(text: string): Set<number> {
  const clean = stripComments(text), result = new Set<number>();
  let quote = "", line = 0, first = true;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === "\n") { line++; first = true; continue; }
    if (quote) {
      if (c === "\\") { if (clean[++i] === "\n") { line++; first = true; } }
      else if (c === quote) quote = "";
      continue;
    }
    if (/\s/.test(c)) continue;
    if (first) { result.add(line); first = false; }
    if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return result;
}

interface DefinitionIndex { keys: Set<string>; baseKeys: Set<string>; commands: Set<string> }
const indexes = new WeakMap<ScopeProof, DefinitionIndex>();

/** Normalize complete declarations first: a newline after a literal may continue an expression instead of ending it. */
function stringKeys(text: string): string[] {
  const normalized = scopeParser.transformSync(text), code = codeLines(normalized);
  return normalized.split("\n").flatMap((line, i) => {
    const match = code.has(i) ? /^export const [\w$]+ = ("(?:\\.|[^"\\])*");$/.exec(line) : null;
    return match ? [JSON.parse(match[1]!) as string] : [];
  });
}

/** Index each scoped source once; registry size must not multiply full-source parsing cost. */
function definitions(proof: ScopeProof): DefinitionIndex {
  const prior = indexes.get(proof);
  if (prior) return prior;
  const index: DefinitionIndex = { keys: new Set(), baseKeys: new Set(), commands: new Set() };
  const oldCommands = new Set<string>();
  const versions = [...proof.sources].map(([path, text]) => ({ path, text, old: false }))
    .concat([...(proof.baseSources ?? [])].map(([path, text]) => ({ path, text, old: true })));
  for (const { path, text, old } of versions) {
    if (!scopeMatches(path, proof.globs) || !validModule(text)) continue;
    const code = codeLines(text), lines = stripComments(text).split("\n");
    for (const key of stringKeys(text)) (old ? index.baseKeys : index.keys).add(key);
    lines.forEach((line, i) => {
      if (!code.has(i)) return;
      const command = /^\s*["']([\w-]+)["']\s*:\s*(?:\{|[A-Za-z_$])/.exec(line);
      if (command) (old ? oldCommands : index.commands).add(command[1]!);
    });
  }
  for (const name of oldCommands) index.commands.delete(name);
  indexes.set(proof, index);
  return index;
}

export const ownDefinition = (name: string, proof: ScopeProof, command = false, old = false): boolean =>
  definitions(proof)[command ? "commands" : old ? "baseKeys" : "keys"].has(name);
export const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Additive subsequence, byte-for-byte: a changed/deleted old line cannot masquerade as an insertion. */
export function additions(base: string, head: string): { text: string; line: number }[] | null {
  const old = base.split("\n"), next = head.split("\n"), out: { text: string; line: number }[] = [];
  let at = 0;
  for (let line = 0; line < next.length; line++) {
    if (at < old.length && next[line] === old[at]) at++;
    else out.push({ text: next[line]!, line });
  }
  return at === old.length ? out : null;
}

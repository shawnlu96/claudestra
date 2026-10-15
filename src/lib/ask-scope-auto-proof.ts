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

interface DefinitionIndex { keys: Set<string>; commands: Set<string> }
const indexes = new WeakMap<ScopeProof, DefinitionIndex>();

/** Index each scoped source once; registry size must not multiply full-source parsing cost. */
function definitions(proof: ScopeProof): DefinitionIndex {
  const prior = indexes.get(proof);
  if (prior) return prior;
  const index: DefinitionIndex = { keys: new Set(), commands: new Set() };
  const oldCommands = new Set<string>();
  const versions = [...proof.sources].map(([path, text]) => ({ path, text, old: false }))
    .concat([...(proof.baseSources ?? [])].map(([path, text]) => ({ path, text, old: true })));
  for (const { path, text, old } of versions) {
    if (!scopeMatches(path, proof.globs) || !validModule(text)) continue;
    const code = codeLines(text), lines = stripComments(text).split("\n");
    const exported = new Set(scopeParser.scan(text).exports);
    for (const name of exported) index.keys.add(name);
    lines.forEach((line, i) => {
      if (!code.has(i)) return;
      const command = /^\s*["']([\w-]+)["']\s*:\s*(?:\{|[A-Za-z_$])/.exec(line);
      if (command) (old ? oldCommands : index.commands).add(command[1]!);
      const key = /^\s*export const ([\w$]+)(?:\s*:\s*string)?\s*=\s*["']([^"']+)["']\s*(?:as const)?\s*;?\s*$/.exec(line);
      if (key && exported.has(key[1]!)) index.keys.add(key[2]!);
    });
  }
  for (const name of oldCommands) index.commands.delete(name);
  indexes.set(proof, index);
  return index;
}

export const ownDefinition = (name: string, proof: ScopeProof, command = false): boolean => definitions(proof)[command ? "commands" : "keys"].has(name);
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

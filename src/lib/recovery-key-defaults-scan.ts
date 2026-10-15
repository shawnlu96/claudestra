/**
 * OBSGATE1 · static scan behind tests/recovery-key-sample-sink.test.ts: which recovery keys have a sample sink in src/lib.
 * A key has one when some file names it (a string literal, or a `const X = "<key>"` declared anywhere in src/lib and used
 * there by name) and the same file writes samples (SINK below), or observation-plan-evidence.ts has its own adapter.
 * Comments are dropped before matching, so a key or a call that only appears in a comment counts for nothing. Pure: the test
 * hands it the sources, so synthetic files exercise the same rules.
 */

export interface ScanSource { path: string; text: string }

/** The scan's own inputs: the key table, the key class / defaults files list every key and are not mechanisms. */
const NOT_MECHANISM = /(^|\/)(recovery-keys|recovery-key-class|recovery-key-defaults[\w-]*)\.ts$/;
const ADAPTER_FILE = /(^|\/)observation-plan-evidence\.ts$/;
/**
 * Sample writes: the gate, a direct observe record, a hand-written recovery_observe note, an ObservedAction built for an
 * injected observe port, or the scheduler identity's `ledger scheduler-recovery-observe` (both end in recordObserved).
 */
const SINK = /\bgateRecovery\s*\(|\brecordObserved\s*\(|\bop\s*:\s*["'`]recovery_observe["'`]|\bObservedAction\b|["'`]scheduler-recovery-observe["'`]/;
const KEY_CONST = /\bconst\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;]+)?\s*=\s*["'`]([A-Za-z][A-Za-z0-9]*)["'`](?:\s+as\s+const)?\s*[;,\n]/g;
const REGEX_BEFORE = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** Source with comments blanked (strings, templates and regex literals kept verbatim, so `//` inside them is not a comment). */
function stripComments(src: string): string {
  let out = "", i = 0, last = "";
  const n = src.length;
  const word = () => /(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(out.trimEnd());
  while (i < n) {
    const c = src[i]!, d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; out += " "; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; else if (c !== "`" && src[j] === "\n") break; j++; }
      out += src.slice(i, j + 1); i = j + 1; last = c; continue;
    }
    if (c === "/" && (REGEX_BEFORE.has(last) || word())) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1); i = j + 1; last = "x"; continue;
    }
    out += c; if (!/\s/.test(c)) last = /[\w$)\]]/.test(c) ? "x" : c; i++;
  }
  return out;
}

const quoted = (text: string, key: string) => text.includes(`"${key}"`) || text.includes(`'${key}'`) || text.includes(`\`${key}\``);
const esc = (s: string) => s.replace(/[$]/g, "\\$");

const IMPORT = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']\s*;?/g;
const resolve = (from: string, spec: string) => {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.replace(/\.js$/, ".ts").split("/")) seg === ".." ? parts.pop() : seg !== "." && parts.push(seg);
  return parts.join("/");
};

/**
 * Key names a file can use: its own `const X = "<key>"`, plus names it imports (relative `./x.js`) from a file that exports
 * them that way. Generic names (KEY) are declared in many files, so an import is followed to its own file, never guessed.
 */
function keyNames(files: readonly ScanSource[], keys: readonly string[]): Map<string, Map<string, string>> {
  const declared = new Map<string, Map<string, string>>(), exported = new Map<string, Map<string, string>>();
  for (const f of files) {
    const mine = new Map<string, string>(), out = new Map<string, string>();
    for (const m of f.text.matchAll(KEY_CONST)) {
      if (!keys.includes(m[2]!)) continue;
      mine.set(m[1]!, m[2]!);
      if (/\bexport\s+$/.test(f.text.slice(Math.max(0, m.index! - 8), m.index!))) out.set(m[1]!, m[2]!);
    }
    declared.set(f.path, mine); exported.set(f.path, out);
  }
  for (const f of files) {
    const mine = declared.get(f.path)!;
    for (const m of f.text.matchAll(IMPORT)) {
      const theirs = exported.get(resolve(f.path, m[2]!));
      if (!theirs) continue;
      for (const part of m[1]!.split(",")) {
        const [name, alias] = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/).map((x) => x.trim());
        const key = name ? theirs.get(name) : undefined;
        if (key) mine.set(alias || name!, key);
      }
    }
  }
  return declared;
}

/** Keys with no sample sink, in key-table order. */
export function keysWithoutSampleSink(keys: readonly string[], sources: readonly ScanSource[]): string[] {
  const files = sources.filter((s) => !NOT_MECHANISM.test(s.path)).map((s) => ({ path: s.path, text: stripComments(s.text) }));
  const names = keyNames(files, keys);
  const sinks = files.filter((f) => SINK.test(f.text));
  const adapters = files.filter((f) => ADAPTER_FILE.test(f.path));
  const used = (f: ScanSource, key: string) => [...names.get(f.path)!].some(([id, k]) => k === key
    && new RegExp(`(^|[^\\w$.])${esc(id)}(?![\\w$])`, "g").test(f.text.replace(KEY_CONST, "").replace(IMPORT, "")));
  return keys.filter((k) => !adapters.some((f) => quoted(f.text, `recovery:${k}`)) && !sinks.some((f) => quoted(f.text, k) || used(f, k)));
}

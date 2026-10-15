/**
 * OBSGATE1 · static scan behind tests/recovery-key-sample-sink.test.ts: which recovery keys have a sample sink in src/lib.
 * A key has one when some file names it (a string literal, or a `const X = "<key>"` declared anywhere in src/lib and used
 * there by name) and the same file writes samples (hasSink below), or observation-plan-evidence.ts has its own adapter.
 * Comments are dropped before matching (lex below, comments inside `${}` included), and the sink match reads code only: a call
 * spelled inside a string or template text, or a bare `import type`, counts for nothing. Pure: the test hands it the sources,
 * so synthetic files exercise the same rules.
 */

export interface ScanSource { path: string; text: string }
/** A source after lex: `text` without comments, `code` without comments or string bodies. */
type Lexed = ScanSource & { code: string };

/** The scan's own inputs: the key table, the key class / defaults files list every key and are not mechanisms. */
const NOT_MECHANISM = /(^|\/)(recovery-keys|recovery-key-class|recovery-key-defaults[\w-]*)\.ts$/;
const ADAPTER_FILE = /(^|\/)observation-plan-evidence\.ts$/;
/**
 * Sample writes, matched on lex's `code`: a call to the gate or to a direct observe record (SINK_CALL, through isCall), a
 * hand-written recovery_observe note, or the scheduler identity's `ledger scheduler-recovery-observe` invoked as a command
 * (the first or second argument of a call; it ends in recordObserved). The command name alone (a table, a list) is no write.
 */
const SINK_CALL = /(?<![\w$])(?:gateRecovery|recordObserved)\s*\(/g;
const SINK_NOTE = /\bop\s*:\s*"recovery_observe"/;
const SINK_CMD = /[\w$)\]]\s*\(\s*(?:"[^"\n]*"\s*,\s*)?"scheduler-recovery-observe"\s*[,)]/g;
/** String values that are sink tokens: lex keeps these whole (as double-quoted), and blanks every other string body. */
const SINK_STRINGS = new Set(["recovery_observe", "scheduler-recovery-observe"]);
/**
 * An injected observe port: the file handles ObservedAction values in code (outside its imports) and calls something named
 * observe* / *Observe* / *Observed* (the port, or the drain that hands queued actions to it; a declaration is no call).
 * Neither alone counts.
 */
const PORT_TYPE = /\bObservedAction\b/;
const PORT_CALL = /(?<![\w$])[\w$]*[oO]bserve[\w$]*\s*(?:\?\.\s*)?\(/g;
const KEY_CONST = /\bconst\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;]+)?\s*=\s*["'`]([A-Za-z][A-Za-z0-9]*)["'`](?:\s+as\s+const)?\s*[;,\n]/g;
const IMPORT = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']\s*;?/g;

/**
 * One pass over a source: `text` with comments blanked (strings, templates and regex literals kept), `code` with string,
 * template-text and regex bodies blanked too (except SINK_STRINGS); `${}` expressions are code in both, so a comment inside
 * one is blanked and a call inside one counts. Newlines kept. Same rules as skip-effects-auto-scope-scan.ts stripComments,
 * which costs seconds over the whole of src/lib (its per-character look-back), past the test's time limit.
 */
function lex(src: string): { text: string; code: string } {
  let text = "", code = "", i = 0, prev = "";
  const tmpl: number[] = []; // per open `${`: brace depth inside it
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const both = (s: string) => { text += s; code += s; };
  const keyword = () => /(?:^|[^\w$.])(?:return|typeof|case|of|in|instanceof|new|delete|void|yield|await|throw|else|do)$/.test(code.slice(-32).trimEnd());
  const template = () => { // i sits just after a backtick, or after the `}` that closes a `${`
    let j = i;
    while (j < n && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
    text += src.slice(i, j); code += blank(src.slice(i, j));
    if (src[j] === "$") { both("${"); i = j + 2; tmpl.push(0); prev = "{"; } else { both("`"); i = j + 1; prev = "x"; }
  };
  while (i < n) {
    const c = src[i]!, d = src[i + 1];
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; both(blank(src.slice(i, end))); i = end; }
    else if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; both(blank(src.slice(i, end))); i = end; }
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const body = src.slice(i + 1, j);
      text += src.slice(i, j + 1); code += SINK_STRINGS.has(body) ? `"${body}"` : c + blank(body) + (src[j] === c ? c : ""); i = j + 1; prev = "x";
    } else if (c === "`") { both(c); i++; template(); }
    else if (c === "/" && (prev === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || keyword())) {
      let j = i + 1, cls = false; // regex literal: skip escapes and `[...]` classes
      while (j < n && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
      text += src.slice(i, j + 1); code += blank(src.slice(i, j + 1)); i = j + 1; prev = "x";
    } else if (c === "}" && tmpl.length && tmpl[tmpl.length - 1] === 0) { tmpl.pop(); both(c); i++; template(); }
    else {
      if (tmpl.length && c === "{") tmpl[tmpl.length - 1]!++;
      else if (tmpl.length && c === "}") tmpl[tmpl.length - 1]!--;
      both(c); i++;
      if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? "x" : c;
    }
  }
  return { text, code };
}

/** Whether a file writes samples: a direct sink, or ObservedAction handled in code together with an observe-port call. */
function hasSink(f: Lexed): boolean {
  if (SINK_NOTE.test(f.code) || hasCall(f.code, SINK_CALL) || hasCall(f.code, SINK_CMD)) return true;
  const body = lex(f.text.replace(IMPORT, "")).code;
  return PORT_TYPE.test(body) && hasCall(body, PORT_CALL);
}

/** Whether some match of `re` (global, ending at a `(`) in lexed code is a call expression rather than a declaration. */
function hasCall(code: string, re: RegExp): boolean {
  for (const m of code.matchAll(re)) if (isCall(code, m.index!, m.index! + m[0].length - 1)) return true;
  return false;
}

/**
 * `code[open]` is the `(` after a name starting at `at`. A declaration is not a call: a `function` / `abstract` head, a
 * parameter list followed by a body or a return type (`) {`, `): T`), or a member of an interface / object type literal.
 */
function isCall(code: string, at: number, open: number): boolean {
  if (/\b(?:function\*?|abstract)\s*$/.test(code.slice(Math.max(0, at - 16), at))) return false;
  let depth = 0, close = open;
  for (; close < code.length; close++) {
    if (code[close] === "(") depth++;
    else if (code[close] === ")" && --depth === 0) break;
  }
  const after = code.slice(close + 1, close + 64);
  if (/^\s*\{/.test(after) || (/^\s*:/.test(after) && memberHead(code, at))) return false;
  depth = 0;
  for (let i = at - 1; i >= 0; i--) { // the innermost `{` around the name: a type body declares, never calls
    if (code[i] === "}") depth++;
    else if (code[i] === "{" && depth-- === 0) return !/(?:\binterface\s+[\w$]+(?:<[^{]*>)?(?:\s+extends\s+[^{]*)?|\btype\s+[\w$]+(?:<[^=]*>)?\s*=)\s*$/.test(code.slice(Math.max(0, i - 200), i));
  }
  return true;
}

/**
 * Whether the name at `at` starts a member / statement (so `name(...): T` is a return type, not a call): the token before it,
 * past member modifiers and a generator `*`, is the start of the file or `{ } ; , )`. A call followed by `:` sits after an
 * operator or keyword instead (`c ? recordObserved(x) : y`, `case gateRecovery(a):`).
 */
function memberHead(code: string, at: number): boolean {
  let head = code.slice(Math.max(0, at - 200), at).trimEnd();
  for (let prev = ""; prev !== head;) {
    prev = head;
    head = head.replace(/(?:^|(?<=[^\w$]))(?:async|static|public|private|protected|readonly|override|declare|get|set)$/, "").replace(/(?<=[{};,)]\s*)\*$/, "").trimEnd();
  }
  return head === "" || /[{};,)]$/.test(head);
}

const quoted = (text: string, key: string) => text.includes(`"${key}"`) || text.includes(`'${key}'`) || text.includes(`\`${key}\``);
const esc = (s: string) => s.replace(/[$]/g, "\\$");

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
  const files: Lexed[] = sources.filter((s) => !NOT_MECHANISM.test(s.path)).map((s) => ({ path: s.path, ...lex(s.text) }));
  const names = keyNames(files, keys);
  const sinks = files.filter(hasSink);
  const uses = new Map(sinks.map((f) => [f.path, lex(f.text.replace(KEY_CONST, "").replace(IMPORT, "")).code]));
  const adapters = files.filter((f) => ADAPTER_FILE.test(f.path));
  const used = (f: ScanSource, key: string) => [...names.get(f.path)!].some(([id, k]) => k === key
    && new RegExp(`(^|[^\\w$.])${esc(id)}(?![\\w$])`, "g").test(uses.get(f.path)!));
  return keys.filter((k) => !adapters.some((f) => quoted(f.text, `recovery:${k}`)) && !sinks.some((f) => quoted(f.text, k) || used(f, k)));
}

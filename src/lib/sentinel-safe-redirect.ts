/** Evidence classification only. Never use the returned command for execution or an execution permission decision. */
import { parseShell } from "./shell-words.js";

// Keep source tokens: shell-words intentionally drops source fds and expansion metadata on redirect targets.
// This narrower lexical envelope proves those details before removing any output redirect.
const TOKEN = new RegExp([
  String.raw`[ \t]+|\n|#[^\n]*`, String.raw`(?:\d*)>&\d+(?=[ \t\n]|$|[;&|<>])`,
  String.raw`(?:\d*)(?:&>>|&>|>>|>\||>&|<>|>|<)|&&|\|\||[;|&]`,
  String.raw`(?:[^\s'"\\<>;&|()]+|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[^\n])+`,
].join("|"), "y");
const REDIRECT = /^(\d*)(&>>|&>|>>|>\||>&|<>|>|<)$/;

function literal(token: string): string | null {
  // shell-words unescapes every double-quoted backslash; real shells preserve e.g. "\q".
  // Reject that ambiguity so a writable path cannot masquerade as the null device.
  let quote: string | null = null;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (quote === "'") { if (c === "'") quote = null; }
    else if (c === "\\") {
      if (quote === '"' && !["$", "`", '"', "\\"].includes(token[i + 1])) return null;
      i++;
    } else if (quote) { if (c === quote) quote = null; }
    else if (c === "'" || c === '"') quote = c;
    else if (c === "{" || c === "}") return null;
  }
  const p = parseShell(`echo ${token}`);
  const s = p.segments[0];
  if (p.broken || p.structural || p.substitution || p.segments.length !== 1 || !s || s.dynamic || s.redirects.length || s.words.length !== 2) return null;
  return s.words[1];
}

/** Static /dev/null output and numeric fd copies only; input reads may be retained for the remote shell. */
export function sentinelSafeRedirects(command: string, inputReads = false): string | null {
  const parsed = parseShell(command);
  if (parsed.broken || parsed.structural || parsed.substitution || !parsed.segments.length) return null;
  const tokens: string[] = [];
  const lexer = new RegExp(TOKEN);
  let at = 0;
  while (at < command.length) {
    lexer.lastIndex = at;
    const m = lexer.exec(command);
    if (!m) return null;
    at = lexer.lastIndex;
    const copy = /^(\d*)>&(\d+)$/.exec(m[0]);
    if (copy) tokens.push(`${copy[1]}>&`, copy[2]);
    else if (!/^[ \t]+$/.test(m[0]) && !m[0].startsWith("#")) tokens.push(m[0]);
  }
  const kept: string[] = [];
  let words = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const r = REDIRECT.exec(token);
    if (r) {
      const raw = tokens[++i];
      const target = raw === undefined ? null : literal(raw);
      if (target === null) return null;
      const [, fd, op] = r;
      if (fd && op.startsWith("&")) return null;
      if (op === "<" && inputReads) kept.push(token, raw);
      else if (op === ">&" && /^\d+$/.test(raw) && (!fd || /^\d+$/.test(fd))) continue;
      else if ([">", ">>", ">|", "&>", "&>>"].includes(op) && target === "/dev/null") continue;
      else return null;
    } else if (["&&", "||", ";", "|", "&", "\n"].includes(token)) {
      if (!words || token === "&" || i === tokens.length - 1) return null;
      kept.push(token);
      words = 0;
    } else {
      if (literal(token) === null) return null;
      kept.push(token);
      words++;
    }
  }
  return words ? kept.join(" ") : null;
}

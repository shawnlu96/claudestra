/** Spelling protection: bounded wildcards may spell a name; stars need the PM's literal-fragment evidence. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { KEYWORDS } from "./peer-pr-surface.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { AutoHit, AutoHitEvidence } from "./center-proposal-auto.js";
import type { ProposalRecord } from "./shared-ledger-feature-proposals.js";

const KEY = "proposalGlobProtection";
const MAX_VARIANTS = 128, MAX_STEPS = 200_000;
const WORDS = [...new Set([...KEYWORDS, "-gate", "order-ask", "order-deliver-scope", "ask-scope-", "ledger-checks",
  "ledger-store", "ledger-schema", "migrat", ".sql", "shared-ledger-contract", "recovery-key-class", "recovery-key-defaults",
  ".claude", "next.config.", "sw", "service-worker", "workbox-"])];
type Token = { kind: "literal" | "bounded" | "star"; value: string; accepts: (c: string) => boolean };
interface Budget { steps: number }
const spend = (b: Budget) => { if (++b.steps > MAX_STEPS) throw new Error("budget"); };
function fail(): never { throw new Error("syntax"); }

/** Expand only braces, including nesting; slash inside constructs and extension syntax are deliberately unsupported. */
function expand(g: string, b: Budget): string[] {
  if (g.length > 500) throw new Error("budget");
  if (/[+@*?!]\(|\\|[\x00-\x1f]/.test(g)) fail();
  const parse = (start: number, nested: boolean): { values: string[]; end: number } => {
    let values = [""], i = start;
    while (i < g.length) {
      spend(b);
      const c = g[i]!;
      if (c === "," || c === "}") { if (!nested) fail(); break; }
      let choices: string[];
      if (c === "{") {
        choices = [];
        do {
          const part = parse(i + 1, true);
          choices.push(...part.values); i = part.end;
          if (choices.length > MAX_VARIANTS) throw new Error("budget");
        } while (g[i] === ",");
        if (g[i] !== "}") fail();
      } else if (c === "[") {
        const end = g.indexOf("]", i + 1);
        if (end < 0 || /[\/\[:]/.test(g.slice(i + 1, end))) fail();
        choices = [g.slice(i, end + 1)]; i = end;
      } else {
        if (c === "]" || c === "!" || (nested && c === "/")) fail();
        choices = [c];
      }
      if (values.length * choices.length > MAX_VARIANTS) throw new Error("budget");
      values = values.flatMap(v => choices.map(x => v + x)); i++;
    }
    return { values, end: i };
  };
  return parse(0, false).values;
}

function tokens(segment: string): Token[] {
  if (segment.includes("**") && segment !== "**") fail();
  if (segment === "**") return [{ kind: "star", value: "x", accepts: () => true }];
  const result: Token[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") result.push({ kind: "star", value: "-", accepts: () => true });
    else if (c === "?") result.push({ kind: "bounded", value: "-", accepts: () => true });
    else if (c === "[") {
      const end = segment.indexOf("]", i + 1), body = segment.slice(i + 1, end);
      if (end < 0 || !body || /[^\x20-\x7e]|[\[\\/:]/.test(body)) fail();
      // Preserve the original range before case folding: [A-z] includes punctuation such as underscore.
      const re = new RegExp(`[${body.startsWith("!") ? "^" + body.slice(1) : body}]`, "i");
      const value = "-_.0123456789abcdefghijklmnopqrstuvwxyz".split("").find(x => re.test(x));
      if (!value) fail();
      result.push({ kind: "bounded", value, accepts: x => re.test(x) }); i = end;
    } else result.push({ kind: "literal", value: c, accepts: x => c.toLowerCase() === x.toLowerCase() });
  }
  return result;
}

/** Complete the remaining segment in the language *<extension>, instead of guessing unknown extension characters. */
function finish(ts: Token[], tail: string, b: Budget): string | undefined {
  const queue = [{ i: 0, k: -1, text: "" }], seen = new Set<string>();
  for (let q = 0; q < queue.length; q++) {
    spend(b);
    const s = queue[q]!, key = `${s.i}:${s.k}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.i === ts.length && s.k === tail.length) return s.text;
    const t = ts[s.i];
    if (s.k === -1) {
      queue.push({ ...s, k: 0 });
      if (t) queue.push({ i: s.i + 1, k: -1, text: s.text + (t.kind === "star" ? "" : t.value) });
    } else if (t?.kind === "star") {
      queue.push({ ...s, i: s.i + 1 });
      if (s.k < tail.length) queue.push({ ...s, k: s.k + 1, text: s.text + tail[s.k] });
    } else if (t && s.k < tail.length && t.accepts(tail[s.k]!)) {
      queue.push({ i: s.i + 1, k: s.k + 1, text: s.text + tail[s.k] });
    }
  }
  return undefined;
}

/** Finite product of token position and keyword position; memo and a shared budget bound adversarial input. */
function spelling(ts: Token[], word: string, b: Budget): string[] {
  const threshold = Math.min(3, word.length), render = (xs: Token[]) => xs.map(t => t.value).join("");
  type State = { i: number; k: number; star: boolean; anchor: boolean; run: number; text: string };
  for (let start = 0; start < ts.length; start++) {
    const queue: State[] = [{ i: start, k: 0, star: false, anchor: false, run: 0, text: "" }], seen = new Set<string>();
    for (let q = 0; q < queue.length; q++) {
      spend(b);
      const s = queue[q]!, key = `${s.i}:${s.k}:${+s.star}:${+s.anchor}:${s.run}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (s.k === word.length) {
        if (!s.star || s.anchor) {
          const prefix = render(ts.slice(0, start)) + s.text, rest = ts.slice(s.i);
          const endings = [render(rest), ...[".ts", ".js", ".mjs", ".cjs"].map(t => finish(rest, t, b))];
          return endings.filter((e): e is string => e !== undefined).map(e => prefix + e);
        }
        continue;
      }
      const t = ts[s.i];
      if (!t) continue;
      if (t.kind === "star") {
        queue.push({ ...s, i: s.i + 1, run: 0 });
        queue.push({ ...s, k: s.k + 1, star: true, run: 0, text: s.text + word[s.k] });
      } else if (t.accepts(word[s.k]!)) {
        const run = t.kind === "literal" ? s.run + 1 : 0;
        const adjacent = ts[s.i - run]?.kind !== "literal" && s.i - run >= 0 || ts[s.i + 1]?.kind !== "literal" && s.i + 1 < ts.length;
        queue.push({ i: s.i + 1, k: s.k + 1, star: s.star, anchor: s.anchor || run >= threshold && adjacent,
          run, text: s.text + word[s.k] });
      }
    }
  }
  return [];
}

/** Match concrete scaffolds using the same case-insensitive token predicates, preserving original character ranges. */
function fits(parts: string[], parsed: Token[][], path: string[], b: Budget): boolean {
  const segment = (ts: Token[], text: string): boolean => {
    const queue = [[0, 0]], seen = new Set<string>();
    for (let q = 0; q < queue.length; q++) {
      spend(b);
      const [i, j] = queue[q]!, key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (i === ts.length && j === text.length) return true;
      const t = ts[i!];
      if (t?.kind === "star") { queue.push([i! + 1, j!]); if (j! < text.length) queue.push([i!, j! + 1]); }
      else if (t && j! < text.length && t.accepts(text[j!]!)) queue.push([i! + 1, j! + 1]);
    }
    return false;
  };
  const visit = (i: number, j: number): boolean => {
    spend(b);
    if (i === parts.length) return j === path.length;
    if (parts[i] === "**") return visit(i + 1, j) || j < path.length && visit(i, j + 1);
    return j < path.length && segment(parsed[i]!, path[j]!) && visit(i + 1, j + 1);
  };
  return visit(0, 0);
}

interface SpellingProof { patterns: string[]; witnesses: string[]; unresolved?: "syntax" | "budget" }
/** Witnesses are concrete paths, subsequently checked by the canonical literal rules, never trusted as risks on their own. */
export function globSpellingProof(raw: string): SpellingProof {
  const b: Budget = { steps: 0 };
  try {
    const patterns = expand(raw, b), witnesses = new Set<string>();
    for (const pattern of patterns) {
      const parts = pattern.split("/"), parsed = parts.map(tokens), defaults = parsed.map(ts => ts.map(t => t.value).join(""));
      for (let i = 0; i < parsed.length; i++) for (const word of WORDS) {
        if (parsed[i]!.every(t => t.kind === "literal")) continue;
        for (const witness of spelling(parsed[i]!, word, b)) {
          const path = defaults.map((p, j) => j === i ? witness : p);
          witnesses.add(path.join("/"));
          // ledger-checks is scoped to src/lib; worker patterns are scoped to web/public, with arbitrary descendants.
          for (const scaffold of [["src", "lib", witness], ["web", "public", ...path.slice(2)]]) {
            if (fits(parts, parsed, scaffold, b)) witnesses.add(scaffold.join("/"));
          }
        }
      }
    }
    return { patterns, witnesses: [...witnesses] };
  } catch (e) {
    // Unsupported syntax and exhausted state budgets are explicit owner outcomes; the exception never authorizes a proposal.
    return { patterns: [], witnesses: [], unresolved: e instanceof Error && e.message === "budget" ? "budget" : "syntax" };
  }
}

export interface GlobProtectionContext {
  project: string;
  db: () => Database;
  now: () => number;
  policy?: RecoveryPolicyPort;
}
export const globProtectionMode = (ctx?: GlobProtectionContext): RecoveryMode => ctx ? (ctx.policy ?? recoveryPolicy)(ctx.project, KEY).mode : "off";

/** Samples contain only added canonical evidence. A failed audit must never change observe's business result. */
export function observeGlobProtection(ctx: GlobProtectionContext, r: ProposalRecord, base: AutoHit[], next: AutoHit[],
  evidence: (hits: AutoHit[]) => AutoHitEvidence): void {
  const added = next.filter(h => !base.some(x => x.reason === h.reason && x.source === h.source));
  if (!added.length) return;
  const hash = createHash("sha256").update(JSON.stringify([r.proposalId, r.proposalRev, r.operation.proposalDigest, added])).digest("hex");
  try {
    recordObserved(ctx.db(), { project: ctx.project, mechanism: KEY, target: "", actionKey: hash, action: "将新增 glob 拼写命中交 owner",
      data: { proposalId: r.proposalId, proposalRev: r.proposalRev, oldReasons: [...new Set(base.map(h => h.reason))],
        newReasons: [...new Set(next.map(h => h.reason))], added: evidence(added).hits, addedOmitted: Math.max(0, added.length - 10) } }, ctx.now());
  } catch (e) { console.warn(`[proposal-glob-protection] observe sample failed: ${(e as Error).name}`); }
}

/**
 * S2D2 acceptance 1: the inventories (scheduler-v2-skip-paths.ts, scheduler-v2-skip-effects.ts) equal what the code does. The scan
 * follows schedulerPass's static imports and counts every side-effect site (ledger call by any callee, SQL write, process, file
 * write, notice, git / gh) per file; a new awaited step, subcommand, effect file or site that is not registered turns this red.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULER_V2_LEDGER_COMMANDS } from "../src/lib/scheduler-v2-ledger-cmds-args.js";
import { SKIP_EFFECT_FILES } from "../src/lib/scheduler-v2-skip-effects.js";
import { SCHEDULER_PASS_PATHS, SKIP_LEDGER_COMMANDS, SKIP_LEDGER_DYNAMIC, type SchedulerPassPath } from "../src/lib/scheduler-v2-skip-paths.js";

const LIB = join(import.meta.dir, "..", "src", "lib");
const source = (file: string) => readFileSync(join(LIB, file), "utf8");

/**
 * Blank `//` and `/* *\/` comments (JSDoc included) to spaces, keeping newlines. Quote-aware: `//` or `/*` inside a string, a
 * template literal (with `${}` nesting) or a regex literal is code, not a comment. A `/` starts a regex wherever an expression may
 * start: after an operator, `=>`, a keyword like `return` / `else`, a `)` that closes an `if` / `while` / `for` / `with` head, or a
 * `}` that closes a block. When unsure it reads a regex (copying code verbatim is safe; a missed regex could blank real code),
 * and an unterminated `/*` is left as code. The keyword look-back reads code with comments and whitespace collapsed, so no
 * comment or gap between `if` and `(` can push the keyword out of view.
 */
function stripComments(src: string): string {
  let out = "", i = 0, prev = ""; // prev: last significant code token, to tell a regex `/` from a division
  let sig = ""; // recent code with each comment / whitespace run collapsed to one space, for the keyword look-back
  const parens: boolean[] = []; // per open `(`: whether it is a control-flow head
  const braces: ("block" | "expr" | "tmpl")[] = []; // per open `{` / `${`
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const tail = () => sig.trimEnd(); // the keyword checks only need the last word
  const put = (s: string, code = true) => { out += code ? s : blank(s); sig = (sig + (code ? s : " ")).replace(/\s+/g, " ").slice(-64); };
  const keyword = () => /(?:^|[^\w$.])(?:return|typeof|case|of|in|instanceof|new|delete|void|yield|await|throw|else|do)$/.test(tail());
  const exprStart = () => prev === "" || prev === "=>" || /^[(,=:[!&|?{;+\-*%<>~^]$/.test(prev) || keyword();
  const quoted = (q: string) => { // copy a string from its opening quote through the closing one
    let j = i + 1;
    while (j < src.length && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    put(src.slice(i, j + 1)); i = j + 1;
  };
  const template = () => { // from after a backtick or a closing `}` of `${`, to the closing backtick or the next `${`
    let j = i;
    while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
    if (src[j] === "$") { put(src.slice(i, j + 2)); i = j + 2; braces.push("tmpl"); prev = "{"; }
    else { put(src.slice(i, j + 1)); i = j + 1; prev = "`"; }
  };
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; put(src.slice(i, end), false); i = end; }
    else if (c === "/" && n === "*" && src.includes("*/", i + 2)) { const end = src.indexOf("*/", i + 2) + 2; put(src.slice(i, end), false); i = end; }
    else if (c === "'" || c === '"') { quoted(c); prev = c; }
    else if (c === "`") { put(c); i++; template(); }
    else if (c === "/" && exprStart()) {
      let j = i + 1, cls = false; // regex literal: skip escapes and `[...]` classes
      while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
      put(src.slice(i, j + 1)); i = j + 1; prev = "/re";
    } else if (c === "}" && braces[braces.length - 1] === "tmpl") { braces.pop(); put(c); i++; template(); }
    else {
      if (c === "(") parens.push(/(?:^|[^\w$.])(?:if|while|for|with)$/.test(tail()));
      // an object literal follows an operator or keyword; a block follows `)`, `=>`, `;`, `{`, `}`, `else`, a name, ...
      if (c === "{") braces.push(/^[(,=:[!&|?+\-*%<>~^]$/.test(prev) || (prev === "w" && keyword() && !/(?:else|do)$/.test(tail())) ? "expr" : "block");
      const closed = c === ")" ? parens.pop() : c === "}" ? braces.pop() === "block" : false;
      put(c); i++;
      if (closed) prev = ";";
      else if (c === ">" && prev === "=" && src[i - 2] === "=") prev = "=>";
      else if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? "w" : c;
    }
  }
  return out;
}
// the gate and its inventories name commands and effects as data; they send nothing
const isGate = (f: string) => f.startsWith("scheduler-v2-skip");
const libFiles = () => readdirSync(LIB).filter((f) => f.endsWith(".ts"));
type Src = { name: string; text: string };

/** Files reachable from schedulerPass and its injected steps through value imports (`import type` carries no code). */
function passGraph(read: (f: string) => string = source, exists = (f: string) => existsSync(join(LIB, f))): Src[] {
  const seen = new Map<string, string>(), queue = ["scheduler-pass.ts", ...SCHEDULER_PASS_PATHS.map((p) => p.file)];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    const text = stripComments(read(f));
    seen.set(f, text);
    const deps = [...text.matchAll(/(?:^|;)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+"\.\/([\w.-]+)\.js"/gm)].filter((m) => !m[1]).map((m) => m[2]!)
      .concat([...text.matchAll(/\bimport\(\s*"\.\/([\w.-]+)\.js"\s*\)/g)].map((m) => m[1]!));
    for (const d of deps) if (exists(`${d}.ts`)) queue.push(`${d}.ts`);
  }
  return [...seen].map(([name, text]) => ({ name, text })).filter((f) => !isGate(f.name));
}

const EFFECTS: Record<string, RegExp> = {
  ledger: /(?:\[\s*"ledger"\s*,|(?<!\b(?:statePath|join|resolve))\(\s*"ledger"\s*,|\b(?:recoveryWrite|ledgerWrite)\()/g,
  // SQL is case-insensitive; `stmt` counts the execution API (bun:sqlite `.run(`, `db.exec(`) whatever the SQL text looks like
  sql: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+(?:OR\s+\w+\s+)?\S+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\b/gi,
  stmt: /\.run\s*\(|\b\w*(?:[dD]b|[dD]atabase)\s*\.exec\s*\(/g,
  proc: /\b(?:Bun\.spawn|Bun\.spawnSync|spawnSync|spawn|execFile|execFileSync|execSync|runBounded|runManagerProcess|tmuxRaw|tmuxFire|tmuxInterrupt)\s*\(/g,
  fs: /\b(?:writeFileSync|writeFile|renameSync|rename|rmSync|rm|unlinkSync|unlink|appendFileSync|mkdirSync|copyFileSync|symlinkSync)\s*\(/g,
  // an effect API imported or destructured under another name (`unlink as drop`, `{ spawn: run }`)
  alias: new RegExp(`\\b(?:${["writeFileSync", "writeFile", "renameSync", "rename", "rmSync", "rm", "unlinkSync", "unlink", "appendFileSync", "mkdirSync",
    "copyFileSync", "symlinkSync", "spawnSync", "spawn", "execFileSync", "execFile", "execSync"].join("|")})(?:\\s+as|\\s*:)\\s+[A-Za-z_$][\\w$]*\\s*[,}]`, "g"),
  notice: /\b(?:notifyProjectPm|bridgeSend|notify)\s*\(/g,
  vcs: /\[\s*"(?:git|gh)"\s*,|\b(?:git|gh)\(\s*\[/g,
};

/** file → site counts, only files with at least one site. */
function effectSites(files: Src[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { name, text } of files) {
    const sig = Object.entries(EFFECTS).map(([k, r]) => [k, [...text.matchAll(r)].length] as const).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(" ");
    if (sig) out.set(name, sig);
  }
  return out;
}

const registered = (): Map<string, string> => new Map(Object.values(SKIP_EFFECT_FILES).flatMap((byFile) => Object.entries(byFile)));

/** Literal subcommands sent by any callee (`x("ledger", "<sub>"`, `["ledger", "<sub>"`, `recoveryWrite(m, "<sub>"`, `ledgerWrite(c, ["<sub>"`). */
function ledgerCalls(files: Src[]): { literal: Set<string>; dynamic: Set<string> } {
  const literal = new Set<string>(), dynamic = new Set<string>();
  for (const { name, text } of files) {
    for (const m of text.matchAll(/(?:\[|(?<!\b(?:statePath|join|resolve))\()\s*"ledger"\s*,\s*("([a-z][a-z-]*)"|[^\s"])/g)) {
      if (m[2]) literal.add(m[2]);
      else dynamic.add(name);
    }
    for (const m of text.matchAll(/\brecoveryWrite\([^,]+,\s*"([a-z-]+)"/g)) literal.add(m[1]!);
    for (const m of text.matchAll(/\bledgerWrite\(\s*\w+\s*,\s*(?:\[\s*|[\w.]+\s*,\s*)"([a-z][a-z-]*)"/g)) literal.add(m[1]!);
  }
  return { literal, dynamic };
}

/** The callee after every `await` inside schedulerPass (`opts.x` for `(opts.x ?? …)` / `opts.x!(…)`). */
function passSteps(text: string): string[] {
  const start = text.indexOf("export async function schedulerPass(");
  expect(start).toBeGreaterThan(-1);
  const body = text.slice(start);
  const out: string[] = [];
  for (const m of body.matchAll(/\bawait\s+([^;]*)/g)) {
    const rest = m[1]!.replace(/^[\s(]+/, "");
    const opt = /^opts\.(\w+)/.exec(rest), name = /^([\w.]+)/.exec(rest);
    out.push(opt ? `opts.${opt[1]}` : name![1]!);
  }
  return [...new Set(out)];
}

describe("S2D2 path inventory", () => {
  test("every awaited step of schedulerPass is listed, and nothing else", () => {
    const steps = passSteps(source("scheduler-pass.ts"));
    expect(steps.sort()).toEqual(SCHEDULER_PASS_PATHS.map((p) => p.step).sort());
  });

  test("an unregistered new step turns the inventory check red", () => {
    const text = source("scheduler-pass.ts").replace("failed.push(...(await lendTakeoverStep",
      "failed.push(...(await newPushStep(db)).failed);\n      failed.push(...(await lendTakeoverStep");
    expect(passSteps(text)).toContain("newPushStep");
    expect(SCHEDULER_PASS_PATHS.map((p) => p.step)).not.toContain("newPushStep");
  });

  test("every listed path names a real function in a real file; every card-effect path has a gate", () => {
    for (const p of SCHEDULER_PASS_PATHS) {
      const fn = p.fn.replace(/\(\)\..*$/, "").replace(/^.*\./, "");
      expect(source(p.file)).toMatch(new RegExp(`\\b${fn}\\b`));
      if (p.effects.length) expect(p.gates.filter((g) => g !== "none").length).toBeGreaterThan(0);
    }
  });

  test("hook-gated paths call the S2D2 gate; pace-gated loops ask skipTask", () => {
    // Modules inside the gate's own import closure get their hook handed over by scheduler-v2-skip.ts (an import would cycle).
    const handed: Record<string, RegExp[]> = {
      "lend-pr-takeover.ts": [/takeoverSkip\?\.\(db, r\.taskId\)/],
      "scheduler-retire-deps.ts": [/reconcileFinishedCardLeases\(/],
    };
    for (const p of SCHEDULER_PASS_PATHS.filter((p: SchedulerPassPath) => p.gates.includes("hook"))) {
      for (const re of handed[p.file] ?? [/from "\.\/scheduler-v2-skip\.js"/]) expect(source(p.file)).toMatch(re);
    }
    const lease = source("ledger-scheduler-lease-finished.ts");
    expect(lease).toContain("isProjectionGuarded(db, row.id) || finishedLeaseSkip.card?.(db, row.id)");
    expect(lease).toContain('${finishedLeaseSkip.exclude?.(db, "t") ?? ""}');
    const gate = source("scheduler-v2-skip.ts");
    for (const s of ["configureTakeoverSkip(schedulerV2SkipTask)", "finishedLeaseSkip.card = schedulerV2SkipTask", "finishedLeaseSkip.exclude = excludeSkipCards"]) {
      expect(gate).toContain(s);
    }
    expect(source("scheduler-pass.ts")).toContain("schedulerV2SkipManager(db, schedulerV2PassManager(");
    expect(source("agent-supervisor-deps.ts")).toContain("schedulerV2SkipManager(db, schedulerManagerWith(lease))");
    expect(source("agent-lifecycle-deps.ts")).toContain("schedulerV2Lifecycle(db, runLifecycle)(plan, policy, {");
    // the checkout cleanup's file effects (archive, each unlink) ask the lifecycle gate's `effect` right before they start
    const cleanup = source("agent-lifecycle-cleanup.ts");
    expect(cleanup.match(/const stop = deps\.effect\?\.\(/g)).toHaveLength(2);
    expect(cleanup).toMatch(/deps\.effect\?\.\(real\); if \(stop\) return stop;\n\s+const r = await archiveSurvey\(/);
    expect(cleanup).toMatch(/deps\.effect\?\.\(join\(real, e\.path\)\);.*\n\s+const err = await unlink\(/);
    expect(source("scheduler-v2-skip-lifecycle.ts")).toContain("effect: (p) => {");
    const paced = ["scheduler-yield.ts", "scheduler-service.ts", "scheduler-deploy-tick.ts", "scheduler-spec-resume.ts", "scheduler-autostart-resume.ts"];
    for (const f of paced) expect(source(f)).toContain("skipTask?.(");
    // S2D2C: deployTick is wired — its in-flight rows ask the unified gate too (with or without a pace) and are only observed (E26)
    const deploy = source("scheduler-deploy-tick.ts");
    expect(deploy).toMatch(/from "\.\/scheduler-v2-skip\.js"/);
    expect(deploy).toContain("if (pace?.skipTask?.(run.taskId) || schedulerV2SkipTask(db, run.taskId)) return heldInFlight(d, db, run, pace);");
  });

  test("peerPr is featureless: intake never binds a feature to the card it creates", () => {
    const peer = SCHEDULER_PASS_PATHS.find((p) => p.step === "opts.peerPr")!;
    expect(peer.gates).toContain("featureless");
    for (const f of libFiles().filter((f) => f.startsWith("peer-pr-"))) expect(source(f)).not.toMatch(/featureId|sharedFeatureId/);
    expect(readFileSync(join(import.meta.dir, "..", "src", "manager", "ledger-peer-pr-cmds.ts"), "utf8")).not.toMatch(/featureId|sharedFeatureId/);
  });
});

describe("S2D2 effect-site inventory", () => {
  const diff = (scan: Map<string, string>, reg: Map<string, string>) => [...new Set([...scan.keys(), ...reg.keys()])].sort()
    .filter((f) => scan.get(f) !== reg.get(f)).map((f) => `${f}: code "${scan.get(f) ?? "-"}" registered "${reg.get(f) ?? "-"}"`);

  test("every reachable file with a side-effect site is registered under one gate with its exact site counts", () => {
    expect(diff(effectSites(passGraph()), registered())).toEqual([]);
    const files = Object.values(SKIP_EFFECT_FILES).flatMap((byFile) => Object.keys(byFile));
    expect(files.length).toBe(new Set(files).size);
  });

  test("red on an aliased ledger or file call, a direct SQL write in any case or a new effect file added inside existing functions", () => {
    const patched = (file: string, find: string, add: string) => (f: string) => {
      const text = source(f);
      if (f !== file) return text;
      expect(text).toContain(find);
      return text.replace(find, `${find}\n${add}`);
    };
    // an alias of the manager under a new name, in a function that already writes
    const alias = passGraph(patched("scheduler-lock-yield-deps.ts", "const wire =", '  const write = manager; await write("ledger", "scheduler-brand-new", c.taskId);'));
    expect(diff(effectSites(alias), registered())).toEqual(['scheduler-lock-yield-deps.ts: code "ledger=3" registered "ledger=2"']);
    expect([...ledgerCalls(alias).literal].filter((x) => !Object.hasOwn(SKIP_LEDGER_COMMANDS, x))).toEqual(["scheduler-brand-new"]);
    // a direct write in the existing finished-lease sweep, no ledger CLI involved
    const sql = passGraph(patched("ledger-scheduler-lease-finished.ts", "    assertActive();\n    tx(db, () => {",
      '      db.query("DELETE FROM scheduler_resources WHERE taskId = ?").run(row.id);'));
    expect(diff(effectSites(sql), registered())).toEqual(['ledger-scheduler-lease-finished.ts: code "sql=8 stmt=8" registered "sql=7 stmt=7"']);
    // the same write in lower case (valid SQLite), before the skip check of the reachable reconcile loop
    const lower = passGraph(patched("ledger-scheduler-lease-finished.ts", "  for (const row of tasks) {",
      '    db.query("delete from scheduler_resources where taskId = ?").run(row.id);'));
    expect(diff(effectSites(lower), registered())).toEqual(['ledger-scheduler-lease-finished.ts: code "sql=8 stmt=8" registered "sql=7 stmt=7"']);
    // SQL text the scan cannot read (a constant from elsewhere): the statement execution still counts
    const opaque = passGraph(patched("ledger-scheduler-lease-finished.ts", "  for (const row of tasks) {", "    db.query(DROP_LOCKS).run(row.id);"));
    expect(diff(effectSites(opaque), registered())).toEqual(['ledger-scheduler-lease-finished.ts: code "sql=7 stmt=8" registered "sql=7 stmt=7"']);
    // a file API under another name: the renaming import counts even though `drop(` matches no effect name
    const renamed = passGraph(patched("scheduler-lock-yield-deps.ts", "const wire =", 'import { unlink as drop } from "node:fs/promises";'));
    expect(diff(effectSites(renamed), registered())).toEqual(['scheduler-lock-yield-deps.ts: code "ledger=2 alias=1" registered "ledger=2"']);
    // a brand-new module the pass reaches through a new import in an existing file; a type-only import is not followed
    const extra: Record<string, string> = { "zz-new-effect.ts": 'export const go = () => Bun.spawn(["gh", "pr", "merge"]);',
      "zz-type-only.ts": 'export type Go = () => void; export const x = () => Bun.spawn(["gh"]);' };
    const added = passGraph((f) => extra[f] ?? (f === "scheduler-lock-yield-deps.ts"
      ? `import { go } from "./zz-new-effect.js"; import type { Go } from "./zz-type-only.js";\n${source(f)}` : source(f)),
    (f) => f in extra || existsSync(join(LIB, f)));
    expect(diff(effectSites(added), registered())).toEqual(['zz-new-effect.ts: code "proc=1 vcs=1" registered "-"']);
  }, 30_000); // six full scans of the pass graph

  test("comments are not effect sites; a real call next to them still is (train 98: S2V2's `rm (V2Held` comment)", () => {
    const patched = (add: string) => passGraph((f) => {
      const text = source(f), find = "    if (\"gone\" in v) {";
      if (f !== "scheduler-retire-tmp.ts") return text;
      expect(text).toContain(find);
      return text.replace(find, `${add}\n${find}`);
    });
    const comments = patched("    // refusing the rm (V2Held ...) and the rm (x)\n    /**\n     * unlink (y), writeFile (z)\n     */\n    const s = \"a // b\"; /* spawn (q) */");
    expect(diff(effectSites(comments), registered())).toEqual([]);
    const real = patched("    // the rm (x)\n    await rm(x);");
    expect(diff(effectSites(real), registered())).toEqual(['scheduler-retire-tmp.ts: code "fs=4 alias=2" registered "fs=3 alias=2"']);
  });

  test("comment stripping keeps strings, templates and regex literals intact", () => {
    const keep = [
      'const u = "http://x/*y*/"; const v = \'// not a comment\';',
      "const t = `a // b ${f(\"/*\")} /* c */ ${{ k: `// d` }.k}`;",
      "const r = /\\/\\/[/*]x/g, q = a / b / c;",
      // an expression statement may start with a regex after a control-flow head, a block, `else`, `=>` (round 5 probe)
      'if (true) /[/*]/.test("x");\nwhile (f(a)) /[/*]/.test(y);\nfor (;;) /[/*]/g;',
      "if (a) { b(); } /[/*]/.test(x);\nfunction f() { } /[/*]/.exec(z);\nelse /[/*]/.test(w);\nconst g = () => /[/*]/;",
      "const o = { a: 1 } / 2 / 3, p = (a) / 2 /* x */;".replace(" /* x */", ""),
      "x = a /* unterminated",
    ];
    for (const k of keep) expect(stripComments(k)).toBe(k);
    expect(stripComments('a(); // rm (x)\n/** unlink (y)\n */ b("//");')).toBe(`a();${" ".repeat(10)}\n${" ".repeat(14)}\n    b("//");`);
    expect(stripComments("x = `${y}` // z")).toBe("x = `${y}`     ");
    expect(stripComments("if (a) { b(); } /* c */ d();")).toBe(`if (a) { b(); } ${" ".repeat(7)} d();`);
  });

  test("a regex holding `/*` cannot hide a real write that follows it (round 5 probe)", () => {
    const hidden = 'export function hidden(db: any,\ntaskId: string, sql: string) {\nif (true) /[/*]/.test("x");\ndb.query(sql).run(taskId);\n}\n';
    for (const at of ["end", "start"] as const) {
      const scan = passGraph((f) => {
        const text = source(f);
        return f !== "ledger-scheduler-lease-finished.ts" ? text : at === "end" ? `${text}\n${hidden}` : `${hidden}\n${text}`;
      });
      expect(diff(effectSites(scan), registered())).toEqual(['ledger-scheduler-lease-finished.ts: code "sql=7 stmt=8" registered "sql=7 stmt=7"']);
    }
  });

  test("a comment between a control keyword and its `(` cannot hide a real write either (round 6 probe)", () => {
    const why = "condition explanation ".repeat(5); // 110 characters, longer than any fixed look-back window
    const hidden = `export function hidden(db: any,\ntaskId: string, sql: string) {\nif /* ${why} */\n(true) /[/*]/.test("x");\ndb.query(sql).run(taskId); /* trailing comment */\n}\n`;
    const scan = passGraph((f) => (f === "ledger-scheduler-lease-finished.ts" ? `${source(f)}\n${hidden}` : source(f)));
    expect(diff(effectSites(scan), registered())).toEqual(['ledger-scheduler-lease-finished.ts: code "sql=7 stmt=8" registered "sql=7 stmt=7"']);
    // nor can comments, spaces or line breaks of any length there, on the bare scanner
    const sp = (n: number) => " ".repeat(n);
    for (const [gap, kept] of [[`/* ${why} */`, sp(why.length + 6)], [`// ${why}\n`, `${sp(why.length + 3)}\n`], [`\n${sp(120)}\n`, `\n${sp(120)}\n`]]) {
      expect(stripComments(`if ${gap} (a) /[/*]/.test(x); b(); /* c */`)).toBe(`if ${kept} (a) /[/*]/.test(x); b(); ${sp(7)}`);
    }
  });
});

describe("S2D2 ledger subcommands", () => {
  test("every ledger subcommand the pass can send is registered with its target argument", () => {
    const { literal, dynamic } = ledgerCalls(passGraph());
    expect([...literal].filter((s) => !Object.hasOwn(SKIP_LEDGER_COMMANDS, s))).toEqual([]);
    expect([...dynamic].sort()).toEqual(Object.keys(SKIP_LEDGER_DYNAMIC).sort());
    for (const subs of Object.values(SKIP_LEDGER_DYNAMIC)) for (const s of subs) expect(Object.hasOwn(SKIP_LEDGER_COMMANDS, s)).toBe(true);
    // a stale registration is caught too (only the dynamic-site commands may be absent from literal calls)
    const viaDynamic = new Set(Object.values(SKIP_LEDGER_DYNAMIC).flat());
    expect(Object.keys(SKIP_LEDGER_COMMANDS).filter((s) => !literal.has(s) && !viaDynamic.has(s))).toEqual([]);
  });

  test("an unregistered subcommand under any callee name, or a computed one, turns the scan red", () => {
    const fake = [{ name: "fake.ts", text: 'await write("ledger", "scheduler-brand-new", "TM"); await manager("ledger", ...xs);' }];
    const { literal, dynamic } = ledgerCalls(fake);
    expect([...literal].filter((s) => !Object.hasOwn(SKIP_LEDGER_COMMANDS, s))).toEqual(["scheduler-brand-new"]);
    expect([...dynamic]).toEqual(["fake.ts"]);
    // path strings that only look alike are not commands
    expect(ledgerCalls([{ name: "p.ts", text: 'statePath("ledger", "docs"); join(dir, "ledger", "docs")' }]).literal.size).toBe(0);
  });

  test("target arguments agree with S2Q's command table", () => {
    const same: Record<string, readonly string[]> = { task: ["task", "task-or-none"], intent: ["intent"], order: ["lend-order"],
      // session-bind / -retire: the first argument is the card; --intent is one of that card's intents
      "session-intent": ["task"] };
    // S2Q rows marked unmapped whose nominal target is not an argument: the gate resolves them by what the command acts on
    const own = new Set(["manual-merge-claim", "memory-auto", "peer-pr-intake"]);
    for (const [cmd, rule] of Object.entries(SCHEDULER_V2_LEDGER_COMMANDS)) {
      if (own.has(cmd)) continue;
      expect([cmd, same[rule.target]]).toEqual([cmd, expect.arrayContaining([SKIP_LEDGER_COMMANDS[cmd]])]);
    }
    expect(own.has("manual-merge-claim") && SKIP_LEDGER_COMMANDS["manual-merge-claim"]).toBe("manual-claim");
  });

  test("dynamic call sites can only produce their registered commands", () => {
    expect(source("scheduler-auto-tick.ts")).toMatch(/\["scheduler-stage", intent\.id[^\]]*\] : \["scheduler-ui-ask", intent\.id\]/);
    const wiring = libFiles().filter((f) => f.startsWith("scheduler-model-wiring")).map(source).join("\n");
    const subs = new Set([...wiring.matchAll(/ledgerWrite\(card, \["([a-z-]+)"/g)].map((m) => m[1]!));
    expect([...subs].sort()).toEqual([...SKIP_LEDGER_DYNAMIC["scheduler-model-wiring.ts"]!].sort());
    const recovery = new Set(libFiles().flatMap((f) => [...source(f).matchAll(/\brecoveryWrite\([^,]+,\s*"([a-z-]+)"/g)].map((m) => m[1]!)));
    expect([...recovery].sort()).toEqual([...SKIP_LEDGER_DYNAMIC["scheduler-recovery-ports.ts"]!].sort());
    const exits = new Set(passGraph().flatMap((f) => [...f.text.matchAll(/\bledgerWrite\(\s*call\s*,\s*[\w.]+\s*,\s*"([a-z-]+)"/g)].map((m) => m[1]!)));
    expect([...exits].sort()).toEqual([...SKIP_LEDGER_DYNAMIC["order-ledger-exit.ts"]!].sort());
  });
});

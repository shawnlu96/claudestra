import { expect, test } from "bun:test";
import { judgeScopeFile } from "../src/lib/ask-scope-auto-diff.js";
import type { ScopeProof } from "../src/lib/ask-scope-auto-proof.js";
import type { ScopeGrant } from "../src/lib/ask-scope-registry.js";

const own = "src/lib/card-feature.ts";
const proof: ScopeProof = { globs: [own], sources: new Map([[own, 'export const KEY = "cardFeature";\n']]), newFiles: new Set([own]) };
const effects: ScopeGrant = { path: "src/lib/scheduler-v2-skip-effects.ts", kind: "effects", check: "headScan" };
const inventory = (lines: string[]) => ["export const SKIP_EFFECT_FILES = {", "  pace: {", ...lines, "  },", "};", ""].join("\n");
const entry = (file: string, count = "fs=1") => `    "${file}": "${count}",`;

test("[验收线 1] own inventory add/delete/count/sort passes same full-table scan; wrong counts fail", () => {
  const a = entry("a.ts"), ownLine = entry("card-feature.ts"), z = entry("z.ts");
  const scan = new Map([["a.ts", "fs=1"], ["card-feature.ts", "fs=1"], ["z.ts", "fs=1"]]);
  for (const base of [inventory([a, z]), inventory([a, z, ownLine]), inventory([a, entry("card-feature.ts", "fs=2"), z])]) {
    expect(judgeScopeFile(effects, base, inventory([a, ownLine, z]), { ...proof, scan })).toBeNull();
  }
  expect(judgeScopeFile(effects, inventory([a, ownLine, z]), inventory([a, z]), { ...proof, scan: new Map([["a.ts", "fs=1"], ["z.ts", "fs=1"]]) })).toBeNull();
  expect(judgeScopeFile(effects, inventory([a, z]), inventory([a, entry("card-feature.ts", "fs=2"), z]), { ...proof, scan })).not.toBeNull();
  expect(judgeScopeFile(effects, inventory([a, z]), inventory([a, z, ownLine]), { ...proof, scan })).not.toBeNull();
});

test("[验收线 1] other card entries, gate moves, and edits outside entries stay outside", () => {
  const base = inventory([entry("a.ts"), entry("card-feature.ts")]);
  const scan = new Map([["a.ts", "fs=2"], ["card-feature.ts", "fs=1"]]);
  expect(judgeScopeFile(effects, base, base.replace('"a.ts": "fs=1"', '"a.ts": "fs=2"'), { ...proof, scan })).not.toBeNull();
  expect(judgeScopeFile(effects, base, base.replace("pace:", "writer:"), { ...proof, scan })).not.toBeNull();
  expect(judgeScopeFile(effects, base, base + "run();\n", { ...proof, scan })).not.toBeNull();
});

const defs = "src/lib/card-cmds.ts";
const cmdProof: ScopeProof = { globs: [defs], sources: new Map([[defs, 'export const CARD_CMDS = {\n  "card-command": { run() {} },\n};\n']]), newFiles: new Set([defs]) };
for (const [kind, table, start, end, added] of [
  ["skip-commands", "SKIP_LEDGER_COMMANDS", "{", "};", '  "card-command": "task",'],
  ["command-rules", "SCHEDULER_V2_LEDGER_COMMANDS", "Object.freeze({", "});", '  "card-command": rule("task", "executor"),'],
  ["services", "SCHEDULER_SERVICE_COMMANDS", "new Set([", "]);", '  "card-command",'],
] as const) {
  test(`[验收线 3] ${table} allows only own new entries inside that table`, () => {
    const base = `export const ${table} = ${start}\n${end}\n`;
    const head = `export const ${table} = ${start}\n${added}\n${end}\n`;
    const grant: ScopeGrant = { path: "src/lib/registry.ts", kind, check: table };
    expect(judgeScopeFile(grant, base, head, cmdProof)).toBeNull();
    expect(judgeScopeFile(grant, base, head.replace("card-command", "other-card"), cmdProof)).not.toBeNull();
    expect(judgeScopeFile(grant, base, head.replace(added, added + " evil();"), cmdProof)).not.toBeNull();
    expect(judgeScopeFile(grant, base, head + "evil();\n", cmdProof)).not.toBeNull();
  });
}

test("[验收线 3] manager table permits exactly one own import and one spread", () => {
  const grant: ScopeGrant = { path: "src/manager/ledger.ts", kind: "manager", check: "spread" };
  const base = "const COMMANDS = {\n};\n";
  const next = 'import { CARD_CMDS } from "../lib/card-cmds.js";\nconst COMMANDS = {\n  ...CARD_CMDS,\n};\n';
  expect(judgeScopeFile(grant, base, next, cmdProof)).toBeNull();
  expect(judgeScopeFile(grant, base, next.replace("  ...CARD_CMDS,", "  ...CARD_CMDS, ...OTHER_CMDS,"), cmdProof)).not.toBeNull();
  expect(judgeScopeFile(grant, base, next.replace("card-cmds.js", "other-cmds.js"), cmdProof)).not.toBeNull();
});

test("[验收线 3] quoted/commented fake definitions do not prove key ownership", () => {
  const grant: ScopeGrant = { path: "src/lib/recovery-keys.ts", kind: "keys", check: "keys" };
  const base = 'export const RECOVERY_KEYS = [\n] as const;\n';
  const next = base.replace("]", '  "cardFeature",\n]');
  for (const text of ['// export const KEY = "cardFeature";', 'export const fake = `\nexport const KEY = "cardFeature";\n`;']) {
    expect(judgeScopeFile(grant, base, next, { ...proof, sources: new Map([[own, text]]) })).not.toBeNull();
  }
});

test("[验收线 3] already-defined commands are not new, and deleted own keys use base definitions", () => {
  const grant: ScopeGrant = { path: "src/lib/shared-ledger-gate-cli-services.ts", kind: "services", check: "commands" };
  const base = "export const SCHEDULER_SERVICE_COMMANDS = new Set([\n]);\n";
  const next = base.replace("]);", '  "card-command",\n]);');
  expect(judgeScopeFile(grant, base, next, { ...cmdProof, baseSources: cmdProof.sources })).not.toBeNull();
  const keys: ScopeGrant = { path: "src/lib/recovery-keys.ts", kind: "keys", check: "keys" };
  const empty = "export const RECOVERY_KEYS = [\n] as const;\n";
  expect(judgeScopeFile(keys, empty.replace("]", '  "cardFeature",\n]'), empty,
    { ...proof, sources: new Map([[own, "export const replacement = true;\n"]]), baseSources: proof.sources })).toBeNull();
});

test("[验收线 1] inventory count updates cannot also edit comments", () => {
  const before = inventory([entry("card-feature.ts", "fs=2") + " // retained explanation"]);
  const after = inventory([entry("card-feature.ts") + " // changed explanation"]);
  expect(judgeScopeFile(effects, before, after, { ...proof, scan: new Map([["card-feature.ts", "fs=1"]]) })).not.toBeNull();
});

test("[验收线 3] entry-shaped data outside the registered table is not an exception", () => {
  const base = inventory([entry("card-feature.ts")]) + "const other = {\n};\n";
  const next = inventory([]) + "const other = {\n" + entry("card-feature.ts") + "\n};\n";
  expect(judgeScopeFile(effects, base, next, { ...proof, scan: new Map() })).not.toBeNull();
  const keys: ScopeGrant = { path: "src/lib/recovery-keys.ts", kind: "keys", check: "keys" };
  const template = 'const example = `\nexport const RECOVERY_KEYS = [\n] as const;\n`;\n';
  expect(judgeScopeFile(keys, template, template.replace("]", '  "cardFeature",\n]'), proof)).not.toBeNull();
});

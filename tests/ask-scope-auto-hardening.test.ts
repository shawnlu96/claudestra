import { posix } from "node:path";
import { expect, test } from "bun:test";
import { describeDeliveredScope } from "../src/lib/ask-scope-auto-display.js";
import { planScope } from "../src/lib/ask-scope-auto-plan.js";
import { judgeScopeFile } from "../src/lib/ask-scope-auto-diff.js";
import type { ScopeProof } from "../src/lib/ask-scope-auto-proof.js";

const source = "src/lib/card-feature.ts";
const context = { globs: [source], security: false, exists: () => true, locked: () => false };
const question = (path: string) => ({ class: "scope", files: [path],
  default: `只加 import 一行 + 调用 ≤3 行；判定逻辑放在本卡新文件 ${source}` });
const proof: ScopeProof = { globs: [source], newFiles: new Set([source]),
  sources: new Map([[source, 'export function feature(ctx: unknown) { return ctx; }\n']]) };
const before = 'export function host(ctx: unknown) {\n  return ctx;\n}\n';
const after = 'import { feature } from "./card-feature.js";\nexport function host(ctx: unknown) {\n  return feature(ctx);\n  return ctx;\n}\n';
const targets = [
  "src/lib/peer-scope-gate.ts", "src/lib/peer-secret-gate.ts", "src/lib/order-tool-route.ts", "src/lib/caller-identity.ts",
  "src/bridge/api-auth.ts", "src/bridge/terminal-auth.ts", "src/bridge/interrupt-gate.ts", "src/bridge/web-gateway.ts",
  "src/bridge/local-api/control.ts", "src/bridge/local-api/shared-projects-auth.ts",
  "src/lib/future-gate.ts", "src/lib/future-auth.ts", "src/lib/auth-future.ts", "src/lib/foo-gate-helper.ts",
  "src/lib/ledger-checks.ts", "src/lib/ledger-checks-future.ts",
];
for (const path of targets) {
  test(`[验收线 1] permission target rejected at declaration and exact-diff check: ${path}`, () => {
    expect(planScope(question(path), context)).toBeNull();
    const grant = { path, kind: "wire" as const, source, check: "wire" };
    const wired = after.replace("./card-feature.js", posix.relative(posix.dirname(path), source).replace(/\.ts$/, ".js").replace(/^(?!\.)/, "./"));
    expect(judgeScopeFile(grant, before, wired, proof)).not.toBeNull();
  });
}

test("[验收线 1] ordinary source wiring and registered service table remain eligible", () => {
  const path = "src/lib/host.ts";
  expect(planScope(question(path), context)?.[0].kind).toBe("wire");
  expect(judgeScopeFile({ path, kind: "wire", source, check: "wire" }, before, after, proof)).toBeNull();
  expect(planScope({ class: "scope", files: ["src/lib/shared-ledger-gate-cli-services.ts"], default: "只加本卡新命令的条目" }, context)?.[0].kind)
    .toBe("services");
});

const keys = { path: "src/lib/recovery-keys.ts", kind: "keys" as const, check: "keys" };
const empty = 'export const RECOVERY_KEYS = [\n] as const;\n';
const withKey = empty.replace("]", '  "existingKey",\n]');
const keyProof = (next: string, base?: string): ScopeProof => ({ globs: [source], sources: new Map([[source, next]]),
  baseSources: base === undefined ? undefined : new Map([[source, base]]), newFiles: new Set() });

test("[验收线 4] exported function and exported identifier do not own a recovery key", () => {
  for (const definition of ['export function existingKey() {}\n', 'export const existingKey = true;\n', 'export const existingKey = "otherKey";\n']) {
    expect(judgeScopeFile(keys, withKey, empty, keyProof(definition, definition))).not.toBeNull();
    expect(judgeScopeFile(keys, empty, withKey, keyProof(definition))).not.toBeNull();
  }
});

test("[验收线 4] literal definitions prove additions at head and deletions only at base", () => {
  const definition = 'export const KEY = "existingKey";\n';
  expect(judgeScopeFile(keys, empty, withKey, keyProof(definition))).toBeNull();
  expect(judgeScopeFile(keys, withKey, empty, keyProof("export const replacement = true;\n", definition))).toBeNull();
  expect(judgeScopeFile(keys, withKey, empty, keyProof(definition, "export const replacement = true;\n"))).not.toBeNull();
  expect(judgeScopeFile(keys, empty, withKey, keyProof("export const replacement = true;\n", definition))).not.toBeNull();
});

test("[验收线 4] continued string expressions cannot claim their literal prefix as a key", () => {
  for (const definition of ['export const KEY = "existingKey"\n+ "suffix";\n', 'export const KEY = "existingKey"\n.toUpperCase();\n']) {
    expect(judgeScopeFile(keys, empty, withKey, keyProof(definition))).not.toBeNull();
    expect(judgeScopeFile(keys, withKey, empty, keyProof(definition, definition))).not.toBeNull();
  }
  expect(judgeScopeFile(keys, empty, withKey, keyProof('export const KEY = "existingKey"\n'))).toBeNull();
});

test("[验收线 4] changing one own key preserves unrelated entries whose definition disappeared", () => {
  const base = 'export const RECOVERY_KEYS = [\n  "alpha",\n  "existingKey",\n] as const;\n';
  const next = base.replace('  "existingKey",\n', '');
  const context = keyProof('export const unrelated = true;\n', 'export const A = "alpha";\nexport const KEY = "existingKey";\n');
  expect(judgeScopeFile(keys, base, next, context)).toBeNull();
});


test("[验收线 2] current mode partitions approved files while preserving unrelated facts and shared-card notes", () => {
  const line = '"src/lib/host.ts"：+2 / -0（2 行）；与 T2 共改，冲突两边保留';
  const other = '"src/lib/other.ts"：+1 / -1（2 行）';
  const body = ["规格外文件（相对 PR base）：", line, other].join("\n");
  const evidence = { askScopeAuto: { rule: "ask-scope-auto/v1", files: [
    { path: "src/lib/host.ts", kind: "wire", added: 2, deleted: 0, granted: true },
    { path: "src/lib/other.ts", kind: "keys", added: 1, deleted: 1, granted: false },
  ] } };
  const stored = describeDeliveredScope(body, evidence);
  expect(stored).toStartWith(body);
  const review = describeDeliveredScope(stored, evidence, "on").split("已自动核准：");
  expect(review[0]).toContain(other);
  expect(review[0]).not.toContain(line);
  expect(review[1]).toContain(line);
  for (const mode of ["off", "observe"] as const) expect(describeDeliveredScope(stored, evidence, mode)).toBe(body);
  expect(describeDeliveredScope(stored, { askScopeAuto: { ...evidence.askScopeAuto, rule: "old" } }, "on")).toBe(body);
});

test("[验收线 2] old delivery events recover spliced files from recorded proof after rollback", () => {
  const evidence = { askScopeAuto: { rule: "ask-scope-auto/v1", files: [
    { path: "src/lib/host.ts", kind: "wire", added: 2, deleted: 0, granted: true },
  ] } };
  for (const mode of ["off", "observe"] as const) {
    const review = describeDeliveredScope("规格外文件：无（相对 PR base）", evidence, mode);
    expect(review).toContain("规格外文件（相对 PR base）：");
    expect(review).toContain('"src/lib/host.ts"：+2 / -0（2 行）');
    expect(review).not.toContain("已自动核准");
  }
});

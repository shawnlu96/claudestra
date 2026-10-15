import { expect, test } from "bun:test";
import { planScope, type ScopeContext } from "../src/lib/ask-scope-auto-plan.js";
import { judgeScopeFile } from "../src/lib/ask-scope-auto-diff.js";

const source = "src/lib/card-feature.ts";
const ctx: ScopeContext = {
  globs: [source], security: false, exists: () => true, locked: () => false,
};
const q = (files: string[], text: string) => ({ class: "scope" as const, default: text, files });
const wire = q(["src/lib/host.ts"], `只加 import 一行 + 调用 ≤3 行；判定逻辑放在本卡新文件 ${source}`);

test("[验收线 1] registry recognizes own sorting and keys; refuses unrelated changes", () => {
  expect(planScope(q(["src/lib/scheduler-v2-skip-effects.ts"], "只将本卡三行挪到字母序位置"), ctx)?.[0].kind).toBe("effects");
  expect(planScope(q(["src/lib/recovery-keys.ts"], "只按字母序加本卡键一行"), ctx)?.[0].kind).toBe("keys");
  expect(planScope(q(["src/lib/recovery-keys.ts"], "删除别的卡的键"), ctx)).toBeNull();
  expect(planScope(q(["src/lib/scheduler-v2-skip-effects.ts"], "修改本卡条目的 gate 分类"), ctx)).toBeNull();
});

test("[验收线 2] wiring requires all five conditions", () => {
  expect(planScope(wire, ctx)?.[0]).toMatchObject({ kind: "wire", source });
  for (const context of [{ ...ctx, security: true }, { ...ctx, exists: () => false }, { ...ctx, locked: () => true }]) {
    expect(planScope(wire, context)).toBeNull();
  }
  expect(planScope({ ...wire, risk: "permission" }, ctx)).toBeNull();
  expect(planScope({ ...wire, default: undefined }, ctx)).toBeNull();
  for (const path of ["src/lib/recovery-key-class.ts", "src/lib/recovery-key-defaults.ts", "scripts/guard/baseline.json"]) {
    expect(planScope({ ...wire, files: [path] }, ctx)).toBeNull();
  }
  expect(planScope({ ...wire, default: wire.default + "，另改默认开关" }, ctx)).toBeNull();
  expect(planScope(wire, { ...ctx, globs: ["src/lib/other.ts"] })).toBeNull();
});

const files = new Map([[source, 'export function feature(ctx: unknown) { return ctx; }\nexport const KEY = "cardFeature";\n']]);
const before = 'export function host(ctx: unknown) {\n  return ctx;\n}\n';
const after = 'import { feature } from "./card-feature.js";\nexport function host(ctx: unknown) {\n  feature(ctx);\n  return ctx;\n}\n';
const wirePlan = { path: "src/lib/host.ts", kind: "wire" as const, source, check: "import 一行 + 调用 ≤3 行" };
const judge = (text: string) => judgeScopeFile(wirePlan, before, text, { globs: [source], sources: files, newFiles: new Set([source]) });

test("[验收线 3] checks actual wire diff, not claimed lines", () => {
  expect(judge(after)).toBeNull();
  expect(judge(after.replace("  feature(ctx);", "  feature(ctx);\n".repeat(4).trimEnd()))).not.toBeNull();
  expect(judge(after.replace("return ctx;", "return null;"))).not.toBeNull();
  expect(judge(after.replace("feature(ctx);", "feature(ctx); evil();"))).not.toBeNull();
  expect(judge(after.replace("feature(ctx);", "feature(evil());"))).not.toBeNull();
  expect(judgeScopeFile(wirePlan, before, after, { globs: [source], sources: files, newFiles: new Set() })).not.toBeNull();
});

test("[验收线 3] registry changes require real own definitions and unchanged skeleton", () => {
  const plan = { path: "src/lib/recovery-keys.ts", kind: "keys" as const, check: "recoveryKeysOrderProblem" };
  const base = 'export const RECOVERY_KEYS = [\n  "alpha",\n  "zeta",\n] as const;\n';
  const next = base.replace('  "zeta",', '  "cardFeature",\n  "zeta",');
  const context = { globs: [source], sources: files, newFiles: new Set([source]) };
  expect(judgeScopeFile(plan, base, next, context)).toBeNull();
  expect(judgeScopeFile(plan, base, next.replace('"cardFeature"', '"otherCard"'), context)).not.toBeNull();
  expect(judgeScopeFile(plan, base, next + 'evil();\n', context)).not.toBeNull();
  expect(judgeScopeFile(plan, base, next.replace('  "alpha",\n', ''), context)).not.toBeNull();
});

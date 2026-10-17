import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { planScope, type ScopeContext } from "../src/lib/ask-scope-auto-plan.js";
import { judgeScopeFile } from "../src/lib/ask-scope-auto-diff.js";
import type { ScopeProof } from "../src/lib/ask-scope-auto-proof.js";
import { scopeProtected, scopeWireProtected } from "../src/lib/ask-scope-registry.js";
import { ASK_SCOPE_CASE_KEY, useAskScopeCasePort } from "../src/lib/ask-scope-case-policy.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode } from "../src/lib/recovery-policy.js";

const source = "src/lib/card-feature.ts";
const ctx: ScopeContext = { globs: [source], security: false, exists: () => true, locked: () => false };
const ask = (files: string[]) => ({ class: "scope", files, default: `只加 import 一行 + 调用 ≤3 行；判定逻辑放在本卡新文件 ${source}` });
const proof: ScopeProof = { globs: [source], newFiles: new Set([source]),
  sources: new Map([[source, "export function feature(ctx: unknown) { return ctx; }\n"]]) };
const before = "export function host(ctx: unknown) {\n  return ctx;\n}\n";
const wired = (path: string) => `import { feature } from "${posix.relative(posix.dirname(path), source).replace(/\.ts$/, ".js").replace(/^(?!\.)/, "./")}";\n`
  + "export function host(ctx: unknown) {\n  return feature(ctx);\n  return ctx;\n}\n";
const deliver = (path: string) => judgeScopeFile({ path, kind: "wire", source, check: "wire" }, before, wired(path), proof);

let mode: RecoveryMode = "observe";
let observed: ObservedAction[] = [];
const fake = () => useAskScopeCasePort({ policy: () => ({ mode, manualAfterMs: null, source: "config" }), observe: (a) => { observed.push(a); } });
afterEach(() => { useAskScopeCasePort(); mode = "observe"; observed = []; });

const variants = [
  "src/lib/Peer-Scope-Gate.ts", "src/bridge/API-AUTH.ts", "src/lib/ASK-SCOPE-registry.ts", "src/lib/Ledger-Checks.ts",
  "src/lib/Ledger-Checks-Future.ts", "src/lib/Recovery-Key-Class.ts", "src/lib/Order-Ask-x.ts", "src/lib/Future-GATE.ts",
];

test("[验收线 1] 复现：基线(off)下大小写变体在提问侧被自动答、交付侧放行；on 后两侧都拒", () => {
  fake();
  mode = "off";
  for (const path of variants) {
    expect(planScope(ask([path]), ctx)?.[0]).toMatchObject({ path, kind: "wire" }); // red: the review's bypass
    expect(deliver(path)).toBeNull();
  }
  mode = "on";
  for (const path of variants) {
    expect(planScope(ask([path]), ctx)).toBeNull(); // green
    expect(deliver(path)).toBe("权限闸文件不自动接线");
  }
  expect(observed).toEqual([]);
});

test("[验收线 2] 固定表 / basename / 目录 / ledger-checks / Scripts/Guard 混合大小写：on 拦，observe 只记差异", () => {
  fake();
  mode = "on";
  for (const path of ["Scripts/Guard/check.ts", "scripts/GUARD/x.ts", "src/lib/ASK-SCOPE-AUTO.ts"]) expect(scopeProtected(path)).toBe(true);
  for (const path of variants) expect(scopeWireProtected(path)).toBe(true);
  // A case variant of a registry table file is neither that entry's grant nor a wiring target.
  expect(planScope({ class: "scope", files: ["src/lib/Recovery-Keys.ts"], default: "只按字母序加本卡键一行" }, ctx)).toBeNull();
  expect(deliver("src/lib/Recovery-Keys.ts")).not.toBeNull();
  mode = "observe";
  expect(scopeProtected("Scripts/Guard/check.ts")).toBe(false);
  expect(planScope(ask(["src/bridge/API-AUTH.ts"]), ctx)?.[0].path).toBe("src/bridge/API-AUTH.ts");
  expect(planScope(ask(["src/bridge/API-AUTH.ts"]), ctx)?.[0].path).toBe("src/bridge/API-AUTH.ts");
  expect(observed.map((a) => [a.mechanism, a.data?.path, a.data?.folded])).toEqual([
    [ASK_SCOPE_CASE_KEY, "Scripts/Guard/check.ts", "scripts/guard/check.ts"],
    [ASK_SCOPE_CASE_KEY, "src/bridge/API-AUTH.ts", "src/bridge/api-auth.ts"],
  ]); // one note per path + rule, repeated asks do not spam
  expect(observed.every((a) => /^[\w.:@/-]{1,120}$/.test(a.actionKey))).toBe(true);
});

test("[验收线 2] 原有小写保护在三档都不放宽", () => {
  fake();
  for (const m of ["off", "observe", "on"] as const) {
    mode = m;
    for (const path of ["src/lib/peer-scope-gate.ts", "src/bridge/api-auth.ts", "src/lib/ledger-checks.ts", "scripts/guard/x.ts", "src/lib/ask-scope-registry.ts"]) {
      expect(scopeWireProtected(path)).toBe(true);
      expect(planScope(ask([path]), ctx)).toBeNull();
    }
  }
  expect(observed).toEqual([]);
});

test("[验收线 3] 普通接线、混合大小写普通文件保留原路径；多文件任一保护命中整单不自动答", () => {
  fake();
  mode = "on";
  expect(planScope(ask(["src/lib/Host.ts"]), ctx)?.[0]).toMatchObject({ path: "src/lib/Host.ts", kind: "wire", source });
  expect(deliver("src/lib/Host.ts")).toBeNull();
  expect(planScope(ask(["src/lib/host.ts"]), ctx)?.[0].path).toBe("src/lib/host.ts");
  expect(planScope(ask(["src/lib/host.ts", "src/lib/Foo-AUTH.ts"]), ctx)).toBeNull();
  mode = "observe";
  expect(planScope(ask(["src/lib/host.ts", "src/lib/Foo-AUTH.ts"]), ctx)?.map((g) => g.path)).toEqual(["src/lib/host.ts", "src/lib/Foo-AUTH.ts"]);
});

test("[验收线 3] 真实文件身份：两个大小写文件各自校验、软链越界与新文件不因折叠放行", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopecase-")), outside = mkdtempSync(join(tmpdir(), "scopecase-out-"));
  try {
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    writeFileSync(join(dir, "src/lib/Host.ts"), "export const a = 1;\n");
    writeFileSync(join(outside, "x.ts"), "export const b = 1;\n");
    symlinkSync(join(outside, "x.ts"), join(dir, "src/lib/link.ts"));
    const exists = (path: string) => {
      try { return lstatSync(join(dir, path)).isFile() && realpathSync(join(dir, path)).startsWith(realpathSync(dir) + sep); } catch { return false; }
    };
    const real: ScopeContext = { ...ctx, exists };
    fake();
    for (const m of ["observe", "on"] as const) {
      mode = m;
      expect(planScope(ask(["src/lib/Host.ts"]), real)?.[0].path).toBe("src/lib/Host.ts");
      expect(planScope(ask(["src/lib/link.ts"]), real)).toBeNull(); // symlink escaping the repo
      expect(planScope(ask(["src/lib/new-file.ts"]), real)).toBeNull(); // new file / rename target
      const caseSensitive = !exists("src/lib/host.ts");
      // Case-sensitive FS: "host.ts" is another file and stays missing; folding never merges it with Host.ts.
      if (caseSensitive) expect(planScope(ask(["src/lib/host.ts"]), real)).toBeNull();
      expect(planScope(ask(["src/lib/Host.ts", "src/lib/host.ts"]), real)?.map((g) => g.path) ?? null)
        .toEqual(caseSensitive ? null : ["src/lib/Host.ts", "src/lib/host.ts"]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("[验收线 4] 默认 observe；恢复文件运行中切 on / off 立即生效，off 与基线一致，读档失败按基线", () => {
  expect(defaultRecoveryMode(ASK_SCOPE_CASE_KEY)).toBe("observe");
  const dir = mkdtempSync(join(tmpdir(), "scopecase-policy-")), path = join(dir, "recovery-policy.json");
  try {
    useAskScopeCasePort({ policy: (p, k) => recoveryPolicy(p, k, path), observe: (a) => { observed.push(a); } });
    const target = "src/bridge/API-AUTH.ts";
    expect(planScope(ask([target]), ctx)?.[0].path).toBe(target); // file missing = default observe
    expect(observed).toHaveLength(1);
    const set = (m: RecoveryMode) => writeFileSync(path, JSON.stringify({ projects: { "claude-orchestrator": { keys: { askScopeCaseFold: m } } } }));
    set("on");
    expect(planScope(ask([target]), ctx)).toBeNull();
    expect(deliver(target)).not.toBeNull();
    set("off");
    expect(planScope(ask([target]), ctx)?.[0].path).toBe(target);
    expect(deliver(target)).toBeNull();
    expect(observed).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ projects: { "claude-orchestrator": { mode: "on" } } }));
    expect(planScope(ask([target]), ctx)).toBeNull(); // project-wide on also covers the key
    writeFileSync(path, "{broken");
    expect(planScope(ask([target]), ctx)?.[0].path).toBe(target); // unreadable policy = stop = baseline, never stricter or looser
    useAskScopeCasePort({ policy: () => { throw new Error("boom"); }, observe: () => { throw new Error("ledger down"); } });
    expect(scopeWireProtected(target)).toBe(false);
    expect(scopeWireProtected("src/bridge/api-auth.ts")).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[验收线 4] observe 记账失败不改业务结论，下次重试", () => {
  let calls = 0;
  useAskScopeCasePort({ policy: () => ({ mode: "observe", manualAfterMs: null, source: "default" }), observe: () => { calls++; throw new Error("busy"); } });
  expect(scopeWireProtected("src/lib/Foo-Gate.ts")).toBe(false);
  expect(scopeWireProtected("src/lib/Foo-Gate.ts")).toBe(false);
  expect(calls).toBe(2);
});

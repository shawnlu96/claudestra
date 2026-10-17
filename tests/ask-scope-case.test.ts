import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { planScope, type ScopeContext } from "../src/lib/ask-scope-auto-plan.js";
import { judgeScopeFile } from "../src/lib/ask-scope-auto-diff.js";
import type { ScopeProof } from "../src/lib/ask-scope-auto-proof.js";
import { scopeProtected, scopeWireProtected } from "../src/lib/ask-scope-registry.js";
import { ASK_SCOPE_CASE_KEY, useAskScopeCasePort } from "../src/lib/ask-scope-case-policy.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { openOrderAsk, type AskDeps } from "../src/lib/order-ask.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { openAskFull, patchAsk } from "../src/lib/ledger-asks.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { ensureDeliverScope } from "../src/lib/order-deliver-scope.js";
import type { ScopeDiff } from "../src/lib/order-deliver-scope-git.js";

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

/**
 * Two real files differing only in case need a case-sensitive filesystem: Linux tmpdir already is; on macOS (default
 * APFS is insensitive) a small case-sensitive APFS image is mounted for this file; SCOPECASE_SENSITIVE_DIR overrides.
 * No such filesystem = the tests fail loudly rather than fall back to a missing-file or alias scenario.
 */
let sensitive: { root: string; env: string; cleanup(): void } | null = null;
function insensitiveAt(dir: string): boolean {
  const probe = mkdtempSync(join(dir, "scopecase-probe-"));
  try { writeFileSync(join(probe, "Probe"), "1"); return existsSync(join(probe, "probe")); } finally { rmSync(probe, { recursive: true, force: true }); }
}
beforeAll(() => {
  const given = process.env.SCOPECASE_SENSITIVE_DIR;
  if (given) { if (!insensitiveAt(given)) sensitive = { root: given, env: `SCOPECASE_SENSITIVE_DIR (${process.platform})`, cleanup() {} }; return; }
  if (!insensitiveAt(tmpdir())) { sensitive = { root: tmpdir(), env: `tmpdir (${process.platform})`, cleanup() {} }; return; }
  if (process.platform !== "darwin") return;
  const box = mkdtempSync(join(tmpdir(), "scopecase-vol-")), mount = join(box, "m");
  mkdirSync(mount);
  const run = (args: string[]) => Bun.spawnSync(["hdiutil", ...args], { stdout: "ignore", stderr: "pipe" });
  const made = run(["create", "-quiet", "-size", "16m", "-fs", "Case-sensitive APFS", "-volname", "scopecase", "-type", "SPARSE", join(box, "v")]);
  if (made.exitCode !== 0 || run(["attach", "-quiet", "-nobrowse", "-mountpoint", mount, join(box, "v.sparseimage")]).exitCode !== 0) {
    rmSync(box, { recursive: true, force: true });
    return;
  }
  sensitive = { root: mount, env: "darwin case-sensitive APFS image", cleanup() { run(["detach", "-quiet", "-force", mount]); rmSync(box, { recursive: true, force: true }); } };
});
afterAll(() => { sensitive?.cleanup(); });

/** Repo with src/lib/Host.ts and src/lib/host.ts as two independent files, plus a symlink escaping the repo. */
function twoFiles(): { dir: string; outside: string; existsIn: (path: string) => boolean } {
  if (!sensitive) throw new Error("没有可用的大小写敏感文件系统：设 SCOPECASE_SENSITIVE_DIR 或在 Linux / 可挂 APFS 镜像的 macOS 上跑");
  const dir = mkdtempSync(join(sensitive.root, "scopecase-")), outside = mkdtempSync(join(sensitive.root, "scopecase-out-"));
  mkdirSync(join(dir, "src/lib"), { recursive: true });
  writeFileSync(join(dir, "src/lib/Host.ts"), "export const upper = 1;\n");
  writeFileSync(join(dir, "src/lib/host.ts"), "export const lower = 2;\n");
  writeFileSync(join(outside, "x.ts"), "export const b = 1;\n");
  symlinkSync(join(outside, "x.ts"), join(dir, "src/lib/link.ts"));
  // Prove the fixture: two identities, two contents — not one file reached by two spellings.
  expect(statSync(join(dir, "src/lib/Host.ts")).ino).not.toBe(statSync(join(dir, "src/lib/host.ts")).ino);
  expect(readFileSync(join(dir, "src/lib/Host.ts"), "utf8")).not.toBe(readFileSync(join(dir, "src/lib/host.ts"), "utf8"));
  expect(readdirSync(join(dir, "src/lib")).sort()).toEqual(["Host.ts", "host.ts", "link.ts"]);
  const existsIn = (path: string) => {
    try { return lstatSync(join(dir, path)).isFile() && realpathSync(join(dir, path)).startsWith(realpathSync(dir) + sep); } catch { return false; }
  };
  return { dir, outside, existsIn };
}

test("[验收线 3] 大小写敏感 FS 两个真实文件各自校验；软链越界与新文件不因折叠放行", () => {
  const { dir, outside, existsIn } = twoFiles();
  console.info(`case-distinct fixture on ${sensitive!.env}`);
  try {
    const real: ScopeContext = { ...ctx, exists: existsIn };
    fake();
    for (const m of ["off", "observe", "on"] as const) {
      mode = m;
      expect(planScope(ask(["src/lib/Host.ts"]), real)?.map((g) => g.path)).toEqual(["src/lib/Host.ts"]);
      expect(planScope(ask(["src/lib/host.ts"]), real)?.map((g) => g.path)).toEqual(["src/lib/host.ts"]);
      // Both asked = two grants with their own spelling; folding never collapses them into one.
      expect(planScope(ask(["src/lib/Host.ts", "src/lib/host.ts"]), real)?.map((g) => g.path)).toEqual(["src/lib/Host.ts", "src/lib/host.ts"]);
      expect(planScope(ask(["src/lib/HOST.ts"]), real)).toBeNull(); // a third spelling is a missing file, not either of the two
      expect(planScope(ask(["src/lib/link.ts"]), real)).toBeNull(); // symlink escaping the repo
      expect(planScope(ask(["src/lib/new-file.ts"]), real)).toBeNull(); // new file / rename target
      expect(planScope(ask(["src/lib/Host.ts", "src/lib/link.ts"]), real)).toBeNull();
    }
    expect(observed).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

/** Real ask → ledger answer → delivery check, against the repo above (askScopeAuto on, mocked Git objects for the PR). */
async function askThenDeliver(asked: string[], delivered: string[]) {
  const { dir, outside } = twoFiles();
  const dbPath = join(dir, "ledger.db"), spec = join(dir, "spec.md");
  const priorConfig = existsSync(SCHEDULER_CONFIG_PATH) ? readFileSync(SCHEDULER_CONFIG_PATH, "utf8") : undefined;
  const db = openLedger(dbPath);
  try {
    writeFileSync(spec, "# T1\n模板：code\n\n## 范围\n本卡文件\n");
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: false, projects: { p: { repoDir: dir, maxActiveWorkers: 1, requiredChecks: ["test"] } } }));
    setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
    createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "机械扩围", kind: "code", spec, pm: "agent-pm", extra: { fileGlobs: [source] } });
    db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
    db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt)
      VALUES ('pool', 'T1', 'p', 'peer', 'codex', 'write', 1, 0, 'h', 'o/r', '{}', '', 's', 'claimed', 100000, 'owner', 0, 0)`);
    const policy: RecoveryPolicyPort = (_p, key) => ({ mode: key === "askScopeAuto" ? "on" : "off", manualAfterMs: null, source: "config" });
    const deps: AskDeps = { db, policy, open: (input, beforeWrite) => openAskFull(db, input, Date.now(), { beforeWrite }),
      markHanded: (id) => patchAsk(db, id, { extra: { notice: "handed" } }),
      notify: async () => ({ handed: true, note: "queued" }), record: (c, x) => void appendEvent(db, c, x) };
    const text = `只加 import 一行 + 调用 ≤3 行；判定逻辑放在本卡新文件 ${source}`;
    const answer = await openOrderAsk(db, deps, { task: getTask(db, "T1")!, orderId: "pool", from: "worker@peer", keyPrefix: "lend" },
      { question: text, options: [], class: "scope", default: text, files: asked });
    const H = "a".repeat(40), B = "b".repeat(40), hosts = ["src/lib/Host.ts", "src/lib/host.ts"];
    const diff: ScopeDiff = { base: B, filesComplete: true,
      files: [...delivered.map((path) => ({ path, added: 2, deleted: 0 })), { path: source, added: 1, deleted: 0 }], objects: {
        mergeBase: async () => B, prHead: async () => H, list: async (c) => c === B ? hosts : [...hosts, source],
        show: async (c, path) => hosts.includes(path) ? (c === B ? before : wired(path)) : "export function feature(ctx: unknown) { return ctx; }\n",
      } };
    await ensureDeliverScope(db, getTask(db, "T1")!, H, async () => diff, Date.now(), policy);
    const scope = listEvents(db, { target: "T1" }).find((e) => e.data.op === "deliver_scope")!.data as {
      files: { path: string }[]; askScopeAuto?: { files: { path: string; granted: boolean }[] } };
    return { answer, outsideFiles: scope.files.map((f) => f.path),
      granted: (scope.askScopeAuto?.files ?? []).map((f) => [f.path, f.granted] as const) };
  } finally {
    closeLedger(dbPath);
    if (priorConfig === undefined) rmSync(SCHEDULER_CONFIG_PATH, { force: true }); else writeFileSync(SCHEDULER_CONFIG_PATH, priorConfig);
    rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
}

for (const m of ["off", "observe", "on"] as const) {
  test(`[验收线 3] 两个真实文件经提问→交付：一个文件的授权不授权另一个（askScopeCaseFold=${m}）`, async () => {
    fake();
    mode = m;
    // Host.ts granted, both delivered: only Host.ts is approved, host.ts stays an unapproved out-of-scope file.
    const upper = await askThenDeliver(["src/lib/Host.ts"], ["src/lib/Host.ts", "src/lib/host.ts"]);
    expect(upper.answer).toMatchObject({ blocking: false, notified: false });
    expect(upper.outsideFiles).toEqual(["src/lib/Host.ts", "src/lib/host.ts"]);
    expect(upper.granted).toEqual([["src/lib/Host.ts", true]]);
    // Mirror: host.ts granted never approves Host.ts.
    const lower = await askThenDeliver(["src/lib/host.ts"], ["src/lib/Host.ts", "src/lib/host.ts"]);
    expect(lower.granted).toEqual([["src/lib/host.ts", true]]);
    // Grant for one, delivery touches only the other: nothing is approved.
    const other = await askThenDeliver(["src/lib/Host.ts"], ["src/lib/host.ts"]);
    expect(other.outsideFiles).toEqual(["src/lib/host.ts"]);
    expect(other.granted).toEqual([]);
    // Positive control: both asked, both approved, each under its own spelling.
    const both = await askThenDeliver(["src/lib/Host.ts", "src/lib/host.ts"], ["src/lib/Host.ts", "src/lib/host.ts"]);
    expect(both.granted).toEqual([["src/lib/Host.ts", true], ["src/lib/host.ts", true]]);
    expect(observed).toEqual([]);
  });
}

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

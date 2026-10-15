import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openOrderAsk, type AskDeps } from "../src/lib/order-ask.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta, appendEvent } from "../src/lib/ledger-write.js";
import { getAsk, openAskFull, patchAsk, answerAsk } from "../src/lib/ledger-asks.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { scopeFileLocked } from "../src/lib/ask-scope-auto.js";
import { ensureDeliverScope, scopeInputs } from "../src/lib/order-deliver-scope.js";
import type { ScopeDiff } from "../src/lib/order-deliver-scope-git.js";

let db: Database, dir: string, dbPath: string, spec: string, mode: RecoveryMode, notices: number, priorConfig: string | undefined;
const source = "src/lib/card-feature.ts", host = "src/lib/host.ts";
const policy: RecoveryPolicyPort = (_project, key) => ({ mode: key === "askScopeAuto" ? mode : "off", manualAfterMs: null, source: "config" });
const task = () => getTask(db, "T1")!;
const deps = (): AskDeps => ({ db, policy, open: (input, beforeWrite) => openAskFull(db, input, Date.now(), { beforeWrite }),
  markHanded: (id) => patchAsk(db, id, { extra: { notice: "handed" } }),
  notify: async () => { notices++; return { handed: true, note: "queued" }; }, record: (ctx, x) => void appendEvent(db, ctx, x) });
const question = (files: string[], text: string) => ({ question: text, options: [], class: "scope" as const, default: text, files });
const keyQ = () => question(["src/lib/recovery-keys.ts"], "只按字母序加本卡键一行");
const wireQ = () => question([host], `只加 import 一行 + 调用 ≤3 行；判定逻辑放在本卡新文件 ${source}`);
const ask = (q = keyQ(), d = deps()) => openOrderAsk(db, d, { task: task(), orderId: "pool", from: "worker@peer", keyPrefix: "lend" }, q);
const idOf = (r: unknown) => (r as { askId: string }).askId;
const notes = (op: string) => listEvents(db, { target: "T1" }).filter((e) => e.data.op === op);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-scope-auto-")); dbPath = join(dir, "ledger.db"); spec = join(dir, "spec.md");
  mkdirSync(join(dir, "src/lib"), { recursive: true }); writeFileSync(join(dir, host), "export const host = true;\n");
  writeFileSync(spec, "# T1\n模板：code\n\n## 范围\n本卡文件\n"); db = openLedger(dbPath); mode = "on"; notices = 0;
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "机械扩围", kind: "code", spec, pm: "agent-pm", extra: { fileGlobs: [source] } });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
  db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt)
    VALUES ('pool', 'T1', 'p', 'peer', 'codex', 'write', 1, 0, 'h', 'o/r', '{}', '', 's', 'claimed', 100000, 'owner', 0, 0)`);
  priorConfig = existsSync(SCHEDULER_CONFIG_PATH) ? readFileSync(SCHEDULER_CONFIG_PATH, "utf8") : undefined;
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: false, projects: { p: { repoDir: dir, maxActiveWorkers: 1, requiredChecks: ["test"] } } }));
});
afterEach(() => {
  closeLedger(dbPath); rmSync(dir, { recursive: true, force: true });
  if (priorConfig === undefined) rmSync(SCHEDULER_CONFIG_PATH, { force: true }); else writeFileSync(SCHEDULER_CONFIG_PATH, priorConfig);
});

test("[验收线 1] on immediately answers, appends check to spec, deduplicates, and never notifies PM", async () => {
  const r = await ask();
  expect(r).toMatchObject({ blocking: false, notified: false });
  expect(getAsk(db, idOf(r))).toMatchObject({ state: "answered", extra: { askScopeAuto: true, notice: "skipped", defaultAppend: "done" } });
  expect(readFileSync(spec, "utf8")).toContain("## 自动定");
  expect(readFileSync(spec, "utf8")).toContain("recoveryKeysOrderProblem");
  expect(task().extra.fileGlobs).toEqual([source]);
  expect(await ask()).toMatchObject({ duplicate: true, notified: false });
  expect(notes("ask_scope_auto")).toHaveLength(1); expect(notices).toBe(0);
  expect(readFileSync(spec, "utf8").match(/## 自动定/g)).toHaveLength(1);
});

test("[验收线 1] three own inventory lines sorted automatically; unrelated declaration keeps PM path", async () => {
  expect(await ask(question(["src/lib/scheduler-v2-skip-effects.ts"], "只把本卡三行挪到字母序位置"))).toMatchObject({ notified: false, blocking: false });
  expect(await ask(question(["src/lib/recovery-keys.ts"], "删除别的卡的键"))).toMatchObject({ notified: true, blocking: true });
  expect(await ask(question(["src/lib/scheduler-v2-skip-effects.ts"], "改本卡条目的 gate 分类"))).toMatchObject({ notified: true });
  expect(notices).toBe(2);
});

test("[验收线 4] observe records exactly one sample with real ask id, no automatic answer; off records none", async () => {
  mode = "observe";
  const r = await ask(); await ask();
  expect(r).toMatchObject({ blocking: true, notified: true });
  expect(getAsk(db, idOf(r))?.state).toBe("open");
  expect(notes("recovery_observe")).toHaveLength(1);
  expect(notes("recovery_observe")[0].data).toMatchObject({ mechanism: "askScopeAuto", actionKey: idOf(r), askId: idOf(r) });
  expect(readFileSync(spec, "utf8")).not.toContain("## 自动定");
  mode = "off";
  await ask(question(["src/lib/recovery-keys.ts"], "只按字母序加本卡键两行"));
  expect(notes("recovery_observe")).toHaveLength(1); expect(notes("ask_scope_auto")).toHaveLength(0);
  expect(recoveryPolicy("p", "askScopeAuto", join(dir, "missing.json"))).toMatchObject({ mode: "observe", source: "default" });
});

test("[验收线 2] wire only approves existing src targets and keeps risk/security on original path", async () => {
  expect(await ask(wireQ())).toMatchObject({ notified: false, blocking: false });
  const risky = { ...wireQ(), risk: "permission" as const, question: "risk" };
  expect(await ask(risky)).toMatchObject({ notified: true, blocking: true });
  writeFileSync(spec, "# T1\n模板：security\n");
  expect(await ask({ ...wireQ(), question: "security" })).toMatchObject({ notified: true, blocking: true });
});

test("[验收线 2] new target, class table, and absent default remain ordinary asks", async () => {
  for (const path of ["src/lib/new-host.ts", "src/lib/recovery-key-class.ts", "src/lib/recovery-key-defaults.ts"]) {
    expect(await ask({ ...wireQ(), files: [path] })).toMatchObject({ notified: true, blocking: true });
  }
  expect(await ask({ ...wireQ(), default: undefined } as unknown as ReturnType<typeof wireQ>)).toMatchObject({ notified: true });
});

function lock(stage: string, scope = "card") {
  createTask(db, { actor: "owner" }, { id: "T2", project: "p", title: "另一卡", kind: "code" });
  db.run("UPDATE tasks SET stage = ? WHERE id = 'T2'", [stage]);
  db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('i', 'T2', 'p', 'write', 'dispatch', 0, 1, 1, 1, 'pending', '', 0, 0)`);
  db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/lib/**', 'T2', 'i', 0, ?)", [scope]);
}

test("[验收线 2] live card locks block wiring; post-merge and intent-only locks do not", async () => {
  lock("build");
  expect(scopeFileLocked(db, "p", "T1", host)).toBe(true);
  expect(await ask(wireQ())).toMatchObject({ notified: true, blocking: true });
  for (const stage of ["live", "verified", "done"]) {
    db.run("UPDATE tasks SET stage = ? WHERE id = 'T2'", [stage]);
    expect(scopeFileLocked(db, "p", "T1", host)).toBe(false);
  }
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T2'");
  db.run("UPDATE scheduler_resources SET scope = 'intent'");
  expect(scopeFileLocked(db, "p", "T1", host)).toBe(false);
});

const H = "a".repeat(40), B = "b".repeat(40);
const baseline = 'export function host(ctx: unknown) {\n  return ctx;\n}\n';
const wired = 'import { feature } from "./card-feature.js";\nexport function host(ctx: unknown) {\n  feature(ctx);\n  return ctx;\n}\n';
function diff(next = wired): ScopeDiff {
  return { base: B, filesComplete: true, files: [{ path: host, added: 2, deleted: 0 }, { path: source, added: 1, deleted: 0 }], objects: {
    mergeBase: async () => B, prHead: async () => H, list: async (commit) => commit === B ? [host] : [host, source],
    show: async (commit, path) => path === host ? (commit === B ? baseline : next) : "export function feature(ctx: unknown) { return ctx; }\n",
  } };
}

test("[验收线 3] deliver_scope retains verified wire diff and line counts as evidence", async () => {
  await ask(wireQ());
  await ensureDeliverScope(db, task(), H, async () => diff(), Date.now(), policy);
  expect(notes("deliver_scope")[0].data).toMatchObject({ files: [{ path: host, added: 2, deleted: 0 }], askScopeAuto: { files: [{ path: host, added: 2, deleted: 0, granted: true }] } });
});

for (const [name, change] of [
  ["too many lines", (d: ScopeDiff) => ({ ...d, objects: { ...d.objects!, show: async (c: string, p: string) => p === host && c === H
    ? wired.replace("  feature(ctx);", "  feature(ctx);\n  feature(ctx);\n  feature(ctx);\n  feature(ctx);") : d.objects!.show(c, p) } })],
  ["head drift", (d: ScopeDiff) => ({ ...d, objects: { ...d.objects!, prHead: async () => "c".repeat(40) } })],
  ["truncated listing", (d: ScopeDiff) => ({ ...d, filesComplete: false })],
  ["missing objects", (d: ScopeDiff) => ({ ...d, objects: undefined })],
] as const) {
  test(`[验收线 3] outside on ${name}`, async () => {
    await ask(wireQ());
    await ensureDeliverScope(db, task(), H, async () => change(diff()), Date.now(), policy);
    expect(notes("deliver_scope")[0].data).toMatchObject({ files: [{ path: host }], askScopeAuto: { files: [{ granted: false }] } });
  });
}

test("[验收线 4] delivery off/observe never grants a prior on answer", async () => {
  await ask(wireQ());
  for (const [state, head] of [["observe", H], ["off", B]] as const) {
    mode = state;
    await ensureDeliverScope(db, task(), head, async () => diff(), Date.now(), policy);
  }
  expect(notes("deliver_scope").every((e) => (e.data.files as unknown[]).length === 1 && e.data.askScopeAuto === undefined)).toBe(true);
});

test("[验收线 1] read-only ledger connection still persists the answer and the specification", async () => {
  const ro = new Database(dbPath, { readonly: true });
  ro.exec("PRAGMA query_only = 1");
  try {
    const d = deps();
    const r = await openOrderAsk(ro, d, { task: task(), orderId: "pool", from: "worker@peer", keyPrefix: "lend" }, keyQ());
    expect(r).toMatchObject({ blocking: false, notified: false });
    expect(getAsk(db, idOf(r))?.state).toBe("answered");
  } finally { ro.close(); }
});

test("[验收线 3] switch rollback during Git reads revokes delivery approval", async () => {
  await ask(wireQ());
  const d = diff();
  d.objects!.prHead = async () => { mode = "off"; return H; };
  await ensureDeliverScope(db, task(), H, async () => d, Date.now(), policy);
  expect(notes("deliver_scope")[0].data).toMatchObject({ files: [{ path: host }], askScopeAuto: { files: [{ granted: false }] } });
});

test("[验收线 2] workflow security template blocks even if the spec says code", async () => {
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T1', 'p', 'security', 1, 'auto', 'codex', '', 1, 0, 0)`);
  expect(await ask(wireQ())).toMatchObject({ notified: true, blocking: true });
  expect(notes("ask_scope_auto")).toHaveLength(0);
});

test("[验收线 3] deletion count and specification changes cannot reuse the grant", async () => {
  await ask(wireQ());
  const deleted = diff(); deleted.files[0]!.deleted = 1;
  await ensureDeliverScope(db, task(), H, async () => deleted, Date.now(), policy);
  expect(notes("deliver_scope")[0].data).toMatchObject({ files: [{ path: host }], askScopeAuto: { files: [{ granted: false }] } });
  const changed = diff();
  changed.objects!.prHead = async () => { db.run("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'"); return B; };
  await ensureDeliverScope(db, task(), B, async () => changed, Date.now(), policy);
  expect(notes("deliver_scope")[1].data).toMatchObject({ files: [{ path: host }], askScopeAuto: { files: [{ granted: false }] } });
});


test("[验收线 2] same head review reflects current mode and always shows approved paths", async () => {
  await ask(wireQ());
  await ensureDeliverScope(db, task(), H, async () => diff(), Date.now(), policy);
  const event = notes("deliver_scope")[0]!;
  expect(event.text).toContain(`已自动核准:${host}(小接线)`);
  expect(event.data.files).toMatchObject([{ path: host, added: 2, deleted: 0 }]);
  const enabled = scopeInputs(db, task(), H, policy).join("\n");
  expect(enabled).toContain("已自动核准：");
  expect(enabled.split("已自动核准：")[1]).toContain(`${JSON.stringify(host)}：+2 / -0`);
  for (const state of ["off", "observe"] as const) {
    mode = state;
    await ensureDeliverScope(db, task(), H, async () => { throw new Error("same head must reuse event"); }, Date.now(), policy);
    const review = scopeInputs(db, task(), H, policy).join("\n");
    expect(review).not.toContain("已自动核准");
    expect(review).toContain(`${JSON.stringify(host)}：+2 / -0`);
    expect(review).toContain("规格外文件（相对 PR base）：");
  }
});

for (const forgery of ["other card ask", "wrong actor", "different grants", "wrong target"] as const) {
  test(`[验收线 3] forged grant remains outside: ${forgery}`, async () => {
    mode = "off";
    const askId = idOf(await ask(wireQ()));
    const grants = [{ path: host, kind: "wire", source, check: "wire" }];
    patchAsk(db, askId, { extra: { askScopeAuto: true, scopeGrants: grants } });
    answerAsk(db, askId, { choices: [], labels: [], text: "provisional", principal: "system:ask-scope-auto", via: "terminal", at: Date.now(), final: true });
    const event = { actor: "system:ask-scope-auto", project: "p", target: "T1",
      data: { op: "ask_scope_auto", rule: "ask-scope-auto/v1", specRev: 1, askId, grants } };
    createTask(db, { actor: "owner" }, { id: "T2", project: "p", title: "other card", kind: "code" });
    if (forgery === "other card ask") {
      db.run("UPDATE asks SET taskId = 'T2' WHERE id = ?", [String(event.data.askId)]);
    }
    const data = forgery === "different grants" ? { ...event.data, grants: [{ ...(event.data.grants as object[])[0], check: "forged" }] } : event.data;
    appendEvent(db, { actor: forgery === "wrong actor" ? "owner" : event.actor }, {
      project: event.project, target: forgery === "wrong target" ? "T2" : event.target, kind: "note", text: "forged", data,
    });
    for (const [state, head] of [["on", H], ["off", B], ["observe", "c".repeat(40)]] as const) {
      mode = state;
      await ensureDeliverScope(db, task(), head, async () => diff(), Date.now(), policy);
      const delivered = notes("deliver_scope").at(-1)!;
      expect(delivered.data.files).toMatchObject([{ path: host }]);
      expect(scopeInputs(db, task(), head, policy).join("\n")).not.toContain("已自动核准");
    }
  });
}


test("[验收线 3] changing grant details while Git proof runs revokes delivery approval", async () => {
  const askId = idOf(await ask(wireQ()));
  const d = diff();
  d.objects!.prHead = async () => {
    const grants = getAsk(db, askId)!.extra.scopeGrants as object[];
    patchAsk(db, askId, { extra: { scopeGrants: [{ ...grants[0], check: "changed during proof" }] } });
    return H;
  };
  await ensureDeliverScope(db, task(), H, async () => d, Date.now(), policy);
  expect(notes("deliver_scope")[0]!.data).toMatchObject({ files: [{ path: host }], askScopeAuto: { files: [{ granted: false }] } });
});

for (const deleting of [false, true]) {
  test(`[验收线 4] a deleted definition source only proves base-key deletion: ${deleting}`, async () => {
    await ask(keyQ());
    const path = "src/lib/recovery-keys.ts", empty = "export const RECOVERY_KEYS = [\n] as const;\n";
    const keyed = empty.replace("]", '  "cardFeature",\n]');
    const d: ScopeDiff = { base: B, filesComplete: true,
      files: [{ path, added: deleting ? 0 : 1, deleted: deleting ? 1 : 0 }, { path: source, added: 0, deleted: 1 }], objects: {
        mergeBase: async () => B, prHead: async () => H,
        list: async (commit) => commit === B ? [path, source] : [path],
        show: async (commit, file) => file === source ? 'export const KEY = "cardFeature";\n'
          : ((commit === B) === deleting ? keyed : empty),
      } };
    await ensureDeliverScope(db, task(), H, async () => d, Date.now(), policy);
    expect(notes("deliver_scope")[0]!.data).toMatchObject({ files: [{ path }], askScopeAuto: { files: [{ granted: deleting }] } });
    if (deleting) expect(notes("deliver_scope")[0]!.text).toContain(`已自动核准:${path}(登记项)`);
  });
}

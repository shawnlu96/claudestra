/** Immediate, provisional mechanical scope answers. Delivery validates exact blobs before any file leaves outside scope. */
import { Database } from "bun:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { getAsk, patchAsk, answerAsk, type OpenedAsk } from "./ledger-asks.js";
import { getMeta, getTask } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { AskDeps, AskSource, OpenedOrderAsk } from "./order-ask.js";
import { appendDefaultSpec, prepareDefaultSpec } from "./order-ask-default-spec.js";
import { assertOrderTakesAsks } from "./order-ask-terminal.js";
import { cardGlobs, privateCardRepo } from "./card-repo.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { resourcesOverlap } from "./ledger-scheduler.js";
import { recordObserved, recoveryPolicy } from "./recovery-policy.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import { scanSpecHead } from "./spec-lint-head.js";
import { planScope, type ScopeQuestion } from "./ask-scope-auto-plan.js";
import type { ScopeGrant } from "./ask-scope-registry.js";

export const ASK_SCOPE_RULE = "ask-scope-auto/v1";

/** Use card locks only. Merge-queued cards can still write; only stages after merge cease to block. */
export function scopeFileLocked(db: Database, project: string, taskId: string, path: string): boolean {
  const rows = db.query(`SELECT r.resource, t.stage FROM scheduler_resources r LEFT JOIN tasks t ON t.id = r.taskId
    WHERE r.project = ? AND r.scope = 'card' AND r.taskId != ?`).all(project, taskId) as { resource: string; stage: string | null }[];
  return rows.some((r) => !["live", "verified", "done", "cancelled"].includes(r.stage ?? "") && resourcesOverlap(r.resource.toLowerCase(), path.toLowerCase()));
}

function livePlan(db: Database, src: AskSource, q: ScopeQuestion): ScopeGrant[] | null {
  const task = getTask(db, src.task.id);
  if (!task) return null;
  const spec = readTextSoft(specPathFor(task, getMeta(db, task.project).docsDir));
  if (spec === null) return null;
  const flow = db.query("SELECT template FROM task_workflows WHERE taskId = ?").get(task.id) as { template: string } | null;
  const security = flow?.template === "security" || scanSpecHead(spec).decls.some((s) => s.trim().toLowerCase() === "security");
  const ownRepo = privateCardRepo(task);
  // Private repos do not inherit Claudestra's registry of permission-sensitive files.
  if (ownRepo) return null;
  return planScope(q, { globs: cardGlobs(task), security,
    locked: (path) => scopeFileLocked(db, task.project, task.id, path),
    exists: (path) => {
      const config = readSchedulerConfig().projects[task.project];
      const dir = config?.repoDir;
      if (!dir) return false;
      try {
        const full = join(dir, path);
        return lstatSync(full).isFile() && realpathSync(full).startsWith(realpathSync(dir) + sep);
      } catch { return false; } // Missing/unreadable targets cannot receive a wiring exception.
    },
  });
}

function appendScopeSpec(db: Database, id: string): void {
  try {
    db.transaction(() => prepareDefaultSpec(db, getAsk(db, id)!)).immediate();
    db.transaction(() => {
      appendDefaultSpec(getAsk(db, id)!);
      patchAsk(db, id, { extra: { defaultAppend: "done" } });
    }).immediate();
  } catch (e) {
    // The existing ask-default sweeper retries the durable pending append, including partial writes.
    console.error(`ask ${id} 机械扩围规格追加待重试：${(e as Error).message}`);
  }
}

function approveScope(db: Database, src: AskSource, q: ScopeQuestion, opened: OpenedAsk, now: number, enabled: () => boolean): string | null {
  return db.transaction(() => {
    if (!enabled()) return null;
    const ask = getAsk(db, opened.ask.id);
    if (!ask || ask.state !== "open") return null;
    const lost = src.recheck?.();
    if (lost) return null;
    assertOrderTakesAsks(db, src.orderId);
    const grants = livePlan(db, src, q), task = getTask(db, src.task.id);
    if (!grants || !task) return null;
    const message = `机械扩围自动答（${ASK_SCOPE_RULE}）：${grants.map((g) => `${g.path} [${g.kind}]；核对 ${g.check}`).join("；")}。`
      + "不扩 fileGlobs；交付逐文件核实际 diff，超出仍记 outside。";
    patchAsk(db, ask.id, { extra: { askScopeAuto: true, notice: "skipped", class: "scope", default: `${q.default}\n${message}`,
      defaultAt: now, defaultAppend: "pending", scopeGrants: grants, scopeSpecRev: task.specRev, scopeRule: ASK_SCOPE_RULE } }, now);
    answerAsk(db, ask.id, { choices: [], labels: [], text: message, principal: "system:ask-scope-auto", via: "terminal", at: now, final: true });
    appendEvent(db, { actor: "system:ask-scope-auto", now, dedupKey: `ask-scope-auto:${ask.id}` }, {
      project: task.project, target: task.id, kind: "note", text: message,
      data: { op: "ask_scope_auto", askId: ask.id, orderId: src.orderId, rule: ASK_SCOPE_RULE, specRev: task.specRev, grants, globs: cardGlobs(task) },
    });
    return message;
  }).immediate();
}

/** Called after opening the ordinary ask, before any notification; off does not read or write anything extra. */
export function tryScopeAuto(db: Database, deps: Omit<AskDeps, "db">, src: AskSource, q: ScopeQuestion, opened: OpenedAsk): OpenedOrderAsk | null {
  let writer: Database | undefined;
  try {
    const policy = deps.policy ?? recoveryPolicy;
    const mode = policy(src.task.project, "askScopeAuto").mode;
    if (mode === "off") return null;
    const ask = opened.ask;
    if (ask.state !== "open" && ask.extra.askScopeAuto !== true) return null;
    const grants = livePlan(db, src, q);
    if (!grants) return null;
    writer = (db.query("PRAGMA query_only").get() as { query_only: number }).query_only
      ? new Database(db.filename, { readwrite: true, create: false }) : db;
    if (writer !== db) writer.exec("PRAGMA busy_timeout = 5000");
    if (mode === "observe") {
      if (ask.state !== "open") return null;
      recordObserved(writer, { project: src.task.project, mechanism: "askScopeAuto", target: src.task.id,
        actionKey: ask.id, action: `自动答机械扩围 ask ${ask.id}`, data: { askId: ask.id, orderId: src.orderId, grants, rule: ASK_SCOPE_RULE } }, Date.now());
      return null;
    }
    const message = ask.extra.askScopeAuto === true && ask.state === "answered" ? ask.answer?.text
      : approveScope(writer, src, q, opened, Date.now(), () => policy(src.task.project, "askScopeAuto").mode === "on");
    if (!message) return null;
    if (getAsk(writer, ask.id)?.extra.defaultAppend === "pending") appendScopeSpec(writer, ask.id);
    return { askId: ask.id, askee: ask.assignee ?? "", duplicate: opened.existed, notified: false, delivered: "机械扩围自动答，未通知 PM", blocking: false, message };
  } catch (e) {
    console.error(`ask ${opened.ask.id} 机械扩围未能自动答，保留原路径：${(e as Error).message}`);
    return null;
  } finally { if (writer && writer !== db) writer.close(); }
}

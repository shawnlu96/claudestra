/**
 * MQWAKE1 共享夹具（本身没有用例；按 *.test.ts 命名以留在本卡文件范围内）：临时台账 + 只读 LedgerReader（query_only，调度服务的连接）
 * + 进程内正规 ledger CLI（PM 的 review / ui-approve / manual-merge-request / autostart-set，调度身份的 scheduler-autostart merge-pm）。
 * s2w() 按 S2W 台账形状合成：人工请求受理 → 调度 claim → update-branch 把 head 换成新 head、review_carry 与 await_ci 成对 →
 * 截图不继承 → 意图 cancelled、合并未发出结束。只合成形状，不读生产截图、凭据或真实库。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

export const P = "p", Q = "q", PM = "agent-pm", FPM = "agent-fpm", DISP = "agent-disp";
export const sha = (n: number) => n.toString(16).padEnd(40, "0");
export const DIGEST = "ab".repeat(32);

export interface Sent { project: string; to: string; text: string }

export function world() {
  const dir = mkdtempSync(join(tmpdir(), "mqwake1-")), path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  for (const p of [P, Q]) {
    setMeta(db, { actor: "owner", now: 1 }, { project: p, key: "pms", value: [PM, FPM, DISP] });
    setMeta(db, { actor: "owner", now: 1 }, { project: p, key: "team", value: { dispatcher: DISP, audit: true } });
  }
  let reader = new LedgerReader(path);
  const w = {
    db, dir, clock: Date.now(), sent: [] as Sent[], projects: [P],
    /** 发送端：缺省记下并成功；测试换成失败 / 回 false / 核租约 */
    send: async (s: Sent): Promise<unknown> => void w.sent.push(s),
    /** 每次调度 CLI 返回后（发之前）跑一次：模拟记录后到发送前的变化 */
    afterLedger: null as null | ((args: string[], r: Record<string, unknown>) => unknown),
    reader: () => reader.get() as Database,
    /** 调度服务重启：新的只读连接，进程内什么都不带 */
    restart() { reader.close(); reader = new LedgerReader(path); },
    as(actor: string, ...args: string[]) {
      return runLedger(args, { db, actor, projectIds: [P, Q], loadRegistry: async () => ({} as Registry), saveRegistry: async () => {},
        now: () => w.clock, autoDispatch: () => true, autoProjects: () => w.projects }) as Promise<Record<string, unknown>>;
    },
    feature(project = P) { return createFeature(db, { actor: PM, now: w.clock }, { project, slug: `f${Math.random().toString(16).slice(2, 8)}`, title: "S2W" }).row.id; },
    /** 调度身份、带「租约」的 ledger CLI；lease=false 时像生产守卫一样回 lease-lost */
    lease: true,
    tickEnv(over: Partial<StartTickEnv> = {}): StartTickEnv {
      const ledger = async (...args: string[]) => {
        if (!w.lease) return { ok: false, code: "lease-lost", error: "租约已丢" };
        const r = await w.as("scheduler", ...args.slice(1));
        await w.afterLedger?.(args.slice(1), r);
        return r;
      };
      const e: StartTickEnv = {
        db: w.reader(), svc: { autoDispatch: true, projects: w.projects, maxWorkers: () => 3 }, ledger,
        plain: async () => { throw new Error("不该开卡"); }, startEnv: () => { throw new Error("不该开卡"); }, stepIO: () => { throw new Error("不该开卡"); },
        readSpec: () => null, quota: async () => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null, windows: [] }),
        notifyPm: async () => { throw new Error("应走 specWaitSend"); }, memo: new Set(), now: () => w.clock, attempt: () => "a1", ...over,
      };
      return Object.assign(e, { specWaitSend: async (_db: Database, project: string, to: string, text: string) => w.send({ project, to, text }) });
    },
    tick(over: Partial<StartTickEnv> = {}) { return autostartTick(w.tickEnv(over)); },
    close() { reader.close(); closeLedger(path); rmSync(dir, { recursive: true, force: true }); },
  };
  return w;
}
export type World = ReturnType<typeof world>;

let prs = 0;
/** 人工 code / ui 卡：PM 经 `ledger review` 登记跨族审查进 merge（ui 卡先 `ledger ui-approve`），再经 `manual-merge-request` 排队 */
export async function manualCard(w: World, id: string, o: { ui?: boolean; featureId?: string | null; project?: string; head?: number } = {}) {
  const project = o.project ?? P, head = sha(o.head ?? 0x100 + ++prs), db = w.db;
  createTask(db, { actor: "owner", now: w.clock }, { project, id, title: id, kind: "code", agent: "agent-author" });
  setWorkflow(db, { actor: "owner", now: w.clock }, { taskId: id, taskRev: 1, template: o.ui ? "ui" : "code", templateVersion: 2, mode: "manual",
    authorFamily: "claude", fallback: "缩小范围", reason: "PM 接管" });
  db.query(`UPDATE tasks SET stage = 'review', round = 1, rev = rev + 1, headSHA = ?, pr = ?, branch = ?, featureId = ?,
    extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = ?`)
    .run(head, `https://github.com/example/mqwake1/pull/${++prs}`, `task/${id}`, o.featureId ?? null, o.ui ? DIGEST : null, id);
  if (o.ui) await ok(w.as(PM, "ui-approve", id, "--head", head, "--digest", DIGEST));
  const findings = join(w.dir, `${id}-findings.json`);
  writeFileSync(findings, "[]");
  await ok(w.as(PM, "review", id, "--reviewer", "agent-review", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", head,
    "--session", `rs-${id}`, "--family", "codex", "--findings", findings, "--path", "r.md", "--to", "merge"));
  const reviewSeq = listEvents(db, { target: id }).findLast((e) => e.kind === "review")!.seq;
  const r = await request(w, id, reviewSeq, o.ui);
  return { id, head, reviewSeq, request: Number(r.request) };
}

export async function request(w: World, id: string, reviewSeq: number, ui?: boolean) {
  const t = getTask(w.db, id)!;
  return ok(w.as(PM, "manual-merge-request", id, "--head", t.headSHA!, "--spec-rev", String(t.specRev), "--round", String(t.round),
    "--review-seq", String(reviewSeq), ...(ui ? ["--ui-digest", String(t.extra.screenshotsDigest)] : []), "--reason", "人工审过，排队合并"));
}

export async function ok(p: Promise<Record<string, unknown>>) {
  const r = await p;
  if (r.ok !== true) throw new Error(`ledger CLI: ${String(r.error)}`);
  return r;
}

const sched = (w: World, id: string, data: Record<string, unknown>) =>
  insertEvent(w.db, { actor: "scheduler", now: w.clock }, { project: getTask(w.db, id)!.project, target: id, kind: "scheduler", text: "", data }, false).seq;

/** 请求的合并运行被 claim（意图 submitted），可选地 update-branch 到 newHead 并按 review_carry + await_ci 成对沿用审查 */
export function claimRun(w: World, c: { id: string; head: string; request: number }, newHead?: string) {
  const intent = `mmq:${c.request}`, t = getTask(w.db, c.id)!;
  w.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,
    createdAt,updatedAt) VALUES (?,?,?,'manual_merge','merge',1,?,?,1,?,2,'submitted','manual merge',?,?)`)
    .run(intent, c.id, t.project, sched(w, c.id, { op: "manual_merge_claim", request: c.request, intentId: intent }), t.rev, c.head, w.clock, w.clock);
  if (newHead) {
    w.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?").run(newHead, c.id);
    const carry = sched(w, c.id, { op: "review_carry", intentId: intent, from: c.head, to: newHead, round: t.round, specRev: t.specRev });
    sched(w, c.id, { op: "merge_phase", intentId: intent, from: "updating", to: "await_ci", carrySeq: carry });
  }
  return intent;
}

/** S2W：claim → update-branch 到新 head（审查沿用）→ 截图不继承 → 意图 cancelled、合并未发出结束 */
export async function s2w(w: World, featureId: string | null) {
  const c = await manualCard(w, "S2W", { ui: true, featureId });
  const newHead = sha(0xe891);
  const intent = claimRun(w, c, newHead);
  sched(w, c.id, { op: "ui_carry", intentId: intent, carried: false, reason: "截图不继承" });
  w.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(intent);
  sched(w, c.id, { op: "merge_resolve", intentId: intent, outcome: "cancelled", reason: "合并未发出" });
  return { ...c, newHead, intent };
}

/** 本功能以外的台账：事件（去掉 merge_pm_wait）与各业务表的全量快照 */
export function business(db: Database) {
  const rows = (sql: string) => JSON.stringify(db.query(sql).all());
  return {
    events: JSON.stringify(listEvents(db, {}).filter((e) => e.data.op !== "merge_pm_wait")),
    tables: ["tasks", "task_workflows", "scheduler_intents", "scheduler_resources", "asks", "meta"].map((t) => rows(`SELECT * FROM ${t}`)),
  };
}
export const pmEvents = (db: Database, id = "S2W") => listEvents(db, { target: id }).filter((e) => e.data.op === "merge_pm_wait");

/** PM 经正规 `autostart-set` 改开关（mergePmWait / feature PM） */
export const setMode = (w: World, mode: string, project = P) => ok(w.as(PM, "autostart-set", "on", "--merge-pm-wait", mode, "--reason", "测试", "--project", project));
export const setFeaturePm = (w: World, fid: string, pm: string, project = P) =>
  ok(w.as(PM, "autostart-set", "on", "--feature", fid, "--pm", pm, "--reason", "测试", "--project", project));

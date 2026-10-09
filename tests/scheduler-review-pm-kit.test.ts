/**
 * RVWAKE1 共享夹具（本身没有用例；按 *.test.ts 命名以留在本卡文件范围内）。临时台账 + 真实只读 LedgerReader（query_only）+ 进程内正规 ledger CLI，
 * 按 S2W 形状合成「正式 manual 远端签审查回执」：调度器经出借池派审 → 真实 B 端 take_review / submit_verdict（合成钥匙、钉住、票据、原件归档）→
 * A 端 lend-write 入账、调度结清 pool_done → PM 经 `workflow-set --mode manual` 把卡留在人工，卡仍停在 review。另有本机来源：
 * 审查员本人 `ledger review` 与 PM 代记。只合成形状，不读生产钥匙、截图、凭据或真实库。
 */
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { REVIEW_PM_OP } from "../src/lib/scheduler-review-pm-ledger.js";
import { aResultDeps, B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

export const PM = "pm", FPM = "agent-fpm", DISP = "agent-disp";
export const P2ROW = { findingId: "note-1", family: "storage", severity: "P2", probe: "[验收线 1] 命名", description: "机器描述" };
export const P1ROW = { findingId: "race-1", family: "concurrency", severity: "P1", probe: "[验收线 3] 两轮同时记账", description: "竞态" };
const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };

export interface Sent { project: string; to: string; text: string }
export type Verdict = { verdict: "pass" | "changes" | "block"; findings?: object[] };
type PoolOpts = { verdict?: Verdict; legacy?: boolean; submitFamily?: string | null; manual?: boolean };

/** 调度身份的 ledger CLI、只读连接、假发送：给 autostartTick（含 pmWakeTicks）用 */
function harness(f: ReturnType<typeof autoFixture>) {
  const path = join(f.dir, "ledger.sqlite");
  let reader = new LedgerReader(path);
  const w = {
    f, db: f.db, sent: [] as Sent[], lease: true,
    send: async (s: Sent): Promise<unknown> => void w.sent.push(s),
    afterLedger: null as null | ((args: string[]) => unknown),
    reader: () => reader.get() as Database,
    restart() { reader.close(); reader = new LedgerReader(path); },
    as: (actor: string, ...args: string[]) => f.cli(actor, ...args) as Promise<Record<string, unknown>>,
    tickEnv(over: Partial<StartTickEnv> = {}): StartTickEnv {
      const ledger = async (...args: string[]) => {
        if (!w.lease) return { ok: false, code: "lease-lost", error: "租约已丢" };
        const r = await w.as("scheduler", ...args.slice(1));
        await w.afterLedger?.(args.slice(1));
        return r;
      };
      const no = () => { throw new Error("不该开卡"); };
      const e: StartTickEnv = {
        db: w.reader(), svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 3 }, ledger, plain: async () => no(), startEnv: no, stepIO: no,
        readSpec: () => null, quota: async () => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null, windows: [] }),
        notifyPm: async () => { throw new Error("应走 specWaitSend"); }, memo: new Set(), now: () => f.tickDeps.now!(), attempt: () => "a1", ...over,
      };
      return Object.assign(e, { specWaitSend: async (_db: Database, project: string, to: string, text: string) => w.send({ project, to, text }) });
    },
    tick(over: Partial<StartTickEnv> = {}) { return autostartTick(w.tickEnv(over)); },
    close() { reader.close(); f.close(); },
  };
  return w;
}
export type World = ReturnType<typeof harness>;

export async function ok(p: Promise<Record<string, unknown>>) {
  const r = await p;
  if (r.ok !== true) throw new Error(`ledger CLI: ${String(r.error)}`);
  return r;
}

/** PM 名单（含 feature PM 与调度助理）、feature，并经正规 autostart-set 定 feature PM */
async function team(w: World): Promise<string> {
  setMeta(w.db, w.f.at("owner"), { project: "p", key: "pms", value: [PM, FPM, DISP] });
  setMeta(w.db, w.f.at("owner"), { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  w.db.prepare("INSERT OR IGNORE INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  const fid = createFeature(w.db, w.f.at(PM), { project: "p", slug: "s2w", title: "S2W" }).row.id;
  w.db.query("UPDATE tasks SET featureId = ? WHERE id = 'T1'").run(fid);
  await ok(w.as(PM, "autostart-set", "on", "--feature", fid, "--pm", FPM, "--reason", "测试", "--project", "p"));
  return fid;
}

/** PM 经正规 workflow-set 把卡留在人工（带 hold，与生产 PM 接管同一入口） */
export async function toManual(w: World) {
  const wf = getWorkflow(w.db, "T1")!;
  await ok(w.as(PM, "workflow-set", "T1", "--rev", String(w.f.task().rev), "--workflow-rev", String(wf.rev), "--template", wf.template, "--version", "2",
    "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "pm_takeover", "--reason", "PM 接管"));
}

/** 正式 manual 远端签审查回执：调度派池单 → B 端真实工具交结论 → A 入账、调度结清；之后 PM 留人工，卡停在 review */
export async function pooledManual(o: PoolOpts = {}) {
  const f = autoFixture(), w = harness(f);
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7', branch = 'task/T1' WHERE id = 'T1'", [spec]);
  const fid = await team(w);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const b = lendSide(f.dir), a = aResultDeps(f.dir, b.pinned);
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, result: a.result };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const poolTick = async () => (await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 0, remote: REMOTE } }, deps)).cards[0];
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  if ((await poolTick())?.step !== "pool_pooled") throw new Error("没派到池");
  const [order] = listLendOrders(f.db, "T1");
  const claim = await peer("claim", { v: 1, orderId: order.orderId, worker: B_WORKER });
  const send = (body: Record<string, unknown>) => {
    const { ticket: _t, ...rest } = body;
    return peer("write", o.legacy ? rest : body);
  };
  const v = o.verdict ?? { verdict: "pass" };
  const answer = await b.answer(claim as never, { verdict: v.verdict, findings: v.findings, report: "## 结论" }, send, { submitFamily: o.submitFamily });
  if (answer.r.ok !== true) throw new Error(`B 交结论失败：${JSON.stringify(answer.r)}`);
  if ((await poolTick())?.step !== "pool_done") throw new Error("池单没结清");
  if (o.manual !== false) await toManual(w);
  const reviewSeq = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review")!.seq;
  return Object.assign(w, { fid, reviewSeq, order });
}

/** 本功能以外的台账全量：事件（去掉 review_pm_wait）与各业务表 */
export function business(db: Database) {
  const rows = (sql: string) => JSON.stringify(db.query(sql).all());
  return {
    events: JSON.stringify(listEvents(db, {}).filter((e) => e.data.op !== REVIEW_PM_OP)),
    tables: ["tasks", "task_workflows", "scheduler_intents", "scheduler_resources", "asks", "meta", "lend_orders"].map((t) => rows(`SELECT * FROM ${t}`)),
  };
}
export const pmEvents = (db: Database, id = "T1") => listEvents(db, { target: id }).filter((e) => e.data.op === REVIEW_PM_OP);
export const setMode = (w: World, mode: string, flag = "--review-pm-wait") =>
  ok(w.as(PM, "autostart-set", "on", flag, mode, "--reason", "测试", "--project", "p"));

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, importTask, setMeta } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { postVerifyTick } from "../src/lib/scheduler-post-verify.js";
import { unsummarized } from "../src/lib/scheduler-post-verify-pull.js";
import { readPostVerifySpec } from "../src/lib/scheduler-post-verify-ledger.js";
import type { SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", FEATURE_PM = "agent-feature-pm", H = 3600_000;
let db: Database, dir: string, clock: number, fid: string, card: string, batches: number, sentReads: number[];
const specs: string[] = [];
function verified(id: string, at = clock, section = "- 核对真实样本"): void {
  const folder = statePath("ledger", "docs", "tasks");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.md`);
  writeFileSync(path, `# ${id}\n## 上线后 PM\n${section}\n`);
  specs.push(path);
  importTask(db, { actor: "owner", now: at }, { createdTs: at - H, initialStage: "live",
    events: [{ kind: "stage", ts: at, data: { from: "live", to: "verified" } }],
    task: { project: P, id, stage: "verified", title: id, kind: "code", pm: PM } });
  db.run("UPDATE tasks SET featureId = ? WHERE id = ?", [fid, id]);
}
const ledger = (...args: string[]) => runLedger(args.slice(1), {
  db, actor: "scheduler", projectIds: [P], now: () => clock, autoDispatch: () => true, autoProjects: () => [P],
  loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {},
});
const tick = () => postVerifyTick({ db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 }, ledger, readSpec: readPostVerifySpec,
  now: () => clock, notifyPm: async () => { throw new Error("应通过收件人路由发送"); }, specWaitSend: async () => {} } as SpecWaitEnv);
const nextDay = () => { const d = new Date(clock); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); clock = d.getTime(); };
const sentBatch = (cards: { taskId: string; verifiedTs: number }[]) => appendEvent(db, { actor: "scheduler", now: clock, dedupKey: `fixture-sent:${batches++}` },
  { project: P, target: "", kind: "note", text: "汇总", data: { op: "post_verify_pull", kind: "sent", day: "2025-01-01", to: FEATURE_PM, text: "汇总", cards } });
/** Count rows returned by the sent-batch scan; every other statement passes through untouched. */
function spyOnSentScan(): void {
  const query = db.query.bind(db);
  db.query = ((sql: string) => {
    const stmt = query(sql);
    if (!sql.includes("'post_verify_pull'")) return stmt;
    return { all: (...args: unknown[]) => { const rows = stmt.all(...(args as [])); sentReads.push(rows.length); return rows; } };
  }) as typeof db.query;
}
beforeEach(() => {
  clock = new Date(2026, 9, 17, 8).getTime();
  dir = mkdtempSync(join(tmpdir(), "pvpull2-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  setMeta(db, { actor: "owner", now: clock - H }, { project: P, key: "pms", value: [PM, FEATURE_PM] });
  fid = createFeature(db, { actor: PM, now: clock - H }, { project: P, slug: "pull", title: "拉取" }).row.id;
  setAutostartSwitch(db, { actor: PM, now: clock }, { project: P, on: true, featureId: fid, pm: FEATURE_PM, specWait: "on", reason: "测试" });
  card = `pvpull2-${Math.random().toString(16).slice(2, 10)}`;
  batches = 0; sentReads = [];
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  db.transaction(() => {
    for (let b = 0; b < 365; b++) sentBatch(Array.from({ length: 100 }, (_, i) => ({ taskId: `${card}-hist-${b}-${i}`, verifiedTs: clock - 400 * 24 * H })));
  })();
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  for (const path of specs.splice(0)) rmSync(path, { force: true });
});

test("修前红修后绿：365 批 × 100 卡历史、候选为 0 时不执行 sent 批次扫描，返回 null", () => {
  spyOnSentScan();
  for (let i = 0; i < 3; i++) expect(unsummarized(db, P, clock + i * 5000)).toBeNull();
  expect(sentReads).toEqual([]);
});

test("修前红修后绿：已发 / 未发 / verifiedTs 变了 / 已结 / 未到期混合，汇总与改前口径逐项相同，只读含候选的批次", async () => {
  const [sentCard, fresh, reverified, closed, later] = ["sent", "fresh", "reverified", "closed", "later"].map((s) => `${card}-${s}`);
  const at = clock;
  setAutostartSwitch(db, { actor: PM, now: clock }, { project: P, on: true, postVerifyDefer: "on", reason: "观察期" });
  for (const id of [sentCard, fresh, reverified, closed]) verified(id, at);
  verified(later, at, "观察期：240 小时\n- 核对");
  await tick();
  sentBatch([{ taskId: sentCard, verifiedTs: at }, { taskId: reverified, verifiedTs: at - H }]);
  appendEvent(db, { actor: PM, now: clock, dedupKey: `post-verify-done:${closed}` }, { project: P, target: closed, kind: "note", text: "已核" });
  nextDay();
  spyOnSentScan();
  expect(unsummarized(db, P, clock)).toEqual({ to: FEATURE_PM, cards: [{ taskId: fresh, verifiedTs: at }, { taskId: reverified, verifiedTs: at }],
    text: `2 条上线后待办到期，\`ledger pm-todo\` 查看\n${fresh}、${reverified}` });
  expect(sentReads).toEqual([1]);
});

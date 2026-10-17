import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getEventByDedup, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, importTask, setMeta } from "../src/lib/ledger-write.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { statePath } from "../src/lib/paths.js";
import { pmTodos } from "../src/lib/pm-todo.js";
import { RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { postVerifyTick } from "../src/lib/scheduler-post-verify.js";
import { POST_VERIFY_REPEAT_MS, readPostVerifySpec } from "../src/lib/scheduler-post-verify-ledger.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import type { SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", FEATURE_PM = "agent-feature-pm";
const H = 3600_000;
let db: Database, dir: string, clock: number, fid: string, card: string;
let sent: { to: string; text: string; level: string }[], failSend: boolean;
const specs: string[] = [];
const policy = (mode: string) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [P]: { keys: { postVerifyPull: mode } } } }));
const records = (id = card) => listEvents(db, { target: id }).filter((e) => e.data.op === "post_verify");
function verified(id: string, at = clock, section = "- 核对真实样本", featureId = fid): void {
  const folder = statePath("ledger", "docs", "tasks");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.md`);
  writeFileSync(path, `# ${id}\n## 上线后 PM\n${section}\n`);
  specs.push(path);
  importTask(db, { actor: "owner", now: at }, { createdTs: at - H, initialStage: "live",
    events: [{ kind: "stage", ts: at, data: { from: "live", to: "verified" } }],
    task: { project: P, id, stage: "verified", title: id, kind: "code", pm: PM } });
  db.run("UPDATE tasks SET featureId = ? WHERE id = ?", [featureId, id]);
}
const runAs = (actor: string, ...args: string[]) => runLedger(args.slice(1), {
  db, actor, projectIds: [P], now: () => clock, autoDispatch: () => true, autoProjects: () => [P],
  loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {},
});
const ledger = (...args: string[]) => runAs("scheduler", ...args);
function env(): SpecWaitEnv {
  return { db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 }, ledger, readSpec: readPostVerifySpec, now: () => clock,
    notifyPm: async () => { throw new Error("应通过收件人路由发送"); },
    specWaitSend: async (_db, _project, to, text, level) => {
      if (failSend) throw new Error("temporary offline");
      sent.push({ to, text, level });
    } };
}
const tick = () => postVerifyTick(env());
const nextDay = () => { const d = new Date(clock); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); clock = d.getTime(); };
const claims = () => listEvents(db, { project: P }).filter((e) => e.data.op === "post_verify_pull" && e.data.kind === "claimed");
const done = (id: string) => appendEvent(db, { actor: PM, now: clock, dedupKey: `post-verify-done:${id}` },
  { project: P, target: id, kind: "note", text: "样本核对完毕" });
beforeEach(() => {
  clock = new Date(2026, 9, 17, 8).getTime();
  dir = mkdtempSync(join(tmpdir(), "pvpull1-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  setMeta(db, { actor: "owner", now: clock - H }, { project: P, key: "pms", value: [PM, FEATURE_PM] });
  fid = createFeature(db, { actor: PM, now: clock - H }, { project: P, slug: "pull", title: "拉取" }).row.id;
  setAutostartSwitch(db, { actor: PM, now: clock }, { project: P, on: true, featureId: fid, pm: FEATURE_PM, specWait: "on", reason: "测试" });
  card = `pvpull-${Math.random().toString(16).slice(2, 10)}`;
  sent = []; failSend = false;
  rmSync(RECOVERY_POLICY_PATH, { force: true });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  for (const path of specs.splice(0)) rmSync(path, { force: true });
});

test("修前红修后绿：默认 on，跨三个窗口只记提醒，pm-todo 仍列出，逐卡 notify 为零", async () => {
  verified(card);
  for (let i = 0; i < 3; i++) {
    expect(await tick()).toEqual([]);
    clock += POST_VERIFY_REPEAT_MS;
  }
  expect(records()).toHaveLength(3);
  expect(sent).toEqual([]);
  expect(pmTodos(db, P, (id) => readPostVerifySpec(id)?.text, clock)).toContainEqual(expect.objectContaining({ task: card, due: true }));
});

test("同日五卡先后到期，次日一条汇总全覆盖；重开只读台账不重复、无新卡翌日不推", async () => {
  const ids = Array.from({ length: 5 }, (_, i) => `${card}-${i}`);
  for (const id of ids) {
    verified(id);
    expect(await tick()).toEqual([]);
    clock += H;
  }
  expect(sent).toEqual([]);
  nextDay();
  expect(await tick()).toEqual([]);
  expect(sent).toEqual([{ to: FEATURE_PM, level: "action", text: `5 条上线后待办到期，\`ledger pm-todo\` 查看\n${ids.join("、")}` }]);
  expect(claims()).toHaveLength(1);
  closeLedger(join(dir, "ledger.sqlite"));
  db = openLedger(join(dir, "ledger.sqlite"));
  const reader = new LedgerReader(join(dir, "ledger.sqlite"));
  try {
    expect(await postVerifyTick({ ...env(), db: reader.get() as Database })).toEqual([]);
    clock += POST_VERIFY_REPEAT_MS;
    expect(await postVerifyTick({ ...env(), db: reader.get() as Database })).toEqual([]);
  } finally { reader.close(); }
  nextDay();
  expect(await tick()).toEqual([]);
  expect(sent).toHaveLength(1);
});

test("每天只发一次，新到期延至下一批次，已汇总旧卡不重复列", async () => {
  verified(card);
  await tick(); nextDay(); await tick();
  const fresh = `${card}-new`;
  verified(fresh); await tick();
  clock += POST_VERIFY_REPEAT_MS; await tick();
  expect(sent).toHaveLength(1);
  nextDay(); await tick();
  expect(sent).toHaveLength(2);
  expect(sent[1].text).toBe(`1 条上线后待办到期，\`ledger pm-todo\` 查看\n${fresh}`);
  expect(claims()).toHaveLength(2);
});

test("每日汇总先认领再发送，发送失败 / 重启不重复认领，待办仍能拉取", async () => {
  verified(card);
  await tick(); nextDay();
  failSend = true;
  expect((await tick())[0].error).toContain("temporary offline");
  expect(claims()).toHaveLength(1);
  failSend = false;
  closeLedger(join(dir, "ledger.sqlite"));
  db = openLedger(join(dir, "ledger.sqlite"));
  expect(await tick()).toEqual([]);
  expect(sent).toEqual([]);
  expect(pmTodos(db, P, (id) => readPostVerifySpec(id)?.text, clock)).toContainEqual(expect.objectContaining({ task: card, due: true }));
  nextDay(); await tick();
  expect(sent).toEqual([]);
});

test("崩溃窗口：领取后、发送前重启，不会再次把当天同一汇总交给发送端", async () => {
  verified(card); await tick(); nextDay();
  expect(await ledger("ledger", "scheduler-autostart", "post-verify-pull", P, "claim")).toMatchObject({ ok: true, due: true });
  closeLedger(join(dir, "ledger.sqlite"));
  db = openLedger(join(dir, "ledger.sqlite"));
  expect(await tick()).toEqual([]);
  expect(claims()).toHaveLength(1);
  expect(sent).toEqual([]);
});

test("汇总前已结 / 非 verified / 无规格 / 缺真实小节的卡不再列出", async () => {
  const ids = [card, `${card}-stage`, `${card}-missing`, `${card}-section`];
  for (const id of ids) verified(id);
  await tick();
  done(card);
  db.run("UPDATE tasks SET stage = 'live' WHERE id = ?", [ids[1]]);
  rmSync(specs.find((p) => p.endsWith(`${ids[2]}.md`))!);
  writeFileSync(specs.find((p) => p.endsWith(`${ids[3]}.md`))!, "# 没有上线后章节\n");
  nextDay();
  expect(await tick()).toEqual([]);
  expect(sent).toEqual([]);
  expect(claims()).toEqual([]);
});

test("多 feature PM 的项目只发一条给当班 PM", async () => {
  verified(card);
  const other = createFeature(db, { actor: PM, now: clock }, { project: P, slug: "other", title: "其他" }).row.id;
  verified(`${card}-other`, clock, "- 验证", other);
  await tick(); nextDay(); await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(PM);
  expect(sent[0].text).toContain(card);
  expect(sent[0].text).toContain(`${card}-other`);
});

test("overdue 失败后下个窗口重试，当班 PM action 送达一次后终结，feature PM 不收", async () => {
  verified(card, clock - 72 * H - 1);
  failSend = true;
  expect((await tick())[0].error).toContain("temporary offline");
  expect(getEventByDedup(db, `post-verify-overdue:${card}:on`)).toBeNull();
  failSend = false;
  expect(await tick()).toEqual([]);
  expect(sent).toEqual([]);
  for (let i = 0; i < 3; i++) {
    clock += POST_VERIFY_REPEAT_MS;
    expect(await tick()).toEqual([]);
  }
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: PM, level: "action" });
  expect(sent[0].text).toStartWith(`[上线后待办] ${card} 上线后 PM 步骤 72 小时未结`);
  expect(records().map((e) => e.data.kind)).toEqual(["overdue", "overdue", "overdue-sent"]);
  nextDay(); await tick();
  expect(sent).toHaveLength(1);
  expect(claims()).toEqual([]);
});

test("观察期 on 到点才记录，超时从观察期满后 72 小时算", async () => {
  verified(card, clock, "观察期：24 小时\n- 核对");
  setAutostartSwitch(db, { actor: PM, now: clock }, { project: P, on: true, postVerifyDefer: "on", reason: "观察期" });
  const initial = clock;
  await tick(); expect(records()).toEqual([]);
  clock = initial + 24 * H; await tick();
  expect(records().map((r) => r.data.kind)).toEqual(["remind"]);
  expect(sent).toEqual([]);
  clock = initial + 96 * H; await tick();
  expect(records().at(-1)?.data.kind).toBe("remind");
  clock += POST_VERIFY_REPEAT_MS; await tick();
  expect(sent.filter((s) => s.text.includes("72 小时未结"))).toEqual([expect.objectContaining({ to: PM, level: "action" })]);
});

test("超时已终结后延长观察期，即使回到 remind 也不再混入每日汇总", async () => {
  verified(card);
  const initial = clock;
  await tick(); clock += 73 * H; await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(PM);
  writeFileSync(specs[0], `## 上线后 PM\n观察期：168 小时\n- 核对\n`);
  setAutostartSwitch(db, { actor: PM, now: clock }, { project: P, on: true, postVerifyDefer: "on", reason: "延期" });
  clock = initial + 169 * H;
  expect(await tick()).toEqual([]);
  expect(sent).toHaveLength(1);
  expect(claims()).toEqual([]);
});

test("off：同输入逐字保留首轮、三个窗口的对象、正文和 info 级别", async () => {
  policy("off"); verified(card);
  for (let i = 0; i < 3; i++) { await tick(); clock += POST_VERIFY_REPEAT_MS; }
  const legacy = `[上线后待办] ${card} 已上线，规格要求 PM 接着做：\n- 核对真实样本\n做完用 `
    + `\`ledger note ${card} "<做了什么>" --dedup post-verify-done:${card}\` 结掉。`;
  expect(sent).toEqual(Array.from({ length: 3 }, () => ({ to: FEATURE_PM, level: "info", text: legacy })));
  expect(records()).toHaveLength(3);
  nextDay(); await tick();
  expect(sent).toHaveLength(4);
  expect(claims()).toEqual([]);
});

test("observe：保留旧提醒并写一次恢复观察，不产每日汇总", async () => {
  policy("observe"); verified(card);
  await tick(); clock += POST_VERIFY_REPEAT_MS; await tick();
  expect(sent).toHaveLength(2);
  expect(sent.every((s) => s.level === "info")).toBe(true);
  expect(listEvents(db, { target: card }).filter((e) => e.data.op === "recovery_observe")).toHaveLength(1);
  nextDay(); await tick(); expect(claims()).toEqual([]);
});

test("共用 specWait observe 只记、off 不记；独立恢复键默认 on，尊重项目模式及键覆盖", async () => {
  verified(card);
  expect(recoveryPolicy(P, "postVerifyPull").mode).toBe("on");
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [P]: { mode: "off" } } }));
  expect(recoveryPolicy(P, "postVerifyPull").mode).toBe("off");
  policy("on");
  expect(recoveryPolicy(P, "postVerifyPull").mode).toBe("on");
  setAutostartSwitch(db, { actor: PM, now: clock }, { project: P, on: true, specWait: "observe", reason: "观察" });
  await tick(); nextDay(); await tick();
  expect(sent).toEqual([]); expect(records()).toHaveLength(2);
  setAutostartSwitch(db, { actor: PM, now: clock }, { project: P, on: true, specWait: "off", reason: "关闭" });
  nextDay(); await tick();
  expect(sent).toEqual([]); expect(records()).toHaveLength(2);
});

test("汇总 CLI 重核身份、项目、模式；拒自定义正文与非法操作", async () => {
  verified(card); await tick(); nextDay();
  const cmd = ["ledger", "scheduler-autostart", "post-verify-pull", P];
  expect(await runAs(PM, ...cmd, "claim")).toMatchObject({ ok: false, code: "forbidden" });
  expect(await ledger(...cmd, "sent")).toMatchObject({ ok: false, code: "invalid" });
  expect(await ledger(...cmd, "claim", "--text", "伪造正文")).toMatchObject({ ok: false, code: "invalid" });
  expect(await ledger(...cmd.slice(0, -1), "other", "claim")).toMatchObject({ ok: false, code: "forbidden" });
  policy("off");
  expect(await ledger(...cmd, "claim")).toMatchObject({ ok: false, code: "conflict" });
  expect(claims()).toEqual([]);
});

test("汇总 CLI 失租抛 SchedulerStopped，停止后不发送", async () => {
  verified(card); await tick(); nextDay();
  await expect(postVerifyTick({ ...env(), ledger: async (...args) => args.includes("post-verify-pull")
    ? { ok: false, code: "lease-lost", error: "stopped" } : ledger(...args) })).rejects.toBeInstanceOf(SchedulerStopped);
  expect(sent).toEqual([]);
});

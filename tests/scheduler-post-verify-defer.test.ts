/**
 * agents-PVDEFER1 验收线 1–8（上线后提醒的观察期）：真实临时台账 + 进程内 ledger CLI 跑完整自动开卡 tick（与 tests/scheduler-post-verify.test.ts 同一套接线），
 * 发送函数换成记录器。卡在 T 时刻 verified，时钟统一走 clock。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localTime } from "../src/lib/ledger-audit-lend-grant.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { importTask, setMeta } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import { classifyPmPush } from "../src/lib/pm-digest.js";
import { readSwitch } from "../src/lib/scheduler-autostart.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { parseObservation } from "../src/lib/scheduler-post-verify-defer.js";
import { POST_VERIFY_REPEAT_MS, postVerifyText, readPostVerifySpec } from "../src/lib/scheduler-post-verify-ledger.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", X = "agent-claudestra";
const H = 3600_000, MIN = 60_000;
let dir: string, db: Database, clock: number, seq: number, card: string, fid: string, T: number;
let sent: { project: string; to: string; text: string }[];
const specs: string[] = [];

const ledgerDeps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {}, now: () => clock + seq++,
  autoDispatch: () => true, autoProjects: () => [P],
});
const schedLedger = async (...args: string[]) => runLedger(args.slice(1), { ...ledgerDeps("scheduler"), now: () => clock });

const REST = "- 跑 `ledger shared-auto observe → on`";
const section = (first: string | null) => (first === null ? REST : `${first}\n${REST}`);
function spec(id: string, first: string | null): void {
  const d = statePath("ledger", "docs", "tasks");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.md`), `# ${id}\n\n## 目标\n做事\n\n## 上线后 PM\n${section(first)}\n\n## 附录\n不算\n`);
  specs.push(join(d, `${id}.md`));
}

function verified(id: string, verifiedTs: number): void {
  importTask(db, { actor: "owner", now: verifiedTs }, {
    createdTs: verifiedTs - H, initialStage: "live",
    events: [{ kind: "stage", ts: verifiedTs, data: { from: "live", to: "verified" } }],
    task: { project: P, id, stage: "verified", title: `${id} 卡`, kind: "code", agent: "agent-w", pm: PM },
  });
  db.run("UPDATE tasks SET featureId = ? WHERE id = ?", [fid, id]);
}

function env(): StartTickEnv {
  const e: StartTickEnv = {
    db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 }, ledger: schedLedger,
    plain: async () => { throw new Error("不该开卡"); }, startEnv: () => { throw new Error("不该开卡"); }, stepIO: () => { throw new Error("不该开卡"); },
    readSpec: readPostVerifySpec, quota: async () => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null, windows: [] }),
    notifyPm: async () => { throw new Error("应走 specWaitSend"); }, memo: new Set(), now: () => clock, attempt: () => "a1",
  };
  return Object.assign(e, { specWaitSend: async (_db: Database, project: string, to: string, text: string) => void sent.push({ project, to, text }) });
}
const tick = async () => expect(await autostartTick(env())).toEqual([]);
const at = async (ms: number) => {
  clock = T + ms;
  await tick();
};
const sw = (input: { specWait?: string; postVerifyDefer?: string }) =>
  setAutostartSwitch(db, { actor: PM, now: clock + seq++ }, { project: P, on: true, ...input, reason: "测试" });
const records = (id = card) => listEvents(db, { target: id }).filter((e) => e.data.op === "post_verify");
const head = (id = card) => `[上线后待办] ${id}`;
const isPostVerify = (text: string) =>
  classifyPmPush({ fromKind: "local", sender: "scheduler", intent: "request", triggerKind: "agent_tool", oneShot: true, body: text });

beforeEach(() => {
  clock = Date.now();
  T = clock;
  seq = 0;
  sent = [];
  dir = mkdtempSync(join(tmpdir(), "pvdefer1-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM, X] });
  fid = createFeature(db, { actor: PM, now: clock + seq++ }, { project: P, slug: "n8", title: "共享台账" }).row.id;
  card = `pvdefer1-${Math.random().toString(16).slice(2, 10)}`;
  verified(card, T);
  setAutostartSwitch(db, { actor: PM, now: clock + seq++ }, { project: P, on: true, featureId: fid, pm: X, reason: "测试" });
});
afterEach(() => {
  for (const s of sent) {
    expect(s.text).toStartWith("[上线后待办] ");
    expect(isPostVerify(s.text)).toMatchObject({ send: "digest", kind: "post-verify" });
  }
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
  for (const p of specs.splice(0)) rmSync(p, { force: true });
});

describe("[验收线 1] parseObservation", () => {
  test("整行匹配才认，封顶 168，含「观察期」但不匹配 = bad，第一行没写 = null", () => {
    expect(parseObservation("观察期:24 小时\n- 其余")).toEqual({ hours: 24, capped: false });
    expect(parseObservation("观察期：24小时")).toEqual({ hours: 24, capped: false });
    expect(parseObservation("  观察期 ： 24 小时  ")).toEqual({ hours: 24, capped: false });
    expect(parseObservation("观察期:168 小时")).toEqual({ hours: 168, capped: false });
    expect(parseObservation("观察期:500 小时")).toEqual({ hours: 168, capped: true });
    for (const bad of ["观察期:1 天", "观察期:0 小时", "- 观察期:24 小时", "**观察期**:24 小时", "观察期:1.5 小时", "观察期"]) expect(parseObservation(bad)).toBe("bad");
    expect(parseObservation("- 跑 observe\n观察期:24 小时")).toBeNull();
    expect(parseObservation("- 跑 observe")).toBeNull();
    expect(parseObservation(null)).toBeNull();
  });
});

describe("[验收线 2] on 档按时提醒", () => {
  test("到点前 0 消息 0 记录；到点后首轮 1 条、30 分钟后再 1 条；超时分界从观察期满算", async () => {
    sw({ specWait: "on", postVerifyDefer: "on" });
    spec(card, "观察期:24 小时");
    await at(MIN);
    await at(23 * H + 59 * MIN);
    expect(sent).toEqual([]);
    expect(records()).toEqual([]);
    await at(24 * H + 1000);
    expect(sent.map((s) => s.to)).toEqual([X]);
    expect(sent[0].text).toBe(postVerifyText("remind", card, section("观察期:24 小时")));
    await at(24 * H + 1000 + POST_VERIFY_REPEAT_MS);
    expect(sent.map((s) => s.to)).toEqual([X, X]);
    await at(72 * H + 1000);
    expect(sent.map((s) => s.to)).toEqual([X, X, X]);
    expect(records().at(-1)?.data.kind).toBe("remind");
    await at(96 * H + 1000);
    expect(sent).toHaveLength(4);
    expect(sent[3].to).toBe(PM);
    expect(sent[3].text).toStartWith(`${head()} 上线后 PM 步骤在观察期（24 小时）满后 72 小时未结`);
    for (let i = 1; i <= 3; i++) await at(96 * H + 1000 + i * POST_VERIFY_REPEAT_MS);
    expect(sent).toHaveLength(4);
  });
});

describe("[验收线 2] 超时终结之后改观察期", () => {
  test("超时已发并终结后把观察期改长：kind 回退成 remind 也 0 条、0 条新记录；writer 直接记 remind 也不写", async () => {
    sw({ specWait: "on", postVerifyDefer: "on" });
    spec(card, "观察期:24 小时");
    await at(97 * H);
    expect(sent.map((s) => s.to)).toEqual([PM]);
    const n = records().length;
    spec(card, "观察期:48 小时");
    await at(98 * H);
    for (let i = 1; i <= 3; i++) await at(98 * H + i * POST_VERIFY_REPEAT_MS);
    expect(sent).toHaveLength(1);
    expect(records()).toHaveLength(n);
    const r = await schedLedger("ledger", "scheduler-autostart", "post-verify", card, "remind", "--mode", "on", "--pm", X);
    expect(r).toMatchObject({ ok: true, due: false });
    expect(records()).toHaveLength(n);
  });

  test("终结记录早于最近一次进 verified（卡重新 verified）不挡，照旧重新提醒", async () => {
    sw({ specWait: "on", postVerifyDefer: "on" });
    spec(card, "观察期:24 小时");
    await at(97 * H);
    expect(sent).toHaveLength(1);
    // 卡回 live 再 verified 的 stage 事件（stage 事件不能经 appendEvent 追加，测试里直接插行）
    db.run("INSERT INTO events (ts, actor, project, target, kind, data) VALUES (?, 'owner', ?, ?, 'stage', ?)",
      [T + 98 * H, P, card, JSON.stringify({ from: "live", to: "verified" })]);
    await at(98 * H + MIN);
    expect(sent).toHaveLength(1);
    await at(122 * H + 1000);
    expect(sent.map((s) => s.to)).toEqual([PM, X]);
  });
});

describe("[验收线 3] on 档封顶", () => {
  test("观察期 500 小时按 168：T+167h59m 0 条，T+168h+1s 1 条", async () => {
    sw({ specWait: "on", postVerifyDefer: "on" });
    spec(card, "观察期:500 小时");
    await at(167 * H + 59 * MIN);
    expect(sent).toEqual([]);
    expect(records()).toEqual([]);
    await at(168 * H + 1000);
    expect(sent.map((s) => s.to)).toEqual([X]);
  });
});

describe("[验收线 4] observe 档（缺省）", () => {
  test("时机照旧；到点前的提醒末行注明 on 时本该何时才提醒；到点后不加；超时仍从 verified 算", async () => {
    sw({ specWait: "on" });
    expect(readSwitch(db, P).postVerifyDefer).toBeUndefined();
    spec(card, "观察期:24 小时");
    await at(MIN);
    expect(sent).toHaveLength(1);
    const note = `（观察期开关 observe：规格写了观察期 24 小时，开关 on 时本该在 ${localTime(T + 24 * H)} 之后才提醒）`;
    expect(sent[0].text).toBe(`${postVerifyText("remind", card, section("观察期:24 小时"))}\n${note}`);
    await at(24 * H + 1000);
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toBe(postVerifyText("remind", card, section("观察期:24 小时")));
    await at(72 * H);
    expect(sent).toHaveLength(3);
    expect(sent[2].text).not.toContain("本该在");
    await at(72 * H + 1000);
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatchObject({ to: PM, text: postVerifyText("overdue", card, "") });
  });

  test("封顶时括号里注明超过 168 小时按 168 小时算", async () => {
    sw({ specWait: "on" });
    spec(card, "观察期:500 小时");
    await at(MIN);
    expect(sent[0].text.split("\n").at(-1)).toBe(
      `（观察期开关 observe：规格写了观察期 500 小时，开关 on 时本该在 ${localTime(T + 168 * H)} 之后才提醒；超过 168 小时按 168 小时算）`);
  });
});

describe("[验收线 5] 格式没认出 / 没写观察期", () => {
  test("on 档「观察期:1 天」：T+1 分钟照发 1 条，末行注明格式没认出", async () => {
    sw({ specWait: "on", postVerifyDefer: "on" });
    spec(card, "观察期:1 天");
    await at(MIN);
    expect(sent).toHaveLength(1);
    expect(sent[0].text.split("\n").at(-1)).toContain("观察期格式没认出");
    expect(sent[0].text).toStartWith(postVerifyText("remind", card, section("观察期:1 天")));
  });

  test("off 档同一规格：正文逐字等于 postVerifyText，时机照旧", async () => {
    sw({ specWait: "on", postVerifyDefer: "off" });
    spec(card, "观察期:1 天");
    await at(MIN);
    expect(sent.map((s) => s.text)).toEqual([postVerifyText("remind", card, section("观察期:1 天"))]);
    spec(card, "观察期:24 小时");
    await at(MIN + POST_VERIFY_REPEAT_MS);
    expect(sent.map((s) => s.text).at(-1)).toBe(postVerifyText("remind", card, section("观察期:24 小时")));
    await at(72 * H + 1000);
    expect(sent.at(-1)).toMatchObject({ to: PM, text: postVerifyText("overdue", card, "") });
  });

  for (const mode of ["on", "observe", "off"]) {
    test(`没写观察期（第二行写了也不算）：${mode} 档正文与现在逐字相等、T+1 分钟就发`, async () => {
      sw({ specWait: "on", postVerifyDefer: mode });
      spec(card, null);
      const second = `${card}-2`;
      verified(second, T);
      const d = statePath("ledger", "docs", "tasks");
      writeFileSync(join(d, `${second}.md`), `## 上线后 PM\n${REST}\n观察期:24 小时\n`);
      specs.push(join(d, `${second}.md`));
      await at(MIN);
      expect(sent.map((s) => s.text).sort()).toEqual([
        postVerifyText("remind", card, REST), postVerifyText("remind", second, `${REST}\n观察期:24 小时`)].sort());
    });
  }
});

describe("[验收线 6] writer 重算", () => {
  const w = (...args: string[]) => runLedger(["scheduler-autostart", "post-verify", card, ...args], { ...ledgerDeps("scheduler"), now: () => clock });

  test("on 档到点前 remind / overdue → conflict 0 写入；到点后同一命令写入 1 条；调度读 observe 写时已切 on 同样 conflict", async () => {
    sw({ specWait: "on", postVerifyDefer: "on" });
    spec(card, "观察期:24 小时");
    clock = T + MIN;
    const r = await w("remind", "--mode", "on", "--pm", X);
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(String((r as { error?: unknown }).error)).toContain("观察期");
    clock = T + 80 * H;
    expect(await w("overdue", "--mode", "on", "--pm", PM)).toMatchObject({ ok: false, code: "conflict" });
    expect(records()).toEqual([]);
    clock = T + 24 * H + 1000;
    expect(await w("remind", "--mode", "on", "--pm", X)).toMatchObject({ ok: true, due: true, to: X });
    expect(records()).toHaveLength(1);
    clock = T + 96 * H + 1000;
    expect(await w("overdue", "--mode", "on", "--pm", PM)).toMatchObject({ ok: true, due: true, to: PM });
    expect(await w("remind", "--mode", "on", "--pm", X)).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("[验收线 7] autostart-set --post-verify-defer", () => {
  const run = (actor: string, ...extra: string[]) =>
    runLedger(["autostart-set", "on", "--project", P, "--reason", "核对完", ...extra], ledgerDeps(actor)) as Promise<Record<string, any>>;

  test("写入并记 meta 事件；非法值 invalid；不带旗标保留原值；非 PM / master / owner forbidden", async () => {
    expect(await run(PM, "--post-verify-defer", "on")).toMatchObject({ ok: true, autostart: { postVerifyDefer: "on" } });
    expect(readSwitch(db, P).postVerifyDefer).toBe("on");
    const ev = listEvents(db, {}).filter((e) => e.kind === "meta" && e.data.op === "autostart").at(-1);
    expect(ev).toMatchObject({ actor: PM, data: { value: { postVerifyDefer: "on" } } });
    expect(ev?.text).toContain("核对完");
    expect(await run(PM, "--post-verify-defer", "later")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "--spec-wait", "on")).toMatchObject({ ok: true, autostart: { postVerifyDefer: "on", specWait: "on" } });
    for (const m of ["observe", "off"]) expect(await run("master", "--post-verify-defer", m)).toMatchObject({ ok: true, autostart: { postVerifyDefer: m } });
    expect(await run("agent-w", "--post-verify-defer", "on")).toMatchObject({ ok: false, code: "forbidden" });
    expect(readSwitch(db, P).postVerifyDefer).toBe("off");
  });
});

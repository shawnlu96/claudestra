/**
 * PMQUIET1 验收线 4 / 6（统一 PM 提醒复核）：S2W 形状的审查已回提醒（tests/scheduler-review-pm-kit.test.ts，真台账 + 正规 ledger CLI）
 * 在记账之后、实际投出之前卡被推进 / 登了合并意图：notifyProjectPm 出口、bridge 立即投、pm-hold 延迟整包（含有效与过期混合的包）都不投，
 * 台账只一条跳过事件。pmQuiet=off 不读不记、正文与投递逐字照旧；observe 照投只记样本。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PmDigest } from "../src/bridge/pm-digest.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { PM_HOLD_LABEL, PmHoldStore } from "../src/lib/pm-hold.js";
import { PM_QUIET_SKIP_OP, pmNoticeGate, pmNoticeRefOf } from "../src/lib/pm-notice-current.js";
import { notifyProjectPm } from "../src/lib/pm-notify.js";
import { activeProjectPm } from "../src/lib/pm-role.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { reviewPmCandidate } from "../src/lib/scheduler-review-pm-wait.js";
import { configurePmQuietMode, pmNoticeTag } from "../src/lib/scheduler-ui-evidence-repair.js";
import { FPM, PM, pooledManual, setMode, type World } from "./scheduler-review-pm-kit.test.js";

let w: World & Awaited<ReturnType<typeof pooledManual>>;
let restore: (() => void)[] = [];
const quiet = (m: RecoveryMode) => restore.push(configurePmQuietMode(() => m));
beforeEach(async () => { w = await pooledManual(); });
afterEach(() => { for (const r of restore.splice(0).reverse()) r(); w.close(); });

const now = () => w.f.tickDeps.now!();
const skips = () => listEvents(w.db, { target: "T1" }).filter((e) => e.data.op === PM_QUIET_SKIP_OP);
const observed = () => listEvents(w.db, { target: "T1" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "pmQuiet");
/** 提醒已记账（try 意图），正文在手：模拟「生成后、发送前」 */
async function recorded(): Promise<string> {
  await setMode(w, "on");
  await w.tick();
  expect(w.sent).toHaveLength(1);
  return w.sent[0].text;
}
/** 发送前卡被推进：PM 推进合并阶段（merge_deploy 节点所在） */
const advance = () => w.as(PM, "stage", "T1", "--from", "review", "--to", "merge", "--text", "PM 推进合并");
/** 发送前登了未结的调度意图（合并意图 / 新一轮在跑） */
const openIntent = () => w.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev,
  head, templateVersion, status, reason, createdAt, updatedAt)
  SELECT 'x-merge', id, project, 'merge_deploy', 'merge', NULL, 0, (SELECT MAX(seq) FROM events), rev, specRev, headSHA, 2, 'pending', '合并', 1, 1
  FROM tasks WHERE id = 'T1'`);

describe("[验收线 4] 提醒生成后、发送前状态前进", () => {
  test("引用按实例键 + 台账发送意图认出；仍是现状照投、不记跳过", async () => {
    quiet("on");
    const text = await recorded();
    expect(pmNoticeRefOf(w.db, "p", text)).toEqual({ kind: "review_pm_wait", taskId: "T1", key: reviewPmCandidate(w.db, "T1", now())!.key });
    expect(pmNoticeRefOf(w.db, "p", text.replace(/实例 [0-9a-f]{16}$/, "实例 0000000000000000"))).toBeNull(); // 台账没有那条发送意图：不认
    expect(pmNoticeGate(w.db, "p", text, now())).toEqual({ send: true });
    expect(skips()).toEqual([]);
  });

  test("推进到合并阶段：notifyProjectPm 出口实际发送为零（不碰 bridge），台账一次跳过事件；重复调用不重复记", async () => {
    quiet("on");
    const text = await recorded();
    expect((await advance()).ok).toBe(true);
    for (let i = 0; i < 3; i++) await notifyProjectPm(w.db, "p", text, { fromName: "scheduler", level: "action", to: FPM });
    expect(skips()).toHaveLength(1);
    expect(skips()[0]).toMatchObject({ actor: "scheduler", data: { kind: "review_pm_wait" } });
    expect(skips()[0].text).toContain("卡现在 merge");
  });

  test("登了未结意图（合并意图已存在）同样跳过", async () => {
    quiet("on");
    const text = await recorded();
    openIntent();
    expect(pmNoticeGate(w.db, "p", text, now())).toMatchObject({ send: false, ref: { kind: "review_pm_wait", taskId: "T1" } });
    expect(skips()).toHaveLength(1);
  });

  test("bridge 立即投与 pm-hold 延迟释放：混合包只带有效那条，过期的出队；全过期不发空包", async () => {
    quiet("on");
    const text = await recorded();
    const pm = activeProjectPm(w.db, "p")!;
    const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
    const to: LocalEndpoint = { kind: "local", agentName: pm, channelId: "ch-pm", ws };
    const store = new PmDigestStore(join(w.f.dir, "pm-digest.json"), join(w.f.dir, "pm-digest-mode.json"));
    const hold = new PmHoldStore(join(w.f.dir, "pm-hold-mode.json"), join(w.f.dir, "pm-hold.json"));
    hold.setSetting("p", { mode: "hold", everyMin: 60, since: 0 });
    const out: Envelope[] = [];
    const raw = async (e: Envelope): Promise<Delivery> => (out.push({ ...e }), { envelope: e, outcome: { kind: "sent" } });
    const digest = new PmDigest({ store, now, db: () => w.db, ledger: () => w.db, hold, heldCarriers: () => new Set(),
      agents: () => [{ name: pm, projectId: "p", channelId: "ch-pm" } as never] });
    const send = (e: Envelope) => digest.wrap(raw, w.db, "p")(e, to);
    digest.start({ clients: new Map([["ch-pm", { ws }]]), deliver: send }, false);
    let n = 0;
    const sched = (content: string): Envelope => ({ from: { kind: "local", agentName: "scheduler", channelId: "", ws }, to, intent: "request", content,
      meta: { messageId: `m${++n}`, threadId: `t${n}`, ts: "2026-10-16T00:00:00Z", triggerKind: "agent_tool", skipInterAgentWatchdog: true } });
    try {
      await send(sched(text));
      await send(sched("[调度引擎] T9 退回人工，请接手：别的事"));
      expect(hold.queue()).toHaveLength(2);
      expect((await advance()).ok).toBe(true);
      // 已暂存后才过期：释放时逐条复核
      hold.setSetting("p", { mode: "off", everyMin: 60, since: 0 });
      await digest.tick();
      expect(out).toHaveLength(1);
      expect(out[0].from).toEqual({ kind: "bridge", label: PM_HOLD_LABEL });
      expect(out[0].content).toContain("攒了 1 条");
      expect(out[0].content).toContain("T9 退回人工");
      expect(out[0].content).not.toContain("[审查已回]");
      expect(hold.queue()).toHaveLength(0);
      expect(skips()).toHaveLength(1);

      // 立即投：过期的直接不投（sent，note pm-quiet）
      expect((await send(sched(text))).outcome).toEqual({ kind: "sent", note: "pm-quiet" });
      expect(out).toHaveLength(1);

      // 全过期的暂存包：不发空包
      hold.setSetting("p", { mode: "hold", everyMin: 60, since: 0 });
      quiet("off");
      await send(sched(text)); // off 时照常入暂存（不复核）
      restore.pop()!();
      hold.setSetting("p", { mode: "off", everyMin: 60, since: 0 });
      await digest.tick();
      expect(out).toHaveLength(1);
      expect(hold.queue()).toHaveLength(0);
      expect(skips()).toHaveLength(1); // 同一实例：去重台账只一条
    } finally { digest.stop(); }
  });
});

/** 真 PmDigest 包装器 + 可控末端：raw 的结果由 reply 决定（缺省真送到），gate 让第一封挂起占住项目串行 */
async function digestKit(text: string) {
  const pm = activeProjectPm(w.db, "p")!;
  const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
  const to: LocalEndpoint = { kind: "local", agentName: pm, channelId: "ch-pm", ws };
  const store = new PmDigestStore(join(w.f.dir, "pm-digest.json"), join(w.f.dir, "pm-digest-mode.json"));
  await store.setPullMode("p", "off");
  const hold = new PmHoldStore(join(w.f.dir, "pm-hold-mode.json"), join(w.f.dir, "pm-hold.json"));
  const out: Envelope[] = [];
  const kit = { pm, to, store, hold, out, reply: (_e: Envelope): Delivery["outcome"] => ({ kind: "sent" }), gate: null as Promise<void> | null };
  const raw = async (e: Envelope): Promise<Delivery> => {
    const g = kit.gate;
    kit.gate = null;
    if (g) await g;
    out.push({ ...e });
    return { envelope: e, outcome: kit.reply(e) };
  };
  const digest = new PmDigest({ store, now, db: () => w.db, ledger: () => w.db, hold, heldCarriers: () => new Set(),
    agents: () => [{ name: pm, projectId: "p", channelId: "ch-pm" } as never] });
  const send = (e: Envelope) => digest.wrap(raw, w.db, "p")(e, to);
  digest.start({ clients: new Map([["ch-pm", { ws }]]), deliver: send }, false);
  let n = 0;
  const sched = (content: string): Envelope => ({ from: { kind: "local", agentName: "scheduler", channelId: "", ws }, to, intent: "request", content,
    meta: { messageId: `k${++n}`, threadId: `t${n}`, ts: "2026-10-16T00:00:00Z", triggerKind: "agent_tool", skipInterAgentWatchdog: true } });
  return { ...kit, kit, digest, send, sched, text };
}

describe("[验收线 4] 串行等待与押后整包（复审 serial-stale / held-bundle）", () => {
  test("过了 gate 在项目串行里排队的提醒，等待期间卡前进：实际 send 为零，台账一次跳过", async () => {
    quiet("on");
    const k = await digestKit(await recorded());
    try {
      let open!: () => void;
      k.kit.gate = new Promise<void>((r) => { open = r; });
      const first = k.send(k.sched("[调度引擎] T9 退回人工，请接手：占住串行"));
      const second = k.send(k.sched(k.text)); // 此刻仍是现状：过 gate 进串行排队
      expect((await advance()).ok).toBe(true);
      open();
      await first;
      expect((await second).outcome).toEqual({ kind: "sent", note: "pm-quiet" });
      expect(k.out.map((e) => e.content)).toEqual(["[调度引擎] T9 退回人工，请接手：占住串行"]);
      expect(skips()).toHaveLength(1);
    } finally { k.digest.stop(); }
  });

  test("整包押在忙 PM 的队里后卡前进：重投时逐条重核，混合包重拼只带有效的，全过期不投", async () => {
    quiet("on");
    const k = await digestKit(await recorded());
    try {
      k.hold.setSetting("p", { mode: "hold", everyMin: 60, since: 0 });
      await k.send(k.sched(k.text));
      await k.send(k.sched("[调度引擎] T9 退回人工，请接手：别的事"));
      k.hold.setSetting("p", { mode: "off", everyMin: 60, since: 0 });
      k.kit.reply = () => ({ kind: "sent", note: "queued" }); // PM 忙：押后队列收下整包
      await k.digest.tick();
      expect(k.out).toHaveLength(1);
      expect(k.hold.queue()).toHaveLength(0);
      const saved = structuredClone({ ...k.out[0], to: undefined }) as unknown as Envelope; // 押后队列落盘的那份
      expect((await advance()).ok).toBe(true);
      k.kit.reply = () => ({ kind: "sent" });
      await k.send({ ...saved, to: k.to });
      expect(k.out).toHaveLength(2);
      expect(k.out[1].content).toContain("攒了 1 条");
      expect(k.out[1].content).toContain("T9 退回人工");
      expect(k.out[1].content).not.toContain("[审查已回]");
      expect(skips()).toHaveLength(1);

      // 只带过期条目的整包：不投
      const stale = { ...saved, to: k.to, pmHold: { entries: (saved as { pmHold?: { entries: { body: string }[] } }).pmHold!.entries
        .filter((e) => e.body.startsWith("[审查已回]")) } } as Envelope;
      expect((await k.send(stale)).outcome).toEqual({ kind: "sent", note: "pm-quiet" });
      expect(k.out).toHaveLength(2);
    } finally { k.digest.stop(); }
  });

  test("pmQuiet=off：整包信封不带原条目，押后重投逐字照旧", async () => {
    quiet("off");
    const k = await digestKit(await recorded());
    try {
      k.hold.setSetting("p", { mode: "hold", everyMin: 60, since: 0 });
      await k.send(k.sched(k.text));
      k.hold.setSetting("p", { mode: "off", everyMin: 60, since: 0 });
      await k.digest.tick();
      expect(k.out).toHaveLength(1);
      expect("pmHold" in k.out[0]).toBe(false);
      await advance();
      await k.send({ ...k.out[0], to: k.to });
      expect(k.out[1].content).toBe(k.out[0].content);
      expect(skips()).toEqual([]);
    } finally { k.digest.stop(); }
  });
});

describe("[验收线 6] pmQuiet=off / observe", () => {
  test("off：同一过期输入照投，不读不记；显式引用不加尾签", async () => {
    quiet("off");
    const text = await recorded();
    await advance();
    expect(pmNoticeGate(w.db, "p", text, now())).toEqual({ send: true });
    expect(skips()).toEqual([]);
    expect(observed()).toEqual([]);
  });

  test("observe：照投，只记一条「本会跳过」样本", async () => {
    quiet("observe");
    const text = await recorded();
    await advance();
    for (let i = 0; i < 2; i++) expect(pmNoticeGate(w.db, "p", text, now())).toEqual({ send: true });
    expect(skips()).toEqual([]);
    expect(observed()).toHaveLength(1);
  });

  test("未知类型沿用旧路；尾签格式可往返", async () => {
    quiet("on");
    expect(pmNoticeGate(w.db, "p", "[调度引擎] T1 退回人工，请接手：x", now())).toEqual({ send: true });
    const ref = { kind: "ui_evidence_repair" as const, taskId: "T1", key: "abc:s1" };
    expect(pmNoticeRefOf(w.db, "p", `正文${pmNoticeTag(ref)}`)).toEqual(ref);
    expect(pmNoticeRefOf(w.db, "p", `正文${pmNoticeTag(ref).replace("\n", " ")}`)).toEqual(ref);
    expect(pmNoticeRefOf(w.db, "p", "正文\n〔提醒复核 not_a_kind T1 k〕")).toBeNull();
  });
});

/**
 * hardening-IAFYI1: inter-agent 看门狗只催 agent 的直接请求（lib/ia-watchdog-scope.ts，恢复键 iaWatchdogScope）。
 * 信封照 bridge 各发送点真实填的路由字段造：send_to_agent（local / agent_tool / request）、回程 pushBackToCaller 与 reply 转发
 * （local / agent_tool / response|notification）、合成回程（local / bridge_synth|system|peer_http）。
 * 看门狗簿照 bridge.ts deliverToLocal 的装配：判据为真才 set，为假什么都不动；Stop 那头的保护条件一行不改（末尾的接线检查）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDirectAgentRequest, scopeIaWatchdog, useIaWatchdogPort, type IaWatchdogEnvelope } from "../src/lib/ia-watchdog-scope.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { hangsInterAgentWatchdog, hangsPendingReply } from "../src/lib/pending-reply-scope.js";
import { observedRecent, recordObserved, recoveryPolicy, type ObservedAction, type RecoveryMode, type RecoveryPolicy } from "../src/lib/recovery-policy.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let n = 0;
const env = (intent: string, triggerKind = "agent_tool", fromKind = "local", extra: { oneShot?: boolean; id?: string } = {}): IaWatchdogEnvelope =>
  ({ from: { kind: fromKind }, intent, meta: { messageId: extra.id ?? `m_${++n}`, triggerKind, skipInterAgentWatchdog: extra.oneShot || undefined } });
const REQUEST = () => env("request");
/** on 下不该催的本机形状：同一 sender 的通知 / 答复 / 广播，和转成 local 的合成回程 */
const NOT_REQUESTS = (): IaWatchdogEnvelope[] => [
  env("notification"), env("response"), env("broadcast"),
  env("request", "bridge_synth"), env("notification", "bridge_synth"), env("request", "system"), env("response", "peer_http"),
];

const PROJECTS: Record<string, string | undefined> = { "ch-pm": "p1", "ch-worker": "p1", "ch-other": "p2", "ch-master": undefined };
function rig(modes: Record<string, RecoveryMode>, over: { policy?: (project: string) => RecoveryPolicy | undefined; observe?: (a: ObservedAction) => void } = {}) {
  const observed: ObservedAction[] = [], logs: string[] = [], reads: string[] = [];
  useIaWatchdogPort({
    projectOf: (channelId) => {
      if (channelId === "ch-broken") throw new Error("registry 坏了");
      return PROJECTS[channelId];
    },
    policy: (project) => { reads.push(project); return over.policy?.(project) ?? { mode: modes[project] ?? "observe", manualAfterMs: null, source: "config" }; },
    observe: over.observe ?? ((a) => { observed.push(a); }),
    log: (line) => { logs.push(line); },
  });
  return { observed, logs, reads, modes };
}
/** bridge.ts 那一行的装配：旧保护三项 + 信封 + bridge 自己解析出的接收方频道 */
const hangs = (e: IaWatchdogEnvelope, to = "ch-pm", o: { sameWs?: boolean; registered?: boolean } = {}) =>
  e.from.kind === "local" && hangsInterAgentWatchdog(o.sameWs ?? false, e.meta.skipInterAgentWatchdog, o.registered ?? true, e, to);

afterEach(() => useIaWatchdogPort());

describe("isDirectAgentRequest：只认 bridge 填的路由字段", () => {
  test("local + agent_tool + request 才是直接请求；任一项不对都不是", () => {
    expect(isDirectAgentRequest(REQUEST())).toBe(true);
    for (const e of NOT_REQUESTS()) expect(isDirectAgentRequest(e)).toBe(false);
    for (const kind of ["bridge", "user", "api", "peer"]) expect(isDirectAgentRequest(env("request", "agent_tool", kind))).toBe(false);
  });
});

describe("on：只给直接请求挂", () => {
  test("直接请求照挂；同一 sender 的通知 / 答复 / 广播、local 形状的合成回程都不挂", () => {
    rig({ p1: "on" });
    expect(hangs(REQUEST())).toBe(true);
    for (const e of NOT_REQUESTS()) expect(hangs(e)).toBe(false);
  });
  test("原生 ledger 推送（from=bridge）和 oneShot 调度通知本来就不挂，三档都一样", () => {
    for (const mode of ["on", "observe", "off"] as const) {
      const r = rig({ p1: mode });
      expect(hangs(env("notification", "bridge_synth", "bridge"))).toBe(false); // bridge/team-router.ts envelopeOf
      expect(hangs(env("request", "agent_tool", "local", { oneShot: true }))).toBe(false); // lib/pm-notify.ts oneShot
      expect([r.observed.length, r.reads.length]).toEqual([0, 0]);
    }
  });
  test("旧保护照旧：发给自己、发送方不在册、oneShot 的直接请求也不挂", () => {
    rig({ p1: "on" });
    expect(hangs(REQUEST(), "ch-pm", { sameWs: true })).toBe(false);
    expect(hangs(REQUEST(), "ch-pm", { registered: false })).toBe(false);
    expect(hangs(env("request", "agent_tool", "local", { oneShot: true }))).toBe(false);
  });
  test("判据里没有名字和正文：信封形状相同结论就相同（名字像 scheduler 的直接请求照催，写着「请答」的系统通知不催）", () => {
    rig({ p1: "on" });
    const named = { ...REQUEST(), from: { kind: "local", agentName: "agent-scheduler" }, content: "FYI，不用回" };
    const pleading = { ...env("notification", "bridge_synth"), from: { kind: "local", agentName: "agent-a" }, content: "[🤖 来自 agent-a] 请答？" };
    expect([hangs(named), hangs(pleading)]).toEqual([true, false]);
  });
});

describe("请求与通知交错（看门狗簿以接收方频道为 key）", () => {
  type Entry = { fromLabel: string; retries: number };
  const arrive = (book: Map<string, Entry>, e: IaWatchdogEnvelope, fromLabel: string, to = "ch-pm") => {
    if (hangs(e, to)) book.set(to, { fromLabel, retries: 0 });
  };
  test("on：后到的通知 / 回程不覆盖也不删除先前直接请求的那一条，已催次数不被清零", () => {
    rig({ p1: "on" });
    const book = new Map<string, Entry>();
    arrive(book, REQUEST(), "agent-a");
    book.get("ch-pm")!.retries = 1; // Stop 已经催过一次
    for (const e of NOT_REQUESTS()) arrive(book, e, "agent-b");
    expect(book.get("ch-pm")).toEqual({ fromLabel: "agent-a", retries: 1 });
    arrive(book, REQUEST(), "agent-c"); // 新的直接请求才换人
    expect(book.get("ch-pm")).toEqual({ fromLabel: "agent-c", retries: 0 });
  });
  test("on：只收到通知的频道簿上没有条目，Stop 没东西可催", () => {
    rig({ p1: "on" });
    const book = new Map<string, Entry>();
    for (const e of NOT_REQUESTS()) arrive(book, e, "agent-b");
    expect(book.size).toBe(0);
  });
  test("observe / off：和改前一样，通知照挂、照覆盖", () => {
    for (const mode of ["observe", "off"] as const) {
      rig({ p1: mode });
      const book = new Map<string, Entry>();
      arrive(book, REQUEST(), "agent-a");
      arrive(book, env("notification"), "agent-b");
      expect(book.get("ch-pm")?.fromLabel).toBe("agent-b");
    }
  });
});

describe("三档与热切", () => {
  test("off：旧过滤，不记观察；observe：旧行为 + 按 messageId 只记一条；on：收窄。每次现读，切档立刻生效", () => {
    const r = rig({ p1: "off" });
    const fyi = env("notification", "agent_tool", "local", { id: "reply_fwd_1_a" });
    expect([hangs(fyi), r.observed.length]).toEqual([true, 0]);
    r.modes.p1 = "observe";
    expect([hangs(fyi), hangs(fyi), hangs(fyi, "ch-worker")]).toEqual([true, true, true]); // 押后重投、同项目另一位收件人：还是这一条消息
    expect(r.observed).toHaveLength(1);
    expect(r.observed[0]).toMatchObject({ project: "p1", mechanism: "iaWatchdogScope", target: "", actionKey: "ia:reply_fwd_1_a",
      data: { fromKind: "local", intent: "notification", triggerKind: "agent_tool", skipInterAgentWatchdog: false, messageId: "reply_fwd_1_a", receiverChannelId: "ch-pm" } });
    expect(JSON.stringify(r.observed[0])).not.toContain("content");
    expect(hangs(env("response"))).toBe(true);
    expect(r.observed).toHaveLength(2);
    r.modes.p1 = "on";
    expect([hangs(fyi), r.observed.length]).toEqual([false, 2]);
    r.modes.p1 = "off";
    expect(hangs(fyi)).toBe(true);
  });
  test("直接请求三档都挂，且不读档位、不记观察（observe 样本里不会混进直接请求）", () => {
    for (const mode of ["on", "observe", "off"] as const) {
      const r = rig({ p1: mode });
      expect([hangs(REQUEST()), r.reads.length, r.observed.length]).toEqual([true, 0, 0]);
    }
  });
  test("档位按接收方的项目取：p1 开了不影响 p2 的收件人", () => {
    rig({ p1: "on", p2: "off" });
    expect([hangs(env("notification"), "ch-pm"), hangs(env("notification"), "ch-other")]).toEqual([false, true]);
  });
  test("没有项目（master）/ 查不出 / 恢复键读不了：旧过滤，留诊断（同一频道同一原因只一行），不记观察", () => {
    const r = rig({ p1: "on" }, { policy: (project) => project === "p2" ? { mode: "off", manualAfterMs: null, source: "error", diagnostic: "recovery-policy.json 读不了" } : undefined });
    expect([hangs(env("notification"), "ch-master"), hangs(env("response"), "ch-master"), hangs(env("notification"), "ch-unknown")]).toEqual([true, true, true]);
    expect(hangs(env("notification"), "ch-broken")).toBe(true);
    expect(hangs(env("notification"), "ch-other")).toBe(true);
    expect(r.logs).toHaveLength(4);
    expect(r.logs.join("\n")).toContain("ch-master 按旧过滤挂看门狗：接收方在 registry 里没有项目");
    expect(r.logs.join("\n")).toContain("registry 坏了");
    expect(r.logs.join("\n")).toContain("recovery-policy.json 读不了");
    expect(r.observed).toHaveLength(0);
  });
  test("观察记不上：看门狗照旧挂，下次重投再记", () => {
    let fail = true;
    const got: ObservedAction[] = [];
    const r = rig({ p1: "observe" }, { observe: (a) => { if (fail) throw new Error("台账忙"); got.push(a); } });
    const fyi = env("notification");
    expect(hangs(fyi)).toBe(true);
    expect(r.logs.join("\n")).toContain("台账忙");
    fail = false;
    expect([hangs(fyi), got.length]).toEqual([true, 1]);
  });
});

describe("真实恢复键文件 + 台账", () => {
  test("缺省 observe：记进台账一条，跨进程重放不重复；文件切到 on / off 立刻换结论", () => {
    const ledgerPath = tempLedgerPath("ia-watchdog-"), db = openLedger(ledgerPath);
    const path = join(mkdtempSync(join(tmpdir(), "ia-watchdog-policy-")), "recovery-policy.json");
    const logs: string[] = [];
    const wire = () => useIaWatchdogPort({ projectOf: () => "p1", policy: (project, key) => recoveryPolicy(project, key, path),
      observe: (a) => { recordObserved(db, a, 1_000); }, log: (l) => { logs.push(l); } });
    wire();
    const odd = env("response", "agent_tool", "local", { id: "带 空格/的 id" }); // actionKey 收不下的形状取摘要
    try {
      expect(scopeIaWatchdog(true, odd, "ch-pm")).toBe(true);
      wire(); // 换端口 = 清掉进程内的去重，模拟 bridge 重启后同一条重投
      expect(scopeIaWatchdog(true, odd, "ch-pm")).toBe(true);
      const rows = observedRecent(db, "p1", 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ mechanism: "iaWatchdogScope", target: "" });
      expect(rows[0]!.text).toContain("from.kind=local intent=response triggerKind=agent_tool");
      writeFileSync(path, JSON.stringify({ projects: { p1: { keys: { iaWatchdogScope: "on" } } } }));
      expect([scopeIaWatchdog(true, odd, "ch-pm"), scopeIaWatchdog(true, REQUEST(), "ch-pm")]).toEqual([false, true]);
      writeFileSync(path, JSON.stringify({ projects: { p1: { keys: { iaWatchdogScope: "off" } } } }));
      expect(scopeIaWatchdog(true, env("notification"), "ch-pm")).toBe(true);
      writeFileSync(path, "{ 坏的");
      expect(scopeIaWatchdog(true, env("notification"), "ch-pm")).toBe(true); // 读不了 = off = 旧过滤
      expect(logs.join("\n")).toContain("恢复停手");
      expect(observedRecent(db, "p1", 10)).toHaveLength(1);
    } finally { closeLedger(ledgerPath); }
  });
});

describe("Web/API 的回复义务不归这里管", () => {
  test("on 下 API / 用户的 request 仍挂 pendingReply；skipInterAgentWatchdog=true（API 入站恒设）不清它", () => {
    const r = rig({ p1: "on" });
    expect(hangsPendingReply("request", "api", true)).toBe(true);
    expect(hangsPendingReply("request", "user", undefined)).toBe(true);
    expect(hangsPendingReply("request", "local", undefined)).toBe(true); // 直接请求两本账都挂
    expect(hangs(env("request", "system", "api", { oneShot: true }))).toBe(false); // 看门狗本来就只管 local 来源
    expect(r.reads).toHaveLength(0);
  });
});

describe("bridge.ts 接线", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "bridge.ts"), "utf8");
  test("只有一处调用，传旧保护三项 + 信封 + bridge 解析的接收方频道；bridge 里没有第二份判据", () => {
    const calls = src.split("\n").filter((l) => l.includes("hangsInterAgentWatchdog(") && !l.trimStart().startsWith("import"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.trim()).toBe('if (env.from.kind === "local" && hangsInterAgentWatchdog(env.from.ws === to.ws, env.meta.skipInterAgentWatchdog, '
      + "await channelStillRegistered(env.from.channelId), env, to.channelId)) {");
    expect(src).not.toContain("ia-watchdog-scope");
    expect(src).not.toContain("iaWatchdogScope");
  });
  test("Stop 那头的保护没动：本回合、非 StopFailure、非叫停之后才取看门狗条目", () => {
    expect(src).toContain('const iaPending = ownTurn && event !== "StopFailure" && !afterAbort ? pendingInterAgentMsg.get(cid) : undefined;');
    expect(src).toContain("if (iaPending.retries >= 1) {");
  });
});

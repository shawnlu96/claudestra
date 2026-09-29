/**
 * bridge/turn-cuts.ts 记录簿：送达 / 回复 / Stop / 事件交错，「停」压提醒并让 Autopilot 让位，押着的提醒何时作废，
 * 终端里自己按的打断，Codex 的打字投递状态。对抗式审查（#148 第 2 轮）P1-1 / P1-3 / P2-1 / P2-2 / P2-4 / P2-7 / P2-8 / P2-9 / P2-14 的回归。
 */
import { describe, expect, test } from "bun:test";
import { TurnCuts } from "../src/bridge/turn-cuts.js";
import type { Envelope } from "../src/bridge/router.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUT_TTL_MS, inflightFrom, stopHeadline, type CutEvent } from "../src/lib/turn-cuts.js";
import { inputHash, type ProgramInput } from "../src/lib/program-input.js";

const T0 = Date.parse("2026-09-28T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DEPLOY = "bun src/manager.ts web-release deploy";
const start = (id: string, name: string, cmd: string, at = T0): CutEvent => ({
  type: "tool_start", ts: iso(at), data: { toolId: id, name, summary: cmd, detail: name === "Bash" ? `描述\n───\n${cmd}` : cmd },
});
const tools = inflightFrom([start("t1", "Bash", DEPLOY)]);

function book(opts: { path?: string; escAt?: () => number; inputs?: () => ProgramInput[] } = {}) {
  let now = T0;
  const b = new TurnCuts(opts.path ?? null, () => now, async () => [{ at: opts.escAt?.() ?? 0, h: "" }, ...(opts.inputs?.() ?? [])]);
  return { b, tick: (ms: number) => void (now += ms), at: () => now };
}
const flush = () => new Promise((r) => setTimeout(r, 0)); // 会话记录打断标记的处理要先查一次 Esc 时刻（异步）
const env = (id: string, text: string, from: Envelope["from"] = { kind: "api", name: "owner", tokenId: "owner" } as Envelope["from"], ts = ""): Envelope =>
  ({
    from, to: { kind: "local", channelId: "ch" } as Envelope["to"], intent: "request", content: text,
    meta: { messageId: id, triggerKind: "api_user", ts, threadId: "t" },
  }) as unknown as Envelope;
const ev = (e: CutEvent, agent = "a") => ({ ...e, chatId: "ch", agent });
const preempt = (b: TurnCuts, by: string, t = tools) => b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: by, byName: "owner", tools: t });

describe("完整一轮", () => {
  test("打断 → 插话送达 → Stop 提醒一次（押后投、不 @）→ 再 Stop 不提醒", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "合并 T3 并上线"), "ch");
    tick(30_000);
    expect(preempt(b, "m2").turnTrigger?.messageId).toBe("m1");
    expect(b.onStop("ch", "Stop", "a")).toBeNull(); // 插话还没送达
    tick(1_200);
    b.noteDelivered(env("m2", "顺便看下 X"), "ch");
    tick(20_000);
    const n = b.onStop("ch", "Stop", "a")!;
    expect(n.meta.waitForIdle).toBe(true);
    expect(n.content).toContain(DEPLOY);
    expect(n.content).toContain("还没回复：owner");
    expect(b.onStop("ch", "Stop", "a")).toBeNull();
  });

  test("打断之后才回过同一地址（多半答的是插话）→ 提示核对，不当成没回", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "合并 T3"), "ch");
    tick(5_000);
    preempt(b, "m2");
    b.noteDelivered(env("m2", "x"), "ch");
    tick(5_000);
    b.noteReplied("ch", "api:owner");
    expect(b.onStop("ch", "Stop", "a")!.content).toContain("核对一下有没有答到");
  });

  test("agent 自己续上了（同命令再跑）→ 不提醒", () => {
    const { b, tick } = book();
    preempt(b, "m2");
    b.noteDelivered(env("m2", "x"), "ch");
    tick(3_000);
    b.onEvent(ev(start("t9", "Bash", DEPLOY)));
    expect(b.get("ch")?.state).toBe("resumed");
    expect(b.onStop("ch", "Stop", "a")).toBeNull();
  });
});

describe("押着的提醒什么时候作废（P2-1 / P2-2 / P2-8）", () => {
  function hinted() {
    const h = book();
    preempt(h.b, "m2");
    h.b.noteDelivered(env("m2", "x"), "ch");
    h.tick(1_000);
    const notice = h.b.onStop("ch", "Stop", "a")!;
    return { ...h, notice: { ...notice, meta: { ...notice.meta, ts: iso(h.at()) } } as Envelope };
  }
  test("没事发生 → 照投", () => expect(hinted().b.noticeWanted(hinted().notice)).toBe(true));
  test("之后有人叫停（停字 / 停止按钮）→ 不投", () => {
    const { b, notice, tick } = hinted();
    tick(1_000);
    b.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] } });
    expect(b.noticeWanted(notice)).toBe(false);
  });
  test("之后又被抢占 → 旧提醒不投，那一段挂进新 cut 的链里", () => {
    const { b, notice, tick } = hinted();
    tick(1_000);
    const next = preempt(b, "m3", { inflight: [] });
    expect(b.noticeWanted(notice)).toBe(false);
    expect(next.chain.map((c) => c.byMessageId)).toEqual(["m2"]);
  });
  test("押着的时候 agent 续上了 → 不投", () => {
    const { b, notice } = hinted();
    b.onEvent(ev(start("t9", "Bash", DEPLOY)));
    expect(b.noticeWanted(notice)).toBe(false);
  });
  test("押了 30 分钟 → 不投", () => {
    const { b, notice, tick } = hinted();
    tick(CUT_TTL_MS + 1);
    expect(b.noticeWanted(notice)).toBe(false);
  });
  test("别的消息不受影响", () => expect(book().b.noticeWanted(env("x", "hi"))).toBe(true));
});

describe("「停」与 Autopilot（P2-8）", () => {
  test("停字 / 停止按钮 / 终端打断之后 Autopilot 让位；人再说一句不是停的话才放行", () => {
    for (const cause of ["stopword", "manual", "terminal", "codex_interrupt"] as const) {
      const { b, tick } = book();
      b.noteHuman("ch", cause === "stopword");
      b.record({ channelId: "ch", agent: "a", cause, tools: { inflight: [] } });
      expect(b.interruptHold("ch")).toBe("stopped");
      tick(1_000);
      b.noteHuman("ch", true); // 又说了一遍「停」：仍然停着
      expect(b.interruptHold("ch")).toBe("stopped");
      b.noteHuman("ch", false);
      expect(b.interruptHold("ch")).toBeNull();
    }
  });
  test("抢占（不是停）不让位；押着的提醒没投时让它先处理", () => {
    const { b, tick } = book();
    preempt(b, "m2");
    expect(b.interruptHold("ch")).toBeNull();
    b.noteDelivered(env("m2", "x"), "ch");
    tick(1_000);
    b.onStop("ch", "Stop", "a");
    expect(b.interruptHold("ch")).toBe("notice");
  });
});

describe("终端里自己按的打断（P1-1 第二条）", () => {
  const interrupted = (at: number) => ({ type: "turn_interrupted", ts: iso(at + 2_000), data: { ts: iso(at) }, chatId: "ch", agent: "a" });
  test("bridge 没发过键 → 记一条「停」类 cut，Autopilot 让位", async () => {
    const { b, at } = book();
    b.onEvent(interrupted(at()));
    await flush();
    expect(b.get("ch")?.cause).toBe("terminal");
    expect(b.interruptHold("ch")).toBe("stopped");
  });
  test("bridge 记了要发键、最后撤回没发（T13e r2）：还原，随后终端里真人的打断照样记成 owner 的停", async () => {
    const { b, at, tick } = book();
    b.noteKeySent("ch", "preempt")();
    tick(400);
    b.onEvent(interrupted(at()));
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
  });
  test("bridge 刚发过键 → 是自己的回声，不记", async () => {
    const { b, at, tick } = book();
    b.noteKeySent("ch", "preempt");
    tick(400);
    b.onEvent(interrupted(at()));
    await flush();
    expect(b.get("ch")).toBeUndefined();
  });
  test("闸门外 bridge 发的 Esc（取消 AUQ、wedge 救回，都走 tmuxSendEscape）→ 不当成人在终端里叫停（对抗式第 3 轮 P2-9）", async () => {
    let escAt = 0;
    const { b, at, tick } = book({ escAt: () => escAt });
    escAt = at();
    tick(600);
    b.onEvent(interrupted(at()));
    await flush();
    expect(b.get("ch")).toBeUndefined();
    tick(60_000); // 很久以前发过的 Esc 不算
    b.onEvent(interrupted(at()));
    await flush();
    expect(b.get("ch")?.cause).toBe("terminal");
  });
  test("回声判定用那一行写进会话记录的时间，不用 watcher 读到的时间", () => {
    const { b, at, tick } = book();
    b.noteKeySent("ch", "preempt");
    tick(4_000);
    expect(b.keySentWithin("ch", at() - 3_600)).toBe(true);
    expect(b.keySentWithin("ch", at() + 60_000)).toBe(false);
  });
});

describe("Codex：打字投递状态（P1-3 / P2-4 / P2-14）", () => {
  const codexCut = (b: TurnCuts, cause: "preempt" | "stopword" = "preempt") => b.record({ channelId: "ch", agent: "cx", runtime: "codex", cause, tools: { inflight: [] } });
  test("channel-server 没声明会打字投递 → bridge 不主动打断（停字也不）", () => {
    const { b } = book();
    expect(b.mayBridgeInterrupt("ch", "codex", false)).toBe(false);
    expect(b.mayBridgeInterrupt("ch", "codex", true)).toBe(false);
    expect(b.mayBridgeInterrupt("ch", undefined, false)).toBe(true); // CC 不受影响
  });
  test("声明了 → 抢占一次；上次 Stop 之前不再抢占（后来的不插到队列里先到的前面），停字照打；Stop 后恢复", () => {
    const { b } = book();
    b.setCodexTypeIn("ch", true);
    expect(b.mayBridgeInterrupt("ch", "codex", false)).toBe(true);
    codexCut(b);
    expect(b.mayBridgeInterrupt("ch", "codex", false)).toBe(false);
    expect(b.mayBridgeInterrupt("ch", "codex", true)).toBe(true);
    b.onStop("ch", "StopFailure", "cx"); // 打断回报不算恢复
    expect(b.mayBridgeInterrupt("ch", "codex", false)).toBe(false);
    b.onStop("ch", "Stop", "cx");
    expect(b.mayBridgeInterrupt("ch", "codex", false)).toBe(true);
  });
  test("打断后下一条标 after_interrupt、只标一条；打字没做成 → 重新挂上", () => {
    const { b } = book();
    codexCut(b, "stopword");
    expect(b.takeAfterInterrupt("ch")).toBe(true);
    expect(b.takeAfterInterrupt("ch")).toBe(false);
    b.rearmAfterInterrupt("ch");
    expect(b.takeAfterInterrupt("ch")).toBe(true);
  });
  test("CC / Pi 的 cut 不标", () => {
    const { b } = book();
    b.record({ channelId: "ch", agent: "a", runtime: "pi", cause: "stopword", tools: { inflight: [] } });
    preempt(b, "m");
    expect(b.takeAfterInterrupt("ch")).toBe(false);
  });
});

describe("Workflow 审查补充（#148 @a24b688）", () => {
  test("Codex 打断回报：抢占的回声不当回合结束；停止按钮的回声照常收尾", () => {
    const { b, at } = book();
    b.noteKeySent("ch", "preempt");
    expect(b.keySentWithin("ch", at() + 500, "preempt")).toBe(true);
    const m = book();
    m.b.noteKeySent("ch", "manual");
    expect(m.b.keySentWithin("ch", m.at() + 500, "preempt")).toBe(false);
    expect(m.b.keySentWithin("ch", m.at() + 500)).toBe(true); // 仍是 bridge 自己的键：不记成终端里按的
  });

  test("语音连发：抢占冷却期内送到的补充也算在处理、也列进「还没回复」；bridge 自己的通知不顶掉人的消息", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "先部署 X"), "ch");
    tick(1_000);
    b.noteDelivered(env("m2", "再把 Y 也改了"), "ch");
    b.noteDelivered(env("n1", "[agent-calls] …", { kind: "bridge", label: "agent-calls" } as Envelope["from"]), "ch");
    tick(1_000);
    const cut = preempt(b, "m3");
    expect(cut.turnTrigger?.messageId).toBe("m1");
    expect(cut.alsoPending?.map((t) => t.messageId)).toEqual(["m2"]);
    b.noteDelivered(env("m3", "x"), "ch");
    tick(1_000);
    const n = b.onStop("ch", "Stop", "a")!.content;
    expect(n).toContain("先部署 X");
    expect(n).toContain("再把 Y 也改了");
  });

  test("Codex：上次 Stop 之后经 queue 投的人类消息记下来，停字抬头列出它们；打进 TUI 的不算；Stop 后清零", () => {
    const { b } = book();
    b.setCodexTypeIn("ch", true);
    b.noteDelivered(env("m1", "部署 X"), "ch", true);
    b.noteDelivered(env("m2", "顺便把 Y 发布"), "ch", false);
    expect(b.codexQueuedBefore("ch")).toEqual(["顺便把 Y 发布"]);
    b.onStop("ch", "Stop", "cx");
    expect(b.codexQueuedBefore("ch")).toEqual([]);
  });

  test("打断前一两秒刚跑完的工具：之后到的成功 tool_done 把它从「被砍断」里摘掉", () => {
    const { b, at } = book();
    preempt(b, "m2");
    b.onEvent({ type: "tool_done", ts: iso(at() + 1_500), data: { toolId: "t1", error: false }, chatId: "ch", agent: "a" });
    const c = b.get("ch")!;
    expect(c.inflight).toEqual([]);
    expect(c.lastDone?.summary).toBe(DEPLOY);
  });

  test("停止按钮在抢占后马上按下也记成停", () => {
    const { b } = book();
    preempt(b, "m2");
    b.record({ channelId: "ch", agent: "a", cause: "manual", tools: { inflight: [] } });
    expect(b.get("ch")?.state).toBe("stopped");
  });
});

describe("对抗式第 3 轮（@57b5354）", () => {
  const stopCut = (b: TurnCuts, runtime?: string, interrupted?: boolean) =>
    b.record({ channelId: "ch", agent: "a", runtime, cause: "stopword", tools: { inflight: [] }, ...(interrupted === undefined ? {} : { interrupted }) });

  test("P2-3：「停」挡住 Autopilot 不设期限（2 小时、一天后仍然停着），owner 再开口才放行", () => {
    const { b, tick } = book();
    stopCut(b);
    tick(CUT_TTL_MS * 4 + 1);
    b.record({ channelId: "other", agent: "x", cause: "preempt", tools: { inflight: [] } }); // 触发一次清理
    expect(b.interruptHold("ch")).toBe("stopped");
    tick(24 * 3_600_000);
    expect(b.interruptHold("ch")).toBe("stopped");
    b.noteHuman("ch", false);
    expect(b.interruptHold("ch")).toBeNull();
  });

  test("P2-3：「停」和「owner 又开口了」都落盘：bridge 重启后照旧", () => {
    const path = join(mkdtempSync(join(tmpdir(), "turn-cuts-")), "turn-cuts.json");
    const a = book({ path });
    stopCut(a.b);
    expect(book({ path }).b.interruptHold("ch")).toBe("stopped");
    a.b.noteHuman("ch", false);
    expect(book({ path }).b.interruptHold("ch")).toBeNull();
  });

  test("终端里敲了新输入（terminal_input）也算 owner 又开口了：解除挂起；敲的是停字就还停着", async () => {
    const { b } = book();
    stopCut(b);
    b.onEvent({ type: "terminal_input", ts: iso(T0), data: { stop: true }, chatId: "ch", agent: "a" });
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
    b.onEvent({ type: "terminal_input", ts: iso(T0), data: { stop: false }, chatId: "ch", agent: "a" });
    await flush();
    expect(b.interruptHold("ch")).toBeNull();
  });

  test("P2-5：Codex 空闲时经 queue 投、马上开跑的那条不算「排在队列里」", () => {
    const { b } = book();
    b.setCodexTypeIn("ch", true);
    b.noteDelivered(env("m1", "部署 X"), "ch", false, false);
    b.noteDelivered(env("m2", "顺便把 Y 发布"), "ch", false, true);
    expect(b.codexQueuedBefore("ch")).toEqual(["顺便把 Y 发布"]);
  });

  test("P2-5：Codex 停字没发出键（空闲 / 被拦）→ 下一条照常走 queue，不去打字", () => {
    const { b } = book();
    b.setCodexTypeIn("ch", true);
    stopCut(b, "codex", false);
    expect(b.takeAfterInterrupt("ch")).toBe(false);
    stopCut(b, "codex", true);
    expect(b.takeAfterInterrupt("ch")).toBe(true);
  });

  test("P1-B / P2-4：停字抬头列出这一轮里停之前还送来过的消息；没在跑时提醒可能是在回答问题", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "看下日志"), "ch");
    tick(1_000);
    b.noteDelivered(env("m2", "部署 Y"), "ch");
    const cut = b.record({ channelId: "ch", agent: "a", runtime: "pi", cause: "stopword", byMessageId: "m3", tools: { inflight: [] } });
    const h = stopHeadline(cut, "fired");
    expect(h).toContain("「部署 Y」");
    expect(h).toContain("先别照做");
    expect(stopHeadline(cut, "not_busy")).toContain("在回答你刚问的问题");
  });
});

describe("Workflow 复核 wf2（@2968ec7f）", () => {
  const ownerStop = (b: TurnCuts) => b.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] } });

  test("stop-semantics-1：owner 停 → 外源忙时抢占盖掉那条 cut → 仍然停着；外源那一轮 Stop 了也停着；owner 说句别的才放行", () => {
    const { b, tick } = book();
    ownerStop(b);
    tick(5_000);
    b.noteDelivered(env("g1", "hi", { kind: "api", name: "guest", tokenId: "g" } as Envelope["from"]), "ch");
    tick(4_000);
    preempt(b, "g2"); // 外源不调 noteHuman，但照样抢占
    expect(b.get("ch")?.cause).toBe("preempt");
    expect(b.interruptHold("ch")).toBe("stopped");
    b.noteDelivered(env("g2", "再来"), "ch");
    tick(1_000);
    b.onStop("ch", "Stop", "a");
    expect(b.interruptHold("ch")).toBe("stopped");
    b.noteHuman("ch", false);
    expect(b.interruptHold("ch")).toBe("notice"); // 不再挡着「停」；外源那次抢占的收尾提醒照常
  });

  test("stoppedAt：最近一次叫停的时刻，owner 再开口之后也留着（押在它之前的消息投出去时照样加抬头）；落盘", () => {
    const path = join(mkdtempSync(join(tmpdir(), "turn-cuts-")), "turn-cuts.json");
    const { b, tick } = book({ path });
    expect(b.stoppedAt("ch")).toBeUndefined();
    ownerStop(b);
    tick(1_000);
    b.noteHuman("ch", false);
    expect(b.stoppedAt("ch")).toBe(T0);
    expect(book({ path }).b.stoppedAt("ch")).toBe(T0);
  });

  test("adv5：叫停记录解除超过 24 小时才清（押后消息最长押 24 小时）；没解除的一直留着", () => {
    const { b, tick } = book();
    ownerStop(b);
    tick(1_000);
    b.noteHuman("ch", false);
    tick(23 * 3_600_000);
    b.record({ channelId: "other", agent: "o", cause: "preempt", tools: { inflight: [] } }); // 记新 cut 时顺带清理
    expect(b.stoppedAt("ch")).toBe(T0);
    tick(2 * 3_600_000);
    b.record({ channelId: "other", agent: "o", cause: "preempt", tools: { inflight: [] } });
    expect(b.stoppedAt("ch")).toBeUndefined();
    b.record({ channelId: "ch2", agent: "a2", cause: "stopword", tools: { inflight: [] } });
    tick(30 * 24 * 3_600_000);
    b.record({ channelId: "other", agent: "o", cause: "preempt", tools: { inflight: [] } });
    expect(b.interruptHold("ch2")).toBe("stopped");
  });

  test("adv5：owner 开口也会清理解除超过 24 小时的叫停记录（不必等下一次打断）", () => {
    const { b, tick } = book();
    ownerStop(b);
    tick(1_000);
    b.noteHuman("ch", false);
    tick(25 * 3_600_000);
    b.noteHuman("ch2", false);
    expect(b.stoppedAt("ch")).toBeUndefined();
  });

  test("adv5：agent 被 kill（forget）：打断 / 叫停记录都删，落盘也删；别的频道不受影响", () => {
    const path = join(mkdtempSync(join(tmpdir(), "turn-cuts-")), "turn-cuts.json");
    const { b } = book({ path });
    b.noteDelivered(env("m1", "合并 T3 并上线"), "ch");
    ownerStop(b);
    b.record({ channelId: "ch2", agent: "a2", cause: "stopword", tools: { inflight: [] } });
    b.forget("ch");
    expect(b.get("ch")).toBeUndefined();
    expect(b.stoppedAt("ch")).toBeUndefined();
    expect(b.interruptHold("ch")).toBeNull();
    expect(b.deliveredMessage("ch", "m1")).toBeUndefined();
    const reloaded = book({ path }).b;
    expect(reloaded.get("ch")).toBeUndefined();
    expect(reloaded.stoppedAt("ch")).toBeUndefined();
    expect(reloaded.interruptHold("ch2")).toBe("stopped");
  });

  test("esc-keys-2：manager 清场 / tmux-send-keys 发的 C-c 引起的打断标记不记成叫停", async () => {
    let inputs: ProgramInput[] = [];
    const { b, at, tick } = book({ inputs: () => inputs });
    inputs = [{ at: at(), h: "" }]; // 发 C-c 之前记下
    b.onEvent({ type: "turn_interrupted", ts: iso(at() + 2_000), data: { ts: iso(at() + 80) }, chatId: "ch", agent: "a" });
    await flush();
    expect(b.get("ch")).toBeUndefined();
    tick(60_000);
    b.onEvent({ type: "turn_interrupted", ts: iso(at() + 2_000), data: { ts: iso(at()) }, chatId: "ch", agent: "a" });
    await flush();
    expect(b.get("ch")?.cause).toBe("terminal");
  });

  test("stop-semantics-3：cron / manager 敲进 TUI 的字不算 owner 开口；owner 自己敲的照样解除", async () => {
    let inputs: ProgramInput[] = [];
    const { b, at, tick } = book({ inputs: () => inputs });
    ownerStop(b);
    tick(60_000);
    inputs = [{ at: at(), h: inputHash("检查爬宠监控服务的运行状态") }];
    tick(10 * 60_000); // CC 忙时敲进去的，回合结束才写进会话记录
    const typed = (text: string) => ({ type: "terminal_input", ts: iso(at()), data: { stop: false, h: inputHash(text), ts: iso(at()) }, chatId: "ch", agent: "a" });
    b.onEvent(typed("检查爬宠监控服务的运行状态"));
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
    b.onEvent(typed("把 X 也改了"));
    await flush();
    expect(b.interruptHold("ch")).toBeNull();
  });
});

describe("停之后马上开口（wf2 stop-semantics-4）", () => {
  const interrupted = (at: number) => ({ type: "turn_interrupted", ts: iso(at + 2_000), data: { ts: iso(at) }, chatId: "ch", agent: "a" });
  const typed = (at: number, stop = false) => ({ type: "terminal_input", ts: iso(at + 2_000), data: { stop, ts: iso(at) }, chatId: "ch", agent: "a" });
  test("终端 Esc 的 cut 晚于随后的终端输入才记下：记停时直接带上解除，不卡到 owner 再说一句", async () => {
    const t0 = T0;
    // 查程序发键（tmux list-panes）负载高时要几百毫秒：这期间 owner 在终端里敲的新指令先处理完了
    const slowKeys = async (): Promise<ProgramInput[]> => (await new Promise((r) => setTimeout(r, 20)), []);
    const late = new TurnCuts(null, () => t0 + 3_000, slowKeys);
    late.onEvent(interrupted(t0));
    late.noteHuman("ch", false, t0 + 1_500);
    await new Promise((r) => setTimeout(r, 40));
    expect(late.get("ch")?.cause).toBe("terminal");
    expect(late.interruptHold("ch")).toBeNull();
    // 对照：没有再开口 → 停着
    const { b } = book();
    b.onEvent(interrupted(t0));
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
  });
  test("停字收尾一拍里 owner 又发了别的：按停字到达的时刻比，解除", () => {
    const { b, tick } = book();
    const heard = b.noteHuman("ch", true);
    tick(500);
    b.noteHuman("ch", false); // 收尾一拍（1.2 秒）里 owner 又说了一句
    tick(700);
    b.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] }, stopAt: heard });
    expect(b.interruptHold("ch")).toBeNull();
    expect(b.stoppedAt("ch")).toBe(heard);
  });
  test("bridge 重启后：owner 解除叫停的时刻从盘上认得，押着的旧「停」晚投不重新挂起（T13e r1 P1-1）", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cuts-restart-")), "cuts.json");
    const { b, tick, at } = book({ path });
    const heldAt = b.noteHuman("ch", true);
    b.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] }, stopAt: heldAt });
    tick(1_000);
    b.noteHuman("ch", false); // 答卡片
    const again = new TurnCuts(path, () => at() + 5_000, async () => []);
    expect(again.lastSpokeAt("ch")).toBe(at());
    again.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] }, stopAt: heldAt });
    expect(again.interruptHold("ch")).toBeNull();
  });
  test("带 dropIfStopped 的（Autopilot 到点收尾）：ws.send 前那一查，叫停中不投、解除了照投（T13e r2 P2）", () => {
    const { b, tick } = book();
    const wrap = { ...env("w1", "Autopilot 已关闭"), from: { kind: "bridge", label: "mission" } } as Envelope;
    wrap.meta.dropIfStopped = true;
    expect(b.noticeWanted(wrap)).toBe(true);
    b.record({ channelId: "ch", agent: "a", cause: "manual", tools: { inflight: [] } });
    expect(b.noticeWanted(wrap)).toBe(false);
    tick(1_000);
    b.noteHuman("ch", false);
    expect(b.noticeWanted(wrap)).toBe(true);
  });
  test("「停」之前的终端输入晚读到，不能解开之后才叫的停", async () => {
    const { b, at, tick } = book();
    const typedAt = at();
    tick(1_000);
    b.noteHuman("ch", true);
    b.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] } });
    tick(1_500);
    b.onEvent(typed(typedAt));
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
  });
});

describe("叫停中止引起的 Stop（wf2 pi-4）", () => {
  test("不清「这一回合送到了哪些」：随后记的停仍列出停之前 steer 进去的", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "部署 X"), "ch");
    b.noteDelivered(env("m2", "顺便把 Y 也部署了"), "ch");
    tick(1_000);
    expect(b.onStop("ch", "Stop", "a", true)).toBeNull();
    tick(1_200);
    const cut = b.record({ channelId: "ch", agent: "a", runtime: "pi", cause: "stopword", byMessageId: "m3", tools: { inflight: [] } });
    expect(cut.turnTrigger?.messageId).toBe("m1");
    expect(stopHeadline(cut, "fired")).toContain("顺便把 Y 也部署了");
  });
  test("对照：正常 Stop 清掉，下一回合从头记", () => {
    const { b } = book();
    b.noteDelivered(env("m1", "部署 X"), "ch");
    b.onStop("ch", "Stop", "a");
    expect(b.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] } }).turnTrigger).toBeUndefined();
  });
  test("插话回合被叫停中止：不按做完提醒续做", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "合并 T3"), "ch");
    preempt(b, "m2");
    tick(1_200);
    b.noteDelivered(env("m2", "x"), "ch");
    tick(5_000);
    expect(b.onStop("ch", "Stop", "a", true)).toBeNull();
    expect(b.onStop("ch", "Stop", "a")).not.toBeNull(); // 真正做完的那次照常提醒
  });
});

/**
 * 打断记录：lib/turn-cuts.ts（纯逻辑 + 文案）和 bridge/turn-cuts.ts 的记录簿（送达 / 回复 / Stop / 事件的交错）。
 * 重点：连环打断挂链、续做检测不把被砍的那一次自己算进去、只在插话回合的正常 Stop 提醒一次、「停」压掉提醒。
 */
import { describe, expect, test } from "bun:test";
import { TurnCuts } from "../src/bridge/turn-cuts.js";
import { unwrapChannelMessage } from "../src/lib/session-history.js";
import type { Envelope } from "../src/bridge/router.js";
import {
  CUT_TTL_MS, inflightFrom, isResumedBy, lateInflight, makeCut, onStop, preemptHeadline, resumeNotice, stopHeadline, withInterruptNote,
  type Cut, type CutEvent, type NewCutInput,
} from "../src/lib/turn-cuts.js";

const T0 = Date.parse("2026-09-28T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const start = (id: string, name: string, cmd: string, at = T0, summary = cmd): CutEvent => ({
  type: "tool_start", ts: iso(at), data: { toolId: id, name, summary, detail: name === "Bash" ? `描述\n───\n${cmd}` : cmd },
});
const done = (id: string, error = false, at = T0): CutEvent => ({ type: "tool_done", ts: iso(at), data: { toolId: id, error } });
const status = (s: string, at = T0): CutEvent => ({ type: "agent_status", ts: iso(at), data: { status: s } });

const DEPLOY = "bun src/manager.ts web-release deploy";

function cutFrom(events: CutEvent[], over: Partial<NewCutInput> = {}, prev?: Cut): Cut {
  return makeCut({ id: "cut_1", agent: "a", channelId: "ch", at: T0 + 1000, cause: "preempt", tools: inflightFrom(events), ...over }, prev);
}

describe("inflightFrom：砍在哪", () => {
  test("本回合有 start 没 done 的是被砍的，最后一个正常 done 是「做到了」", () => {
    const r = inflightFrom([start("t1", "Bash", "gh pr merge 129"), done("t1"), start("t2", "Bash", DEPLOY)]);
    expect(r.inflight.map((t) => t.toolId)).toEqual(["t2"]);
    expect(r.inflight[0].command).toBe(DEPLOY);
    expect(r.lastDone?.summary).toBe("gh pr merge 129");
  });

  test("上一回合没收尾的不算：只看最后一次 done 之后", () => {
    const r = inflightFrom([start("old", "Bash", "sleep 999"), status("done"), start("t1", "Read", "a.ts"), done("t1")]);
    expect(r.inflight).toEqual([]);
    expect(r.lastDone?.name).toBe("Read");
  });

  test("并行调用：各自的 done 都到了就都不算在跑", () => {
    const r = inflightFrom([start("p1", "Read", "a"), start("p2", "Read", "b"), start("p3", "Bash", "ls"), done("p1"), done("p2"), done("p3")]);
    expect(r.inflight).toEqual([]);
  });

  test("出错收尾的不算「做到了」", () => {
    expect(inflightFrom([start("t1", "Bash", "x"), done("t1", true)]).lastDone).toBeUndefined();
  });
});

describe("makeCut：分类与连环打断", () => {
  test("副作用取 inflight 里最重的一类", () => {
    const c = cutFrom([start("t1", "Read", "a.ts"), start("t2", "Bash", "git tag v9")]);
    expect(c.sideEffect).toBe("external");
    expect(c.state).toBe("open");
  });

  test("插话那一回合又被打断：上一条还开着就挂进 chain（按先后，摊平）", () => {
    const first = cutFrom([start("t1", "Bash", DEPLOY)]);
    const second = cutFrom([start("t2", "Bash", "gh pr merge 1")], { id: "cut_2", at: T0 + 5000 }, first);
    const third = cutFrom([], { id: "cut_3", at: T0 + 9000 }, second);
    expect(third.chain.map((c) => c.id)).toEqual(["cut_1", "cut_2"]);
    expect(third.chain.every((c) => c.chain.length === 0)).toBe(true);
  });

  test("上一条已收尾 / 已过期就不挂", () => {
    const first = { ...cutFrom([start("t1", "Bash", DEPLOY)]), state: "resumed" as const };
    expect(cutFrom([], { id: "cut_2" }, first).chain).toEqual([]);
    const stale = cutFrom([start("t1", "Bash", DEPLOY)]);
    expect(cutFrom([], { id: "cut_2", at: stale.at + CUT_TTL_MS + 1 }, stale).chain).toEqual([]);
  });

  test("停字 / 手动 / 终端里的 Esc：一出生就是 stopped，之前没收尾的一起压掉", () => {
    const open = cutFrom([start("t1", "Bash", DEPLOY)]);
    for (const cause of ["stopword", "manual", "codex_interrupt"] as const) {
      const c = cutFrom([start("t2", "Bash", "x")], { id: "cut_2", cause }, open);
      expect(c.state).toBe("stopped");
      expect(c.chain).toEqual([]);
    }
  });
});

describe("续做检测", () => {
  const cut = cutFrom([start("t1", "Bash", DEPLOY)]);
  test("同名同命令的新调用 = 已续做（后台重跑、空白不同也算）", () => {
    expect(isResumedBy(cut, start("t9", "Bash", `${DEPLOY}  `))).toBe(true);
  });
  test("被砍的那一次自己（watcher 迟到的 start）不算", () => {
    expect(isResumedBy(cut, start("t1", "Bash", DEPLOY))).toBe(false);
  });
  test("不同命令 / 不同工具不算", () => {
    expect(isResumedBy(cut, start("t9", "Bash", "git status"))).toBe(false);
    expect(isResumedBy(cut, start("t9", "Read", DEPLOY))).toBe(false);
  });
  test("chain 里任一段续上都算（连环打断后先续最早那件）", () => {
    const second = cutFrom([start("t2", "Bash", "gh pr merge 1")], { id: "cut_2" }, cut);
    expect(isResumedBy(second, start("t9", "Bash", DEPLOY))).toBe(true);
  });
  test("非 Bash 按摘要比", () => {
    const c = cutFrom([start("e1", "Edit", "Edit bridge.ts")]);
    expect(isResumedBy(c, start("e2", "Edit", "Edit bridge.ts"))).toBe(true);
  });
});

describe("lateInflight：watcher 晚读到的被砍工具", () => {
  const cut = cutFrom([]);
  test("打断前起的、打断后几秒内出错收尾 → 补进 inflight 并重新分类", () => {
    const s = start("t1", "Bash", "git push --force origin main", T0 + 900);
    const upd = lateInflight(cut, s, done("t1", true, T0 + 2500));
    expect(upd?.inflight.map((t) => t.toolId)).toEqual(["t1"]);
    expect(upd?.sideEffect).toBe("external");
  });
  test("正常收尾 / 打断很久以后 / 打断后才起的都不补", () => {
    const s = start("t1", "Bash", "x", T0 + 900);
    expect(lateInflight(cut, s, done("t1", false, T0 + 2000))).toBeNull();
    expect(lateInflight(cut, s, done("t1", true, T0 + 60_000))).toBeNull();
    expect(lateInflight(cut, start("t2", "Bash", "x", T0 + 5000), done("t2", true, T0 + 6000))).toBeNull();
  });
});

describe("onStop：什么时候提醒", () => {
  const base = { ...cutFrom([start("t1", "Bash", DEPLOY)]), deliveredAt: T0 + 2000 };
  test("插话消息送达之后的正常 Stop → 提醒", () => expect(onStop(base, "Stop", T0 + 9000)).toBe("hint"));
  test("StopFailure（Codex 打断回声 / API 错误）不提醒", () => expect(onStop(base, "StopFailure", T0 + 9000)).toBe("none"));
  test("插话消息还没送达（押着）不提醒", () => expect(onStop({ ...base, deliveredAt: undefined }, "Stop", T0 + 9000)).toBe("none"));
  test("已续做 / 已停 / 已提醒过的不再提醒", () => {
    for (const state of ["resumed", "stopped", "hinted", "expired"] as const) expect(onStop({ ...base, state }, "Stop", T0 + 9000)).toBe("none");
  });
  test("30 分钟没动静 → 过期", () => expect(onStop(base, "Stop", base.at + CUT_TTL_MS + 1)).toBe("expire"));
});

describe("文案", () => {
  const trig = { messageId: "m0", fromKind: "api", fromName: "owner", excerpt: "合并 T3 并上线网页", replyTo: "api:owner", at: T0 - 60_000 };
  const cut = cutFrom([start("t0", "Bash", "gh pr merge 129"), done("t0"), start("t1", "Bash", DEPLOY)], { turnTrigger: trig, byName: "owner" });

  test("抬头：砍在哪、能不能重跑、在处理谁的什么，并说明 STOP 措辞不代表放弃", () => {
    const h = preemptHeadline(cut);
    expect(h).toContain(DEPLOY);
    expect(h).toContain("可以直接重跑");
    expect(h).toContain("合并 T3 并上线网页");
    expect(h).toContain("STOP … wait for the user");
    expect(h.startsWith("[⚡")).toBe(true);
    expect(h.endsWith("]")).toBe(true);
  });

  test("Codex 的抬头换成 turn_aborted 的说明", () => {
    expect(preemptHeadline({ ...cut, runtime: "codex" })).toContain("turn_aborted");
  });

  test("没有在跑的工具：写「在思考 / 出字」和最后做完的一步", () => {
    const c = cutFrom([start("t0", "Bash", "gh pr merge 129"), done("t0")]);
    expect(preemptHeadline(c)).toContain("当时在思考 / 出字，最后做完的是 gh pr merge 129");
  });

  test("停字抬头：不续做；后面还有话就照常处理", () => {
    expect(stopHeadline(cut, "")).toContain("简短确认已停");
    expect(stopHeadline(cut, "先别合")).toContain("停字后面的话照常处理");
  });

  test("收尾提醒：被砍断 / 做到了 / 还没回复，最后一句允许忽略", () => {
    const n = resumeNotice(cut, () => true);
    expect(n.startsWith("[⏯ 打断收尾]")).toBe(true);
    expect(n).toContain(`被砍断：Bash「${DEPLOY}」——可以直接重跑`);
    expect(n).toContain("做到了：gh pr merge 129");
    expect(n).toContain("还没回复：owner");
    expect(n).toContain("已经做完或决定不做，就忽略这条");
    expect(resumeNotice(cut, () => false)).toContain("还没回复：无");
  });

  test("对外 / 不可逆加固定警告；Codex 加「命令可能还在后台跑」", () => {
    const ext = cutFrom([start("t1", "Bash", "gh release create v9")]);
    expect(resumeNotice(ext, () => false)).toContain("不要直接重跑");
    expect(resumeNotice({ ...cut, runtime: "codex" }, () => false)).toContain("可能还在后台跑");
    expect(resumeNotice(cut, () => false)).not.toContain("⚠");
  });

  test("连环打断按先后编号列出", () => {
    const second = cutFrom([start("t2", "Bash", "gh pr merge 7")], { id: "cut_2", at: T0 + 5000 }, cut);
    const n = resumeNotice(second, () => false);
    expect(n).toContain("连续被打断 2 次");
    expect(n.indexOf(DEPLOY)).toBeLessThan(n.indexOf("gh pr merge 7"));
  });

  test("withInterruptNote：插在来源头之后；没有来源头就放最前；都以「]」+ 空行分块", () => {
    const api = "[🌐 来自 Web 端用户「owner」（HTTP API 接入）。\n用 reply() 回答。]\n\n先别部署";
    expect(withInterruptNote(api, "[⚡ x]")).toBe("[🌐 来自 Web 端用户「owner」（HTTP API 接入）。\n用 reply() 回答。]\n\n[⚡ x]\n\n先别部署");
    expect(withInterruptNote("先别部署", "[⚡ x]")).toBe("[⚡ x]\n\n先别部署");
  });
});

describe("TurnCuts 记录簿：送达 / 回复 / Stop / 事件交错", () => {
  function book() {
    let now = T0;
    const b = new TurnCuts(null, () => now);
    return { b, tick: (ms: number) => void (now += ms), at: () => now };
  }
  const env = (id: string, text: string, from: Envelope["from"] = { kind: "api", name: "owner", tokenId: "owner" } as Envelope["from"]): Envelope =>
    ({
      from, to: { kind: "local", channelId: "ch" } as Envelope["to"], intent: "request", content: text,
      meta: { messageId: id, triggerKind: "api_user", ts: "", threadId: "t" },
    }) as unknown as Envelope;
  const tools = inflightFrom([start("t1", "Bash", DEPLOY)]);

  test("完整一轮：打断 → 插话送达 → Stop 提醒一次 → 再 Stop 不提醒", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "合并 T3 并上线"), "ch");
    tick(30_000);
    const cut = b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m2", byName: "owner", tools });
    expect(cut.turnTrigger?.messageId).toBe("m1");
    expect(b.onStop("ch", "Stop")).toBeNull(); // 插话还没送达
    tick(1_200);
    b.noteDelivered(env("m2", "顺便看下 X"), "ch");
    tick(20_000);
    const n = b.onStop("ch", "Stop");
    expect(n).toContain(DEPLOY);
    expect(n).toContain("还没回复：owner");
    expect(b.onStop("ch", "Stop")).toBeNull();
  });

  test("打断前已经回复过那条消息 → 不列为「还没回复」；打断之后的回复（答的是插话）不算", () => {
    const { b, tick } = book();
    b.noteDelivered(env("m1", "合并 T3"), "ch");
    tick(5_000);
    b.noteReplied("ch", "api:owner");
    tick(5_000);
    b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m2", tools });
    b.noteDelivered(env("m2", "x"), "ch");
    tick(5_000);
    expect(b.onStop("ch", "Stop")).toContain("还没回复：无");

    const c = book();
    c.b.noteDelivered(env("m1", "合并 T3"), "ch");
    c.tick(5_000);
    c.b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m2", tools });
    c.b.noteDelivered(env("m2", "x"), "ch");
    c.tick(5_000);
    c.b.noteReplied("ch", "api:owner");
    expect(c.b.onStop("ch", "Stop")).toContain("还没回复：owner");
  });

  test("agent 自己续上了（同命令再跑）→ 不提醒", () => {
    const { b, tick } = book();
    b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m2", tools });
    b.noteDelivered(env("m2", "x"), "ch");
    tick(3_000);
    b.onEvent({ ...start("t9", "Bash", DEPLOY), chatId: "ch" });
    expect(b.get("ch")?.state).toBe("resumed");
    expect(b.onStop("ch", "Stop")).toBeNull();
  });

  test("停字没发键（本来空闲）也压掉之前没收尾的", () => {
    const { b } = book();
    b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m2", tools });
    b.noteDelivered(env("m2", "x"), "ch");
    b.stop("ch");
    expect(b.onStop("ch", "Stop")).toBeNull();
  });

  test("连环：插话回合又被打断，Stop 时两段都列出", () => {
    const { b, tick } = book();
    b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m2", tools });
    b.noteDelivered(env("m2", "x"), "ch");
    tick(4_000);
    b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m3", tools: inflightFrom([start("t2", "Bash", "gh pr merge 3")]) });
    b.noteDelivered(env("m3", "y"), "ch");
    tick(4_000);
    const n = b.onStop("ch", "Stop") ?? "";
    expect(n).toContain("连续被打断 2 次");
    expect(n).toContain(DEPLOY);
    expect(n).toContain("gh pr merge 3");
  });

  test("收尾提醒自己送达不会变成下一次打断的「在处理」", () => {
    const { b } = book();
    b.noteDelivered(env("m1", "真正的请求"), "ch");
    b.noteDelivered(env("n1", "[⏯ 打断收尾] …", { kind: "bridge", label: "turn-cuts" } as Envelope["from"]), "ch");
    expect(b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m9", tools }).turnTrigger?.messageId).toBe("m1");
  });

  test("recentlyCut：Codex 的 Interrupt 回声认得出", () => {
    const { b, tick } = book();
    b.record({ channelId: "ch", agent: "a", cause: "preempt", byMessageId: "m2", tools });
    tick(3_000);
    expect(b.recentlyCut("ch", 15_000)).toBe(true);
    tick(20_000);
    expect(b.recentlyCut("ch", 15_000)).toBe(false);
  });
});

describe("打断抬头不进历史正文（lib/turn-cuts.ts withInterruptNote）", () => {
  const ch = (body: string) => `<channel source="claudestra" chat_id="api:tok_x" message_id="m1" user="owner" user_id="api:tok_x" api="true">\n${body}\n</channel>`;
  test("来源头 + ⚡ 抬头：两块都剥掉，只剩用户原话", () => {
    const body = "[🌐 来自 Web 端用户「owner」（HTTP API 接入，非 Discord）。\n用 reply() 回答到本 chat_id。]\n\n[⚡ 这条消息打断了你：当时在跑 Bash「x」。\n先处理这条。]\n\n先别部署";
    expect(unwrapChannelMessage(ch(body))?.text).toBe("先别部署");
  });
  test("Discord 用户没有来源头：只有 ⏹ 抬头也剥掉", () => {
    expect(unwrapChannelMessage(ch("[⏹ 这是一条「停」指令：已替你打断。]\n\n停"))?.text).toBe("停");
  });
});

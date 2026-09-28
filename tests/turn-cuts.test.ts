/**
 * 打断记录：lib/turn-cuts.ts（纯逻辑 + 文案）和 bridge/turn-cuts.ts 的记录簿（送达 / 回复 / Stop / 事件的交错）。
 * 重点：连环打断挂链、续做检测不把被砍的那一次自己算进去、只在插话回合的正常 Stop 提醒一次、「停」压掉提醒。
 */
import { describe, expect, test } from "bun:test";
import { unwrapChannelMessage } from "../src/lib/session-history.js";
import { isHumanRequest, type Envelope } from "../src/bridge/router.js";
import {
  completedOnlyFrom, settleBy, CUT_TTL_MS, inflightFrom, resumeBy, lateInflight, makeCut, onStop, preemptHeadline, resumeNotice, stopHeadline, withInterruptNote,
  transcriptUserEvent,
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

describe("续做检测（逐段）", () => {
  const cut = cutFrom([start("t1", "Bash", DEPLOY)]);
  test("同名同命令的新调用 = 这一段续上了；单段 = 整条 resumed（后台重跑、空白不同也算）", () => {
    expect(resumeBy(cut, start("t9", "Bash", `${DEPLOY}  `))?.state).toBe("resumed");
  });
  test("被砍的那一次自己（watcher 迟到的 start）不算", () => {
    expect(resumeBy(cut, start("t1", "Bash", DEPLOY))).toBeNull();
  });
  test("不同命令 / 不同工具不算", () => {
    expect(resumeBy(cut, start("t9", "Bash", "git status"))).toBeNull();
    expect(resumeBy(cut, start("t9", "Read", DEPLOY))).toBeNull();
  });
  test("连环打断：只续上一段 → 整条还是 open，提醒只列没续上的那段", () => {
    const second = cutFrom([start("t2", "Bash", "gh pr merge 1")], { id: "cut_2" }, cut);
    const r = resumeBy(second, start("t9", "Bash", DEPLOY))!;
    expect(r.state).toBe("open");
    expect(r.chain[0].resumed).toBe(true);
    const n = resumeNotice(r, () => "replied");
    expect(n).not.toContain(DEPLOY);
    expect(n).toContain("gh pr merge 1");
    expect(resumeBy(r, start("t8", "Bash", "gh pr merge 1"))?.state).toBe("resumed");
  });
  test("非 Bash 按摘要比", () => {
    const c = cutFrom([start("e1", "Edit", "Edit bridge.ts")]);
    expect(resumeBy(c, start("e2", "Edit", "Edit bridge.ts"))?.state).toBe("resumed");
  });
  test("砍在思考 / 出字的段认不出续没续：一直算没续", () => {
    expect(resumeBy(cutFrom([]), start("t9", "Bash", DEPLOY))).toBeNull();
  });
});

describe("Codex 与刚跑完的工具（Workflow 审查）", () => {
  test("Codex 的会话记录只在命令跑完才有 tool_use：不当成在跑，只取最后一条当「做到了」", () => {
    const evs = [start("c1", "Bash", "rg foo"), start("c2", "Bash", "git push origin x")];
    expect(inflightFrom(evs).inflight.length).toBe(2); // 旧判据：全当成被砍
    const r = completedOnlyFrom(evs);
    expect(r.inflight).toEqual([]);
    expect(r.lastDone?.summary).toBe("git push origin x");
    const c = cutFrom(evs, { runtime: "codex", tools: r });
    expect(preemptHeadline(c)).toContain("bridge 看不到（Codex 命令跑完才记录）");
    expect(resumeNotice(c, () => "replied")).toContain("看不到是哪条命令");
  });
  test("打断后到的成功 tool_done：从 inflight 摘掉；出错的 / 很久以后的不摘", () => {
    const c = cutFrom([start("t1", "Bash", "curl -X POST https://x/order")]);
    expect(settleBy(c, done("t1", false, T0 + 2000))?.inflight).toEqual([]);
    expect(settleBy(c, done("t1", true, T0 + 2000))).toBeNull();
    expect(settleBy(c, done("t1", false, T0 + 60_000))).toBeNull();
  });
  test("停字抬头：Pi 如实写「已请求」；Codex 列出停之前排在队列里的消息", () => {
    const c = cutFrom([]);
    expect(stopHeadline(c, "requested")).toContain("没有回执");
    const h = stopHeadline(c, "fired", ["顺便把 Y 发布"]);
    expect(h).toContain("停之前还有 1 条消息排在队列里");
    expect(h).toContain("顺便把 Y 发布");
  });
  test("可以重跑的也把核对建议带进抬头（kickstart：先看 pid）", () => {
    const c = cutFrom([start("t1", "Bash", "launchctl kickstart -k gui/501/x")]);
    expect(preemptHeadline(c)).toContain("先看服务的 pid");
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

  test("停字抬头照实写：打断了 / 本来就空闲 / 没能打断（请自己停）；都不续做", () => {
    expect(stopHeadline(cut, "fired")).toContain("已替你打断");
    expect(stopHeadline(cut, "not_busy")).toContain("你刚才没有在跑的回合");
    expect(stopHeadline(cut, "failed")).toContain("没能替你打断");
    for (const o of ["fired", "not_busy", "failed"] as const) expect(stopHeadline(cut, o)).toContain("不要续做被打断的事");
  });

  test("收尾提醒：被砍断 / 做到了 / 还没回复，最后一句允许忽略", () => {
    const n = resumeNotice(cut, () => "never");
    expect(n.startsWith("[⏯ 打断收尾]")).toBe(true);
    expect(n).toContain(`被砍断：Bash「${DEPLOY}」——可以直接重跑`);
    expect(n).toContain("做到了：gh pr merge 129");
    expect(n).toContain("还没回复：owner");
    expect(n).toContain("已经做完或决定不做，就忽略这条");
    expect(resumeNotice(cut, () => "replied")).toContain("还没回复：无");
    expect(resumeNotice(cut, () => "after_cut")).toContain("核对一下有没有答到"); // 打断之后回过同一地址：可能答的是插话
  });

  test("对外 / 不可逆加固定警告；Codex 加「命令可能还在后台跑」", () => {
    const ext = cutFrom([start("t1", "Bash", "gh release create v9")]);
    expect(resumeNotice(ext, () => "replied")).toContain("不要直接重跑");
    expect(resumeNotice({ ...cut, runtime: "codex" }, () => "replied")).toContain("可能还在后台跑");
    expect(resumeNotice(cut, () => "replied")).not.toContain("⚠");
  });

  test("连环打断按先后编号列出", () => {
    const second = cutFrom([start("t2", "Bash", "gh pr merge 7")], { id: "cut_2", at: T0 + 5000 }, cut);
    const n = resumeNotice(second, () => "replied");
    expect(n).toContain("连续被打断 2 次");
    expect(n.indexOf(DEPLOY)).toBeLessThan(n.indexOf("gh pr merge 7"));
  });

  test("withInterruptNote：插在来源头之后；没有来源头就放最前；都以「]」+ 空行分块", () => {
    const api = "[🌐 来自 Web 端用户「owner」（HTTP API 接入）。\n用 reply() 回答。]\n\n先别部署";
    expect(withInterruptNote(api, "[⚡ x]")).toBe("[🌐 来自 Web 端用户「owner」（HTTP API 接入）。\n用 reply() 回答。]\n\n[⚡ x]\n\n先别部署");
    expect(withInterruptNote("先别部署", "[⚡ x]")).toBe("[⚡ x]\n\n先别部署");
  });
});

describe("打断抬头不进历史正文（lib/turn-cuts.ts withInterruptNote → lib/inbound-body.ts）", () => {
  const api = (body: string, note = true) =>
    `<channel source="claudestra" chat_id="api:tok_x" message_id="m1" user="owner" user_id="api:tok_x" api="true"${note ? ' interrupt_note="true"' : ""}>\n${body}\n</channel>`;
  const discord = (body: string, note = true) =>
    `<channel source="claudestra" chat_id="123" message_id="m2" user="owner" user_id="u1"${note ? ' interrupt_note="true"' : ""}>\n${body}\n</channel>`;
  const HEAD = "[🌐 来自 Web 端用户「owner」（HTTP API 接入，非 Discord）。\n用 reply() 回答到本 chat_id。]\n\n";
  test("bridge 加了抬头（interrupt_note）：来源头 + ⚡ 抬头两块都剥掉，只剩用户原话", () => {
    expect(unwrapChannelMessage(api(`${HEAD}[⚡ 这条消息打断了你：当时在跑 Bash「x」。\n先处理这条。]\n\n先别部署`))?.text).toBe("先别部署");
  });
  test("Discord 用户的消息（没有来源头、没有 api / is_agent）：bridge 加的 ⏹ / ⚡ 抬头也剥", () => {
    expect(unwrapChannelMessage(discord("[⏹ 这是一条「停」指令：已替你打断。]\n\n停"))?.text).toBe("停");
    expect(unwrapChannelMessage(discord("[⚡ 这条消息打断了你：当时在跑 x。]\n\n先别部署"))?.text).toBe("先别部署");
  });
  test("用户自己手写同样开头（没有 interrupt_note）：不剥，内容不能从历史里藏起来", () => {
    const spoof = "[⚡ 这条消息打断了你：假的]\n\n真正要说的";
    expect(unwrapChannelMessage(discord(spoof, false))?.text).toBe(spoof);
    expect(unwrapChannelMessage(api(`${HEAD}${spoof}`, false))?.text).toBe(spoof);
  });
  test("普通以 [ 开头的正文不动", () => {
    expect(unwrapChannelMessage(discord("[TODO] 看一下\n\n正文"))?.text).toBe("[TODO] 看一下\n\n正文");
  });
});

describe("waitForIdle 的固定语义（T11a 的答复复用）", () => {
  const mk = (over: Partial<Envelope["meta"]>, from: Envelope["from"] = { kind: "api", name: "owner", tokenId: "t" } as Envelope["from"]) =>
    ({ from, to: { kind: "local", channelId: "ch" }, intent: "request", content: "x", meta: { messageId: "m", triggerKind: "api_user", ts: "", threadId: "t", ...over } }) as unknown as Envelope;
  test("人类 request 会抢占；带 waitForIdle 的永远不算（不打断、flush 时不插队）", () => {
    expect(isHumanRequest(mk({}))).toBe(true);
    expect(isHumanRequest(mk({ waitForIdle: true }))).toBe(false);
  });
  test("peer 的 api 入站、response、agent 消息本来就不算", () => {
    expect(isHumanRequest(mk({}, { kind: "api", name: "p", tokenId: "t", peer: "ahh" } as Envelope["from"]))).toBe(false);
    expect(isHumanRequest({ ...mk({}), intent: "response" } as Envelope)).toBe(false);
    expect(isHumanRequest(mk({}, { kind: "local", channelId: "c" } as Envelope["from"]))).toBe(false);
  });
});

describe("transcriptUserEvent：会话记录里的 user 记录（打断标记 / 终端里敲的新输入）", () => {
  const txt = (text: string, extra: Record<string, unknown> = {}) => ({ message: { content: [{ type: "text", text }] }, ...extra });
  test("打断标记", () => {
    expect(transcriptUserEvent(txt("[Request interrupted by user for tool use]"))).toEqual({ type: "turn_interrupted", data: {} });
    expect(transcriptUserEvent({ message: { content: "[Request interrupted by user]" } })).toEqual({ type: "turn_interrupted", data: {} });
  });
  test("终端里敲的真实输入 → terminal_input；敲的是停字 → stop", () => {
    expect(transcriptUserEvent(txt("把 X 也改了", { origin: { kind: "human" }, promptSource: "typed" }))).toEqual({ type: "terminal_input", data: { stop: false }, transient: true });
    expect(transcriptUserEvent({ message: { content: "2" } })).toEqual({ type: "terminal_input", data: { stop: false }, transient: true }); // 老版本没有 origin
    expect(transcriptUserEvent(txt("停", { origin: { kind: "human" } }))).toEqual({ type: "terminal_input", data: { stop: true }, transient: true });
  });
  test("排除：channel 注入、后台通知、自动续跑、compact 续写、meta、斜杠命令、<标签> 系统文本、工具结果", () => {
    const no = [
      txt('<channel source="claudestra" chat_id="1">hi</channel>', { isMeta: true, origin: { kind: "channel" } }),
      txt("<task-notification> <task-id>x</task-id>", { origin: { kind: "task-notification" } }),
      txt("You can continue now.", { isMeta: true, origin: { kind: "auto-continuation" } }),
      txt("Another Claude session sent a message", { isMeta: true, origin: { kind: "peer" } }),
      txt("This session is being continued from a previous conversation", { isCompactSummary: true }),
      txt("Base directory for this skill: /x", { isMeta: true }),
      txt("/compact 摘要必须保留…"),
      txt("<command-message>save-compact</command-message> <command-name>/save-compact</command-name>", { origin: { kind: "human" } }),
      txt("<local-command-stdout>Set model</local-command-stdout>"),
      { message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
      txt("   "),
    ];
    for (const e of no) expect(transcriptUserEvent(e)).toBeNull();
  });
  test("只认 Claude Code：Pi / Codex 的会话记录里 bridge 投进去的消息分不出是不是终端里敲的", () => {
    expect(transcriptUserEvent(txt("[🌐 guest] 部署 Y"), "pi")).toBeNull();
    expect(transcriptUserEvent(txt("hi"), "codex")).toBeNull();
    expect(transcriptUserEvent(txt("hi"), "claude-code")).toEqual({ type: "terminal_input", data: { stop: false }, transient: true });
    expect(transcriptUserEvent(txt("[Request interrupted by user]"), "pi")).toEqual({ type: "turn_interrupted", data: {} });
  });
});

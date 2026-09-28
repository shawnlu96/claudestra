/**
 * Codex 被打断之后的「打字投递」：lib/codex-tui-submit.ts 的输入框判断与粘贴流程、CodexQueueSink 的分支、
 * bridge 侧「上次 Stop 之后被打断过」的标记。画面夹具取自 codex-cli 0.153.4 的 capture-pane -e（2026-09-28 实测）。
 */
import { describe, expect, test } from "bun:test";
import { TurnCuts } from "../src/bridge/turn-cuts.js";
import { CodexQueueSink } from "../src/lib/codex-thread.js";
import { composerState, ownPaneIO, typeIntoCodex, type TypeInIO } from "../src/lib/codex-tui-submit.js";

const E = "\x1b";
const HISTORY = [
  `${E}[1;2m› ${E}[0m请在 shell 里前台运行：ping -c 30 127.0.0.1`,
  "• 我会在 shell 前台运行这条命令，完成后告诉你行数。",
  "■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.",
  "",
].join("\n");
const FOOTER = `\n\n  ${E}[38;2;246;226;183mgpt-6-astra default${E}[2m${E}[39m · ${E}[0m${E}[38;2;171;223;167m/private/tmp/w${E}[39m`;
const EMPTY = `${HISTORY}${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m${FOOTER}`;
const EMPTY_OTHER_TIP = `${HISTORY}${E}[1m›${E}[0m ${E}[2mFind and fix a bug in @filename${E}[0m${FOOTER}`;
const TYPED = `${HISTORY}${E}[1m›${E}[0m hello "x" $HOME \`y\` 中文${FOOTER}`;
const PASTED = `${HISTORY}${E}[1m›${E}[0m [Pasted Content 1532 chars]${FOOTER}`;
const BUSY = `${HISTORY}• Working (6s • esc to interrupt) · 1 background terminal running\n${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m${FOOTER}`;
const TRUST = "> You are in /tmp/w\n  Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n  Press enter to continue";
const OVERLAY = `${HISTORY}${E}[1m›${E}[0m ${E}[2mAsk${E}[0m\n  esc to go back · enter to edit message`;

describe("composerState：能不能直接粘贴提交", () => {
  test("空输入框（暗色占位提示，文案会轮换）", () => {
    expect(composerState(EMPTY)).toBe("empty");
    expect(composerState(EMPTY_OTHER_TIP)).toBe("empty");
  });
  test("输入框里已经有字（人在终端里打了一半 / 刚粘进去）", () => {
    expect(composerState(TYPED)).toBe("has-text");
    expect(composerState(PASTED)).toBe("has-text");
  });
  test("回合在跑", () => expect(composerState(BUSY)).toBe("busy"));
  test("信任框 / 回溯遮罩", () => {
    expect(composerState(TRUST)).toBe("dialog");
    expect(composerState(OVERLAY)).toBe("dialog");
  });
  test("历史里的用户消息（粗体加暗的 ›）不当成输入框；没有输入框就是 unknown", () => {
    expect(composerState(HISTORY)).toBe("unknown");
    expect(composerState("")).toBe("unknown");
    expect(composerState("› plain text without colors")).toBe("unknown"); // 抓屏没带颜色就判断不了
  });
});

function fakeIO(frames: string[], opts: { throwOnCapture?: number } = {}) {
  const calls: string[] = [];
  let i = 0;
  let captures = 0;
  const io: TypeInIO = {
    capture: async () => {
      captures++;
      if (opts.throwOnCapture === captures) throw new Error("tmux gone");
      return frames[Math.min(i, frames.length - 1)];
    },
    paste: async (t) => void (calls.push(`paste:${t}`), i++),
    enter: async () => void (calls.push("enter"), i++),
    clear: async () => void calls.push("clear"),
    sleep: async () => undefined,
  };
  return { io, calls };
}

describe("typeIntoCodex", () => {
  const MSG = `<channel a="1">\n多行\n"引号" $HOME \`反引号\`\n</channel>`;

  test("空输入框 → 原文粘贴 → 回车 → 看到回合开始 = 成功", async () => {
    const { io, calls } = fakeIO([EMPTY, PASTED, BUSY]);
    expect(await typeIntoCodex(io, MSG)).toEqual({ ok: true });
    expect(calls).toEqual([`paste:${MSG}`, "enter"]);
  });

  test("内容以 / 或 ! 开头（TUI 的斜杠命令 / 本机 shell）→ 不打", async () => {
    for (const t of ["/quit", " !rm -rf x"]) {
      const { io, calls } = fakeIO([EMPTY]);
      expect((await typeIntoCodex(io, t)).ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("输入框不空 / 在忙 / 有弹框 / 认不出：一个键都不发，交给 queue", async () => {
    for (const f of [TYPED, BUSY, TRUST, HISTORY]) {
      const { io, calls } = fakeIO([f]);
      expect((await typeIntoCodex(io, MSG)).ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("粘贴没落进去（输入框还是空的）→ 失败、不清（没东西可清）", async () => {
    const { io, calls } = fakeIO([EMPTY, EMPTY]);
    expect((await typeIntoCodex(io, MSG)).ok).toBe(false);
    expect(calls).toEqual([`paste:${MSG}`]);
  });

  test("粘贴后画面认不出 → 清掉输入框再报失败（退回 queue 不会进两次）", async () => {
    const { io, calls } = fakeIO([EMPTY, HISTORY]);
    expect((await typeIntoCodex(io, MSG)).ok).toBe(false);
    expect(calls).toEqual([`paste:${MSG}`, "clear"]);
  });

  test("第一下回车被当成换行 → 再补一下", async () => {
    const { io, calls } = fakeIO([EMPTY, PASTED, PASTED, EMPTY]);
    expect(await typeIntoCodex(io, MSG)).toEqual({ ok: true });
    expect(calls.filter((c) => c === "enter").length).toBe(2);
  });

  test("两下回车都没提交 → 仍算已打（不能退回 queue），标 unconfirmed", async () => {
    const { io } = fakeIO([EMPTY, PASTED]);
    expect(await typeIntoCodex(io, MSG)).toEqual({ ok: true, unconfirmed: true });
  });

  test("粘贴后 tmux 出错 → 清掉再报失败", async () => {
    const { io, calls } = fakeIO([EMPTY, PASTED], { throwOnCapture: 2 });
    const r = await typeIntoCodex(io, MSG);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([`paste:${MSG}`, "clear"]);
  });
});

describe("ownPaneIO：只打进自己那个 pane", () => {
  test("TMUX_PANE 不是 %N → 不打", () => {
    expect("error" in ownPaneIO({ TMUX_PANE: "master:agent-x", TMUX: "/tmp/x,1,0" })).toBe(true);
    expect("error" in ownPaneIO({})).toBe(true);
  });
  test("pane 在别的 tmux server 上（socket 对不上）→ 不打", () => {
    expect("error" in ownPaneIO({ TMUX_PANE: "%3", TMUX: "/tmp/some-other.sock,123,0" })).toBe(true);
  });
});

describe("CodexQueueSink：after_interrupt 分支", () => {
  function sink(typeIn?: (t: string) => Promise<{ ok: true } | { ok: false; why: string }>) {
    const queued: string[] = [];
    const typed: string[] = [];
    const logs: string[] = [];
    const s = new CodexQueueSink({
      source: "claudestra",
      getSessionId: () => "019e0000-0000-7000-8000-000000000001",
      heldThreadIds: async () => ["019e0000-0000-7000-8000-000000000001"],
      onSwitch: () => undefined,
      queue: async (_s, t) => (queued.push(t), { ok: true, out: "", err: "" }),
      notify: async () => undefined,
      log: (l) => void logs.push(l),
      typeIn: typeIn ? async (t) => (typed.push(t), typeIn(t)) : undefined,
    });
    return { s, queued, typed, logs };
  }

  test("带 after_interrupt → 打字投递、不走 queue；这个标记不出现在 <channel> 属性里", async () => {
    const h = sink(async () => ({ ok: true }));
    expect(await h.s.deliver("2+3?", { chat_id: "c", after_interrupt: "true" })).toEqual({ ok: true });
    expect(h.queued).toEqual([]);
    expect(h.typed[0]).toContain("2+3?");
    expect(h.typed[0]).not.toContain("after_interrupt");
  });

  test("打字没做成 → 退回 queue 并记日志", async () => {
    const h = sink(async () => ({ ok: false, why: "输入框状态 has-text" }));
    await h.s.deliver("x", { after_interrupt: "true" });
    expect(h.queued.length).toBe(1);
    expect(h.logs.some((l) => l.includes("退回 codex queue"))).toBe(true);
  });

  test("没有标记 → 照常 queue，不碰 TUI", async () => {
    const h = sink(async () => ({ ok: true }));
    await h.s.deliver("x", { chat_id: "c" });
    expect(h.typed).toEqual([]);
    expect(h.queued.length).toBe(1);
  });
});

describe("bridge：Codex 上次 Stop 之后被打断过 → 下一条标 after_interrupt", () => {
  const tools = { inflight: [] };
  test("抢占 / 停字 / 停止按钮 / 终端 Esc 都算；只标一条", () => {
    for (const cause of ["preempt", "stopword", "manual", "codex_interrupt"] as const) {
      const b = new TurnCuts(null);
      b.record({ channelId: "ch", agent: "cx", runtime: "codex", cause, tools });
      expect(b.takeAfterInterrupt("ch")).toBe(true);
      expect(b.takeAfterInterrupt("ch")).toBe(false);
    }
  });
  test("打断之后先来了正常 Stop（队列已恢复）→ 不标；StopFailure（打断回报）不算恢复", () => {
    const b = new TurnCuts(null);
    b.record({ channelId: "ch", agent: "cx", runtime: "codex", cause: "manual", tools });
    b.onStop("ch", "StopFailure");
    expect(b.takeAfterInterrupt("ch")).toBe(true);
    b.record({ channelId: "ch", agent: "cx", runtime: "codex", cause: "manual", tools });
    b.onStop("ch", "Stop");
    expect(b.takeAfterInterrupt("ch")).toBe(false);
  });
  test("CC / Pi 不标", () => {
    const b = new TurnCuts(null);
    b.record({ channelId: "a", agent: "a", runtime: "pi", cause: "stopword", tools });
    b.record({ channelId: "b", agent: "b", cause: "preempt", tools });
    expect(b.takeAfterInterrupt("a") || b.takeAfterInterrupt("b")).toBe(false);
  });
});

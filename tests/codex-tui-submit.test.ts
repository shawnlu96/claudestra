/**
 * Codex 被打断之后的「打字投递」：lib/codex-tui-submit.ts 的输入框判断与粘贴流程、CodexQueueSink 的分支、
 * bridge 侧「上次 Stop 之后被打断过」的标记。画面夹具取自 codex-cli 0.153.4 的 capture-pane -e（2026-09-28 实测）。
 */
import { describe, expect, test } from "bun:test";
import { CodexQueueSink } from "../src/lib/codex-thread.js";
import { composerState, ownPaneIO, sanitizeForPaste, typeIntoCodex, type TypeInIO } from "../src/lib/codex-tui-submit.js";

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
    paste: async (t) => (calls.push(`paste:${t}`), i++, true),
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
    const notices: { text: string; fyi?: true }[] = [];
    const s = new CodexQueueSink({
      source: "claudestra",
      getSessionId: () => "019e0000-0000-7000-8000-000000000001",
      heldThreadIds: async () => ["019e0000-0000-7000-8000-000000000001"],
      onSwitch: () => undefined,
      queue: async (_s, t) => (queued.push(t), { ok: true, out: "", err: "" }),
      notify: async (_c, text, fyi) => void notices.push({ text, fyi }),
      log: (l) => void logs.push(l),
      typeIn: typeIn ? async (t) => (typed.push(t), typeIn(t)) : undefined,
    });
    return { s, queued, typed, logs, notices };
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
    // 消息其实排进了队列：提示只在本频道发（fyi），不走 reply——否则 bridge 当成 agent 答了这条（对抗式第 3 轮 P2-6）
    expect(h.notices.length).toBe(1);
    expect(h.notices[0].fyi).toBe(true);
  });

  test("没有标记 → 照常 queue，不碰 TUI", async () => {
    const h = sink(async () => ({ ok: true }));
    await h.s.deliver("x", { chat_id: "c" });
    expect(h.typed).toEqual([]);
    expect(h.queued.length).toBe(1);
  });
});

describe("sanitizeForPaste：消息内容不能变成按键（P1-4）", () => {
  test("括号粘贴结束符 ESC[201~ 被拆掉：后面的 !shell / C-c 只是普通文字", () => {
    const evil = "hi\x1b[201~!rm -rf ~\x03\x03";
    const clean = sanitizeForPaste(evil);
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("\x03");
    expect(clean).toBe("hi[201~!rm -rf ~");
  });
  test("C1 控制字符（单字节 CSI \x9b）、DEL 也去掉；换行 / 制表符保留，\r 统一成换行", () => {
    expect(sanitizeForPaste("a\x9b201~b\x7fc")).toBe("a201~bc");
    expect(sanitizeForPaste("l1\r\nl2\rl3\tx")).toBe("l1\nl2\nl3\tx");
  });
  test("正常内容原样：引号、$、反引号、中文、尖括号", () => {
    const ok = '<channel a="1">\n"双引号" $HOME `反引号` 中文 & <尖括号>\n</channel>';
    expect(sanitizeForPaste(ok)).toBe(ok);
  });
  test("typeIntoCodex 粘进去的是清洗后的内容", async () => {
    const pasted: string[] = [];
    let n = 0;
    const frames = [EMPTY, PASTED, BUSY];
    const io: TypeInIO = {
      capture: async () => frames[Math.min(n, 2)], paste: async (t) => (pasted.push(t), n++, true), enter: async () => void n++,
      clear: async () => undefined, sleep: async () => undefined,
    };
    await typeIntoCodex(io, "<channel>x\x1b[201~!date</channel>");
    expect(pasted).toEqual(["<channel>x[201~!date</channel>"]);
  });
});

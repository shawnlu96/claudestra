import { describe, expect, test } from "bun:test";
import { createTtyInput, fitTail, parseTerminalLine, pickPermissionOption, type TerminalOp } from "../src/lib/acp/tty-input.ts";
import type { PermissionCard } from "../src/lib/acp/permissions.ts";

// ACP 窗口输入行的按键语义：回车发、Esc / Ctrl-C 打断、空闲连按两次 Ctrl-C 才退、斜杠命令、审批 y/n/数字

const CARD: PermissionCard = {
  toolCallId: "t1", title: "Codex 请求授权：rm", detail: "rm -rf x", mcp: false,
  options: [{ id: "allow_once", label: "允许", style: "success" }, { id: "always", label: "总是允许", style: "success" }, { id: "decline", label: "拒绝", style: "danger" }],
};

function rig(o: { busy?: boolean; permission?: boolean; reply?: (op: TerminalOp) => Promise<{ ok: boolean; error?: string; note?: string }> } = {}) {
  const ops: TerminalOp[] = [], printed: string[] = [];
  let exits = 0, t = 1_000_000;
  const state = { busy: !!o.busy, permission: o.permission ? { permId: "h-1", card: CARD } : null };
  const input = createTtyInput({
    busy: () => state.busy,
    permission: () => state.permission,
    request: (op) => (ops.push(op), o.reply ? o.reply(op) : Promise.resolve({ ok: true })),
    print: (l) => void printed.push(l),
    redraw: () => {},
    exit: () => void exits++,
    now: () => t,
    escMs: 5,
  });
  return { input, ops, printed, state, exits: () => exits, advance: (ms: number) => void (t += ms) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("parseTerminalLine：命令与网页同名同义", () => {
  test.each([
    ["/model gpt-5.6-luna", { op: "config", configId: "model", value: "gpt-5.6-luna" }],
    ["/effort high", { op: "config", configId: "effort", value: "high" }],
    ["/thinking low", { op: "config", configId: "effort", value: "low" }],
    ["/clear", { op: "clear" }],
    ["/compact", { op: "compact" }],
    ["/help", { help: true }],
    ["/model", { error: "用法：/model <模型名>" }],
    ["/review 看看这个", { op: "message", text: "/review 看看这个" }],
    ["你好", { op: "message", text: "你好" }],
  ])("%s", (line, want) => expect(parseTerminalLine(line)).toEqual(want as never));
});

describe("输入与发送", () => {
  test("逐键打字、退格、回车：整行作为一条消息交给 bridge（不自己开回合）", () => {
    const r = rig();
    for (const k of ["h", "i", "x", "\x7f", "!", "\r"]) r.input.feed(k);
    expect(r.ops).toEqual([{ op: "message", text: "hi!" }]);
    expect(r.input.line(80)).toBe("❯ ");
  });

  test("快速连按（同一个 data 块里两个回车）：每个回车各发一条，不合并（r1 enter-batch-merge 复现）", () => {
    const r = rig();
    r.input.feed("a\rb");
    expect(r.ops).toEqual([{ op: "message", text: "a" }]);
    r.input.feed("\r/clear\r");
    expect(r.ops).toEqual([{ op: "message", text: "a" }, { op: "message", text: "b" }, { op: "clear" }]);
  });

  test("bracketed paste：ESC[200~ … ESC[201~ 之间的回车留在正文（可跨 data 块），之后的回车才发", () => {
    const r = rig();
    r.input.feed("\x1b[200~第一行\r");
    r.input.feed("第二行\r\n第三行\x1b[20");
    r.input.feed("1~");
    expect(r.ops).toEqual([]);
    expect(r.input.line(80)).toBe("❯ 第一行⏎第二行⏎第三行");
    r.input.feed("\r");
    expect(r.ops).toEqual([{ op: "message", text: "第一行\n第二行\n第三行" }]);
  });

  test("方向键的 ESC 和 [A 被拆到两次 data：不算 Esc、不打断，也不进正文（r1 split-escape-aborts 复现）", async () => {
    const r = rig({ busy: true });
    r.input.feed("\x1b");
    r.input.feed("[A");
    r.input.feed("\x1b");
    r.input.feed("O");
    r.input.feed("B");
    await new Promise((res) => setTimeout(res, 20));
    expect(r.ops).toEqual([]);
    expect(r.input.line(80)).toBe("❯ ");
  });

  test("方向键等转义序列不进正文；空行回车不发", () => {
    const r = rig();
    r.input.feed("\x1b[A\x1b[D\x1bOBa");
    r.input.feed("\r");
    r.input.feed("\r");
    expect(r.ops).toEqual([{ op: "message", text: "a" }]);
  });

  test("bridge 不认 / 押着：在窗口里说清楚", async () => {
    const r = rig({ reply: async (op) => (op.op === "message" ? { ok: true, note: "押着没投" } : { ok: false, error: "宿主不在线" }) });
    r.input.feed("hi\r");
    r.input.feed("/clear\r");
    await flush();
    expect(r.printed).toEqual(["❯ /clear", "· 押着没投", "❌ 宿主不在线（原文已放回输入行）"]);
  });

  test("没发出去（拒投 / 断线）：原文放回输入行，不用重打（r1 failed-send-drops-draft）；已经在打新的就不覆盖", async () => {
    const refused = rig({ reply: async () => ({ ok: false, error: "拒投" }) });
    refused.input.feed("一段很长的话\r");
    await flush();
    expect(refused.input.line(80)).toBe("❯ 一段很长的话");
    const down = rig({ reply: async () => { throw new Error("bridge 连接还没好"); } });
    down.input.feed("第一句\r");
    down.input.feed("第二");
    await flush();
    expect(down.input.line(80)).toBe("❯ 第二");
    expect(down.printed.at(-1)).toContain("没送到 bridge");
  });
});

describe("斜杠命令", () => {
  test("/model /effort /clear /compact 各交一个动作；/help 本地打印、不打扰 bridge", async () => {
    const r = rig({ reply: async () => ({ ok: true, note: "好了" }) });
    for (const l of ["/model luna", "/effort high", "/clear", "/compact", "/help"]) r.input.feed(`${l}\r`);
    await flush();
    expect(r.ops).toEqual([
      { op: "config", configId: "model", value: "luna" }, { op: "config", configId: "effort", value: "high" }, { op: "clear" }, { op: "compact" },
    ]);
    expect(r.printed.some((l) => l.startsWith("终端命令：") && l.includes("/compact"))).toBe(true);
    expect(r.printed.filter((l) => l === "✅ 好了")).toHaveLength(4);
  });
});

describe("打断与退出", () => {
  test("Esc：等一小会儿没有后文才算；回合中 = 打断（交 bridge 走网页同一条打断）；空闲 = 清空输入，什么都不发", async () => {
    const busy = rig({ busy: true });
    busy.input.feed("\x1b");
    expect(busy.ops).toEqual([]); // 还在等后文
    await new Promise((res) => setTimeout(res, 20));
    expect(busy.ops).toEqual([{ op: "interrupt" }]);
    const idle = rig();
    idle.input.feed("草稿");
    idle.input.feed("\x1b");
    await new Promise((res) => setTimeout(res, 20));
    expect(idle.ops).toEqual([]);
    expect(idle.input.line(80)).toBe("❯ ");
  });

  test("Ctrl-C 回合中 = 打断，不退出", () => {
    const r = rig({ busy: true });
    r.input.feed("\x03");
    r.input.feed("\x03");
    expect(r.ops).toEqual([{ op: "interrupt" }, { op: "interrupt" }]);
    expect(r.exits()).toBe(0);
  });

  test("空闲时误按一次 Ctrl-C 不退出（只提示）；2 秒内再按一次才退", () => {
    const r = rig();
    r.input.feed("\x03");
    expect(r.exits()).toBe(0);
    expect(r.printed.at(-1)).toContain("再按一次 Ctrl-C");
    r.advance(2_500);
    r.input.feed("\x03");
    expect(r.exits()).toBe(0); // 隔太久：重新算第一下
    r.advance(500);
    r.input.feed("\x03");
    expect(r.exits()).toBe(1);
  });

  test("输入行有字时 Ctrl-C 先清字，不算退出的一下", () => {
    const r = rig();
    r.input.feed("abc");
    r.input.feed("\x03");
    r.input.feed("\x03");
    expect(r.exits()).toBe(0);
    expect(r.input.line(80)).toBe("❯ ");
  });
});

describe("终端审批", () => {
  test("y = 第一个允许、n = 第一个拒绝、数字 = 第几个；结果走 permission 动作", async () => {
    expect(pickPermissionOption(CARD, "y")).toBe("allow_once");
    expect(pickPermissionOption(CARD, "n")).toBe("decline");
    expect(pickPermissionOption(CARD, "2")).toBe("always");
    expect(pickPermissionOption(CARD, "9")).toBeNull();
    const r = rig({ permission: true });
    expect(r.input.line(200)).toContain("[1]允许 [2]总是允许 [3]拒绝");
    r.input.feed("n");
    await flush();
    expect(r.ops).toEqual([{ op: "permission", permId: "h-1", optionId: "decline" }]);
    expect(r.printed).toEqual(["✅ 已作答：拒绝"]);
  });

  test("上一下还没回就再按：吞掉，同一张卡只答一次", () => {
    const r = rig({ permission: true, reply: () => new Promise(() => {}) });
    r.input.feed("y");
    r.input.feed("y");
    r.input.feed("n");
    expect(r.ops).toHaveLength(1);
  });

  test("输入行有字时 y/n 照常是正文（在写消息，不是答卡）", () => {
    const r = rig({ permission: true });
    r.input.feed("hey\r");
    expect(r.ops).toEqual([{ op: "message", text: "hey" }]);
  });
});

test("fitTail：放不下留尾巴、前面 …；中文按两格，总宽不超过 cols - 1", () => {
  expect(fitTail("❯ abc", 20)).toBe("❯ abc");
  const s = fitTail(`❯ ${"中".repeat(30)}`, 21);
  expect(s.startsWith("…")).toBe(true);
  expect(Bun.stringWidth(s)).toBeLessThanOrEqual(20);
});

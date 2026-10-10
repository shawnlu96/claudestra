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
    expect(down.printed.at(-1)).toBe("❌ 没送到 bridge：bridge 连接还没好（输入行已有新内容，没放回；原文：第一句）"); // r2：不再谎称已放回
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

describe("终端审批：整行是选项键 + 回车才答卡（显式确认）", () => {
  const typeEach = (r: ReturnType<typeof rig>, text: string) => { for (const ch of text) r.input.feed(ch); };

  test("y + 回车 → 第一个允许；n + 回车 → 第一个拒绝；序号 + 回车 → 第几个；结果走 permission 动作", async () => {
    expect(pickPermissionOption(CARD, "y")).toBe("allow_once");
    expect(pickPermissionOption(CARD, "n")).toBe("decline");
    expect(pickPermissionOption(CARD, "2")).toBe("always");
    expect(pickPermissionOption(CARD, "9")).toBeNull();
    const yes = rig({ permission: true });
    expect(yes.input.line(200)).toContain("[1]允许 [2]总是允许 [3]拒绝（y/n/序号 + 回车）");
    yes.input.feed("y");
    expect(yes.ops).toEqual([]); // 没回车不答
    yes.input.feed("\r");
    expect(yes.ops).toEqual([{ op: "permission", permId: "h-1", optionId: "allow_once" }]);
    const no = rig({ permission: true });
    no.input.feed("n");
    no.input.feed("\r");
    await flush();
    expect(no.ops).toEqual([{ op: "permission", permId: "h-1", optionId: "decline" }]);
    expect(no.printed).toEqual(["✅ 已作答：拒绝"]);
    const second = rig({ permission: true });
    second.input.feed("2\r");
    expect(second.ops).toEqual([{ op: "permission", permId: "h-1", optionId: "always" }]);
  });

  for (const [how, feed] of [["整块 feed", (r: ReturnType<typeof rig>, t: string) => r.input.feed(t)], ["逐字 feed", typeEach]] as const) {
    test(`无标记粘贴 y 开头的话（${how}）：不答卡，文字留在输入行（Shawn paste-grants-permission）`, () => {
      const r = rig({ permission: true });
      feed(r, "you should reject this command");
      expect(r.ops).toEqual([]);
      expect(r.input.line(100)).toBe("❯ you should reject this command");
    });

    test(`数字开头的消息（${how}）：不按序号答卡，文字留在输入行`, () => {
      const r = rig({ permission: true });
      feed(r, "2 个问题先回答");
      expect(r.ops).toEqual([]);
      expect(r.input.line(100)).toBe("❯ 2 个问题先回答");
    });
  }

  test("bracketed paste 分 3 次进来（开始标记 / 正文 / 结束标记）：正文留输入行，不答卡；回车整条当消息发", () => {
    const r = rig({ permission: true });
    r.input.feed("\x1b[200~");
    r.input.feed("y");
    r.input.feed("es, 1 more\x1b[201~");
    expect(r.ops).toEqual([]);
    expect(r.input.line(100)).toBe("❯ yes, 1 more");
    r.input.feed("\r");
    expect(r.ops).toEqual([{ op: "message", text: "yes, 1 more" }]);
  });

  test("审批挂起时别的内容回车：照常当消息发（插进当前回合），不答卡", () => {
    const r = rig({ permission: true });
    r.input.feed("yes please\r");
    expect(r.ops).toEqual([{ op: "message", text: "yes please" }]);
  });

  test("上一下作答还没回就再回车：不重复提交；卡上没有的键说清楚、不发", () => {
    const r = rig({ permission: true, reply: () => new Promise(() => {}) });
    r.input.feed("y\r");
    r.input.feed("n\r");
    expect(r.ops).toHaveLength(1);
    const noDecline = rig({ permission: true });
    noDecline.state.permission = { permId: "h-2", card: { ...CARD, options: [CARD.options[0]!] } };
    noDecline.input.feed("n\r");
    expect(noDecline.ops).toEqual([]);
    expect(noDecline.printed.at(-1)).toContain("卡上没有");
  });

  test("没有审批在等：单个 y + 回车就是一条普通消息", () => {
    const r = rig();
    r.input.feed("y\r");
    expect(r.ops).toEqual([{ op: "message", text: "y" }]);
  });
});

test("fitTail：放不下留尾巴、前面 …；中文按两格，总宽不超过 cols - 1", () => {
  expect(fitTail("❯ abc", 20)).toBe("❯ abc");
  const s = fitTail(`❯ ${"中".repeat(30)}`, 21);
  expect(s.startsWith("…")).toBe(true);
  expect(Bun.stringWidth(s)).toBeLessThanOrEqual(20);
});

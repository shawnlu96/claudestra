import { describe, expect, test } from "bun:test";
import {
  agentChipIndex,
  agentLabelKey,
  cleanSummary,
  messagePlainText,
  splitQuoted,
  toolIcon,
} from "@/features/chat/message-text";
import type { ChatMessage } from "@/features/chat/type";

const msg = (p: Partial<ChatMessage>): ChatMessage => ({ id: "m1", role: "assistant", content: "", ...p }) as ChatMessage;

describe("工具行", () => {
  test("toolIcon：已知工具给专属图标，未知给 🔧", () => {
    expect(toolIcon("Bash")).toBe("💻");
    expect(toolIcon("Agent")).toBe("🤖");
    expect(toolIcon("mcp__x__y")).toBe("🔧");
  });
  test("cleanSummary：去掉 ||command|| 标记并压空白", () => {
    expect(cleanSummary("||ls -la||  in  /tmp")).toBe("ls -la in /tmp");
  });
});

describe("splitQuoted（左滑引用格式）", () => {
  test("「> 引用\\n\\n正文」拆成引用 + 正文", () => {
    expect(splitQuoted("> 原话\n\n我的回复\n第二行")).toEqual({ quoted: "原话", body: "我的回复\n第二行" });
  });
  test("不是引用格式：原样作正文", () => {
    expect(splitQuoted("> 只有引用没有空行")).toEqual({ quoted: undefined, body: "> 只有引用没有空行" });
    expect(splitQuoted("普通消息")).toEqual({ quoted: undefined, body: "普通消息" });
  });
});

describe("messagePlainText（复制整条）", () => {
  test("按段序取叙述 + reply；工具段、进度句不进剪贴板", () => {
    const m = msg({
      segments: [
        { kind: "text", text: "先看一下" },
        { kind: "tools", tools: [] },
        { kind: "text", text: "💭 进度", progress: true },
        { kind: "reply", text: "结论" },
      ] as ChatMessage["segments"],
    });
    expect(messagePlainText(m)).toBe("先看一下\n\n结论");
  });
  test("reply 既在段里又挂在 replyText 上：只复制一遍", () => {
    const m = msg({ segments: [{ kind: "reply", text: "结论" }] as ChatMessage["segments"], replyText: "结论" });
    expect(messagePlainText(m)).toBe("结论");
  });
  test("无段（旧快照）：content + replyText", () => {
    expect(messagePlainText(msg({ content: "叙述", replyText: "回复" }))).toBe("叙述\n\n回复");
  });
  test("行内按钮语法退化成文字", () => {
    const out = messagePlainText(msg({ replyText: "点 [[{#go .primary}继续]] 吧" }));
    expect(out).not.toContain("[[");
    expect(out).toContain("继续");
  });
});

describe("agent chip 名单（D8-4 字符串订阅键）", () => {
  const agents = [
    { name: "__master__", displayName: "大总管", pinnedMaster: true },
    { name: "web", displayName: "Web 前端" },
    { name: "bare" },
  ];
  test("同一数组引用只拼一次；内容相同的新数组得到相同的串（Object.is 相等 → 不重渲染）", () => {
    const k1 = agentLabelKey(agents);
    expect(agentLabelKey(agents)).toBe(k1);
    expect(agentLabelKey(agents.map((a) => ({ ...a })))).toBe(k1);
    expect(agentLabelKey([...agents, { name: "new" }])).not.toBe(k1);
  });
  test("还原：labels 含 name / displayName / master 别名；resolve 映射回前端名", () => {
    const { labels, resolve } = agentChipIndex(agentLabelKey(agents));
    expect(labels).toEqual(["__master__", "大总管", "master", "web", "Web 前端", "bare"]);
    expect(resolve("master")).toBe("__master__");
    expect(resolve("Web 前端")).toBe("web");
    expect(resolve("bare")).toBe("bare");
    expect(resolve("nobody")).toBeNull();
  });
  test("空名单", () => {
    const { labels, resolve } = agentChipIndex(agentLabelKey([]));
    expect(labels).toEqual([]);
    expect(resolve("master")).toBeNull();
  });
});

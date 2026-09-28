import { describe, expect, test } from "bun:test";
import { isSelfSource, OWNER_CHAT_ID, selfIdsFrom, toChatMessages, type NeutralMessage } from "@/lib/chat/history-shape";

// owner 2026-09-24：本人的所有来源靠右（自己的 web、自己的 Discord），其余一律靠左
describe("isSelfSource（本人的所有来源都算本人）", () => {
  const self = new Set(["api:owner:self", "111111111111111111"]);
  test("本端乐观消息（没有 from）= 本人；自己的设备、自己的 Discord 账号 = 本人", () => {
    expect(isSelfSource(undefined, undefined, self)).toBe(true);
    expect(isSelfSource("iPhone · Safari", "api:owner:self", self)).toBe(true);
    expect(isSelfSource("shawn", "111111111111111111", self)).toBe(true);
  });
  test("别人的设备 / 别人的 Discord / peer / agent = 别人", () => {
    expect(isSelfSource("phone-app", "api:tok_other", self)).toBe(false);
    expect(isSelfSource("friend", "222222222222222222", self)).toBe(false);
    expect(isSelfSource("peer-Sekai", "api:tok_peer", self)).toBe(false);
  });
  test("老数据没有 fromId，或 whoami 取不到：退回按旧 token 名 web-ui 认", () => {
    expect(isSelfSource("web-ui", undefined, self)).toBe(true);
    expect(isSelfSource("shawn", undefined, self)).toBe(false);
    expect(isSelfSource("web-ui", "api:owner:self", new Set())).toBe(true);
  });
  test("selfIdsFrom：owner 设备默认 api:owner:self；guest 用配对回的 principalId；whoami 的 ownerIds 一并算", () => {
    expect([...selfIdsFrom(undefined, { tokenId: "owner:self", ownerIds: ["111"] })].sort()).toEqual(["111", OWNER_CHAT_ID]);
    expect([...selfIdsFrom("guest:mom", null)]).toEqual(["api:guest:mom"]);
  });
});

const u = (seq: number, text: string, extra: Partial<NeutralMessage> = {}): NeutralMessage => ({ seq, role: "user", text, ts: `2026-09-27T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });
const a = (seq: number, extra: Partial<NeutralMessage> = {}): NeutralMessage => ({ seq, role: "assistant", ts: `2026-09-27T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });

describe("toChatMessages（历史记录 → 气泡）", () => {
  test("同一回合的连续 assistant 记录合成一泡：text 空行拼接、工具按序、reply 单独成段、seqEnd 追到尾", () => {
    const out = toChatMessages([u(1, "hi"), a(2, { text: "think" }), a(3, { tools: [{ name: "Read", summary: "a.ts" }] }), a(4, { replyText: "done", turnMs: 1200 })], { sid: "s1" });
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    const g = out[1];
    expect(g.id).toBe("h2");
    expect(g.seqEnd).toBe(4);
    expect(g.content).toBe("think");
    expect(g.toolCalls?.map((t) => t.name)).toEqual(["Read"]);
    expect(g.replyText).toBe("done");
    expect(g.segments?.map((s) => s.kind)).toEqual(["text", "tools", "reply"]);
    expect(g.turnDone).toBe(true); // 尾轮正常收尾才标完成
    expect(out[0].sid).toBe("s1");
  });
  test("user / system / compact 边界断开分组；中断标记与斜杠命令记录渲染成系统分隔线；compactSummary 跳过", () => {
    const items: NeutralMessage[] = [
      a(1, { text: "a" }),
      u(2, "[Request interrupted by user]"),
      a(3, { text: "b" }),
      u(4, "<command-name>/clear</command-name>"),
      u(5, "长摘要", { compactSummary: true }),
      { seq: 6, role: "system", text: "── 上下文已压缩 ──" },
      a(7, { text: "c" }),
    ];
    const out = toChatMessages(items);
    expect(out.map((m) => `${m.role}:${m.content}`)).toEqual(["assistant:a", "system:已被用户中断", "assistant:b", "system:/clear", "system:上下文已压缩", "assistant:c"]);
  });
  test("入站附件：头属性里的路径（网页上传）+ 正文标记（Discord 两处都写）合并去重；只有附件没有正文也成泡", () => {
    const out = toChatMessages([
      u(1, "看这两张", { attachments: ["/s/inbox/api_1_a.png", "/s/inbox/api_2_b.pdf"] }),
      u(2, "[attachment: /s/inbox/1525_c.png]", { attachments: ["/s/inbox/1525_c.png"] }),
      u(3, "", { attachments: ["/s/inbox/api_3_d.jpg"] }),
    ]);
    expect(out.map((m) => [m.content, m.attachments?.map((x) => `${x.kind}:${x.name}`)])).toEqual([
      ["看这两张", ["image:a.png", "file:b.pdf"]],
      ["", ["image:c.png"]],
      ["", ["image:d.jpg"]],
    ]);
  });
  test("按钮点击的机器 payload 还原成组件 label，并回填锚点气泡的 replyClicks（已答态跨刷新持久）", () => {
    const comps = [{ type: "buttons" as const, buttons: [{ id: "go", label: "✅ 发版" }] }];
    const out = toChatMessages([a(1, { replyText: "要发版吗", replyComponents: comps }), u(2, "[button:go]"), u(3, "[button:nope]")]);
    expect(out[1].content).toBe("✅ 发版");
    expect(out[0].replyClicks).toEqual({ b0: "go" });
    expect(out[2].content).toBe("🔘 nope"); // 组件里没有 → 兜底显示 id
  });
  test("隐藏区间不输出但仍是分组断点；before 分页片段（tail=false）不标完成；外源入站剥注入头 + 附件标记", () => {
    const hidden = (seq: number) => seq === 2;
    const out = toChatMessages([a(1, { text: "a", turnMs: 5 }), u(2, "secret"), a(3, { text: "b", turnMs: 9 })], { isHidden: hidden, tail: false });
    expect(out.map((m) => m.content)).toEqual(["a", "b"]);
    expect(out[1].turnDone).toBeUndefined();
    const peerMsg = u(1, "[🤝 来自 peer Sekai]\n看这个\n[attachment: /tmp/inbox/123_pic.png]", { from: "peer-Sekai", fromId: "api:peer" });
    const ext = toChatMessages([peerMsg], { selfIds: new Set(["api:owner:self"]) });
    expect(ext[0].from).toBe("peer-Sekai");
    expect(ext[0].content).toBe("看这个");
    expect(ext[0].attachments?.[0]).toMatchObject({ name: "pic.png", kind: "image", url: "/api/v1/attachments/123_pic.png" });
  });
  test("CRLF 归一 + 进度句自成一段不进 content", () => {
    const out = toChatMessages([a(1, { text: "x\r\ny", progress: "正在读文件" })]);
    expect(out[0].content).toBe("x\ny");
    expect(out[0].segments?.[0]).toMatchObject({ kind: "text", progress: true, text: "正在读文件" });
  });
});

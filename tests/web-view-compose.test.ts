import { describe, expect, test } from "bun:test";
import {
  composeView,
  droppedBlobUrls,
  mergePendingByTs,
  stripInboundHeader,
  survivingPending,
  PENDING_KEEP_MS,
  isUserEcho,
  sendCursor,
} from "@/features/chat/view-compose";
import type { ChatMessage } from "@/features/chat/type";

const NOW = Date.parse("2026-09-23T03:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function local(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${Math.random()}`, role: "user", content, local: true, ts: iso(60_000), ...extra };
}
function histUser(seq: number, content: string, ts = iso(30_000)): ChatMessage {
  return { id: `h${seq}`, role: "user", content, ts };
}
function histAsst(seq: number, text: string, ts = iso(20_000)): ChatMessage {
  return { id: `h${seq}`, role: "assistant", content: text, segments: [{ kind: "text", text }], ts };
}

describe("stripInboundHeader", () => {
  test("剥 Claudestra 注入头，普通 [ 开头的文本不动", () => {
    expect(stripInboundHeader("[🌐 来自 Web 端用户「x」（…）。\n用 reply() 回]\n\n正文")).toBe("正文");
    expect(stripInboundHeader("[TODO] 普通文本")).toBe("[TODO] 普通文本");
  });
});

describe("survivingPending（乐观消息对账）", () => {
  test("同一文本连发两条：历史里只进了一条 → 只消费一条，另一条保全", () => {
    const cur = [local("好"), local("好")];
    const left = survivingPending(cur, [histUser(1, "好")], NOW);
    expect(left.length).toBe(1);
  });

  test("两条都进了历史 → 各自对账，一条不留", () => {
    const cur = [local("好"), local("好")];
    expect(survivingPending(cur, [histUser(1, "好"), histUser(2, "好")], NOW)).toEqual([]);
  });

  test("Pi：历史里的入站消息带注入头，本地只有正文 → 对上（09-14）", () => {
    const cur = [local("帮我看下日志")];
    const h = [histUser(1, "[🌐 来自 Web 端用户「shawn」]\n\n帮我看下日志")];
    expect(survivingPending(cur, h, NOW)).toEqual([]);
  });

  test("按钮回投：历史含 wire 原文 / 「🔘 label」形态都算对上（07-16）", () => {
    const btn = local("✅ 好的", { wire: "[button:go_ahead]" });
    expect(survivingPending([btn], [histUser(1, "<channel>[button:go_ahead]</channel>")], NOW)).toEqual([]);
    expect(survivingPending([btn], [histUser(1, "🔘 go_ahead")], NOW)).toEqual([]);
  });

  test("纯附件（T23）：发送时游标之后落盘、附件数相同的空正文条目 → 对上；时钟快也不影响", () => {
    const img = { name: "image.png", kind: "image" as const, url: "blob:x" };
    // 本地时钟比服务端快 5 分钟：历史 ts 早于本地 ts，照样对上（不再按时间窗）
    const cur = [local("", { attachments: [img], sentAfter: { seq: 10, sid: "s1" }, ts: iso(0) })];
    const h = { ...histUser(12, "", iso(5 * 60_000)), seqEnd: 12, sid: "s1", attachments: [{ ...img, url: "/api/v1/attachments/api_1_image.png" }] };
    expect(survivingPending(cur, [h], NOW)).toEqual([]);
  });

  test("纯附件：游标之前的另一条纯图片 / 附件数不同 / 有字 → 不配，刚发的气泡保全", () => {
    const img = { name: "image.png", kind: "image" as const };
    const cur = [local("", { attachments: [img], sentAfter: { seq: 10, sid: "s1" } })];
    const older = { ...histUser(8, ""), seqEnd: 8, sid: "s1", attachments: [img] }; // 上一张已对上账的纯图（审查 P2-2 全量重载）
    const twoImgs = { ...histUser(11, ""), seqEnd: 11, sid: "s1", attachments: [img, img] };
    expect(survivingPending(cur, [older, twoImgs], NOW).length).toBe(1);
    expect(survivingPending(cur, [{ ...histUser(12, "有字的消息"), seqEnd: 12, sid: "s1" }], NOW).length).toBe(1);
  });

  test("sendCursor：取视图里最后一条带行号的消息；没有就不记", () => {
    const list: ChatMessage[] = [{ ...histUser(3, "a"), seqEnd: 3, sid: "s1" }, { ...histAsst(4, "b"), seqEnd: 7, sid: "s1" }, local("刚发的")];
    expect(sendCursor(list)).toEqual({ sentAfter: { seq: 7, sid: "s1" } });
    expect(sendCursor([local("x")])).toEqual({});
  });

  test("CRLF 与首尾空白归一（07-15）", () => {
    expect(survivingPending([local("a\r\nb ")], [histUser(1, "a\nb")], NOW)).toEqual([]);
  });

  test("30 分钟还没对上的不再保全", () => {
    const old = local("很久以前", { ts: iso(PENDING_KEEP_MS + 1) });
    const fresh = local("刚发的", { ts: iso(1000) });
    expect(survivingPending([old, fresh], [], NOW)).toEqual([fresh]);
  });

  test("非本地 / 非用户消息不参与", () => {
    const a: ChatMessage = { id: "x", role: "assistant", content: "hi", local: true };
    const u: ChatMessage = { id: "y", role: "user", content: "hi" };
    expect(survivingPending([a, u], [], NOW)).toEqual([]);
  });
});

describe("mergePendingByTs（09-04：按时间插回，不一律接尾）", () => {
  test("插在第一条比它新的消息前面；无 ts 的接尾", () => {
    const list = [histUser(1, "a", iso(50_000)), histAsst(2, "b", iso(10_000))];
    const p1 = local("中间", { ts: iso(30_000) });
    const p2 = local("无时间", { ts: undefined });
    const out = mergePendingByTs(list, [p1, p2]);
    expect(out.map((m) => m.content)).toEqual(["a", "中间", "b", "无时间"]);
  });
  test("没有幸存的原样返回同一个数组", () => {
    const list = [histUser(1, "a")];
    expect(mergePendingByTs(list, [])).toBe(list);
  });
});

describe("composeView（全量 / 差量共用的视图重组）", () => {
  test("不在回合中：历史 + 幸存乐观消息，不恢复思考点", () => {
    const pending = local("还在排队", { ts: iso(1000) });
    const history = [histUser(1, "a"), histAsst(2, "b")];
    const v = composeView({ current: [pending], history, incoming: history, streaming: false, cursor: null, nowMs: NOW });
    expect(v.messages.map((m) => m.content)).toEqual(["a", "b", "还在排队"]);
    expect(v.restoreAwaiting).toBe(false);
  });

  test("回合进行中：比历史新的直播气泡保全在尾部（07-16「像卡死」）", () => {
    const liveBubble: ChatMessage = {
      id: "m9", role: "assistant", content: "还在写", streamed: true, ts: iso(0),
      segments: [{ kind: "text", text: "还在写" }],
    };
    const history = [histUser(1, "a"), histAsst(2, "b", iso(60_000))];
    const v = composeView({ current: [liveBubble], history, incoming: history, streaming: true, cursor: null, nowMs: NOW });
    expect(v.messages[v.messages.length - 1].id).toBe("m9");
    expect(v.restoreAwaiting).toBe(false);
  });

  test("回合进行中但直播气泡已被历史吸收 → 丢掉它，并恢复「思考中」", () => {
    const liveBubble: ChatMessage = {
      id: "m9", role: "assistant", content: "b", streamed: true, ts: iso(21_000),
      segments: [{ kind: "text", text: "b" }],
    };
    const history = [histUser(1, "a"), histAsst(2, "b", iso(20_000))];
    const v = composeView({ current: [liveBubble], history, incoming: history, streaming: true, cursor: null, nowMs: NOW });
    expect(v.messages.map((m) => m.id)).toEqual(["h1", "h2"]);
    expect(v.restoreAwaiting).toBe(true);
  });

  test("差量：对账只看这次新到的记录（incoming = delta）", () => {
    const pending = local("新消息", { ts: iso(1000) });
    const base = [histUser(1, "旧"), histAsst(2, "旧回复")];
    const delta = [histUser(3, "新消息", iso(500))];
    const v = composeView({ current: [...base, pending], history: [...base, ...delta], incoming: delta, streaming: false, cursor: null, nowMs: NOW });
    expect(v.messages.map((m) => m.id)).toEqual(["h1", "h2", "h3"]);
  });
});

describe("droppedBlobUrls（乐观气泡被历史替换后回收本地预览 URL）", () => {
  test("只回收被丢掉的本地气泡里的 blob:，留下的与服务端 URL 不碰", () => {
    const gone = local("图", { id: "m1", attachments: [{ name: "a.png", kind: "image", url: "blob:x/1" }] });
    const kept = local("图2", { id: "m2", attachments: [{ name: "b.png", kind: "image", url: "blob:x/2" }] });
    const server: ChatMessage = {
      id: "h9", role: "user", content: "图", attachments: [{ name: "a.png", kind: "image", url: "/api/chat/attachment/a.png" }],
    };
    expect(droppedBlobUrls([gone, kept, server], [kept])).toEqual(["blob:x/1"]);
  });
});

describe("isUserEcho（他端发言回声去重）", () => {
  const img = (url?: string, name = "image.png") => ({ name, kind: "image" as const, ...(url ? { url } : {}) });

  test("本端乐观的纯图气泡（blob 地址）收到自己的回声 → 算回声；文件名按服务端规则清洗后比", () => {
    expect(isUserEcho(local("", { attachments: [img("blob:a")] }), "", [img("/api/v1/attachments/api_1_image.png")])).toBe(true);
    expect(isUserEcho(local("", { attachments: [img("blob:a", "截图 1.png")] }), "", [img("/api/v1/attachments/api_1___1.png", "___1.png")])).toBe(true);
  });

  test("审查 P2-3：别的设备连发的第二张纯图（地址不同）不能被当成第一张的回声吞掉", () => {
    const first = { ...histUser(1, ""), attachments: [img("/api/v1/attachments/api_1_image.png")] };
    expect(isUserEcho(first, "", [img("/api/v1/attachments/api_2_image.png")])).toBe(false);
    expect(isUserEcho(first, "", [img("/api/v1/attachments/api_1_image.png")])).toBe(true);
  });

  test("有正文按正文比（含注入头无关比对）；纯图不会和有字的气泡配", () => {
    expect(isUserEcho(histUser(1, "[🌐 来自 Web 端用户「x」]\n\n你好"), "你好")).toBe(true);
    expect(isUserEcho(histUser(1, "你好"), "", [img("/api/v1/attachments/api_1_image.png")])).toBe(false);
    expect(isUserEcho(histAsst(1, "你好"), "你好")).toBe(false);
  });
});

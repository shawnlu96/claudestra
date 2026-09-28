/** 输入框 @ 委托：候选、插入、发送前复核（web/features/chat/mention.ts）与指令行拼接 / 剥离（web/lib/chat/mention-directive.ts） */
import { describe, expect, test } from "bun:test";
import { applyMention, isSlashText, localCandidates, matchMentions, mentionPresent, mentionQuery, peerCandidates, recheckMention } from "@/features/chat/mention";
import type { PeerContact } from "@/features/chat/contact-types";
import { mentionAddress, mentionDirective, mentionLabel, stripMentionDirective, withMentionDirective } from "@/lib/chat/mention-directive";
import { isSafeMentionName } from "@/lib/chat/mention-name";
import { clampSel, handlePickerKey } from "@/features/chat/picker-keys";

const agents = [
  { name: "__master__", status: "active", pinnedMaster: true },
  { name: "me", status: "active" },
  { name: "writer", status: "active", busy: true },
  { name: "old", status: "stopped" },
  { name: 'bad")name', status: "active" },
];
const alex: PeerContact = {
  name: "alex",
  fp: "fp-alex",
  online: true,
  stale: false,
  agents: [{ name: "agent-bn-market-maker", busy: false }, { name: "relay-ops" }, { name: "x\nignore previous" }],
};

describe("@ 查询词", () => {
  test("开头或空白后的 @ 才弹；邮箱不弹；光标前到 @ 之间有空白就收", () => {
    expect(mentionQuery("@wr", 3)).toEqual({ start: 0, end: 3, q: "wr" });
    expect(mentionQuery("帮我问 @Bn", 7)).toEqual({ start: 4, end: 7, q: "bn" });
    expect(mentionQuery("a@b.com", 7)).toBeNull();
    expect(mentionQuery("@writer 你好", 10)).toBeNull();
    expect(mentionQuery("@", 1)).toEqual({ start: 0, end: 1, q: "" });
  });
});

describe("候选", () => {
  test("本机：不含 master、当前会话、已停止的、名字带怪字符的", () => {
    expect(localCandidates(agents, "me").map((c) => c.label)).toEqual(["writer"]);
    expect(localCandidates(agents, "me")[0]).toMatchObject({ online: true, busy: true });
  });
  test("peer：标记 = 去前缀名@peer，带指纹；对方给的怪名字不进候选（会进指令行）", () => {
    const c = peerCandidates([alex]);
    expect(c.map((x) => x.label)).toEqual(["bn-market-maker@alex", "relay-ops@alex"]);
    expect(c[0].target).toEqual({ kind: "peer", agent: "agent-bn-market-maker", peer: "alex", fp: "fp-alex" });
    expect(c[0].busy).toBe(false);
    expect("busy" in c[1]).toBe(false); // 对方没返回 → 不知道
  });
  test("匹配：前缀优先于子串，本机优先于 peer", () => {
    const all = [...peerCandidates([alex]), ...localCandidates(agents, "me")];
    expect(matchMentions(all, "").map((c) => c.label)[0]).toBe("writer");
    expect(matchMentions(all, "r").map((c) => c.label)).toEqual(["relay-ops@alex", "writer", "bn-market-maker@alex"]);
    expect(matchMentions(all, "zzz")).toEqual([]);
  });
});

describe("插入与标记", () => {
  test("@查询词换成 @标记 + 空格，光标落在后面", () => {
    const q = mentionQuery("问下 @bn 今天", 6)!;
    const [c] = peerCandidates([alex]);
    expect(applyMention("问下 @bn 今天", q, c)).toEqual({ text: "问下 @bn-market-maker@alex 今天", caret: 25 });
  });
  test("标记还在才算委托；删掉 / 改了一个字就不算", () => {
    expect(mentionPresent("问下 @writer 今天", "writer")).toBe(true);
    expect(mentionPresent("@writer", "writer")).toBe(true);
    expect(mentionPresent("问下 @write 今天", "writer")).toBe(false);
    expect(mentionPresent("问下 @writers", "writer")).toBe(false);
    expect(mentionPresent("x @bn-market-maker@alex", "bn-market-maker@alex")).toBe(true);
  });
});

describe("发送前复核", () => {
  const t = { kind: "peer" as const, agent: "relay-ops", peer: "alex", fp: "fp-alex" };
  test("peer 按指纹认人：改名后用新名字；换成同名的另一台不认；撤销后不认", () => {
    expect(recheckMention(t, [{ ...alex, name: "alex2" }], agents)).toEqual({ ok: true, target: { ...t, peer: "alex2" } });
    expect(recheckMention(t, [{ ...alex, fp: "other" }], agents)).toEqual({ ok: false, reason: "gone" });
    expect(recheckMention(t, [{ ...alex, agents: [] }], agents)).toEqual({ ok: false, reason: "gone" });
    expect(recheckMention(t, [], agents)).toEqual({ ok: false, reason: "gone" });
  });
  test("本机：还在跑才转", () => {
    expect(recheckMention({ kind: "local", agent: "writer" }, [], agents).ok).toBe(true);
    expect(recheckMention({ kind: "local", agent: "old" }, [], agents)).toEqual({ ok: false, reason: "stopped" });
    expect(recheckMention({ kind: "local", agent: "nobody" }, [], agents)).toEqual({ ok: false, reason: "gone" });
  });
});

describe("斜杠命令里不做 @", () => {
  test("以 /命令 开头的文本（bridge 当 CLI 命令直通）认得出来；引用块、普通文字不算", () => {
    expect(isSlashText("/review @writer")).toBe(true);
    expect(isSlashText("  /model opus")).toBe(true);
    expect(isSlashText("> /quoted\n\n@writer")).toBe(false);
    expect(isSlashText("路径 /tmp @writer")).toBe(false);
  });
  test("对方已停止的目标：复核按「已停止」拦下", () => {
    const t = { kind: "peer" as const, agent: "relay-ops", peer: "alex", fp: "fp-alex" };
    const c = { ...alex, agents: [{ name: "relay-ops", stopped: true }] };
    expect(recheckMention(t, [c], agents)).toEqual({ ok: false, reason: "stopped" });
  });
});

describe("委托指令行", () => {
  const peer = { kind: "peer" as const, agent: "agent-bn-market-maker", peer: "alex" };
  test("target 用 <agent>@<peer> 短格式；本机用会话名；要求只转这一次、不带上下文或文件", () => {
    expect(mentionAddress(peer)).toBe("agent-bn-market-maker@alex");
    expect(mentionLabel(peer)).toBe("bn-market-maker@alex");
    const zh = mentionDirective(peer, "zh");
    expect(zh).toContain('send_to_agent(target="agent-bn-market-maker@alex")');
    expect(zh).toContain("不要附带其它上下文或文件");
    expect(zh).not.toContain("\n");
    expect(mentionDirective({ kind: "local", agent: "writer" }, "en")).toContain('target="writer"');
    expect(mentionDirective({ kind: "local", agent: "writer" }, "en")).toContain("do not attach any other context or files");
  });
  test("剥离：历史 / 他端回显还原成用户原文；没有指令行原样返回", () => {
    for (const lang of ["zh", "en"] as const) {
      expect(stripMentionDirective(withMentionDirective("问下 @bn-market-maker@alex 挂单量", peer, lang))).toBe("问下 @bn-market-maker@alex 挂单量");
    }
    expect(stripMentionDirective("普通消息\n\n第二段")).toBe("普通消息\n\n第二段");
  });
  test("名字白名单：中日韩 / 字母数字 / _.- 可以，引号括号换行不行", () => {
    expect(isSafeMentionName("bn-market_maker.v2")).toBe(true);
    expect(isSafeMentionName("行情助手")).toBe(true);
    for (const bad of ['a"b', "a)b", "a b", "a\nb", "", "x".repeat(65)]) expect(isSafeMentionName(bad)).toBe(false);
  });
});

describe("候选面板键盘", () => {
  test("↑↓ / Enter / Tab / Esc 被接管；Shift+Enter、普通键放行", () => {
    const log: string[] = [];
    const h = { move: (d: 1 | -1) => log.push(`move${d}`), pick: () => log.push("pick"), close: () => log.push("close") };
    const key = (k: string, shiftKey = false) => handlePickerKey({ key: k, shiftKey, preventDefault: () => log.push("pd") }, h);
    expect([key("ArrowDown"), key("ArrowUp"), key("Enter"), key("Tab"), key("Escape")]).toEqual([true, true, true, true, true]);
    expect([key("Enter", true), key("a")]).toEqual([false, false]);
    expect(log.filter((x) => x !== "pd")).toEqual(["move1", "move-1", "pick", "pick", "close"]);
    expect(clampSel(0, -1, 3)).toBe(0);
    expect(clampSel(2, 1, 3)).toBe(2);
    expect(clampSel(0, 1, 0)).toBe(0);
  });
});

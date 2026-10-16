import { describe, expect, test } from "bun:test";
import { createTuiScreen } from "../src/lib/acp/tui/screen.ts";
import { stripSgr } from "../src/lib/acp/tui/text.ts";
import { transcriptOfEntry, transcriptOfInbound } from "../src/lib/acp/transcript.ts";
import { foldsOf, type TurnState } from "../src/lib/acp/tty-status.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { termText } from "./helpers/acp-tty-term.ts";
import { CONFIG, playSession } from "./helpers/acp-tui-session.ts";

// ACP 终端新视图：定稿写一行进一行滚动记录、底栏擦掉重画；同一串标准事件不管哪个 harness 来，画出来逐字一样

const IDLE: TurnState = { busy: false, queued: 0, permissions: 0 };
const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv";

function screen(cols = 80, opts: { input?: string; rows?: number } = {}) {
  const st = { state: { ...IDLE }, now: 0, cols, out: "", writes: [] as string[], input: opts.input };
  const s = createTuiScreen({ write: (x) => void ((st.out += x), st.writes.push(x)), columns: () => st.cols, rows: () => opts.rows ?? 60 },
    () => st.state, () => st.now, opts.input === undefined ? undefined : () => ({ text: st.input ?? "", permission: null }));
  return { st, s, view: () => termText(st.out).split("\n") };
}

/** 整轮会话照宿主顺序喂进去，返回屏幕上的行 */
function session(cols: number, from: "claudestra-meta" | "compaction-update" = "claudestra-meta") {
  const r = screen(cols, { input: "" });
  playSession(r.s, { from });
  return r.view();
}

describe("整轮会话", () => {
  test("52 列（手机网页终端）：每种元素都在、没有一行超宽", () => {
    const lines = session(52);
    expect(lines.every((l) => Bun.stringWidth(l) <= 51)).toBe(true);
    const text = lines.join("\n");
    for (const want of ["┃ owner · 21:03", "● 计划 · 1/3", "  ▸ 跑测试", "✓ Read(lease-sync.ts)", "✗ Bash(bun test tests/lease.test.ts)",
      "  ⎿ ✗ （共 14 行，末尾 4 行）", "╭─ ⏸ 需要审批", "│ [3] 拒绝", "● 结论", "  • 第一处：lease-sync.ts 的比较", "  │ 引用：审查意见原文",
      "  ╭─ ts", "  lease-sync.ts │ 比较参数 │ 低", "── 已打断 · 21:03:10", "── 回合结束 · 21:03:11"]) expect(text).toContain(want);
    expect(lines.at(-1)).toBe("● 空闲 · 上下文 46% · gpt-5.1-codex · high"); // 窄屏上下文只留百分比，换来多放模型和 effort
    expect(lines.slice(-4, -1)).toEqual(["─".repeat(51), "❯  ", "─".repeat(51)]);
  });

  test("120 列：同一份内容，长行不折", () => {
    const lines = session(120);
    expect(lines.every((l) => Bun.stringWidth(l) <= 119)).toBe(true);
    expect(lines).toContain("  ⎿ src/lib/lease-sync.ts | 4 ++--");
  });

  test("与 harness 无关：同一串事件，按 Pi 和 Codex 的翻译配置喂，输出逐字相同（含颜色）", () => {
    const a = screen(52, { input: "" }), b = screen(52, { input: "" });
    playSession(a.s, { from: "claudestra-meta" });
    playSession(b.s, { from: "compaction-update" });
    expect(a.st.out).toBe(b.st.out);
  });
});

describe("流式与重画", () => {
  test("正文边收边显示；画过的定稿行之后不再动（只擦底栏）", () => {
    const { st, s, view } = screen(60, { input: "" });
    const t = createAcpTranslator(() => "T");
    const committed: string[][] = [];
    for (const text of ["# 标题\n第一", "段\n- 列", "表\n", "```\ncode\n", "```\n结尾"]) {
      const u = { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text } };
      for (const e of t.push(u)) for (const i of transcriptOfEntry(e)) s.show(i);
      s.update(u);
      committed.push(view().slice(0, -4)); // 底栏 = 输入框三行 + 状态栏
    }
    for (const e of t.flush()) for (const i of transcriptOfEntry(e)) s.show(i);
    committed.push(view().slice(0, -4));
    committed.reduce((prev, cur) => (expect(cur.slice(0, prev.length)).toEqual(prev), cur));
    expect(committed.at(-1)).toEqual(["● 标题", "  第一段", "  • 列表", "  ╭─", "  │ code", "  ╰─", "  结尾"]);
    for (const w of st.writes) expect(w.split("\x1b[1A").length - 1).toBeLessThanOrEqual(3); // 每次只往上擦底栏（4 行），够不着定稿
  });

  test("工具在跑时只在底栏（计时原地走），结束后带结果落进滚动记录一次", () => {
    const { st, s, view } = screen(60);
    st.state = { busy: true, queued: 0, permissions: 0 };
    s.show("● Bash(sleep 3)");
    s.update({ sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", status: "in_progress" });
    expect(view()).toEqual(["◐ Bash(sleep 3) · 0s", "✻ 思考中… 0s · Esc 打断"]);
    st.now = 2_000;
    s.tick();
    expect(view()).toEqual(["◑ Bash(sleep 3) · 2s", "✻ 思考中… 2s · Esc 打断"]);
    s.show("  ⎿ 无输出");
    s.update({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" });
    expect(view()).toEqual(["✓ Bash(sleep 3)", "  ⎿ 无输出", "✻ 思考中… 2s · Esc 打断"]);
  });

  test("思考只在底栏预览，正文一来就收起", () => {
    const { s, view } = screen(60);
    s.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一想\n" } });
    expect(view()).toEqual(["✻ 想一想", "● 空闲"]);
    s.update({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "好\n下" } });
    expect(view()).toEqual(["● 好", "● 空闲"]);
  });

  test("变窄：底栏每一折都擦掉（照 tmux 的折法算），再按新宽度画", () => {
    const { st, s, view } = screen(60, { input: "你好".repeat(10) });
    s.config(CONFIG);
    const old = view().slice(-4); // 输入框三行 + 状态栏
    st.cols = 20;
    const mark = st.out.length;
    s.resize();
    const up = old.length - 1 + old.reduce((n, l) => n + foldsOf(l, 20), 0);
    const out = st.out.slice(mark);
    expect(out.startsWith(`\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(up)}`)).toBe(true);
    expect(out.slice(13 + 8 * up).split("\n").map(stripSgr).every((l) => Bun.stringWidth(l) <= 19)).toBe(true);
  });

  test("空闲时定时器不写任何字节；忙时计时同一秒内不重画", () => {
    const { st, s } = screen(60, { input: "" });
    s.tick();
    const n = st.out.length;
    for (let i = 0; i < 10; i++) s.tick();
    expect(st.out.length).toBe(n);
    st.state = { busy: true, queued: 0, permissions: 0 };
    s.tick();
    const m = st.out.length;
    st.now = 900;
    s.tick();
    expect(st.out.length).toBe(m);
  });

  test("输入框多行：粘贴进来的换行照样分行，最多 6 行（上面注明还有几行）", () => {
    const { s, view } = screen(30, { input: Array.from({ length: 9 }, (_, i) => `行${i}`).join("\n") });
    s.tick();
    expect(view().slice(0, -1)).toEqual(["─".repeat(29), "  … 上面还有 4 行", "  行4", "  行5", "  行6", "  行7", "  行8 ", "─".repeat(29)]);
  });

  test("退出前擦掉底栏、把光标显示回来", () => {
    const { st, s, view } = screen(40);
    s.print("一行");
    s.close();
    expect(st.out.endsWith("\x1b[?25h")).toBe(true);
    expect(view().join("\n").trimEnd()).toBe("一行");
  });
});

describe("脱敏与上限不回退", () => {
  test("正文（流式）、工具失败输出、收到的消息、思考预览里的密钥都打码", () => {
    const { st, s } = screen(80);
    const t = createAcpTranslator(() => "T");
    const feed = (u: object) => {
      for (const e of t.push(u)) for (const i of transcriptOfEntry(e)) s.show(i);
      s.update(u);
    };
    s.show(transcriptOfInbound(`密钥 ${SECRET}`, { user: "owner" }));
    feed({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `用 ${SECRET}\n` } });
    feed({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: `key ${SECRET}\n下一行\n` } });
    feed({ sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", title: `curl -H 'x: ${SECRET}'`, status: "in_progress" });
    feed({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "failed", _meta: { terminal_output_delta: { data: `boom ${SECRET}\n` } } });
    for (const e of t.flush()) for (const i of transcriptOfEntry(e)) s.show(i);
    expect(st.out).not.toContain("AbCdEfGhIjKl");
    expect(st.out).toContain("[redacted]");
  });

  test("思考预览经 update 写到终端的字节里没有明文（行窗口 / 字符窗口 / 分块三种）", () => {
    const VALUE = "Sup3rS3cretValue9";
    for (const gap of ["\n".repeat(5), " ".repeat(4000)]) {
      const { st, s } = screen(80);
      const text = `password=${gap}${VALUE}\n下一步\n`;
      for (const piece of text.match(/[\s\S]{1,5}/g)!) s.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: piece } });
      expect(st.out).not.toContain(VALUE);
      expect(st.out).toContain("✻ 下一步");
    }
  });

  test("超长正文照 transcript.ts 的上限截（200 行），注明原本多少行", () => {
    const { s, view } = screen(80);
    const t = createAcpTranslator(() => "T");
    const u = { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n") } };
    for (const e of t.push(u)) for (const i of transcriptOfEntry(e)) s.show(i);
    s.update(u);
    for (const e of t.flush()) for (const i of transcriptOfEntry(e)) s.show(i);
    const lines = view();
    expect(lines.filter((l) => /^(● |  )l\d+/.test(l)).length).toBe(200);
    expect(lines.join("\n")).toContain("…（共 300 行）");
  });
});

test("一轮 200 条事件的回合：渲染总耗时（证据里记这个数）", () => {
  const { s } = screen(120, { input: "" });
  const t = createAcpTranslator(() => "T");
  const updates = Array.from({ length: 200 }, (_, i) => (i % 10 === 9
    ? { sessionUpdate: "tool_call", toolCallId: `c${i}`, kind: "execute", title: `echo ${i}`, status: "completed" }
    : { sessionUpdate: "agent_message_chunk", messageId: `m${Math.floor(i / 10)}`, content: { type: "text", text: `第 ${i} 段 **粗** \`code\`\n` } }));
  const t0 = performance.now();
  for (const u of updates) {
    for (const e of t.push(u)) for (const i of transcriptOfEntry(e)) s.show(i);
    s.update(u);
  }
  const ms = performance.now() - t0;
  console.log(`[acp-tui] 200 条事件渲染 ${ms.toFixed(1)}ms（每条 ${(ms / 200).toFixed(2)}ms）`);
  expect(ms).toBeLessThan(2_000);
});

/**
 * v2.9+ 会话历史解析单测：jsonl → 中性消息 / 分页 / session 清单合并 / 参数校验
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readSessionHistory,
  listAgentSessions,
  listSubagentFiles,
  isValidSessionId,
  isValidSubagentId,
  unwrapChannelMessage,
} from "../src/lib/session-history.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function writeJsonl(dir: string, name: string, records: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const SAMPLE = [
  { type: "mode", sessionId: SID }, // 非消息条目 → 忽略
  { type: "user", isMeta: true, timestamp: "2026-07-01T00:00:00Z", message: { content: "caveat 元信息" } },
  { type: "user", timestamp: "2026-07-01T00:01:00Z", message: { content: "第一条用户消息" } },
  {
    type: "assistant",
    timestamp: "2026-07-01T00:02:00Z",
    message: {
      model: "claude-fable-5",
      content: [
        { type: "text", text: "我来处理" },
        { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
      ],
    },
  },
  // 纯 tool_result 载荷的 user 条目 → 过滤
  { type: "user", timestamp: "2026-07-01T00:03:00Z", message: { content: [{ type: "tool_result", content: "..." }] } },
  { type: "system", subtype: "compact_boundary", timestamp: "2026-07-01T00:04:00Z" },
  { type: "user", isCompactSummary: true, timestamp: "2026-07-01T00:04:01Z", message: { content: [{ type: "text", text: "压缩摘要全文" }] } },
  { type: "user", timestamp: "2026-07-01T00:05:00Z", message: { content: "第二条用户消息" } },
];

// [fork] channel 入站消息解包（web/API/Discord 用户消息在 jsonl 里是 isMeta + <channel> 包装）
describe("unwrapChannelMessage", () => {
  const wrap = (attrs: string, body: string) => `<channel ${attrs}>\n${body}\n</channel>`;

  test("API 用户消息：剥 wrapper + [🌐 …] header，提取 user 属性", () => {
    const raw = wrap(
      'source="claudestra" chat_id="api:tok_x" user="web-ui" user_id="api:tok_x" api="true"',
      "[🌐 来自 API 用户「web-ui」（外部 token 接入，非 Discord）。\n直接用 reply() 回答到本 chat_id 即可；对方看不到本频道历史。]\n\n帮我修一下渲染"
    );
    expect(unwrapChannelMessage(raw)).toEqual({ text: "帮我修一下渲染", from: "web-ui" });
  });

  test("agent↔agent：剥 [🤖 …] header（header 内含 ] 不截断正文）", () => {
    const raw = wrap(
      'source="claudestra" chat_id="local-x" user="cstra-dev"',
      "[🤖 来自 master 的 inbound 消息（非 FYI）。\n判断一下：[DIRECT] 标记的要处理。]\n\n请检查 [这个] 模块"
    );
    expect(unwrapChannelMessage(raw)).toEqual({ text: "请检查 [这个] 模块", from: "cstra-dev" });
  });

  test("无 header 的 channel 消息原样保留（以 [ 开头的真实输入不误伤）", () => {
    const raw = wrap('chat_id="discord:123" user="tao"', "[临时] 看下这个报错");
    expect(unwrapChannelMessage(raw)).toEqual({ text: "[临时] 看下这个报错", from: "tao" });
  });

  test("非 channel 包装（caveat 等真 meta）返回 null", () => {
    expect(unwrapChannelMessage("Caveat: the messages below were generated…")).toBeNull();
    expect(unwrapChannelMessage("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
  });

  test("readSessionHistory：channel 包装的 isMeta user 进历史，caveat meta 照旧过滤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      { type: "user", isMeta: true, timestamp: "2026-07-01T00:00:00Z", message: { content: "caveat 元信息" } },
      {
        type: "user",
        isMeta: true,
        timestamp: "2026-07-01T00:01:00Z",
        message: { content: '<channel source="claudestra" chat_id="api:tok_x" user="web-ui">\n[🌐 来自 API 用户「web-ui」（外部 token 接入，非 Discord）。\n直接 reply() 即可。]\n\n你好呀\n</channel>' },
      },
      { type: "assistant", timestamp: "2026-07-01T00:02:00Z", message: { content: [{ type: "text", text: "你好" }] } },
    ]);
    const page = await readSessionHistory(p);
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(page.messages[0].text).toBe("你好呀");
    expect(page.messages[0].from).toBe("web-ui");
  });
});

describe("readSessionHistory", () => {
  test("after 差量分页:只回 seq 之后的消息,从头取,hasMore=差量大于一页", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, SAMPLE);
    const full = await readSessionHistory(p, {});
    const anchor = full.messages[1].seq; // assistant 那条
    const delta = await readSessionHistory(p, { after: anchor });
    // 锚点之后的消息 = full 里 seq > anchor 的那些,顺序一致
    const expected = full.messages.filter((m) => m.seq > anchor);
    expect(delta.messages.map((m) => m.seq)).toEqual(expected.map((m) => m.seq));
    expect(delta.hasMore).toBe(false);
    // 锚点 = 最后一条 → 差量为空
    const empty = await readSessionHistory(p, { after: full.messages[full.messages.length - 1].seq });
    expect(empty.messages.length).toBe(0);
    expect(empty.hasMore).toBe(false);
    // limit=1 时差量大于一页 → hasMore=true 且只回紧邻锚点的第一条
    const paged = await readSessionHistory(p, { after: anchor, limit: 1 });
    expect(paged.messages.length).toBe(1);
    expect(paged.messages[0].seq).toBe(expected[0].seq);
    expect(paged.hasMore).toBe(true);
  });

  test("解析：过滤 meta/tool_result，保留 user/assistant/compact 边界与摘要", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, SAMPLE);
    const page = await readSessionHistory(p, { formatToolFn: (n, i) => `${n} ${i?.file_path ?? ""}`.trim() });
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
    const roles = page.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "system", "user", "user"]);
    expect(page.messages[1].tools?.[0].summary).toBe("Read /a.ts");
    expect(page.messages[1].model).toBe("claude-fable-5");
    expect(page.messages[2].text).toContain("压缩");
    expect(page.messages[3].compactSummary).toBe(true);
    expect(page.messages[4].text).toBe("第二条用户消息");
  });

  test("[fork] reply() tool_use 提取成 replyText（不当工具卡），叙述与回复分开", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      { type: "user", timestamp: "2026-07-01T00:00:00Z", message: { content: "问题" } },
      {
        type: "assistant",
        timestamp: "2026-07-01T00:01:00Z",
        message: {
          content: [
            { type: "text", text: "让我看看" },
            { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
            { type: "tool_use", name: "mcp__claudestra__reply", input: { chat_id: "api:x", text: "**结论**：好了" } },
          ],
        },
      },
    ]);
    const page = await readSessionHistory(p, { formatToolFn: (n) => n });
    const asst = page.messages.find((m) => m.role === "assistant")!;
    expect(asst.text).toBe("让我看看"); // 过程叙述
    expect(asst.replyText).toBe("**结论**：好了"); // reply 正文被提取（否则历史里蒸发）
    expect(asst.tools?.map((t) => t.name)).toEqual(["Read"]); // reply 不再混进工具卡
  });

  test("[fork] TUI 斜杠命令记录 → system 轻条目，stdout 去 ANSI，空输出过滤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      // command-name 开头
      { type: "user", timestamp: "2026-07-01T00:00:00Z", message: { content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-fable-5</command-args>" } },
      // stdout 带 ANSI
      { type: "user", timestamp: "2026-07-01T00:00:01Z", message: { content: "<local-command-stdout>Set model to \x1b[1mFable 5\x1b[22m and saved</local-command-stdout>" } },
      // command-message 开头（顺序颠倒的变体，之前漏网裸渲染）
      { type: "user", timestamp: "2026-07-01T00:00:02Z", message: { content: "<command-message>save-compact</command-message>\n<command-name>/save-compact</command-name>" } },
      // 空 stdout → 整条过滤
      { type: "user", timestamp: "2026-07-01T00:00:03Z", message: { content: "<local-command-stdout>(no content)</local-command-stdout>" } },
      // 队列回放的裸斜杠命令（tmux 注入 /compact 的额外纯文本记录）→ 跳过，
      // 否则与后续 <command-name> 记录渲染成双份
      { type: "user", timestamp: "2026-07-01T00:00:03Z", message: { content: "/compact" } },
      // 真实用户输入不受影响
      { type: "user", timestamp: "2026-07-01T00:00:04Z", message: { content: "正常消息" } },
    ]);
    const page = await readSessionHistory(p);
    expect(page.messages.map((m) => [m.role, m.text])).toEqual([
      ["system", "/model"],
      ["system", "Set model to Fable 5 and saved"],
      ["system", "/save-compact"],
      ["user", "正常消息"],
    ]);
  });

  test("[fork] reply 附带 components 提取进 replyComponents（历史也渲染按钮）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      {
        type: "assistant",
        timestamp: "2026-07-01T00:01:00Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__claudestra__reply",
              input: {
                text: "要发布吗?",
                components: [
                  { type: "buttons", buttons: [
                    { id: "go", label: "✅ 发布", style: "success" },
                    { id: "no", label: "取消" },
                    { bad: "缺 id/label 的按钮被丢弃" },
                  ] },
                  { type: "select", id: "pick", placeholder: "选一个", options: [
                    { label: "A", value: "a", description: "选项A" },
                    { label: "缺 value 被丢弃" },
                  ] },
                  { type: "unknown-row-dropped" },
                ],
              },
            },
          ],
        },
      },
    ]);
    const page = await readSessionHistory(p);
    const asst = page.messages.find((m) => m.role === "assistant")!;
    expect(asst.replyText).toBe("要发布吗?");
    expect(asst.replyComponents).toEqual([
      { type: "buttons", buttons: [
        { id: "go", label: "✅ 发布", style: "success" },
        { id: "no", label: "取消" },
      ] },
      { type: "select", id: "pick", placeholder: "选一个", options: [
        { label: "A", value: "a", description: "选项A" },
      ] },
    ]);
  });

  test("[fork] reply 无 components / components 非数组 → replyComponents 不出现", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      {
        type: "assistant",
        timestamp: "2026-07-01T00:01:00Z",
        message: { content: [{ type: "tool_use", name: "mcp__claudestra__reply", input: { text: "普通回复", components: "坏数据" } }] },
      },
    ]);
    const page = await readSessionHistory(p);
    expect(page.messages[0].replyText).toBe("普通回复");
    expect(page.messages[0].replyComponents).toBeUndefined();
  });

  test("[fork] 纯 reply（无叙述、无其它工具）也保留：text 空 + replyText 有值", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      {
        type: "assistant",
        timestamp: "2026-07-01T00:01:00Z",
        message: { content: [{ type: "tool_use", name: "mcp__claudestra__reply", input: { text: "只有回复" } }] },
      },
    ]);
    const page = await readSessionHistory(p);
    expect(page.messages.length).toBe(1);
    expect(page.messages[0].text).toBe("");
    expect(page.messages[0].replyText).toBe("只有回复");
    expect(page.messages[0].tools).toBeUndefined();
  });

  test("分页：默认取尾部，before 往前翻，hasMore 正确", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, SAMPLE);
    const last2 = await readSessionHistory(p, { limit: 2 });
    expect(last2.messages.length).toBe(2);
    expect(last2.hasMore).toBe(true);
    expect(last2.messages[1].text).toBe("第二条用户消息");
    // 用第一页开头的 seq 往前翻
    const prev = await readSessionHistory(p, { limit: 2, before: last2.messages[0].seq });
    expect(prev.messages.length).toBe(2);
    expect(prev.messages.at(-1)!.seq).toBeLessThan(last2.messages[0].seq);
    // 翻到头
    const first = await readSessionHistory(p, { limit: 100, before: prev.messages[0].seq });
    expect(first.hasMore).toBe(false);
  });
});

describe("listAgentSessions", () => {
  test("归档打底 + live 更大覆盖 + subagents 同构发现", async () => {
    const base = mkdtempSync(join(tmpdir(), "hist-list-"));
    const archiveRoot = join(base, "archive");
    const agentDir = join(archiveRoot, "agent-x");
    mkdirSync(agentDir, { recursive: true });
    writeJsonl(agentDir, `${SID}.jsonl`, SAMPLE.slice(0, 3)); // 归档较小
    const subDir = join(agentDir, SID, "subagents");
    mkdirSync(subDir, { recursive: true });
    writeJsonl(subDir, "agent-sub1.jsonl", [SAMPLE[2]]);

    const liveDir = join(base, "live");
    mkdirSync(liveDir, { recursive: true });
    const livePath = writeJsonl(liveDir, `${SID}.jsonl`, SAMPLE); // live 更大

    const sessions = await listAgentSessions("agent-x", {
      cwd: "/whatever",
      archiveRoot,
      livePathFor: (_cwd, sid) => join(liveDir, `${sid}.jsonl`),
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].source).toBe("live");
    expect(sessions[0].path).toBe(livePath);

    // live 没有 subagents 目录 → 空；归档侧的要从归档路径读
    expect(sessions[0].subagents).toEqual([]);
    expect(listSubagentFiles(join(agentDir, `${SID}.jsonl`))).toEqual(["agent-sub1"]);
  });

  test("无 cwd（agent 已 kill）只列归档；current session 无归档也可见", async () => {
    const base = mkdtempSync(join(tmpdir(), "hist-list-"));
    const archiveRoot = join(base, "archive");
    const agentDir = join(archiveRoot, "agent-x");
    mkdirSync(agentDir, { recursive: true });
    writeJsonl(agentDir, `${SID}.jsonl`, SAMPLE.slice(0, 3));

    const archOnly = await listAgentSessions("agent-x", { archiveRoot });
    expect(archOnly.length).toBe(1);
    expect(archOnly[0].source).toBe("archive");

    // current session 只有 live 文件（还没归档过）
    const liveDir = join(base, "live");
    mkdirSync(liveDir, { recursive: true });
    const curSid = "11111111-2222-3333-4444-555555555555";
    writeJsonl(liveDir, `${curSid}.jsonl`, SAMPLE);
    const both = await listAgentSessions("agent-x", {
      cwd: "/whatever",
      currentSessionId: curSid,
      archiveRoot,
      livePathFor: (_cwd, sid) => join(liveDir, `${sid}.jsonl`),
    });
    expect(both.length).toBe(2);
    expect(both.find((s) => s.sessionId === curSid)?.source).toBe("live");
  });
});

describe("参数校验（拼路径前的白名单）", () => {
  test("sessionId：uuid 形态过，路径穿越不过", () => {
    expect(isValidSessionId(SID)).toBe(true);
    expect(isValidSessionId("../../etc/passwd")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });
  test("subagent id：agent-xxx 过，其他不过", () => {
    expect(isValidSubagentId("agent-a1B_-x")).toBe(true);
    expect(isValidSubagentId("agent-../x")).toBe(false);
    expect(isValidSubagentId("nope")).toBe(false);
  });
});

// [fork] 聊天记录全文搜索（跨会话搜索端点的解析层）
describe("searchSessionHistory", () => {
  const { searchSessionHistory } = require("../src/lib/session-history.js");
  const dir = mkdtempSync(join(tmpdir(), "cstra-search-"));
  const file = writeJsonl(dir, "s.jsonl", [
    { type: "user", timestamp: "2026-07-01T00:01:00Z", message: { content: "我们聊过火山引擎的流式 ASR 方案" } },
    {
      type: "assistant",
      timestamp: "2026-07-01T00:02:00Z",
      message: {
        content: [
          { type: "text", text: "好的，火山引擎的 key 到了我就接" },
          { type: "tool_use", name: "Bash", input: { command: "echo 火山引擎" } },
        ],
      },
    },
    // reply 正文可搜
    {
      type: "assistant",
      timestamp: "2026-07-01T00:03:00Z",
      message: { content: [{ type: "tool_use", name: "mcp__claudestra__reply", input: { text: "ASR 用火山引擎，等 key" } }] },
    },
    // channel 包装的入站消息:解包后搜
    {
      type: "user",
      isMeta: true,
      timestamp: "2026-07-01T00:04:00Z",
      message: { content: '<channel source="claudestra" chat_id="api:x" user="web-ui">\n记得处理火山引擎的事\n</channel>' },
    },
    // compact 摘要:可搜且打标
    { type: "user", isCompactSummary: true, timestamp: "2026-07-01T00:05:00Z", message: { content: [{ type: "text", text: "早前讨论过火山引擎接入,还没做" }] } },
    // 机器产物不搜:命令记录 / task-notification
    { type: "user", timestamp: "2026-07-01T00:06:00Z", message: { content: "<command-name>/compact</command-name><command-message>火山引擎</command-message>" } },
  ]);

  test("正文命中:user/assistant/reply/channel 解包/compact 摘要", async () => {
    const hits = await searchSessionHistory(file, "火山引擎");
    expect(hits.length).toBe(5);
    expect(hits[0].role).toBe("user");
    expect(hits.find((h: any) => h.from === "web-ui")).toBeTruthy();
    expect(hits.find((h: any) => h.compact === true)).toBeTruthy();
  });

  test("大文件尾部切片时 seq 仍是全文件行号(搜索跳转坐标系)", async () => {
    // 100 条填充 + 尾部 1 条命中;maxFullScanBytes 压小强制切片
    const records = Array.from({ length: 100 }, (_, i) => ({
      type: "user" as const,
      timestamp: "2026-07-01T00:00:00Z",
      message: { content: `填充消息第 ${i} 号,凑体积用的一行普通对话内容` },
    }));
    records.push({
      type: "user",
      timestamp: "2026-07-01T01:00:00Z",
      message: { content: "切片行号校准专用命中词" },
    });
    const big = writeJsonl(dir, "sliced.jsonl", records);
    const full = await searchSessionHistory(big, "切片行号校准");
    expect(full.length).toBe(1);
    expect(full[0].seq).toBe(100); // 全文件行号
    // 切到只剩尾部 ~2KB:不切片行号会从切片起点重数、远小于 100
    const sliced = await searchSessionHistory(big, "切片行号校准", { maxFullScanBytes: 2048 });
    expect(sliced.length).toBe(1);
    expect(sliced[0].seq).toBe(100); // 与全量扫描同坐标
  });

  test("大小写不敏感 + 只搜正文(工具参数命中不算)", async () => {
    const hits = await searchSessionHistory(file, "asr");
    expect(hits.length).toBe(2); // user 首条 + reply 正文
    const cmd = await searchSessionHistory(file, "echo 火山");
    expect(cmd.length).toBe(0); // 只在 Bash input 里出现 → 不算命中
  });

  test("snippet 命中词居中 + maxHits 截断", async () => {
    const long = writeJsonl(dir, "long.jsonl", [
      { type: "user", timestamp: "2026-07-01T00:01:00Z", message: { content: "x".repeat(500) + "独特关键词" + "y".repeat(500) } },
    ]);
    const [hit] = await searchSessionHistory(long, "独特关键词");
    expect(hit.snippet).toContain("独特关键词");
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(true);
    const capped = await searchSessionHistory(file, "火山引擎", { maxHits: 2 });
    expect(capped.length).toBe(2);
  });

  test("无命中/短查询返回空", async () => {
    expect(await searchSessionHistory(file, "不存在的词")).toEqual([]);
    expect(await searchSessionHistory(file, "")).toEqual([]);
  });
});

// ── 大文件尾读(2026-08-23 perf 根因:全文读 232MB 同步阻塞主线程→502) ─────────
// 用 maxFullReadBytes 逼小 fixture 走尾读路径,断言与全读逐条一致(seq/内容/顺序)。
describe("readSessionHistory 尾读路径(maxFullReadBytes)", () => {
  // 造一段够多行的会话:交替 user/assistant,再掺入会被过滤的 tool_result 大行
  function bigSession(dir: string): string {
    const recs: unknown[] = [];
    for (let k = 0; k < 200; k++) {
      recs.push({ type: "user", timestamp: `2026-07-01T00:00:${String(k).padStart(2, "0")}Z`, message: { content: `用户消息 ${k}` } });
      recs.push({
        type: "assistant",
        timestamp: `2026-07-01T00:01:${String(k).padStart(2, "0")}Z`,
        message: { model: "claude-opus-5", content: [{ type: "text", text: `助手回复 ${k}` }] },
      });
      // 掺一条巨大的 tool_result 载荷行(会被过滤,不产出消息)——模拟真实 jsonl 里
      // 尾部可能被大行占据,考验「窗口里可显示消息不够就加宽」
      recs.push({ type: "user", timestamp: `2026-07-01T00:02:${String(k).padStart(2, "0")}Z`, message: { content: [{ type: "tool_result", content: "x".repeat(500) }] } });
    }
    return writeJsonl(dir, `${SID}.jsonl`, recs);
  }

  test("默认页:尾读与全读拿到同一批尾部消息(seq+文本一致)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cstra-tail-"));
    const p = bigSession(dir);
    const full = await readSessionHistory(p, { limit: 50, maxFullReadBytes: 1 << 30 });
    const tail = await readSessionHistory(p, { limit: 50, maxFullReadBytes: 4096 }); // 逼尾读
    expect(tail.messages.map((m) => [m.seq, m.text])).toEqual(full.messages.map((m) => [m.seq, m.text]));
    expect(tail.messages.length).toBe(50);
    expect(tail.hasMore).toBe(true); // 尾读未到文件头 → 前面还有更早
  });

  test("差量 after=:尾读只回 seq>after,与全读一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cstra-tail-"));
    const p = bigSession(dir);
    const full0 = await readSessionHistory(p, { limit: 500, maxFullReadBytes: 1 << 30 });
    const anchor = full0.messages[full0.messages.length - 6].seq; // 靠尾部的一个锚
    const full = await readSessionHistory(p, { after: anchor, limit: 500, maxFullReadBytes: 1 << 30 });
    const tail = await readSessionHistory(p, { after: anchor, limit: 500, maxFullReadBytes: 4096 });
    expect(tail.messages.map((m) => m.seq)).toEqual(full.messages.map((m) => m.seq));
    expect(tail.messages.every((m) => m.seq > anchor)).toBe(true);
  });

  test("差量锚点较老:窗口自动加宽回读到锚点,集合仍完整", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cstra-tail-"));
    const p = bigSession(dir);
    const full0 = await readSessionHistory(p, { limit: 5000, maxFullReadBytes: 1 << 30 });
    const anchor = full0.messages[10].seq; // 很靠前的锚 → 差量很大,需加宽
    const full = await readSessionHistory(p, { after: anchor, limit: 5000, maxFullReadBytes: 1 << 30 });
    const tail = await readSessionHistory(p, { after: anchor, limit: 5000, maxFullReadBytes: 4096 });
    expect(tail.messages.map((m) => m.seq)).toEqual(full.messages.map((m) => m.seq));
  });

  test("before= 往回翻页:尾读与全读同一页", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cstra-tail-"));
    const p = bigSession(dir);
    const full0 = await readSessionHistory(p, { limit: 5000, maxFullReadBytes: 1 << 30 });
    const cursor = full0.messages[full0.messages.length - 20].seq;
    const full = await readSessionHistory(p, { before: cursor, limit: 10, maxFullReadBytes: 1 << 30 });
    const tail = await readSessionHistory(p, { before: cursor, limit: 10, maxFullReadBytes: 4096 });
    expect(tail.messages.map((m) => [m.seq, m.text])).toEqual(full.messages.map((m) => [m.seq, m.text]));
    expect(tail.messages.every((m) => m.seq < cursor)).toBe(true);
    expect(tail.messages.length).toBe(10);
  });

  test("尾读读到文件头(窗口≥文件)时 hasMore 与全读一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cstra-tail-"));
    // 小会话:即便阈值=1,加宽到 cut=0 就读全,应与全读完全一致
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      { type: "user", timestamp: "2026-07-01T00:00:00Z", message: { content: "只有一条" } },
    ]);
    const full = await readSessionHistory(p, { limit: 50, maxFullReadBytes: 1 << 30 });
    const tail = await readSessionHistory(p, { limit: 50, maxFullReadBytes: 1 });
    expect(tail.messages.map((m) => [m.seq, m.text])).toEqual(full.messages.map((m) => [m.seq, m.text]));
    expect(tail.hasMore).toBe(false);
  });
});

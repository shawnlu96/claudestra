/**
 * hardening-JFORMAT：formatTool / formatToolDetail 从 bridge/jsonl-watcher.ts 抽到 lib/tool-display-format.ts 的等价性。
 *
 * 固定基线 oracle（捕获 manifest）：
 *   - 来源：base 提交 3d1ea9c81da7e2c1e22b7e768213e06110c21762，src/bridge/jsonl-watcher.ts blob 97c5c942c386d8bcd74a2cd46c3ba1d064605680（抽出前）
 *   - 方法：本文件的 CASES + 捕获 helper 原样拼成一次性 bun test，在 base 提交的 git archive 快照上跑（env -i、bun --no-env-file、临时 HOME/TMP/STATE/RUNTIME、
 *     BRIDGE_URL 指向拒连端口），三个入口各取一遍：直接调用旧导出、readSessionHistory 传 formatToolFn/toolDetailFn（api-routes 的接法）、
 *     startWatching 尾读合成 JSONL 收 tool_start 事件；结果即下面的 BASELINE（未经手改）
 *   - BASELINE 本身钉 sha256（BASELINE_SHA256），被改动即红；缺用例 / 入口没出卡数少于捕获时都直接失败，不 skip
 *   - 输出编码：≤48 字节（utf-8）逐字存，更长的存 utf-8 字节 sha256 前 128 位 + 字节数（同样逐字节）
 * 限制：watcher 入口只覆盖 claude-code 运行时的尾读路径与默认 MCP_NAME（claudestra）；被 isHiddenTool 隐藏的工具与写不进 JSONL /
 * 旧实现会抛的用例只在直接调用层比对；bg-activity-watcher 只经 re-export 同一函数对象覆盖，未单独跑它的尾读。
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "../src/lib/tool-display-format.ts";
import * as w from "../src/bridge/jsonl-watcher.ts";
import * as bus from "../src/bridge/event-bus.ts";
import * as sessionPaths from "../src/lib/session-path-resolve.ts";
import { MCP_TOOL_PREFIX } from "../src/bridge/config.ts";
import { readSessionHistory } from "../src/lib/session-history.ts";

// ── 合成用例（与基线捕获脚本共用同一份源码：捕获时原样拼进本文件） ──
// json=true：入参能写进 JSONL，并且旧实现不抛——同一份用例还要过真实历史读取 / watcher 工具事件入口
interface Case { id: string; name: string; input: () => any; json: boolean }

const LONG = "0123456789".repeat(450); // 4500 字符，越过 4k 截断
const circular = () => { const o: any = { a: 1 }; o.self = o; return o; };
const CASES: Case[] = [
  // Read / Edit / Write：取 basename；空值
  { id: "read-path", name: "Read", input: () => ({ file_path: "/repo/src/a.ts", offset: 0, limit: 20 }), json: true },
  { id: "read-empty", name: "Read", input: () => ({}), json: true },
  { id: "read-trailing-slash", name: "Read", input: () => ({ file_path: "/repo/dir/" }), json: true },
  { id: "read-undefined", name: "Read", input: () => undefined, json: false },
  { id: "read-null-offset", name: "Read", input: () => ({ file_path: "/x.ts", offset: null, limit: 5 }), json: true },
  { id: "read-nonstring-path", name: "Read", input: () => ({ file_path: 42 }), json: false },
  { id: "edit-full", name: "Edit", input: () => ({ file_path: "/r/b.ts", old_string: "foo\n", new_string: "bar\n" }), json: true },
  { id: "edit-missing", name: "Edit", input: () => ({ file_path: "/r/b.ts" }), json: true },
  { id: "edit-null-input", name: "Edit", input: () => null, json: true },
  { id: "write-content", name: "Write", input: () => ({ file_path: "/r/c.md", content: "  hello\n世界  " }), json: true },
  { id: "write-long", name: "Write", input: () => ({ file_path: "/r/big.txt", content: LONG }), json: true },
  // Bash：有/无 description、多行、&&、200 截断
  { id: "bash-desc", name: "Bash", input: () => ({ description: "Run tests", command: "cd x &&\nbun test" }), json: true },
  { id: "bash-desc-long", name: "Bash", input: () => ({ description: "Long", command: "echo " + "a".repeat(300) }), json: true },
  { id: "bash-nodesc", name: "Bash", input: () => ({ command: "  git status && git diff\nsecond line" }), json: true },
  { id: "bash-empty", name: "Bash", input: () => ({}), json: true },
  { id: "bash-desc-nocmd", name: "Bash", input: () => ({ description: "only desc" }), json: true },
  { id: "bash-desc-numcmd", name: "Bash", input: () => ({ description: "d", command: 7 }), json: false },
  { id: "bash-secret", name: "Bash", input: () => ({ command: "curl -H 'Authorization: Bearer FIXTURE_TOKEN' http://127.0.0.1:1/" }), json: true },
  // Glob / Grep
  { id: "glob", name: "Glob", input: () => ({ pattern: "**/*.ts" }), json: true },
  { id: "glob-empty", name: "Glob", input: () => ({}), json: true },
  { id: "grep", name: "Grep", input: () => ({ pattern: "foo|bar", path: "/r" }), json: true },
  // 任务清单
  { id: "task-create", name: "TaskCreate", input: () => ({ subject: "做一件事".repeat(30) }), json: true },
  { id: "task-create-empty", name: "TaskCreate", input: () => ({}), json: true },
  { id: "task-update", name: "TaskUpdate", input: () => ({ taskId: 3, status: "completed" }), json: true },
  { id: "task-update-zero", name: "TaskUpdate", input: () => ({ taskId: 0 }), json: true },
  { id: "task-update-none", name: "TaskUpdate", input: () => ({}), json: true },
  // send_to_agent：裸名 / MCP 名
  { id: "send-bare", name: "send_to_agent", input: () => ({ target: "agent-b", text: "line1\nline2", expecting: "reply" }), json: true },
  { id: "send-mcp", name: "mcp__claudestra__send_to_agent", input: () => ({ target: "agent-b", text: "  body\n多行  ", expecting: "ack" }), json: true },
  { id: "send-mcp-long", name: "mcp__claudestra__send_to_agent", input: () => ({ target: "agent-b", text: LONG }), json: true },
  { id: "send-mcp-empty", name: "mcp__claudestra__send_to_agent", input: () => ({}), json: true },
  { id: "send-mcp-notarget", name: "mcp__x__send_to_agent", input: () => ({ text: "hi" }), json: true },
  // 非 claudestra 前缀的 MCP 名：watcher 不隐藏，直播入口也能比对到
  { id: "send-peer-mcp", name: "mcp__peer__send_to_agent", input: () => ({ target: "agent-d", text: "hello\nworld", expecting: "x" }), json: true },
  { id: "fwd-peer-mcp", name: "mcp__peer__forward_to_agent", input: () => ({ target: "agent-d", reason: "r" }), json: true },
  // forward：裸名 / MCP 名 / 非 mcp 前缀不算
  { id: "fwd-bare", name: "forward_to_agent", input: () => ({ target: "agent-c", reason: "发错了" }), json: true },
  { id: "fwd-mcp", name: "mcp__claudestra__forward_to_agent", input: () => ({ target: "agent-c" }), json: true },
  { id: "fwd-mcp-empty", name: "mcp__claudestra__forward_to_agent", input: () => ({}), json: true },
  { id: "fwd-not-mcp", name: "x__forward_to_agent", input: () => ({ target: "agent-c" }), json: true },
  // Pi 裸名自有工具
  { id: "reply-bare", name: "reply", input: () => ({ text: "hi", chat_id: "1" }), json: true },
  { id: "fetch-bare", name: "fetch_messages", input: () => ({}), json: true },
  { id: "project-info", name: "project_info", input: () => ({}), json: true },
  // MCP 通用 / 未知
  { id: "mcp-generic", name: "mcp__mem0__add_memory", input: () => ({ text: "m", api_key: "FIXTURE_KEY" }), json: true },
  { id: "mcp-three-seg", name: "mcp__a__b__c", input: () => ({ k: [1, { n: null }] }), json: true },
  { id: "unknown", name: "WebSearch", input: () => ({ query: "q" }), json: true },
  { id: "unknown-plain", name: "SomeTool", input: () => ({}), json: true },
  { id: "unknown-undefined", name: "SomeTool", input: () => undefined, json: false },
  { id: "unknown-null", name: "SomeTool", input: () => null, json: true },
  { id: "unknown-string", name: "SomeTool", input: () => "  raw string  ", json: true },
  { id: "unknown-whitespace", name: "SomeTool", input: () => "   ", json: true },
  { id: "unknown-long", name: "SomeTool", input: () => ({ blob: LONG }), json: true },
  { id: "agent", name: "Agent", input: () => ({ subagent_type: "Explore", prompt: "p" }), json: true },
  // 4k 边界：detail 恰 4000 / 4001
  { id: "trunc-4000", name: "Write", input: () => ({ file_path: "", content: "y".repeat(3996) }), json: true },
  { id: "trunc-exact", name: "SomeTool", input: () => "z".repeat(3998), json: true },
  { id: "trunc-plus1", name: "SomeTool", input: () => "z".repeat(3999), json: true },
  { id: "trunc-surrogate", name: "SomeTool", input: () => "😀".repeat(2100), json: true },
  // JSON fallback / 原异常
  { id: "json-circular", name: "SomeTool", input: circular, json: false },
  { id: "json-bigint", name: "SomeTool", input: () => ({ n: 10n }), json: false },
  { id: "json-throw-tostring", name: "SomeTool", json: false, input: () => {
    const o: any = { toJSON() { throw new Error("x"); } };
    o.toString = () => { throw new Error("toString boom"); };
    return o;
  } },
  { id: "json-tojson", name: "SomeTool", input: () => ({ toJSON: () => "custom" }), json: false },
];
// ── 输出编码：≤48 字节逐字存；更长的存 utf-8 字节的 sha256（前 128 位）+ 字节数（同样逐字节）。抛错存 { throws: 编码后的「类名: 消息」 } ──
type Out = string | { throws: string };
const enc = (s: string): string => {
  const n = Buffer.byteLength(s, "utf8");
  return n <= 48 ? s : `sha256:${createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32)}:${n}`;
};
function run(fn: () => string): Out {
  try {
    const r = fn();
    if (typeof r !== "string") return { throws: `non-string:${typeof r}` };
    return enc(r);
  } catch (e) {
    return { throws: enc(`${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`) };
  }
}

/** 直接调用：每个用例的摘要与详情 */
function captureDirect(fmt: (n: string, i: any) => string, detail: (n: string, i: any) => string) {
  const out: Record<string, [Out, Out]> = {};
  for (const c of CASES) out[c.id] = [run(() => fmt(c.name, c.input())), run(() => detail(c.name, c.input()))];
  return out;
}

/** 每个 json 用例一行 assistant tool_use，tool_use id = toolu_<用例 id> */
function fixtureJsonl(): string {
  return CASES.filter((c) => c.json).map((c, i) => JSON.stringify({
    type: "assistant", uuid: `u-${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${c.id}`, name: c.name, input: c.input() }] },
  })).join("\n") + "\n";
}

/** 真实历史读取入口：readSessionHistory 传 formatToolFn / toolDetailFn（api-routes 的接法）。没出工具卡的记 null */
async function captureHistory(
  readSessionHistory: typeof import("../src/lib/session-history.ts").readSessionHistory,
  fmt: (n: string, i: any) => string, detail: (n: string, i: any) => string,
) {
  const dir = mkdtempSync(join(tmpdir(), "tdf-hist-"));
  try {
    const p = join(dir, "00000000-0000-4000-8000-00000000f0a1.jsonl");
    writeFileSync(p, fixtureJsonl());
    const page = await readSessionHistory(p, { limit: 500, formatToolFn: fmt, toolDetailFn: detail });
    const byId = new Map<string, [string, string | null]>();
    for (const m of page.messages) for (const t of m.tools ?? []) {
      if (t.id) byId.set(t.id, [enc(t.summary), t.detail === undefined ? null : enc(t.detail)]);
    }
    const out: Record<string, [string, string | null] | null> = {};
    for (const c of CASES.filter((x) => x.json)) out[c.id] = byId.get(`toolu_${c.id}`) ?? null;
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 真实 watcher 工具事件入口：startWatching 尾读合成 JSONL（local- 频道不碰 Discord），收 tool_start 事件。没发事件的记 null */
async function captureWatcher(
  w: typeof import("../src/bridge/jsonl-watcher.ts"),
  bus: typeof import("../src/bridge/event-bus.ts"),
  sessionPaths: typeof import("../src/lib/session-path-resolve.ts"),
) {
  const dir = mkdtempSync(join(tmpdir(), "tdf-watch-"));
  const sessionFile = join(dir, "session.jsonl");
  const agent = "agent-tool-display-format-fixture";
  const channel = "local-tool-display-format-fixture";
  const discord = {} as Parameters<typeof w.startWatching>[4];
  const resolve = spyOn(sessionPaths, "resolveSessionPath").mockReturnValue(sessionFile);
  const seen = new Map<string, [string, string]>();
  const unsub = bus.subscribeEvents({ agent }, (e) => {
    if (e.type !== "tool_start") return;
    const d = e.data as { toolId: string; summary: string; detail: string };
    seen.set(d.toolId, [enc(d.summary), enc(d.detail)]);
  });
  writeFileSync(sessionFile, "");
  try {
    await w.startWatching(agent, dir, "fixture-session", channel, discord, { runtime: "claude-code" });
    appendFileSync(sessionFile, fixtureJsonl());
    await w.drainChannelWatcher(channel, discord);
  } finally {
    unsub();
    w.stopWatching(agent);
    resolve.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
  const out: Record<string, [string, string] | null> = {};
  for (const c of CASES.filter((x) => x.json)) out[c.id] = seen.get(`toolu_${c.id}`) ?? null;
  return out;
}

// ── 固定基线（base 上旧实现的捕获结果，勿手改；JSON.stringify 后的 sha256 钉在 BASELINE_SHA256） ──
const BASELINE_SHA256 = "1dc753bac5a56361fa2c62c5872bcbe6a74c7cf9a5f27543d11437373a53b4ec";
const BASELINE: Baseline = {
  direct: {
    "read-path": ["📖 Read a.ts","/repo/src/a.ts\noffset=0\nlimit=20"],
    "read-empty": ["📖 Read ",""],
    "read-trailing-slash": ["📖 Read ","/repo/dir/"],
    "read-undefined": ["📖 Read ",""],
    "read-null-offset": ["📖 Read x.ts","/x.ts\nlimit=5"],
    "read-nonstring-path": [{"throws":"sha256:478bc75a666499e501428ae912b54cb7:129"},"42"],
    "edit-full": ["✏️ Edit b.ts","sha256:df39100eb5e06f0d5f353c1608b370e2:64"],
    "edit-missing": ["✏️ Edit b.ts","sha256:3f73e8e4fa065a9a8568114a1bada387:56"],
    "edit-null-input": ["✏️ Edit ","─── old ───\n\n─── new ───"],
    "write-content": ["📝 Write c.md","/r/c.md\n───\n  hello\n世界"],
    "write-long": ["📝 Write big.txt","sha256:bae1bb9727c628ca4cbc63d75c2819b4:4043"],
    "bash-desc": ["💻 Run tests ||cd x && bun test||","Run tests\n───\ncd x &&\nbun test"],
    "bash-desc-long": ["sha256:9d4dd226b153604116e9e7051f865d27:214","sha256:7f3fae903e34deede5610d4ea2062dcd:320"],
    "bash-nodesc": ["💻 git status","git status && git diff\nsecond line"],
    "bash-empty": ["💻 ",""],
    "bash-desc-nocmd": ["💻 only desc ||||","only desc"],
    "bash-desc-numcmd": [{"throws":"sha256:7508af53e6ed92382331bcb70e18ce56:157"},"d\n───\n7"],
    "bash-secret": ["sha256:2c5958d3c37f54b7d49c4670d2c99c88:70","sha256:963c040c1da53718a3dd59a84f339e6a:65"],
    "glob": ["🔍 Glob **/*.ts","{\n  \"pattern\": \"**/*.ts\"\n}"],
    "glob-empty": ["🔍 Glob ","{}"],
    "grep": ["🔎 Grep foo|bar","{\n  \"pattern\": \"foo|bar\",\n  \"path\": \"/r\"\n}"],
    "task-create": ["sha256:abc55fd6dab9e5ecf5de45fb085fbd82:260","sha256:54eff9778322cbf8cbedff05017434dd:379"],
    "task-create-empty": ["🗒️ 新任务：","{}"],
    "task-update": ["🗒️ 任务 #3 → completed","{\n  \"taskId\": 3,\n  \"status\": \"completed\"\n}"],
    "task-update-zero": ["🗒️ 任务 #0","{\n  \"taskId\": 0\n}"],
    "task-update-none": ["🗒️ 任务 #?","{}"],
    "send-bare": ["🤝 send_to_agent → agent-b：line1 line2","sha256:9ea934232fe0d82bf7ba7f6ab7c492e9:75"],
    "send-mcp": ["🤝 send_to_agent → agent-b：body 多行","sha256:eee9a3bd84a5d6967590199ec2963d4b:58"],
    "send-mcp-long": ["sha256:59ed9bf9740e88fcf79424922099f1ba:233","sha256:2bbe447795f5d0f808cb700677670129:4045"],
    "send-mcp-empty": ["🤝 send_to_agent",""],
    "send-mcp-notarget": ["🤝 send_to_agent ：hi","hi"],
    "send-peer-mcp": ["🤝 send_to_agent → agent-d：hello world","sha256:0072c8fcaf49d9434c801843c4aa7a0a:54"],
    "fwd-peer-mcp": ["↪ 转交给 agent-d：r","{\n  \"target\": \"agent-d\",\n  \"reason\": \"r\"\n}"],
    "fwd-bare": ["↪ 转交给 agent-c：发错了","sha256:1c36899727ccd6832089126ff6b782db:50"],
    "fwd-mcp": ["↪ 转交给 agent-c","{\n  \"target\": \"agent-c\"\n}"],
    "fwd-mcp-empty": ["↪ 转交给 ?","{}"],
    "fwd-not-mcp": ["🔧 x__forward_to_agent","{\n  \"target\": \"agent-c\"\n}"],
    "reply-bare": ["💬 回复","{\n  \"text\": \"hi\",\n  \"chat_id\": \"1\"\n}"],
    "fetch-bare": ["📥 取消息","{}"],
    "project-info": ["📁 project 信息","{}"],
    "mcp-generic": ["🔧 mem0/add_memory","{\n  \"text\": \"m\",\n  \"api_key\": \"FIXTURE_KEY\"\n}"],
    "mcp-three-seg": ["🔧 a/b__c","sha256:c3a567912491313051504bba1cdb7361:51"],
    "unknown": ["🌐 WebSearch","{\n  \"query\": \"q\"\n}"],
    "unknown-plain": ["🔧 SomeTool","{}"],
    "unknown-undefined": ["🔧 SomeTool","{}"],
    "unknown-null": ["🔧 SomeTool","{}"],
    "unknown-string": ["🔧 SomeTool","\"  raw string  \""],
    "unknown-whitespace": ["🔧 SomeTool","\"   \""],
    "unknown-long": ["🔧 SomeTool","sha256:8a15bf5fa4717d8068262d3a0f8f0216:4037"],
    "agent": ["🤖 Agent","sha256:8d8363d7d0318f54e095e22db49950a1:49"],
    "trunc-4000": ["📝 Write ","sha256:11fad444f9f05945e24b996701a0e6aa:4006"],
    "trunc-exact": ["🔧 SomeTool","sha256:6e1ac6eb3bdbd8df6f3216f876c7b4b4:4000"],
    "trunc-plus1": ["🔧 SomeTool","sha256:72b6dcd482f366f63d7052564d299461:4037"],
    "trunc-surrogate": ["🔧 SomeTool","sha256:9fc160303dcfd5a88e882bd330d6ca52:8036"],
    "json-circular": ["🔧 SomeTool","[object Object]"],
    "json-bigint": ["🔧 SomeTool","[object Object]"],
    "json-throw-tostring": ["🔧 SomeTool",{"throws":"Error: toString boom"}],
    "json-tojson": ["🔧 SomeTool","\"custom\""],
  },
  history: {
    "read-path": ["📖 Read a.ts","/repo/src/a.ts\noffset=0\nlimit=20"],
    "read-empty": ["📖 Read ",null],
    "read-trailing-slash": ["📖 Read ","/repo/dir/"],
    "read-null-offset": ["📖 Read x.ts","/x.ts\nlimit=5"],
    "edit-full": ["✏️ Edit b.ts","sha256:df39100eb5e06f0d5f353c1608b370e2:64"],
    "edit-missing": ["✏️ Edit b.ts","sha256:3f73e8e4fa065a9a8568114a1bada387:56"],
    "edit-null-input": ["✏️ Edit ","─── old ───\n\n─── new ───"],
    "write-content": ["📝 Write c.md","/r/c.md\n───\n  hello\n世界"],
    "write-long": ["📝 Write big.txt","sha256:bae1bb9727c628ca4cbc63d75c2819b4:4043"],
    "bash-desc": ["💻 Run tests ||cd x && bun test||","Run tests\n───\ncd x &&\nbun test"],
    "bash-desc-long": ["sha256:9d4dd226b153604116e9e7051f865d27:214","sha256:7f3fae903e34deede5610d4ea2062dcd:320"],
    "bash-nodesc": ["💻 git status","git status && git diff\nsecond line"],
    "bash-empty": ["💻 ",null],
    "bash-desc-nocmd": ["💻 only desc ||||","only desc"],
    "bash-secret": ["sha256:2c5958d3c37f54b7d49c4670d2c99c88:70","sha256:963c040c1da53718a3dd59a84f339e6a:65"],
    "glob": ["🔍 Glob **/*.ts","{\n  \"pattern\": \"**/*.ts\"\n}"],
    "glob-empty": ["🔍 Glob ","{}"],
    "grep": ["🔎 Grep foo|bar","{\n  \"pattern\": \"foo|bar\",\n  \"path\": \"/r\"\n}"],
    "task-create": ["sha256:abc55fd6dab9e5ecf5de45fb085fbd82:260","sha256:54eff9778322cbf8cbedff05017434dd:379"],
    "task-create-empty": ["🗒️ 新任务：","{}"],
    "task-update": ["🗒️ 任务 #3 → completed","{\n  \"taskId\": 3,\n  \"status\": \"completed\"\n}"],
    "task-update-zero": ["🗒️ 任务 #0","{\n  \"taskId\": 0\n}"],
    "task-update-none": ["🗒️ 任务 #?","{}"],
    "send-bare": ["🤝 send_to_agent → agent-b：line1 line2","sha256:9ea934232fe0d82bf7ba7f6ab7c492e9:75"],
    "send-mcp": ["🤝 send_to_agent → agent-b：body 多行","sha256:eee9a3bd84a5d6967590199ec2963d4b:58"],
    "send-mcp-long": ["sha256:59ed9bf9740e88fcf79424922099f1ba:233","sha256:2bbe447795f5d0f808cb700677670129:4045"],
    "send-mcp-empty": ["🤝 send_to_agent",null],
    "send-mcp-notarget": ["🤝 send_to_agent ：hi","hi"],
    "send-peer-mcp": ["🤝 send_to_agent → agent-d：hello world","sha256:0072c8fcaf49d9434c801843c4aa7a0a:54"],
    "fwd-peer-mcp": ["↪ 转交给 agent-d：r","{\n  \"target\": \"agent-d\",\n  \"reason\": \"r\"\n}"],
    "fwd-bare": ["↪ 转交给 agent-c：发错了","sha256:1c36899727ccd6832089126ff6b782db:50"],
    "fwd-mcp": ["↪ 转交给 agent-c","{\n  \"target\": \"agent-c\"\n}"],
    "fwd-mcp-empty": ["↪ 转交给 ?","{}"],
    "fwd-not-mcp": ["🔧 x__forward_to_agent","{\n  \"target\": \"agent-c\"\n}"],
    "reply-bare": null,
    "fetch-bare": ["📥 取消息","{}"],
    "project-info": ["📁 project 信息","{}"],
    "mcp-generic": ["🔧 mem0/add_memory","{\n  \"text\": \"m\",\n  \"api_key\": \"FIXTURE_KEY\"\n}"],
    "mcp-three-seg": ["🔧 a/b__c","sha256:c3a567912491313051504bba1cdb7361:51"],
    "unknown": ["🌐 WebSearch","{\n  \"query\": \"q\"\n}"],
    "unknown-plain": ["🔧 SomeTool","{}"],
    "unknown-null": ["🔧 SomeTool","{}"],
    "unknown-string": ["🔧 SomeTool","\"  raw string  \""],
    "unknown-whitespace": ["🔧 SomeTool","\"   \""],
    "unknown-long": ["🔧 SomeTool","sha256:8a15bf5fa4717d8068262d3a0f8f0216:4037"],
    "agent": ["🤖 Agent","sha256:8d8363d7d0318f54e095e22db49950a1:49"],
    "trunc-4000": ["📝 Write ","sha256:11fad444f9f05945e24b996701a0e6aa:4006"],
    "trunc-exact": ["🔧 SomeTool","sha256:6e1ac6eb3bdbd8df6f3216f876c7b4b4:4000"],
    "trunc-plus1": ["🔧 SomeTool","sha256:72b6dcd482f366f63d7052564d299461:4037"],
    "trunc-surrogate": ["🔧 SomeTool","sha256:9fc160303dcfd5a88e882bd330d6ca52:8036"],
  },
  watcher: {
    "read-path": ["📖 Read a.ts","/repo/src/a.ts\noffset=0\nlimit=20"],
    "read-empty": ["📖 Read ",""],
    "read-trailing-slash": ["📖 Read ","/repo/dir/"],
    "read-null-offset": ["📖 Read x.ts","/x.ts\nlimit=5"],
    "edit-full": ["✏️ Edit b.ts","sha256:df39100eb5e06f0d5f353c1608b370e2:64"],
    "edit-missing": ["✏️ Edit b.ts","sha256:3f73e8e4fa065a9a8568114a1bada387:56"],
    "edit-null-input": ["✏️ Edit ","─── old ───\n\n─── new ───"],
    "write-content": ["📝 Write c.md","/r/c.md\n───\n  hello\n世界"],
    "write-long": ["📝 Write big.txt","sha256:bae1bb9727c628ca4cbc63d75c2819b4:4043"],
    "bash-desc": ["💻 Run tests ||cd x && bun test||","Run tests\n───\ncd x &&\nbun test"],
    "bash-desc-long": ["sha256:9d4dd226b153604116e9e7051f865d27:214","sha256:7f3fae903e34deede5610d4ea2062dcd:320"],
    "bash-nodesc": ["💻 git status","git status && git diff\nsecond line"],
    "bash-empty": ["💻 ",""],
    "bash-desc-nocmd": ["💻 only desc ||||","only desc"],
    "bash-secret": ["sha256:2c5958d3c37f54b7d49c4670d2c99c88:70","sha256:963c040c1da53718a3dd59a84f339e6a:65"],
    "glob": ["🔍 Glob **/*.ts","{\n  \"pattern\": \"**/*.ts\"\n}"],
    "glob-empty": ["🔍 Glob ","{}"],
    "grep": ["🔎 Grep foo|bar","{\n  \"pattern\": \"foo|bar\",\n  \"path\": \"/r\"\n}"],
    "task-create": ["sha256:abc55fd6dab9e5ecf5de45fb085fbd82:260","sha256:54eff9778322cbf8cbedff05017434dd:379"],
    "task-create-empty": ["🗒️ 新任务：","{}"],
    "task-update": ["🗒️ 任务 #3 → completed","{\n  \"taskId\": 3,\n  \"status\": \"completed\"\n}"],
    "task-update-zero": ["🗒️ 任务 #0","{\n  \"taskId\": 0\n}"],
    "task-update-none": ["🗒️ 任务 #?","{}"],
    "send-bare": ["🤝 send_to_agent → agent-b：line1 line2","sha256:9ea934232fe0d82bf7ba7f6ab7c492e9:75"],
    "send-mcp": null,
    "send-mcp-long": null,
    "send-mcp-empty": null,
    "send-mcp-notarget": ["🤝 send_to_agent ：hi","hi"],
    "send-peer-mcp": ["🤝 send_to_agent → agent-d：hello world","sha256:0072c8fcaf49d9434c801843c4aa7a0a:54"],
    "fwd-peer-mcp": ["↪ 转交给 agent-d：r","{\n  \"target\": \"agent-d\",\n  \"reason\": \"r\"\n}"],
    "fwd-bare": ["↪ 转交给 agent-c：发错了","sha256:1c36899727ccd6832089126ff6b782db:50"],
    "fwd-mcp": null,
    "fwd-mcp-empty": null,
    "fwd-not-mcp": ["🔧 x__forward_to_agent","{\n  \"target\": \"agent-c\"\n}"],
    "reply-bare": null,
    "fetch-bare": null,
    "project-info": ["📁 project 信息","{}"],
    "mcp-generic": ["🔧 mem0/add_memory","{\n  \"text\": \"m\",\n  \"api_key\": \"FIXTURE_KEY\"\n}"],
    "mcp-three-seg": ["🔧 a/b__c","sha256:c3a567912491313051504bba1cdb7361:51"],
    "unknown": ["🌐 WebSearch","{\n  \"query\": \"q\"\n}"],
    "unknown-plain": ["🔧 SomeTool","{}"],
    "unknown-null": ["🔧 SomeTool","{}"],
    "unknown-string": ["🔧 SomeTool","\"  raw string  \""],
    "unknown-whitespace": ["🔧 SomeTool","\"   \""],
    "unknown-long": ["🔧 SomeTool","sha256:8a15bf5fa4717d8068262d3a0f8f0216:4037"],
    "agent": ["🤖 Agent","sha256:8d8363d7d0318f54e095e22db49950a1:49"],
    "trunc-4000": ["📝 Write ","sha256:11fad444f9f05945e24b996701a0e6aa:4006"],
    "trunc-exact": ["🔧 SomeTool","sha256:6e1ac6eb3bdbd8df6f3216f876c7b4b4:4000"],
    "trunc-plus1": ["🔧 SomeTool","sha256:72b6dcd482f366f63d7052564d299461:4037"],
    "trunc-surrogate": ["🔧 SomeTool","sha256:9fc160303dcfd5a88e882bd330d6ca52:8036"],
  },
};

// 每个用例一项：[摘要, 详情]；入口没出工具卡记 null（历史里详情为空串时不带 detail，记 null）
type Baseline = {
  direct: Record<string, [Out, Out]>;
  history: Record<string, [string, string | null] | null>;
  watcher: Record<string, [string, string] | null>;
};
// 捕获时各入口实际出卡的用例数：少了说明入口没走到，直接红
const HISTORY_CARDS = 49;
const WATCHER_CARDS = 43;

function loadBaseline(): Baseline {
  expect(createHash("sha256").update(JSON.stringify(BASELINE), "utf8").digest("hex")).toBe(BASELINE_SHA256);
  const b = BASELINE;
  const all = CASES.map((c) => c.id).sort();
  const json = CASES.filter((c) => c.json).map((c) => c.id).sort();
  expect(new Set(all).size).toBe(all.length);
  expect(Object.keys(b.direct).sort()).toEqual(all);
  expect(Object.keys(b.history).sort()).toEqual(json);
  expect(Object.keys(b.watcher).sort()).toEqual(json);
  expect(Object.values(b.history).filter(Boolean).length).toBe(HISTORY_CARDS);
  expect(Object.values(b.watcher).filter(Boolean).length).toBe(WATCHER_CARDS);
  return b;
}

describe("tool-display-format 与抽出前基线逐字节等价", () => {
  const b = loadBaseline();

  test("lib 新模块：直接调用全部用例（含空值 / 4k 裁切 / JSON 循环 fallback / 原异常）", () => {
    expect(captureDirect(lib.formatTool, lib.formatToolDetail)).toEqual(b.direct);
  });

  test("watcher 旧导出名仍在，且就是 lib 的同一函数（bg-activity-watcher / api-routes / bridge 原 import 不变）", () => {
    expect(w.formatTool).toBe(lib.formatTool);
    expect(w.formatToolDetail).toBe(lib.formatToolDetail);
    expect(captureDirect(w.formatTool, w.formatToolDetail)).toEqual(b.direct);
  });

  test("真实历史读取入口：readSessionHistory + watcher 导出的 formatToolFn / toolDetailFn", async () => {
    expect(await captureHistory(readSessionHistory, w.formatTool, w.formatToolDetail)).toEqual(b.history);
  });

  test("真实 watcher 工具事件入口：startWatching 尾读 → tool_start summary / detail", async () => {
    // 基线按默认 MCP_NAME 捕获（决定哪些工具被隐藏）；环境不同就是基线对不上，直接红，不 skip
    expect(MCP_TOOL_PREFIX).toBe("mcp__claudestra__");
    expect(await captureWatcher(w, bus, sessionPaths)).toEqual(b.watcher);
  });

  test("lib 边界：只 import lib/forward，不碰 bridge / env / IO", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/tool-display-format.ts"), "utf8");
    expect([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual(["./forward.js"]);
    expect(src).not.toMatch(/process\.env|\bBun\.|require\(|import\(/);
    expect(Object.keys(lib).sort()).toEqual(["formatTool", "formatToolDetail", "summarizeCommand"]);
  });
});

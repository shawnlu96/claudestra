/**
 * ACP 窗口会话的典型条目（取自审计窗口里实际刷过的几类）：读文件的 git show | nl | sed、rg 搜索、heredoc 脚本、
 * 长 ; 串、空输出、单行输出、失败命令、agent 正文、reply、收到的消息。tests/acp-transcript-view.test.ts 用它断言，
 * 交付证据里的修改前后对照也用同一批（每项带时间，跨一次分钟）。
 */
import { createTranscriptStamper, transcriptOfEntry, transcriptOfInbound, transcriptOfStop } from "../../src/lib/acp/transcript.ts";
import { createAcpTranslator } from "../../src/lib/acp/updates.ts";

const code = (n: number, head: string) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(6)}\t${i ? `  const x${i} = ${i};` : head}`).join("\n");
const at = (m: number, s: number) => new Date(2026, 9, 7, 11, m, s);
const chunk = (messageId: string, text: string) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
const exec = (id: string, title: string, out: string, failed = false) => [
  { sessionUpdate: "tool_call", toolCallId: id, kind: "execute", title, status: "in_progress" },
  ...(out ? [{ sessionUpdate: "tool_call_update", toolCallId: id, _meta: { terminal_output_delta: { data: out } } }] : []),
  { sessionUpdate: "tool_call_update", toolCallId: id, status: failed ? "failed" : "completed" },
];

const HEREDOC = "mkdir -p /tmp/a/home /tmp/a/tmp\ncat > /tmp/a/probe.ts <<'TS'\nimport { mkdirSync } from \"node:fs\";\nconst root = process.env.TMPDIR!;\nTS\nbun /tmp/a/probe.ts";
const FAIL_OUT = [...Array.from({ length: 28 }, (_, i) => `(pass) case ${i}`), "error: expect(received).toBe(expected)", "(fail) lease > releases lock"].join("\n");

/** 每项：一组 session/update（过真的翻译器）或一条收到的消息，加它进窗口的时间 */
type Fixture = { at: Date; updates?: unknown[]; inbound?: { content: string; user: string } };

const FIXTURES: Fixture[] = [
  { at: at(23, 20), inbound: { content: "审一下 LCK-1 的放锁改动", user: "owner" } },
  { at: at(23, 21), updates: [chunk("m1", "先看改动前后的放锁代码。")] },
  { at: at(23, 24), updates: exec("c1",
    "git show 93410059:src/lib/ledger-scheduler-lease-finished.ts | nl -ba | sed -n '1,155p'; git show 93410059:src/lib/ledger-scheduler-lease.ts | head -85",
    code(339, "/** Finished cards can retain a dispatch */")) },
  { at: at(23, 45), updates: exec("c2", "cd /Users/x/repo && git diff 93410059 HEAD -- src/lib/ledger-scheduler-lease-sync.ts", code(226, "import { mkdtempSync } from \"node:fs\";")) },
  { at: at(24, 5), updates: exec("c3", "mktemp -d /private/tmp/lck1-audit.XXXXXX", "/private/tmp/lck1-audit.RNofCB\n") },
  { at: at(24, 5), updates: exec("c4",
    "rg -n -A14 'CREATE TABLE IF NOT EXISTS scheduler_resources|CREATE TABLE scheduler_resources' src/lib/ledger-*.ts; sed -n '1,22p' src/lib/ledger-read.ts",
    code(38, "src/lib/ledger-scheduler-schema.ts:29:  `CREATE TABLE IF NOT EXISTS scheduler_resources (")) },
  { at: at(24, 49), updates: exec("c5", HEREDOC, code(14, "10 |")) },
  { at: at(25, 27), updates: exec("c6", "GIT_PAGER=cat git status --short; git diff --stat; git log -1 --oneline", "") },
  { at: at(25, 27), updates: exec("c7", "bun test tests/scheduler-merge-handoff.test.ts", FAIL_OUT, true) },
  { at: at(25, 28), updates: [chunk("m2", "放锁条件少了完整 diff 参数，结论如下。")] },
  { at: at(25, 28), updates: [
    { sessionUpdate: "tool_call", toolCallId: "r1", status: "in_progress", _meta: { is_mcp_tool_call: true },
      rawInput: { server: "claudestra", tool: "reply", arguments: { chat_id: "api:owner", text: "P1=1：文件 diff 缺 --no-relative" } } },
    { sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed", rawOutput: { result: { content: [{ type: "text", text: "Sent message(s): [\"1557232365116456974\"]" }] } } },
  ] },
];

/** 整批夹具 → 窗口文本：updates 过真的翻译器，收到的消息走 transcriptOfInbound，同一个 stamper 盖时间 */
export function renderFixtures(): string {
  const stamp = createTranscriptStamper();
  const t = createAcpTranslator(() => "T");
  const out = FIXTURES.flatMap((f) =>
    (f.inbound ? [transcriptOfInbound(f.inbound.content, { user: f.inbound.user })]
      : [...(f.updates ?? []).flatMap((u) => t.push(u)), ...t.flush()].flatMap(transcriptOfEntry)).map((i) => stamp(i, f.at)));
  return [...out, stamp(transcriptOfStop({ event: "Stop", stopHookActive: false }), at(25, 31))].join("\n");
}

/**
 * 一轮典型的 ACP 会话（标准 session/update），照宿主的顺序喂给窗口视图：每条更新先过真的翻译器（updates.ts），
 * 条目经 transcript.ts 变成段先 show，再把原始更新交 update（host.ts onUpdate 就是这个顺序）；收到的消息、审批、回合结束按宿主的格式 show。
 * 覆盖验收要的元素：Markdown 正文（标题 / 列表 / 引用 / 粗体 / 行内代码 / 代码块 / 表格）、思考、3 次工具调用（1 次失败）、计划、权限请求、打断、
 * 用量、配置。tests/acp-tui-*.test.ts 和交付截图（scripts/acp-tui-shots.ts）用同一份。
 */
import type { PermissionCard } from "../../src/lib/acp/permissions.ts";
import { transcriptOfEntry, transcriptOfInbound, transcriptOfStop } from "../../src/lib/acp/transcript.ts";
import { permissionLines } from "../../src/lib/acp/tty-input.ts";
import { createAcpTranslator, type CompactSource } from "../../src/lib/acp/updates.ts";

type Rec = Record<string, unknown>;

/** 视图要实现的两个入口（逐行视图和新视图都是） */
export interface ViewSink {
  show(item: string, at?: Date): void;
  update(u: unknown, at?: Date): void;
  config?(raw: unknown): void;
}

const at = (s: number) => new Date(2026, 9, 14, 21, 3, s);
const chunk = (messageId: string, text: string) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
const thought = (text: string) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const call = (id: string, kind: string, title: string, extra: Rec = {}) => ({ sessionUpdate: "tool_call", toolCallId: id, kind, title, status: "in_progress", ...extra });
const done = (id: string, out: string, failed = false) => [
  ...(out ? [{ sessionUpdate: "tool_call_update", toolCallId: id, _meta: { terminal_output_delta: { data: out } } }] : []),
  { sessionUpdate: "tool_call_update", toolCallId: id, status: failed ? "failed" : "completed" },
];

export const CONFIG = [
  { id: "model", name: "模型", currentValue: "gpt-5.1-codex", options: [{ value: "gpt-5.1-codex", name: "gpt-5.1-codex" }] },
  { id: "reasoning_effort", name: "推理", currentValue: "high", options: [{ value: "high", name: "high" }] },
];

export const PERMISSION: PermissionCard = {
  title: "要运行命令：rm -rf build/",
  detail: "工作目录 ~/repo",
  options: [{ id: "allow", label: "允许", style: "success" }, { id: "always", label: "总是允许", style: "primary" }, { id: "deny", label: "拒绝", style: "danger" }],
} as PermissionCard;

const ANSWER = [
  "## 结论\n\n放锁条件少了 **完整 diff** 参数，",
  "修法见下。\n\n- 第一处：`lease-sync.ts` 的比较\n- 第二处：重试\n  - 子项：退避 3s\n1. 先改代码\n2. 再补测试\n\n",
  "> 引用：审查意见原文\n\n```ts\nconst ok = diff(a, b, { relative: false });\n```\n\n",
  "| 文件 | 改动 | 风险 |\n|---|---|---|\n| lease-sync.ts | 比较参数 | 低 |\n| 中文文件名.ts | 重试 | 中 |\n\n最后一行。",
].join("");

/** 一步：一组原始更新（同一时刻），或一段宿主直接显示的文字 */
type Step = { at: Date; updates?: Rec[]; item?: string };

function sessionSteps(): Step[] {
  return [
    { at: at(0), item: transcriptOfInbound("审一下 LCK-1 的放锁改动，顺便清掉 build 目录", { user: "owner" }) },
    { at: at(1), updates: [thought("先看 diff。\n"), thought("再看测试是怎么"), thought("挂的。\n")] },
    { at: at(2), updates: [{ sessionUpdate: "plan", entries: [
      { content: "读改动", status: "completed" }, { content: "跑测试", status: "in_progress" }, { content: "写结论", status: "pending" }] }] },
    { at: at(3), updates: [call("c1", "read", "src/lib/lease-sync.ts", { locations: [{ path: "src/lib/lease-sync.ts" }] }), ...done("c1", "a\nb\nc\nd\n")] },
    { at: at(4), updates: [call("c2", "execute", "git diff --stat HEAD~1")] },
    { at: at(5), updates: done("c2", " src/lib/lease-sync.ts | 4 ++--\n") },
    { at: at(6), updates: [call("c3", "execute", "bun test tests/lease.test.ts"),
      ...done("c3", [...Array.from({ length: 12 }, (_, i) => `(pass) case ${i}`), "error: expect(received).toBe(expected)", "(fail) lease > releases lock"].join("\n"), true)] },
    { at: at(7), item: permissionLines(PERMISSION) },
    { at: at(8), updates: [{ sessionUpdate: "usage_update", used: 91_000, size: 200_000 }, { sessionUpdate: "config_option_update", configOptions: CONFIG }] },
    { at: at(9), updates: ANSWER.match(/[\s\S]{1,23}/g)!.map((t) => chunk("m1", t)) },
    { at: at(10), item: "── 已打断 ──" },
    { at: at(11), item: transcriptOfStop({ event: "Stop", stopHookActive: false }) },
  ];
}

/** 照宿主的顺序把整轮喂给视图；flush 在回合结束前（host.ts 收尾时吐攒着的正文）。steps：只放前几步（截「回合进行中」的样子） */
/** 回合进行中：读完一个文件、git diff 还在跑、思考到一半 */
export function playBusy(view: ViewSink): void {
  playSession(view, undefined, 5);
  const u = thought("diff 只动了一个文件，等它跑完再看测试。\n");
  view.update(u);
}

export function playSession(view: ViewSink, compact: CompactSource = { from: "claudestra-meta" }, steps = Infinity): void {
  const t = createAcpTranslator(() => "T", compact);
  for (const step of sessionSteps().slice(0, steps)) {
    if (step.item?.startsWith("──")) for (const e of t.flush()) for (const i of transcriptOfEntry(e)) view.show(i, step.at);
    if (step.item) view.show(step.item, step.at);
    for (const u of step.updates ?? []) {
      for (const e of t.push(u)) for (const i of transcriptOfEntry(e)) view.show(i, step.at);
      view.update(u, step.at);
    }
  }
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";
import * as hub from "../src/lib/session-history.js";
import * as leaf from "../src/lib/session-history-parse.js";
import { inboundSha } from "../src/lib/inbound-ledger.js";
import { runtimeForSessionPath } from "../src/lib/session-source.js";
import type { HistoryMessage } from "../src/lib/session-history-types.js";

// The immutable pre-extraction source is the oracle; no second parser is maintained in fixtures.
const BASE = "4da22541700dd8fe03f35cdbd9d1d2376edcfd2a";
const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "histp-extraction-"));
let original: typeof hub & { parseHistoryLines: typeof leaf.parseHistoryLines };
let before: string;
const json = JSON.stringify;
const user = (content: unknown, extra = {}) => ({ type: "user", message: { content }, ...extra });
const assistant = (content: unknown, extra = {}) => ({ type: "assistant", message: { content, model: "fixture" }, ...extra });
const tool = (name: string, id = name, input: unknown = {}) => ({ type: "tool_use", name, id, input });
const result = (id: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, is_error, content: "done" });
const channel = '<channel user="fixture" user_id="api:fixture" message_id="mid">\n中文 🧪 \\ "\n</channel>';
const replyRows = [{ type: "buttons", buttons: [{ id: "fixture", label: "选择 🧪" }] }];

beforeAll(async () => {
  const r = Bun.spawnSync(["git", "show", `${BASE}:src/lib/session-history.ts`], { cwd: root });
  expect(r.exitCode).toBe(0);
  before = r.stdout.toString();
  // Only expose the private parser and relocate imports; its statements stay byte-for-byte intact.
  const source = before.replace("function parseHistoryLines(", "export function parseHistoryLines(")
    .replace(/from "\.\/([^\"]+)"/g, (_, name) => `from "${pathToFileURL(join(root, "src/lib", name)).href}"`);
  const p = join(scratch, "original.ts");
  writeFileSync(p, source);
  original = await import(p);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** 抽取之后有意改过的地方：[声明, 抽取前片段, 现在的片段]。套到抽取前原文上再逐字节比，其余字节照样锁死 */
const AMENDED: [string, string, string][] = [
  // NAR1：CC 忙时队列吸收的入站标 midTurn，网页不把它当回合边界（web/features/chat/reply-echo.ts）
  ["parseHistoryLines", "inbox.fresh(mid, msg)) all.push(msg);", "inbox.fresh(mid, msg)) all.push(Object.assign(msg, { midTurn: true }));"],
  ["HistoryMessage", "  fromId?: string;\n}", "  fromId?: string;\n  /** CC 忙时队列吸收、并进当前回合的入站（attachment queued_command）：不是新回合的开头 */\n  midTurn?: boolean;\n}"],
];

function amended(name: string, body: string): string {
  return AMENDED.filter(([n]) => n === name).reduce((b, [, from, to]) => {
    expect(b.split(from)).toHaveLength(2); // 片段在原文里恰好一处，登记错了直接红
    return b.replace(from, to);
  }, body);
}

function declarations(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of parseSync("history.ts", source).program.body) {
    const d: any = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    const name = d?.id?.name ?? d?.declarations?.[0]?.id?.name;
    if (name) out.set(name, source.slice(d.start, d.end));
  }
  return out;
}

const matrices: [string, string[]][] = [
  ["empty", []],
  ["broken and partial", ["", "  ", "{", "null", "{}", '{"type":"user","message":', json(user(null)), json(assistant("bad"))]],
  ["unicode escapes duplicate unknown fields", [
    json(user("中文 🧪\n\t\\\" é")), '{"type":"unknown","type":"user","message":{"content":"last"},"extra":42}',
    json(user([{ type: "unknown" }, { type: "text", text: "保留" }, null])), json({ type: "unknown", content: "ignored" }),
  ]],
  ["channel queue duplicate and meta", [
    json({ type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt: channel } }),
    json(user(channel, { isMeta: true })), json(user(channel, { isMeta: true })),
    json(user(channel.replace('user="fixture"', 'user="bridge:nudge"'), { isMeta: true })),
    json(user("meta", { isMeta: true })), json(user("summary", { isCompactSummary: true })),
  ]],
  ["system commands and duration", [
    json({ type: "system", subtype: "compact_boundary" }),
    json({ type: "system", subtype: "local_command", content: "<command-name>/help</command-name>" }),
    json({ type: "system", subtype: "local_command", content: "<local-command-stdout>中文\nOK</local-command-stdout>" }),
    json(assistant([{ type: "text", text: "answer" }])), json({ type: "system", subtype: "turn_duration", durationMs: 321 }),
    json(user("boundary")), json({ type: "system", subtype: "turn_duration", durationMs: 999 }),
  ]],
  ["tools reply success failure and open", [
    json(assistant([tool("Read"), tool("Write"), tool("Open"), tool("reply", "r1", { text: "答复\n🧪", components: replyRows, files: ["/tmp/中文.txt", null] }),
      tool("mcp__fixture__reply", "r2", { text: "second", components: replyRows }), tool("reply", "empty", { text: " " })])),
    json(user([result("Read"), result("Write", true), result("r1", true), { ...result("r2"), content: "Sent message(s): [] · ask ask_fixture" }, result("unknown")])),
    json(assistant([tool("Same", "same"), result("same")])),
  ]],
  ["progress api error and empty blocks", [
    json(assistant([null, { type: "thinking", thinking: "  进度 🧪  " }, { type: "text", text: "  " }])),
    json(assistant([{ type: "thinking", thinking: "x".repeat(801) }])),
    ...[1, 2].map(() => json(assistant([{ type: "text", text: "API Error: fixture" }], { isApiErrorMessage: true }))),
  ]],
  ["pi", [
    json({ type: "session", version: 3, id: "fixture", cwd: "/fixture" }),
    json({ type: "message", message: { role: "user", content: [{ type: "text", text: channel }] } }),
    json({ type: "message", message: { role: "assistant", content: [tool("read", "p1"), tool("reply", "p2", { text: "Pi 🧪" })] } }),
    json({ type: "message", message: { role: "toolResult", toolCallId: "p1", toolName: "read", content: [{ type: "text", text: "failed" }], isError: true } }),
  ]],
  ["codex", [
    json({ type: "session_meta", payload: { id: "fixture", cwd: "/fixture" } }),
    json({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: channel }] } }),
    json({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex 🧪" }] } }),
    json({ type: "event_msg", payload: { type: "task_complete", error: { message: "fixture failure" } } }),
  ]],
];

function callbacks(trace: unknown[], fail?: string) {
  return {
    formatToolFn: (name: string, input: unknown) => { trace.push(["fmt", name, input]); if (fail === "fmt") throw new Error("fmt fixture"); return `工具:${name}`; },
    toolDetailFn: (name: string, input: unknown) => { trace.push(["detail", name, input]); if (fail === "detail") throw new Error("detail fixture"); return json(input); },
    inbound: (mid: string) => {
      trace.push(["inbound", mid]);
      if (fail === "inbound") throw new Error("inbound fixture");
      return fail === "trusted" ? { sha: inboundSha(channel.split("\n").slice(1, -1).join("\n")), meta: { user: "ledger", user_id: "api:ledger" } } : null;
    },
  };
}

async function outcome(run: () => unknown) {
  try { return { value: await run() }; }
  catch (e) { return { error: { name: (e as Error).name, message: (e as Error).message } }; }
}

function page(all: HistoryMessage[], opts: { limit?: number; before?: number; after?: number }) {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const eligible = all.filter(m => opts.after != null ? m.seq > opts.after : opts.before == null || m.seq < opts.before);
  const messages = opts.after != null ? eligible.slice(0, limit) : eligible.slice(-limit);
  return { messages, total: all.length, hasMore: eligible.length > messages.length };
}

describe("history extraction against immutable original", () => {
  test("all moved declarations and all remaining implementations are unchanged", () => {
    const old = declarations(before);
    const parse = declarations(readFileSync(join(root, "src/lib/session-history-parse.ts"), "utf8"));
    const types = declarations(readFileSync(join(root, "src/lib/session-history-types.ts"), "utf8"));
    const remaining = declarations(readFileSync(join(root, "src/lib/session-history.ts"), "utf8"));
    for (const [name, body] of old) {
      expect([parse, types, remaining].filter(m => m.has(name))).toHaveLength(1);
      expect(parse.get(name) ?? types.get(name) ?? remaining.get(name)).toBe(amended(name, body));
    }
    expect([...parse.keys()]).toContain("parseHistoryLines");
    expect([...types.keys()]).toContain("HistoryMessage");
    expect(remaining.has("parseHistoryLines")).toBe(false);
    expect(Object.keys(hub).sort()).toEqual(Object.keys(original).filter(k => k !== "parseHistoryLines").sort());
    expect(hub.PROGRESS_NOTE_MAX_CHARS).toBe(leaf.PROGRESS_NOTE_MAX_CHARS);
    expect(hub.progressNoteOf).toBe(leaf.progressNoteOf);
    expect(hub.isReplyTool).toBe(leaf.isReplyTool);
    expect(hub.queuedPromptOf).toBe(leaf.queuedPromptOf);
    expect(hub.channelMessageId).toBe(leaf.channelMessageId);
    expect(hub.unwrapChannelMessage).toBe(leaf.unwrapChannelMessage);
  });

  for (const [name, lines] of matrices) {
    test(`${name}: original/public/leaf bytes, callback order, full/tail pagination and search`, async () => {
      const p = join(scratch, `${name}.jsonl`);
      writeFileSync(p, lines.join("\n"));
      const runtime = runtimeForSessionPath(p);
      if (name === "pi" || name === "codex") {
        expect(runtime).toBe(name);
        expect((await hub.readSessionHistory(p)).messages.length).toBeGreaterThan(0);
      }
      for (const offset of [0, 37]) {
        const a: unknown[] = [], b: unknown[] = [];
        const ca = callbacks(a), cb = callbacks(b);
        expect(json(await outcome(() => leaf.parseHistoryLines([...lines], offset, ca.formatToolFn, ca.toolDetailFn, runtime, ca.inbound))))
          .toBe(json(await outcome(() => original.parseHistoryLines([...lines], offset, cb.formatToolFn, cb.toolDetailFn, runtime, cb.inbound))));
        expect(json(a)).toBe(json(b));
      }
      for (const maxFullReadBytes of [undefined, 0]) {
        for (const paging of [{}, { limit: 2 }, { before: 4, limit: 2 }, { after: 1, limit: 2 }, { after: 1, before: 4 }, { limit: 0 }, { limit: 501 }]) {
          const a: unknown[] = [], b: unknown[] = [], c: unknown[] = [];
          const opts = { ...paging, maxFullReadBytes };
          const actual = await hub.readSessionHistory(p, { ...opts, ...callbacks(a) });
          expect(json(actual)).toBe(json(await original.readSessionHistory(p, { ...opts, ...callbacks(b) })));
          const cb = callbacks(c);
          const parsed = leaf.parseHistoryLines([...lines], 0, cb.formatToolFn, cb.toolDetailFn, runtime, cb.inbound);
          expect(json(actual)).toBe(json(page(parsed, paging)));
          expect(json(a)).toBe(json(b));
          expect(json(a)).toBe(json(c));
        }
      }
      expect(json(await hub.readSessionHistory(p))).toBe(json(await original.readSessionHistory(p)));
      for (const query of ["", "中文", "reply", "🧪", "fixture"]) {
        expect(json(await hub.searchSessionHistory(p, query, { chunkBytes: 7 })))
          .toBe(json(await original.searchSessionHistory(p, query, { chunkBytes: 7 })));
      }
    });
  }

  test("foreign lookup success, missing and throwing callbacks preserve neutral source fields", async () => {
    const lines = matrices.find(([name]) => name === "codex")![1];
    const p = join(scratch, "lookup.jsonl");
    writeFileSync(p, lines.join("\n"));
    for (const mode of ["trusted", "missing", "inbound"]) {
      const a: unknown[] = [], b: unknown[] = [];
      const actual = await hub.readSessionHistory(p, callbacks(a, mode));
      expect(json(actual)).toBe(json(await original.readSessionHistory(p, callbacks(b, mode))));
      expect(a).toEqual(b);
      expect(a).toContainEqual(["inbound", "mid"]);
      expect(actual.messages.find(m => m.role === "user")?.from).toBe(mode === "trusted" ? "ledger" : undefined);
    }
  });

  test("missing file and renderer exceptions preserve failure and callback order", async () => {
    const missing = join(scratch, "missing.jsonl");
    expect(await outcome(() => hub.readSessionHistory(missing))).toEqual(await outcome(() => original.readSessionHistory(missing)));
    const p = join(scratch, "throws.jsonl");
    writeFileSync(p, json(assistant([tool("Read")])));
    for (const fail of ["fmt", "detail"]) {
      const a: unknown[] = [], b: unknown[] = [];
      expect(await outcome(() => hub.readSessionHistory(p, callbacks(a, fail))))
        .toEqual(await outcome(() => original.readSessionHistory(p, callbacks(b, fail))));
      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
    }
  });
});

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainChannelWatcher, startWatching, stopWatching } from "../src/bridge/jsonl-watcher";
import { activeBgTasksFor, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus";
import * as paths from "../src/lib/session-path-resolve";
import { projectJsonlPath, subagentsDir } from "../src/lib/jsonl-cost";
import { parseHistoryLines } from "../src/lib/session-history-parse";
import { formatTool, formatToolDetail } from "../src/lib/tool-display-format";
import { newReadCursor, readCursor, tailReadCursor } from "../src/lib/jsonl-read-cursor";

let root: string;
let oldHome: string | undefined;
const events: BridgeEvent[] = [];
let unsub: () => void;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jsonl-framing-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  unsub = subscribeEvents({ allow: e => e.agent.startsWith("jframe-") }, e => events.push(e));
});
afterAll(() => {
  unsub();
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

function assistant(text: string) {
  return { type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text }] } };
}
function line(entry: object) { return JSON.stringify(entry) + "\n"; }

async function mainFixture(name: string, initial: string | Uint8Array = "") {
  const agent = `jframe-${name}`;
  const channel = `local-${agent}`;
  const file = join(root, name + ".jsonl");
  writeFileSync(file, initial);
  const resolve = spyOn(paths, "resolveSessionPath").mockReturnValue(file);
  const discord = {} as Parameters<typeof startWatching>[4];
  try { await startWatching(agent, root, name, channel, discord); }
  finally { resolve.mockRestore(); }
  return { file, agent, drain: () => drainChannelWatcher(channel, discord),
    of: (type: string) => events.filter(e => e.agent === agent && e.type === type) };
}

describe("main JSONL framing with real IO and Stop drain", () => {
  const records = [
    ["text", assistant("中文🙂 complete"), "assistant_text"],
    ["tool", { ...assistant(""), message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "中文🙂" } }] } }, "tool_start"],
    ["error", { ...assistant("中文🙂 unavailable"), isApiErrorMessage: true, error: "api_error" }, "assistant_text"],
    ["compact", { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 20000, postTokens: 10000, trigger: "中文🙂" } }, "compact_done"],
  ] as const;
  for (const [name, entry, type] of records) {
    test(`${name}: split UTF-8 produces no partial event, then one complete event`, async () => {
      const f = await mainFixture(name, "\n{}\n");
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const bytes = Buffer.from(line(entry));
        const cut = bytes.indexOf(Buffer.from("🙂")) + 2;
        appendFileSync(f.file, bytes.subarray(0, cut));
        await f.drain();
        expect(f.of(type)).toHaveLength(0);
        expect(log.mock.calls).toHaveLength(0);
        appendFileSync(f.file, bytes.subarray(cut));
        const result = await f.drain();
        await f.drain();
        expect(f.of(type)).toHaveLength(1);
        if (name !== "compact") expect(f.of(type)[0].data).toMatchObject({ seq: 2, sid: name });
        if (name === "text") {
          expect(result.text).toBe("中文🙂 complete");
          const history = parseHistoryLines(["", "{}", JSON.stringify(entry), ""], 0, formatTool, formatToolDetail);
          expect(history.find(m => m.text === "中文🙂 complete")?.seq).toBe(2);
        }
        if (name === "error") expect(result.apiError).toBe(true);
        expect(log.mock.calls).toHaveLength(0);
      } finally { stopWatching(f.agent); log.mockRestore(); }
    });
  }

  test("startup tail keeps an unfinished record; blank and malformed full lines keep physical seq", async () => {
    const bytes = Buffer.from(line(assistant("startup中文🙂")));
    const cut = bytes.indexOf(Buffer.from("🙂")) + 1;
    const f = await mainFixture("tail", bytes.subarray(0, cut));
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.drain();
      appendFileSync(f.file, bytes.subarray(cut));
      appendFileSync(f.file, "\n{bad}\n" + line(assistant("after bad")));
      await f.drain();
      expect(f.of("assistant_text").map(e => [e.data.text, e.data.seq])).toEqual([["startup中文🙂", 0], ["after bad", 3]]);
      expect(log.mock.calls).toHaveLength(1);
    } finally { stopWatching(f.agent); log.mockRestore(); }
  });

  for (const mode of ["truncate", "replace-small", "replace-same"] as const) {
    test(`${mode}: rebuild seq, drop partial bytes and old API/tool state`, async () => {
      const f = await mainFixture(mode);
      try {
        const old = line({ ...assistant("old error"), isApiErrorMessage: true, error: "api_error" });
        appendFileSync(f.file, old + '{"type":"assistant","stale":');
        await f.drain();
        const oldSource = f.of("assistant_text").at(-1)?.data.source;
        const next = line(assistant("new"));
        const content = mode === "replace-same" ? next + " ".repeat(Buffer.byteLength(old + '{"type":"assistant","stale":') - Buffer.byteLength(next)) : next;
        if (mode === "truncate") writeFileSync(f.file, content);
        else { writeFileSync(f.file + ".new", content); renameSync(f.file + ".new", f.file); }
        const result = await f.drain();
        expect(result.text).toBe("new");
        expect(result.apiError).toBe(false);
        expect(f.of("assistant_text").at(-1)?.data).toMatchObject({ text: "new", seq: 0 });
        expect(f.of("assistant_text").at(-1)?.data.source).not.toBe(oldSource);
        await f.drain();
        expect(f.of("assistant_text")).toHaveLength(2);
      } finally { stopWatching(f.agent); }
    });
  }
});

test("cursor only commits complete raw bytes and counts all physical newlines", async () => {
  const file = join(root, "cursor.jsonl");
  writeFileSync(file, "old\n\nunfinished");
  const cursor = await tailReadCursor(file);
  expect(cursor).toMatchObject({ offset: 5, lineNo: 2 });
  expect((await readCursor(file, cursor)).lines).toEqual([]);
  expect(cursor.offset).toBe(5);
  appendFileSync(file, "中文🙂\n\n{}\n");
  const r = await readCursor(file, cursor);
  expect(r.lines).toEqual([{ seq: 2, line: "unfinished中文🙂" }, { seq: 4, line: "{}" }]);
  expect(cursor.lineNo).toBe(5);
  expect((await readCursor(file, cursor)).lines).toEqual([]);
  writeFileSync(file, "partial");
  const reset = await readCursor(file, cursor);
  expect(reset.reset).toBe(true);
  expect(reset.lines).toEqual([]);
  expect(cursor).toMatchObject({ offset: 0, lineNo: 0, generation: 1 });
  appendFileSync(file, "\n");
  expect((await readCursor(file, cursor)).lines).toEqual([{ seq: 0, line: "partial" }]);
});

test("observed partial length shrinking starts a new generation even before any line was consumed", async () => {
  const file = join(root, "partial-shrink.jsonl");
  const cursor = newReadCursor();
  writeFileSync(file, "uncompleted old record");
  await readCursor(file, cursor);
  writeFileSync(file, "{}\n");
  const r = await readCursor(file, cursor);
  expect(r.reset).toBe(true);
  expect(r.lines).toEqual([{ seq: 0, line: "{}" }]);
});

function bgFixture(name: string) {
  const agent = { name: `jframe-bg-${name}`, channelId: `local-bg-${name}`, cwd: join(root, name), sessionId: name };
  const tasks = join(root, "tasks", name);
  const subs = subagentsDir(agent.cwd, agent.sessionId);
  const main = projectJsonlPath(agent.cwd, agent.sessionId);
  mkdirSync(tasks, { recursive: true });
  mkdirSync(subs, { recursive: true });
  writeFileSync(main, line({ type: "user", message: { content: [{ type: "tool_result", content: "Command running in background with ID: shell" }] } }));
  let now = Date.now();
  const poll = () => { now += 10000; return pollBgActivitiesForTest({ now: () => now, agents: async () => [agent], shellDir: () => tasks }); };
  return { agent, poll, file: (kind: string) => kind === "shell" ? join(tasks, "shell.output") : join(subs, "agent-sub.jsonl"),
    completed: () => events.filter(e => e.agent === agent.name && e.type === "bg_task_completed") };
}

describe("background identity boundaries", () => {
  test("subagent split UTF-8 waits for newline; malformed complete JSON does not block the answer", async () => {
    const f = bgFixture("split");
    await f.poll();
    const file = f.file("subagent");
    const bytes = Buffer.from(line({ ...assistant("sub中文🙂"), message: { ...assistant("sub中文🙂").message, stop_reason: "end_turn" } }));
    const cut = bytes.indexOf(Buffer.from("🙂")) + 1;
    writeFileSync(file, bytes.subarray(0, cut));
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.poll();
      expect(f.completed()).toEqual([]);
      expect(events.filter(e => e.agent === f.agent.name && e.type === "bg_task_update")).toEqual([]);
      expect(log.mock.calls).toHaveLength(0);
      appendFileSync(file, bytes.subarray(cut));
      appendFileSync(file, "{bad}\n\n");
      await f.poll();
      await f.poll();
      expect(f.completed()).toHaveLength(1);
      expect(log.mock.calls).toHaveLength(1);
      const update = events.find(e => e.agent === f.agent.name && e.type === "bg_task_update");
      expect(update?.data.items).toEqual(["💬 sub中文🙂"]);
    } finally { log.mockRestore(); }
  });

  test("dormant subagent replacement with a user record wakes from the new file's beginning", async () => {
    const f = bgFixture("dormant");
    const file = f.file("subagent");
    writeFileSync(file, line({ ...assistant("old".repeat(100)), message: { ...assistant("old".repeat(100)).message, stop_reason: "end_turn" } }));
    await f.poll();
    expect(activeBgTasksFor(f.agent.name)).toHaveLength(0);
    writeFileSync(file + ".new", line({ type: "user", message: { content: "resume" } }) +
      line({ ...assistant("awake"), message: { ...assistant("awake").message, stop_reason: "end_turn" } }));
    renameSync(file + ".new", file);
    await f.poll();
    expect(f.completed()).toHaveLength(1);
    expect(events.find(e => e.agent === f.agent.name && e.type === "bg_task_update")?.data.items).toEqual(["💬 awake"]);
  });

  for (const kind of ["subagent", "shell"]) for (const mode of ["truncate", "replace-small", "replace-same"]) {
    test(`${kind} ${mode}: reset pending UTF-8 and progress, consume the new file`, async () => {
      const f = bgFixture(`${kind}-${mode}`);
      await f.poll();
      const file = f.file(kind);
      const initial = kind === "shell" ? "x".repeat(200) + "\npending中文" : line({ ...assistant(""), message: { content: [{ type: "tool_use", name: "Read", id: "old", input: {} }] } }) + '{"stale":';
      writeFileSync(file, Buffer.concat([Buffer.from(initial), Buffer.from("🙂").subarray(0, 2)]));
      await f.poll();
      expect(activeBgTasksFor(f.agent.name)).toHaveLength(1);
      const next = kind === "shell" ? "new\n[exited with code 0]" : line({ ...assistant("new中文🙂"), message: { ...assistant("new中文🙂").message, stop_reason: "end_turn" } });
      const content = mode === "replace-same" ? (kind === "shell" ? " ".repeat(Buffer.byteLength(initial) + 2 - Buffer.byteLength(next)) + next :
        next + " ".repeat(Buffer.byteLength(initial) + 2 - Buffer.byteLength(next))) : next;
      if (mode === "truncate") writeFileSync(file, content);
      else { writeFileSync(file + ".new", content); renameSync(file + ".new", file); }
      await f.poll();
      await f.poll();
      expect(f.completed()).toHaveLength(1);
      expect(f.completed()[0].data).toMatchObject({ kind, status: "done" });
      const updates = events.filter(e => e.agent === f.agent.name && e.type === "bg_task_update");
      const items = updates.flatMap(e => e.data.items as string[]);
      expect(items.some(t => t.includes(kind === "shell" ? "[exited with code 0]" : "new中文🙂"))).toBe(true);
      expect(items.some(t => t.includes("pending") || t.includes("�"))).toBe(false);
    });
  }
});

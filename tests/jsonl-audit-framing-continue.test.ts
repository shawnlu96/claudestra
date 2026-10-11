import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainChannelWatcher, startWatching, stopWatching } from "../src/bridge/jsonl-watcher";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus";
import * as paths from "../src/lib/session-path-resolve";
import * as sessionSource from "../src/lib/session-source";
import { newReadCursor, readCursor, tailReadCursor } from "../src/lib/jsonl-read-cursor";

let root: string;
let oldHome: string | undefined;
const events: BridgeEvent[] = [];
let unsub: () => void;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jsonl-continue-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  unsub = subscribeEvents({ allow: e => e.agent.startsWith("jcont-") }, e => events.push(e));
});
afterAll(() => {
  unsub();
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

function line(text: string) {
  return JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text }] } }) + "\n";
}

async function fixture(name: string) {
  const agent = `jcont-${name}`;
  const channel = `fake-${agent}`;
  const file = join(root, name + ".jsonl");
  const sent: string[] = [];
  writeFileSync(file, "");
  const resolve = spyOn(paths, "resolveSessionPath").mockReturnValue(file);
  const discord = { channels: { fetch: async () => ({ send: async ({ content }: { content: string }) => {
    sent.push(content); return { id: "fixture-message" };
  } }) } } as unknown as Parameters<typeof startWatching>[4];
  try { await startWatching(agent, root, name, channel, discord); }
  finally { resolve.mockRestore(); }
  const texts = () => events.filter(e => e.agent === agent && e.type === "assistant_text").map(e => [e.data.text, e.data.seq]);
  const pushes = (text: string) => sent.join("\n").split(text).length - 1;
  return { file, agent, sent, texts, pushes, drain: async () => { await drainChannelWatcher(channel, discord); await drainChannelWatcher(channel, discord); } };
}

describe("same content under a new generation signal continues instead of replaying", () => {
  for (const how of ["move", "rewrite"] as const) {
    test(`[验收线 1] ${how} with a new inode and identical content pushes only the two appended lines`, async () => {
      const f = await fixture(`same-${how}`);
      const moved = how === "move" ? join(root, "worktree-same-move.jsonl") : f.file;
      const find = spyOn(sessionSource, "findSessionJsonlBySessionId").mockReturnValue(moved);
      try {
        appendFileSync(f.file, line("history-a") + line("history-b") + line("history-c"));
        await f.drain();
        expect(f.texts()).toEqual([["history-a", 0], ["history-b", 1], ["history-c", 2]]);
        const before = statSync(f.file).ino;
        // Copy then delete (move) or write a fresh file and rename over (rewrite): either way the inode changes.
        writeFileSync(moved + ".copy", readFileSync(f.file));
        if (how === "move") { renameSync(moved + ".copy", moved); unlinkSync(f.file); }
        else renameSync(moved + ".copy", moved);
        expect(statSync(moved).ino).not.toBe(before);
        appendFileSync(moved, line("fresh-d") + line("fresh-e"));
        await f.drain();
        expect(f.texts()).toEqual([["history-a", 0], ["history-b", 1], ["history-c", 2], ["fresh-d", 3], ["fresh-e", 4]]);
        for (const t of ["history-a", "history-b", "history-c", "fresh-d", "fresh-e"]) expect(f.pushes(t)).toBe(1);
      } finally { stopWatching(f.agent); find.mockRestore(); }
    });
  }

  test("[验收线 2] cutting only the unconsumed partial tail, then completing it, pushes the completed line once", async () => {
    const f = await fixture("tail-cut");
    try {
      appendFileSync(f.file, line("kept-a") + line("kept-b"));
      const consumed = statSync(f.file).size;
      appendFileSync(f.file, '{"type":"assistant","message":{"content":[{"type":"te');
      await f.drain();
      expect(f.texts()).toEqual([["kept-a", 0], ["kept-b", 1]]);
      truncateSync(f.file, consumed);
      await f.drain();
      appendFileSync(f.file, line("completed-c"));
      await f.drain();
      expect(f.texts()).toEqual([["kept-a", 0], ["kept-b", 1], ["completed-c", 2]]);
      for (const t of ["kept-a", "kept-b", "completed-c"]) expect(f.pushes(t)).toBe(1);
    } finally { stopWatching(f.agent); }
  });
});

describe("cursor anchor boundaries", () => {
  test("[验收线 1] tail cursor anchors startup history; an identical rewrite reads only the increment", async () => {
    const file = join(root, "tail-anchor.jsonl");
    writeFileSync(file, "a\nbb\n");
    const cursor = await tailReadCursor(file);
    writeFileSync(file + ".new", "a\nbb\ncc\n");
    renameSync(file + ".new", file);
    const r = await readCursor(file, cursor);
    expect(r.reset).toBe(false);
    expect(r.lines).toEqual([{ seq: 2, line: "cc" }]);
    expect(cursor).toMatchObject({ offset: 8, lineNo: 3, generation: 0 });
  });

  test("[验收线 2] partial tail shrink keeps offset; the completed line keeps its physical seq", async () => {
    const file = join(root, "cursor-tail.jsonl");
    const cursor = newReadCursor();
    writeFileSync(file, "x\ny\npartial-old");
    expect((await readCursor(file, cursor)).lines).toEqual([{ seq: 0, line: "x" }, { seq: 1, line: "y" }]);
    truncateSync(file, 4);
    const cut = await readCursor(file, cursor);
    expect(cut).toMatchObject({ reset: false, lines: [] });
    appendFileSync(file, "z\n");
    expect((await readCursor(file, cursor)).lines).toEqual([{ seq: 2, line: "z" }]);
    expect(cursor).toMatchObject({ offset: 6, lineNo: 3, generation: 0 });
  });

  for (const mode of ["truncate", "same-length", "anchor-shifted"] as const) {
    test(`[验收线 3] ${mode}: rebuild from 0 with seq equal to the real line number`, async () => {
      const file = join(root, `rebuild-${mode}.jsonl`);
      const cursor = newReadCursor();
      writeFileSync(file, "one\ntwo\n");
      await readCursor(file, cursor);
      const content = mode === "truncate" ? "n\n" : mode === "same-length" ? "uno\ntwX\n" : "abc_two\n";
      writeFileSync(file + ".new", content);
      renameSync(file + ".new", file);
      const r = await readCursor(file, cursor);
      expect(r.reset).toBe(true);
      expect(r.lines.map(l => l.seq)).toEqual(content.trimEnd().split("\n").map((_, i) => i));
      expect(cursor).toMatchObject({ offset: Buffer.byteLength(content), generation: 1 });
    });
  }

  test("shell mode keeps the JFRAME1 reset rule on a same-content replacement", async () => {
    const file = join(root, "shell.out");
    const cursor = newReadCursor();
    writeFileSync(file, "out\n");
    await readCursor(file, cursor, "shell");
    writeFileSync(file + ".new", "out\nmore");
    renameSync(file + ".new", file);
    const r = await readCursor(file, cursor, "shell");
    expect(r.reset).toBe(true);
    expect(new TextDecoder().decode(r.bytes)).toBe("out\nmore");
  });
});

import { expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainChannelWatcher, startWatching, stopWatching } from "../src/bridge/jsonl-watcher.ts";
import * as sessionPaths from "../src/lib/session-path-resolve.ts";

test("same tmux session re-registration preserves unread JSONL lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watcher-reconnect-"));
  const sessionFile = join(dir, "session.jsonl");
  const agent = "agent-watcher-reconnect-fixture";
  const channel = "local-watcher-reconnect-fixture";
  const discord = {} as Parameters<typeof startWatching>[4];
  const opts = { runtime: "claude-code" };
  // Keep the real watcher and file IO, but never look up the user's actual session tree.
  const resolve = spyOn(sessionPaths, "resolveSessionPath").mockReturnValue(sessionFile);
  writeFileSync(sessionFile, "");
  try {
    await startWatching(agent, dir, "fixture-session", channel, discord, opts);
    // Append and re-register in the same tick, before fs.watch has consumed the new line.
    appendFileSync(sessionFile, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
      message: { content: [{ type: "text", text: "must survive reconnect" }] } }) + "\n");
    await startWatching(agent, dir, "fixture-session", channel, discord, opts);
    expect((await drainChannelWatcher(channel, discord)).text).toBe("must survive reconnect");
  } finally {
    stopWatching(agent);
    resolve.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

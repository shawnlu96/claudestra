import { describe, expect, test } from "bun:test";
import {
  RECALL_HOOK_TIMEOUT_S,
  RECALL_MATCHER,
  ensureRecallHook,
  handoffPath,
  hasRecallHook,
  isRecallHookCommand,
  memoryDir,
  projectSlug,
  removeRecallHook,
  type ClaudeSettings,
} from "../src/lib/session-recall";

const CMD = "/Users/x/.bun/bin/bun /Users/x/repos/claude-orchestrator/src/hooks/recall-hook.ts";

describe("projectSlug / handoffPath", () => {
  test("mirrors Claude Code's ~/.claude/projects naming (every non-alnum → '-')", () => {
    expect(projectSlug("/Users/shawn/repos/claude-orchestrator")).toBe("-Users-shawn-repos-claude-orchestrator");
    // dotted dirs: `.claude-orchestrator` → `-claude-orchestrator` with the slash's dash in front
    expect(projectSlug("/Users/shawn/.claude-orchestrator/master")).toBe("-Users-shawn--claude-orchestrator-master");
    expect(projectSlug("/private/tmp")).toBe("-private-tmp");
  });

  test("handoff lives in the auto-memory dir of that cwd", () => {
    expect(memoryDir("/Users/shawn/mem0-mcp", "/Users/shawn")).toBe("/Users/shawn/.claude/projects/-Users-shawn-mem0-mcp/memory");
    expect(handoffPath("/Users/shawn/mem0-mcp", "/Users/shawn")).toBe("/Users/shawn/.claude/projects/-Users-shawn-mem0-mcp/memory/HANDOFF.md");
  });
});

describe("ensureRecallHook", () => {
  test("adds a SessionStart entry to empty settings", () => {
    const s: ClaudeSettings = {};
    expect(ensureRecallHook(s, CMD)).toBe(true);
    expect(s.hooks!.SessionStart).toEqual([
      { matcher: RECALL_MATCHER, hooks: [{ type: "command", command: CMD, timeout: RECALL_HOOK_TIMEOUT_S }] },
    ]);
    expect(hasRecallHook(s)).toBe(true);
  });

  test("is idempotent and leaves other hooks alone", () => {
    const s: ClaudeSettings = {
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "bun typing-hook.ts" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };
    expect(ensureRecallHook(s, CMD)).toBe(true);
    expect(ensureRecallHook(s, CMD)).toBe(false);
    expect(s.hooks!.SessionStart).toHaveLength(2);
    expect(s.hooks!.SessionStart[0]).toEqual({ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] });
    expect(s.hooks!.Stop).toHaveLength(1);
  });

  test("rewrites an existing recall entry in place (old bun path / stale matcher)", () => {
    const s: ClaudeSettings = {
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "bun /old/src/hooks/recall-hook.ts" }] }] },
    };
    expect(ensureRecallHook(s, CMD)).toBe(true);
    expect(s.hooks!.SessionStart).toHaveLength(1);
    expect(s.hooks!.SessionStart[0].matcher).toBe(RECALL_MATCHER);
    expect(s.hooks!.SessionStart[0].hooks[0]).toEqual({ type: "command", command: CMD, timeout: RECALL_HOOK_TIMEOUT_S });
  });

  test("isRecallHookCommand only matches our hook script", () => {
    expect(isRecallHookCommand(CMD)).toBe(true);
    expect(isRecallHookCommand("bun typing-hook.ts")).toBe(false);
    expect(isRecallHookCommand(undefined)).toBe(false);
  });
});

describe("removeRecallHook", () => {
  test("drops our command, keeps foreign SessionStart hooks, deletes the key when empty", () => {
    const s: ClaudeSettings = {};
    ensureRecallHook(s, CMD);
    expect(removeRecallHook(s)).toBe(true);
    expect(s.hooks!.SessionStart).toBeUndefined();
    expect(removeRecallHook(s)).toBe(false);

    const mixed: ClaudeSettings = {
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }, { type: "command", command: CMD }] }] },
    };
    expect(removeRecallHook(mixed)).toBe(true);
    expect(mixed.hooks!.SessionStart).toEqual([{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }]);
    expect(hasRecallHook(mixed)).toBe(false);
  });
});

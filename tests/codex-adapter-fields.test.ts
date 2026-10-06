// 自研 Codex 适配器的字段映射（CX-3）：命令标题 / kind / locations、plan、usage_update、prompt 回包的 usage 与 _meta.quota，
// 形状对着 codex-acp 2.1.0 发给 AIR 宿主的那份，并经宿主真用的翻译器（lib/acp/updates.ts）核对宿主拿到的条目。
import { describe, expect, test } from "bun:test";
import { commandFacts, promptUsage, stripShellPrefix } from "../src/lib/acp/codex-adapter/events.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { harness, type Rec, until } from "./helpers/codex-fake-app.ts";

describe("命令的标题与 kind（2.1.0 commandActionFacts）", () => {
  test("stripShellPrefix：去掉 bash / zsh / sh 和 -lc，单引号整段包着的去引号", () => {
    expect(stripShellPrefix("/bin/zsh -lc 'echo hi'")).toBe("echo hi");
    expect(stripShellPrefix("bash -lc ls")).toBe("ls");
    expect(stripShellPrefix("sh -c 'a' && 'b'")).toBe("a' && 'b");
    expect(stripShellPrefix("echo hi")).toBe("echo hi");
  });

  test("单个 read / search / listFiles 动作按它出 kind、标题、locations；多个动作或 unknown 当终端命令", () => {
    const cmd = "/bin/zsh -lc 'cat a.txt'";
    expect(commandFacts(cmd, "/w", [{ type: "read", command: "cat a.txt", path: "/w/a.txt" }])).toEqual({ kind: "read", title: "Read file '/w/a.txt'", locations: [{ path: "/w/a.txt" }] });
    expect(commandFacts(cmd, "/w", [{ type: "search", query: "needle", path: "src" }])).toEqual({ kind: "search", title: "Search for 'needle' in src" });
    expect(commandFacts(cmd, "/w", [{ type: "search", query: null, path: null }])).toEqual({ kind: "search", title: "Search" });
    expect(commandFacts(cmd, "/w", [{ type: "listFiles", path: null }])).toEqual({ kind: "read", title: "List files" });
    expect(commandFacts(cmd, "/w", [{ type: "unknown", command: "echo hi" }])).toEqual({ kind: "execute", title: "echo hi", rawInput: { command: "echo hi", cwd: "/w" } });
    const two = [{ type: "read", path: "/w/a" }, { type: "read", path: "/w/b" }];
    expect(commandFacts(cmd, "/w", two)).toEqual({ kind: "execute", title: "cat a.txt", rawInput: { command: cmd, cwd: "/w" } });
  });
});

describe("回合里的更新经宿主翻译器", () => {
  async function turnWith(feed: (turnId: string, h: ReturnType<typeof harness>) => void) {
    const h = harness();
    await h.open();
    h.f.on("turn/start", (_p, id) => {
      const turnId = (h.f.turn = h.f.nextTurn());
      h.f.feed({ id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      h.f.started(turnId);
      feed(turnId, h);
      h.f.complete(turnId);
      return undefined;
    });
    await h.session.prompt("go");
    const tr = createAcpTranslator(() => "t");
    return { h, entries: [...h.updates.flatMap((u) => tr.push(u)), ...tr.flush()] };
  }
  const item = (h: ReturnType<typeof harness>, turnId: string, method: string, it: Rec) => h.f.note(method, { threadId: "th-1", turnId, item: it });

  test("读文件的命令 → Read（file_path 来自 locations）；终端命令 → Bash，标题去了 shell 前缀", async () => {
    const readAction = { type: "read", command: "cat a.txt", name: "a.txt", path: "/w/a.txt" };
    const read = { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'cat a.txt'", cwd: "/w", status: "inProgress", commandActions: [readAction] };
    const run = { type: "commandExecution", id: "c2", command: "/bin/zsh -lc 'echo hi'", cwd: "/w", status: "inProgress", commandActions: [{ type: "unknown", command: "echo hi" }] };
    const { entries } = await turnWith((t, h) => {
      item(h, t, "item/started", read);
      item(h, t, "item/completed", { ...read, status: "completed", exitCode: 0, aggregatedOutput: "x" });
      item(h, t, "item/started", run);
      item(h, t, "item/completed", { ...run, status: "completed", exitCode: 0, aggregatedOutput: "hi\n" });
    });
    const uses = entries.map((e) => e.message?.content?.[0]).filter((c) => c?.type === "tool_use");
    expect(uses.map((u) => [u.name, u.input])).toEqual([["Read", { file_path: "/w/a.txt" }], ["Bash", { command: "echo hi" }]]);
  });

  test("turn/plan/updated → plan（inProgress 改 in_progress）→ 宿主的 update_plan", async () => {
    const plan = [{ step: "一", status: "completed" }, { step: "二", status: "inProgress" }];
    const { h, entries } = await turnWith((t, hh) => hh.f.note("turn/plan/updated", { threadId: "th-1", turnId: t, explanation: null, plan }));
    expect(h.updates.find((u) => u.sessionUpdate === "plan")).toEqual({
      sessionUpdate: "plan", entries: [{ content: "一", status: "completed", priority: "medium" }, { content: "二", status: "in_progress", priority: "medium" }],
    });
    const use = entries.find((e) => e.message?.content?.[0]?.name === "update_plan")?.message.content[0];
    expect(use.input).toEqual({ plan: [{ step: "一", status: "completed" }, { step: "二", status: "in_progress" }] });
  });
});

const LAST = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, outputTokens: 15, reasoningOutputTokens: 5 };

describe("用量", () => {
  test("thread/tokenUsage/updated → usage_update（used = last.totalTokens，size = 窗口；没窗口不发）；prompt 回包带 usage 和 _meta.quota", async () => {
    const h = harness();
    await h.open();
    h.f.on("turn/start", (_p, id) => {
      const turnId = (h.f.turn = h.f.nextTurn());
      h.f.feed({ id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      h.f.started(turnId);
      const usage = (w: number | null) => h.f.note("thread/tokenUsage/updated", { threadId: "th-1", turnId, tokenUsage: { last: LAST, total: LAST, modelContextWindow: w } });
      usage(null);
      usage(258_400);
      h.f.complete(turnId);
      return undefined;
    });
    await h.session.prompt("go");
    expect(h.updates.filter((u) => u.sessionUpdate === "usage_update")).toEqual([{ sessionUpdate: "usage_update", used: 120, size: 258_400 }]);
    const tr = createAcpTranslator(() => "t");
    expect(h.updates.flatMap((u) => tr.push(u)).filter((e) => e.subtype === "context_usage")).toEqual([{ type: "system", subtype: "context_usage", timestamp: "t", tokens: 120, window: 258_400 }]);
    await until(() => h.out().some((m) => m.result?.stopReason === "end_turn"), "prompt 回包");
    const res = h.out().find((m) => m.result?.stopReason === "end_turn")!.result;
    expect(res.usage).toEqual({ totalTokens: 120, inputTokens: 60, cachedReadTokens: 40, outputTokens: 15, thoughtTokens: 5 });
    expect(res._meta.quota.model_usage).toEqual([{ model: "gpt-x", token_count: { totalTokens: 120, inputTokens: 60, cachedInputTokens: 40, outputTokens: 15, reasoningOutputTokens: 5 } }]);
  });

  test("promptUsage：还没有用量时 usage 为 null、model_usage 为空；模型名去掉方括号后缀", () => {
    expect(promptUsage(null, "m")).toEqual({ usage: null, _meta: { quota: { token_count: null, model_usage: [] } } });
    expect((promptUsage(LAST, "gpt-x[1m]")._meta as Rec).quota.model_usage[0].model).toBe("gpt-x");
  });
});

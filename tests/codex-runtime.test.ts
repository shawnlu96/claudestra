/**
 * Codex 适配器的生命周期契约（P3c）：外部动作全经 CodexAdapterDeps 注入，窗口是假的。
 * 真 Codex 的端到端见 scripts/codex-adapter-e2e.ts。
 */
import { describe, expect, test } from "bun:test";
import { BOOTSTRAP_MARKER, codexContextPreamble, codexDeveloperInstructions } from "../src/lib/codex-launch.js";
import { codexLineToClaudeShape } from "../src/lib/codex-session.js";
import {
  CONTEXT_PREAMBLE_MARKER,
  CodexQueueSink,
  decodePreambleEnv,
  encodePreambleEnv,
  type CmdResult,
} from "../src/lib/codex-thread.js";
import { bridgePortOf, codexAdapter, createCodexAdapter, type CodexAdapterDeps } from "../src/lib/runtimes/codex.js";
import { managedFor, type LaunchSpec, type WindowOps } from "../src/lib/runtimes/index.js";
import { createLineTranslator, translateSessionLine } from "../src/lib/session-source.js";

const SID = "019a0000-1111-7222-8333-444455556666";
const OTHER = "019a0000-9999-7222-8333-444455556666";

function deps(over: Partial<CodexAdapterDeps> = {}): Partial<CodexAdapterDeps> {
  return {
    run: async () => ({ ok: true, out: "", err: "" }),
    resolveBin: async () => "/opt/codex/bin/codex",
    execBootstrap: async () => ({ code: 0, out: `{"type":"thread.started","thread_id":"${SID}"}\n{"type":"turn.completed"}\n`, err: "" }),
    childPids: async () => [4242],
    heldThreadIds: async () => [SID],
    sessionCwd: () => "/work/from-rollout",
    bunBin: "/usr/local/bin/bun",
    repoRoot: "/repo",
    now: () => 0,
    ...over,
  };
}

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  mode: "new",
  channelId: "123",
  bridgeUrl: "ws://localhost:3999",
  sessionId: "ignored-before-bootstrap",
  agentName: "agent-cx",
  purpose: "写测试",
  cwd: "/work/dir",
  ...over,
});

function fakeWindow(panes: string[], opts: Record<string, string> = {}) {
  const keys: string[] = [];
  const lines: string[] = [];
  let i = 0;
  const win: WindowOps = {
    name: "agent-cx",
    target: "master:agent-cx",
    capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
    sendLine: async (t) => { lines.push(t); },
    sendLiteral: async (t) => { lines.push(t); },
    sendKey: async (k) => { keys.push(k); },
    sendEscape: async () => { keys.push("Escape"); },
    getOption: async (k) => opts[k] ?? null,
    setOption: async (k, v) => { opts[k] = v; return true; },
    childPids: async () => [],
    sleep: async () => {},
  };
  return { win, keys, lines, opts };
}

describe("注册与声明", () => {
  test("managedFor('codex') 是可启动的 Codex 适配器", () => {
    const a = managedFor("codex")!;
    expect(a).toBe(codexAdapter);
    expect(a.manageable).toBe(true);
    expect(a.exitCommand).toBe("/quit");
    expect(a.noteTag).toBe("codex");
    expect(a.registryFields(spec())).toEqual({ runtime: "codex" });
  });

  test("会话 id 只收 UUID（Codex 的 thread id）", () => {
    expect(codexAdapter.isValidSessionId(SID)).toBe(true);
    expect(codexAdapter.isValidSessionId("my-thread")).toBe(false);
  });

  test("bridge 端口从 BRIDGE_URL 取（typing-hook 靠它找 bridge）", () => {
    expect(bridgePortOf("ws://127.0.0.1:38591")).toBe("38591");
  });
});

describe("available", () => {
  test("找不到 codex → 可操作的提示", async () => {
    const r = await createCodexAdapter(deps({ resolveBin: async () => null })).available();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/npm i -g @openai\/codex/);
  });

  test("没有 queue 子命令（旧版）→ 提示升级", async () => {
    const r = await createCodexAdapter(deps({ run: async () => ({ ok: false, out: "", err: "unknown" }) })).available();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/codex queue.*升级/s);
  });

  test("可用时缓存结果（bridge 的 /runtimes 不会每次都拉登录 shell）", async () => {
    let n = 0;
    const a = createCodexAdapter(deps({ resolveBin: async () => { n++; return "/x/codex"; } }));
    expect((await a.available()).ok).toBe(true);
    expect((await a.available()).ok).toBe(true);
    expect(n).toBe(1);
  });
});

describe("prepareSession", () => {
  test("new：exec 引导拿 thread id，不挂 claudestra MCP / hooks，在目标目录跑", async () => {
    let seen: { argv: string[]; cwd: string } | null = null;
    const a = createCodexAdapter(deps({ execBootstrap: async (argv, cwd) => { seen = { argv, cwd }; return { code: 0, out: `{"type":"thread.started","thread_id":"${SID}"}`, err: "" }; } }));
    expect(await a.prepareSession!(spec())).toEqual({ sessionId: SID });
    expect(seen!.cwd).toBe("/work/dir");
    const joined = seen!.argv.join(" ");
    expect(seen!.argv.slice(0, 3)).toEqual(["/opt/codex/bin/codex", "exec", "--json"]);
    expect(joined).not.toContain("mcp_servers");
    expect(joined).not.toContain("hooks.");
    expect(joined).toContain("写测试");
    expect(seen!.argv.at(-1)).toContain(BOOTSTRAP_MARKER);
  });

  test("resume / fork：原样返回，不跑 exec", async () => {
    let ran = false;
    const a = createCodexAdapter(deps({ execBootstrap: async () => { ran = true; return { code: 0, out: "", err: "" }; } }));
    expect(await a.prepareSession!(spec({ mode: "resume", sessionId: SID }))).toEqual({ sessionId: SID });
    expect(await a.prepareSession!(spec({ mode: "fork", sessionId: SID }))).toEqual({ sessionId: SID });
    expect(ran).toBe(false);
  });

  test("引导失败带 stderr 末行报错；只支持 bypassPermissions", async () => {
    const a = createCodexAdapter(deps({ execBootstrap: async () => ({ code: 1, out: "", err: "boom\nnot logged in" }) }));
    await expect(a.prepareSession!(spec())).rejects.toThrow(/not logged in/);
    await expect(codexAdapter.prepareSession!(spec({ permissionMode: "acceptEdits" }))).rejects.toThrow(/只支持 bypassPermissions/);
    await expect(createCodexAdapter(deps()).prepareSession!(spec({ cwd: undefined }))).rejects.toThrow(/工作目录/);
  });
});

describe("buildLaunchCommand", () => {
  test("resume / fork 子命令；cwd 缺省取 rollout 首行；resume 带职责前言环境变量", async () => {
    const a = createCodexAdapter(deps());
    await a.available();
    const resume = a.buildLaunchCommand(spec({ mode: "resume", sessionId: SID, cwd: undefined }));
    expect(resume).toContain(`/opt/codex/bin/codex resume ${SID} `);
    expect(resume).toContain("/work/from-rollout");
    expect(resume).toContain("CLAUDESTRA_CODEX_PREAMBLE=");
    expect(resume).toContain("BRIDGE_PORT=3999 ");
    const fork = a.buildLaunchCommand(spec({ mode: "fork", sessionId: SID }));
    expect(fork).toContain(`/opt/codex/bin/codex fork ${SID} `);
    const fresh = a.buildLaunchCommand(spec({ mode: "new", sessionId: SID }));
    expect(fresh).toContain(`/opt/codex/bin/codex resume ${SID} `);
    expect(fresh).not.toContain("CLAUDESTRA_CODEX_PREAMBLE=");
  });

  test("codex 路径没解析过就报错（不拿裸 codex 碰运气）", () => {
    const prev = process.env.CODEX_TUI_BIN;
    delete process.env.CODEX_TUI_BIN;
    try {
      expect(() => createCodexAdapter(deps()).buildLaunchCommand(spec({ mode: "resume", sessionId: SID }))).toThrow(/尚未解析/);
    } finally {
      if (prev !== undefined) process.env.CODEX_TUI_BIN = prev;
    }
  });
});

describe("beforeLaunch / waitReady", () => {
  const budget = { rounds: 20, pollMs: 1 };

  test("beforeLaunch 清就绪标记；标记为 1 即就绪", async () => {
    const a = createCodexAdapter(deps());
    const w = fakeWindow(["~ %"], { "@claudestra_ready": "1" });
    await a.beforeLaunch!(w.win);
    expect(w.opts["@claudestra_ready"]).toBe("0");
    w.opts["@claudestra_ready"] = "1";
    expect(await a.waitReady(w.win, budget)).toEqual({ ready: true });
  });

  test("active writer → occupied（restart 据此改 fork）", async () => {
    const a = createCodexAdapter(deps());
    const w = fakeWindow(["~ %", "~ %", `Error: thread ${SID} already has an active writer\n~ %`]);
    await a.beforeLaunch!(w.win);
    const r = await a.waitReady(w.win, budget);
    expect(r).toMatchObject({ ready: false, reason: "occupied" });
  });

  test("三种对话框 → blocked-dialog 立即失败，绝不按键", async () => {
    for (const text of ["Hooks need review", "Do you trust the contents of this directory?", "✨ Update available! 0.153 -> 0.160"]) {
      const a = createCodexAdapter(deps());
      const w = fakeWindow(["~ %", `>_ OpenAI Codex\n${text}\n› 1. Update now`]);
      await a.beforeLaunch!(w.win);
      const r = await a.waitReady(w.win, budget);
      expect(r).toMatchObject({ ready: false, reason: "blocked-dialog" });
      expect(w.keys).toEqual([]);
      expect(w.lines).toEqual([]);
    }
  });

  test("复用窗口：上一次启动留在 pane 里的 active writer 不算数", async () => {
    const a = createCodexAdapter(deps());
    const stale = `Error: thread ${SID} already has an active writer\n~ %`;
    const w = fakeWindow([stale, stale, `${stale}\n>_ OpenAI Codex (loading)`], {});
    await a.beforeLaunch!(w.win);
    setTimeout(() => { w.opts["@claudestra_ready"] = "1"; }, 0);
    const r = await a.waitReady(w.win, { rounds: 3, pollMs: 1 });
    expect(r.ready === true || (r.ready === false && r.reason !== "occupied")).toBe(true);
  });

  test("提示符后面跟着刚键入的命令、codex 子进程还在 → 不算 exited", async () => {
    const a = createCodexAdapter(deps());
    const w = fakeWindow(["➜  work git:(main) DISCORD_CHANNEL_ID=1 /opt/codex resume x"]);
    w.win.childPids = async () => [4242];
    await a.beforeLaunch!(w.win);
    expect(await a.waitReady(w.win, { rounds: 8, pollMs: 1 })).toMatchObject({ ready: false, reason: "timeout" });
  });

  test("回到 shell → exited（不等满预算）", async () => {
    const a = createCodexAdapter(deps());
    const w = fakeWindow(["codex: error: not logged in\n➜  work git:(main)"]);
    await a.beforeLaunch!(w.win);
    expect(await a.waitReady(w.win, budget)).toMatchObject({ ready: false, reason: "exited" });
  });
});

describe("discoverSessionId", () => {
  test("pane 子进程持有的线程锁，排除源 id", async () => {
    const a = createCodexAdapter(deps({ heldThreadIds: async () => [SID, OTHER] }));
    expect(await a.discoverSessionId!({ windowName: "agent-cx", cwd: "/w", exclude: SID, timeoutMs: 0 })).toEqual({
      sessionId: OTHER,
      via: "thread-writer-lock",
    });
  });

  test("没有锁 → null", async () => {
    const a = createCodexAdapter(deps({ heldThreadIds: async () => [] }));
    expect(await a.discoverSessionId!({ windowName: "agent-cx", cwd: "/w", timeoutMs: 0 })).toBeNull();
  });
});

describe("职责前言（重启 / 收编后第一条投递）", () => {
  test("前言与 developer_instructions 同源", () => {
    const opts = { agentName: "agent-cx", purpose: "审 PR", projectContext: "project: p1" };
    const pre = codexContextPreamble(opts);
    const di = codexDeveloperInstructions({ ...opts, channelRules: "RULES" });
    expect(pre.startsWith(CONTEXT_PREAMBLE_MARKER)).toBe(true);
    for (const part of ["agent「agent-cx」", "审 PR", "project: p1", "reply 工具"]) {
      expect(pre).toContain(part);
      expect(di).toContain(part);
    }
    expect(pre).not.toContain("RULES");
  });

  test("环境变量编解码：换行引号都能过；不是我们的前言就丢", () => {
    const pre = codexContextPreamble({ agentName: "a", purpose: `x\n'y' "z"` });
    expect(decodePreambleEnv(encodePreambleEnv(pre))).toBe(pre);
    expect(decodePreambleEnv(encodePreambleEnv("hello"))).toBeUndefined();
    expect(decodePreambleEnv("")).toBeUndefined();
  });

  function sink(results: boolean[], preamble?: string) {
    const sent: string[] = [];
    const s = new CodexQueueSink({
      source: "claudestra",
      getSessionId: () => SID,
      heldThreadIds: async () => [SID],
      onSwitch: () => {},
      queue: async (_sid, text): Promise<CmdResult> => {
        sent.push(text);
        return { ok: results.shift() ?? true, out: "", err: "fail" };
      },
      notify: async () => {},
      preamble,
    });
    return { s, sent };
  }

  test("只附在第一条成功投递上；失败不算用掉", async () => {
    const pre = codexContextPreamble({ agentName: "a", purpose: "p" });
    const { s, sent } = sink([false, true, true], pre);
    await s.deliver("one", { chat_id: "1" });
    await s.deliver("two", { chat_id: "1" });
    await s.deliver("three", { chat_id: "1" });
    expect(sent[0].startsWith(CONTEXT_PREAMBLE_MARKER)).toBe(true);
    expect(sent[1].startsWith(CONTEXT_PREAMBLE_MARKER)).toBe(true);
    expect(sent[1]).toContain("two");
    expect(sent[2].startsWith("<channel ")).toBe(true);
  });

  test("没有前言（new 模式）= 与 P3b 行为一致", async () => {
    const { s, sent } = sink([true]);
    await s.deliver("one", { chat_id: "1" });
    expect(sent[0].startsWith("<channel ")).toBe(true);
  });

  test("历史翻译剥掉前言，只留 <channel> 消息", () => {
    const pre = codexContextPreamble({ agentName: "a", purpose: "p" });
    const text = `${pre}\n\n<channel source="claudestra" chat_id="1">\nhi\n</channel>`;
    const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    const rec = codexLineToClaudeShape(line)!;
    expect(rec.isMeta).toBe(true);
    // 前言正文里也提到「<channel …>」——剥的必须是 sink 拼上的那个标签，不是前言里的字样
    expect(pre).toContain("<channel …>");
    expect(String(rec.message.content)).toBe(`<channel source="claudestra" chat_id="1">\nhi\n</channel>`);
  });
});

describe("有状态翻译（每文件一份状态）", () => {
  const ev = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });
  const lines = [
    ev("session_meta", { id: SID, cwd: "/w" }),
    ev("event_msg", { type: "task_started" }),
    ev("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `${BOOTSTRAP_MARKER} 只回复 OK` }] }),
    ev("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }),
    ev("event_msg", { type: "task_started" }),
    ev("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "真问题" }] }),
    ev("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "真回答" }] }),
  ];

  test("引导轮的 assistant OK 被丢掉；无状态近似做不到", () => {
    const t = createLineTranslator("codex");
    const stateful = lines.map((l) => t(l)).filter(Boolean).map((r) => JSON.stringify(r));
    expect(stateful.some((s) => s.includes('"OK"'))).toBe(false);
    expect(stateful.some((s) => s.includes("真回答"))).toBe(true);
    const stateless = lines.map((l) => translateSessionLine("codex", l)).filter(Boolean).map((r) => JSON.stringify(r));
    expect(stateless.some((s) => s.includes('"OK"'))).toBe(true);
  });

  test("translateSessionLine 按 scope 共享状态；CC / Pi 与无状态逐条一致", () => {
    const scope = {};
    const scoped = lines.map((l) => translateSessionLine("codex", l, scope)).filter(Boolean).map((r) => JSON.stringify(r));
    expect(scoped.some((s) => s.includes('"OK"'))).toBe(false);
    const cc = JSON.stringify({ type: "user", message: { content: "hi" } });
    expect(translateSessionLine(undefined, cc, {})).toEqual(translateSessionLine(undefined, cc));
    expect(translateSessionLine("pi", cc, {})).toEqual(translateSessionLine("pi", cc));
  });
});

/**
 * Pi 适配器契约测试：宿主真用的 AcpSession / 翻译器 ↔ 适配器（真代码）↔ 回放录下来的 pi 0.99.1 rpc 流。
 * 夹具 tests/fixtures/pi-rpc-0.99.1.jsonl 是真 pi（deepseek-v4-flash、隔离的 PI_CODING_AGENT_DIR）经 tap 外壳按到达顺序录的
 * {d:"in"|"out", r}：in = 适配器发给 pi 的命令，out = pi 的输出。录完删掉了适配器不读的 thinking_delta / toolcall_delta 和
 * system 消息（提示词全文），agent_end.messages 清空，思考正文换成 …，路径换成 /rec；打断前那一对 clear_queue（p20q）是后补的（录制时适配器
 * 还只发 abort），回包形状照 pi rpc 文档。回放时适配器发出的每条命令（除 id）必须与录的逐字相同，
 * pi 的输出按段一次性整块吐出（最严的交错）。pi 升级后要重录；场景与下面的步骤一一对应。
 */
import { describe, expect, test } from "bun:test";
import { PI_MCP_SERVERS_ENV } from "../src/lib/acp/pi-adapter/mcp-mount.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { assistant, cmd, CWD, FIXTURE, harness, ok, out, promptLine, STARTUP, until, type Rec } from "./acp-contract/pi-replay.ts";

const status = (u: Rec) => u?._meta?.claudestra?.threadStatus?.type;

describe("Pi 适配器 · 回放 pi 0.99.1 录制流（契约）", () => {
  test("新建 → 工具回合（bash + mcp reply）→ 切思考档 / 模型 → 空闲插话 → 忙时插话 → 打断", async () => {
    const h = harness(FIXTURE);
    const { session, updates } = h;
    expect(await session.initialize()).toEqual({ resume: true, fork: false });
    expect(session.steering).toBe(true);

    // 录制时 session/new 带的是假 MCP server：宿主的 AcpSession 构造时给定的 mcpServers，create / resume 都带它
    expect(await session.create(CWD)).toBe("sid-replay");
    const mounted = { claudestra: { command: "/bin/bun-rec", args: ["/rec/fake-mcp.ts"], env: { FAKE_MCP_LOG: "/rec/mcp.log" } } };
    expect(h.opened).toEqual([{ sessionId: "sid-replay", cwd: CWD, env: { [PI_MCP_SERVERS_ENV]: JSON.stringify(mounted) } }]);
    expect(session.configOptions.map((o) => [o.id, o.currentValue, o.choices.map((c) => c.value)])).toEqual([
      ["model", "cc-switch-deep-seek/deepseek-v4-flash", ["cc-switch-deep-seek/deepseek-flash", "cc-switch-deep-seek/deepseek-v4-flash"]],
      ["reasoning_effort", "high", ["off", "high", "max"]],
    ]);

    // 1. 工具回合：宿主的翻译器翻出 Bash + mcp__claudestra__reply + 正文 done
    const t1 = updates.length;
    const turn1 = "Step 1: run the shell command `echo contract-ok` with the bash tool. Step 2: call the mcp__claudestra__reply tool with text \"pong\". Step 3: answer with exactly the word: done";
    expect(await session.prompt(turn1)).toEqual({ kind: "done" });
    const tr = createAcpTranslator(() => "T");
    const entries = [...updates.slice(t1).flatMap((u) => tr.push(u)), ...tr.flush()];
    const blocks = entries.map((e) => e.message?.content?.[0]).filter(Boolean);
    expect(blocks.filter((b) => b.type === "tool_use").map((b) => [b.name, b.input])).toEqual([
      ["Bash", { command: "echo contract-ok" }], ["mcp__claudestra__reply", { text: "pong" }],
    ]);
    expect(blocks.filter((b) => b.type === "tool_result").map((b) => b.content).sort()).toEqual(["contract-ok\n", "sent"]);
    expect(blocks.filter((b) => b.type === "text").map((b) => b.text.trim())).toEqual(["done"]);
    expect(updates.slice(t1).map(status).filter(Boolean)).toEqual(["active", "idle"]);
    await until(() => updates.some((u) => u.sessionUpdate === "usage_update"), "第一回合的 usage_update");

    // 2. 思考档 / 模型：本地校验 + set_* 之后以 pi 回报的 get_state 为准
    expect(await session.setConfig("reasoning_effort", "low")).toMatchObject({ ok: false });
    expect(await session.setConfig("reasoning_effort", "max")).toEqual({ ok: true });
    expect(await session.setConfig("model", "cc-switch-deep-seek/deepseek-flash")).toEqual({ ok: true });
    expect(session.configOptions.map((o) => [o.id, o.currentValue])).toEqual([["model", "cc-switch-deep-seek/deepseek-flash"], ["reasoning_effort", "max"]]);

    // 3. 空闲时插话：pi 另起一轮 → startedNewTurn；回包必须先于这一轮的 idle 到宿主（宿主按回包那一刻的序号等 idle），
    //    这一轮的结束靠宿主认出中性的 _meta.claudestra.threadStatus（updates.ts threadStatusOf）
    const steer1 = await session.steer("Answer with exactly the word: ok");
    expect(steer1.outcome).toBe("startedNewTurn");
    const ended = steer1.outcome === "startedNewTurn" ? steer1.done : Promise.resolve(null);
    expect(await Promise.race([ended, Bun.sleep(3_000).then(() => "等不到插话那一轮的 idle")])).toEqual({ kind: "done" });

    // 4. 忙时插话：排进在跑的回合 → injected，回合照常结束
    const t4 = updates.length;
    const turn2 = session.prompt("Run `sleep 3` with the bash tool, then answer with exactly the word: done");
    await until(() => updates.slice(t4).some((u) => u.sessionUpdate === "tool_call"), "sleep 3 的工具调用");
    expect(await session.rpc.request<Rec>("_session/steering", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Also append the word: steered" }] })).toEqual({ outcome: "injected" });
    expect(await turn2).toEqual({ kind: "done" });

    // 5. 打断：_claudestra/cancel → clear_queue 再 abort，bash 当场失败，回合 cancelled
    const t5 = updates.length;
    const turn3 = session.prompt("Run `sleep 30` with the bash tool, then answer with exactly the word: finished");
    await until(() => updates.slice(t5).some((u) => u.sessionUpdate === "tool_call"), "sleep 30 的工具调用");
    expect(await session.cancel()).toEqual({ cleared: [], clearedIds: [] });
    expect(await turn3).toEqual({ kind: "cancelled" });
    expect(updates.slice(t5).find((u) => u.sessionUpdate === "tool_call_update")).toMatchObject({ status: "failed", content: [{ content: { text: "Command aborted" } }] });

    await until(() => h.pi.done(), "夹具全部回放完");
    expect(h.pi.mismatches).toEqual([]);
    const usage = () => updates.filter((u) => u.sessionUpdate === "usage_update");
    await until(() => usage().length === 4, "四个回合各一条 usage_update");
    expect(usage().every((u) => u.used > 0 && u.size === 1_000_000)).toBe(true);
    h.hostWire.close("host exit");
    await until(() => h.exits.length > 0, "适配器退出");
    expect(h.exits).toEqual([0]);
  });
});


async function created(h: ReturnType<typeof harness>) {
  await h.session.initialize();
  await h.session.create(CWD);
}

describe("Pi 适配器 · 手写的边界流", () => {
  test("扩展弹框一律回取消（带原 id），通知类不回；回合照常结束", async () => {
    const h = harness([
      ...STARTUP, promptLine("p4", "hi"),
      ok("p4", "prompt", { disposition: "started" }), out({ type: "agent_start" }),
      out({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "rm?" }),
      out({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "fyi" }),
      cmd({ type: "extension_ui_response", id: "ui-1", cancelled: true }),
      out({ type: "message_start", message: { role: "assistant", content: [] } }), assistant({ content: [{ type: "text", text: "ok" }] }), out({ type: "agent_settled" }),
      cmd({ type: "get_session_stats", id: "p5" }), ok("p5", "get_session_stats", { contextUsage: { tokens: 10, contextWindow: 100 } }),
    ]);
    await created(h);
    expect(await h.session.prompt("hi")).toEqual({ kind: "done" });
    await until(() => h.pi.done(), "夹具回放完");
    expect(h.pi.mismatches).toEqual([]);
    expect(h.logs.some((l) => l.includes("confirm") && l.includes("取消"))).toBe(true);
  });

  test("回合以 provider 错误收尾 → JSON-RPC 错误，宿主记成失败并带上原因", async () => {
    const h = harness([
      ...STARTUP, promptLine("p4", "boom"),
      ok("p4", "prompt", { disposition: "started" }), out({ type: "agent_start" }),
      assistant({ stopReason: "error", errorMessage: "529 overloaded" }), out({ type: "agent_end", messages: [], willRetry: false }), out({ type: "agent_settled" }),
      cmd({ type: "get_session_stats", id: "p5" }), ok("p5", "get_session_stats", {}),
    ]);
    await created(h);
    expect(await h.session.prompt("boom")).toMatchObject({ kind: "failed", failure: { kind: "error", message: "Pi 回合失败：529 overloaded" } });
    await until(() => h.pi.done(), "夹具回放完");
    expect(h.pi.mismatches).toEqual([]);
  });

  test("扩展命令当场处理（handled）不等 settled；pi 回合中途退出 → 在等的回合失败、适配器以 1 退出", async () => {
    const h = harness([
      ...STARTUP, promptLine("p4", "/claudestra-thinking off"), ok("p4", "prompt", { disposition: "handled" }),
      promptLine("p5", "long"), ok("p5", "prompt", { disposition: "started" }), out({ type: "agent_start" }),
    ]);
    await created(h);
    expect(await h.session.prompt("/claudestra-thinking off")).toEqual({ kind: "done" });
    const long = h.session.prompt("long");
    await until(() => h.updates.some((u) => status(u) === "active"), "long 回合开始");
    h.pi.crash("exit 137");
    expect(await long).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("pi 退出了（exit 137）") } });
    expect(h.exits).toEqual([1]);
  });

  test("回合还在等时来了 session/new（/clear）：那一轮以错误结束、不悬着；旧 pi 被带走，新 pi 接上，适配器不退出", async () => {
    const h = harness([...STARTUP, promptLine("p4", "long"), ok("p4", "prompt", { disposition: "started" }), out({ type: "agent_start" })], STARTUP);
    await created(h);
    const long = h.session.prompt("long");
    await until(() => h.updates.some((u) => status(u) === "active"), "long 回合开始");
    await h.session.create(CWD);
    expect(await long).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("会话被换掉或关闭了") } });
    expect(h.pis.map((p) => [p.done(), p.mismatches])).toEqual([[true, []], [true, []]]);
    expect(h.exits).toEqual([]);
  });
});

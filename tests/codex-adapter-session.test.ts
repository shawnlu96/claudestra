// 自研 Codex 适配器的会话、配置与启动环境（CX-2）：会话代际（I11）、配置覆盖层、配置项、拒起。用例名前缀是设计里的 B / R 编号。
import { describe, expect, test } from "bun:test";
import { spawnAdapter } from "../src/lib/acp/adapter-proc.ts";
import { CODEX_ACP_ADAPTER_MAIN } from "../src/lib/acp/codex-adapter/main.ts";
import { applyConfig, configOptions, modelStateOf, parseAdapterEnv, threadConfig } from "../src/lib/acp/codex-adapter/session-config.ts";
import { classifyPromptError } from "../src/lib/acp/failures.ts";
import { AcpIncompatibleError } from "../src/lib/acp/protocol.ts";
import { RpcError } from "../src/lib/acp/rpc.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { fakeApp, harness, MODEL, tick, until } from "./helpers/codex-fake-app.ts";
import { testChildEnv } from "./test-env.ts";

const rpc = (s: AcpSession) => (s as unknown as { rpc: { request(m: string, p: unknown): Promise<any>; notify(m: string, p: unknown): void } }).rpc;
const NEW = { cwd: "/w", mcpServers: [] };
const OTHER = { ...MODEL, id: "gpt-y", model: "gpt-y", displayName: "GPT Y", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] };

describe("启动环境（B13、B15、B38）", () => {
  test("B38 INITIAL_AGENT_MODE 只认 4 个名字，认不出拒起；不设时同 2.1.0 用 agent", () => {
    const full = { ok: true, cfg: { policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } } };
    expect(parseAdapterEnv({ CODEX_PATH: "/c", INITIAL_AGENT_MODE: "agent-full-access" })).toMatchObject(full);
    expect(parseAdapterEnv({ CODEX_PATH: "/c" })).toMatchObject({ ok: true, cfg: { policy: { approvalPolicy: "on-request", approvalsReviewer: "auto_review" } } });
    expect(parseAdapterEnv({ CODEX_PATH: "/c", INITIAL_AGENT_MODE: "yolo" })).toMatchObject({ ok: false, why: expect.stringContaining("yolo") });
    expect(parseAdapterEnv({ INITIAL_AGENT_MODE: "agent" })).toMatchObject({ ok: false, why: expect.stringContaining("CODEX_PATH") });
    expect(parseAdapterEnv({ CODEX_PATH: "/c", CODEX_CONFIG: "{bad" })).toMatchObject({ ok: false, why: expect.stringContaining("CODEX_CONFIG") });
    expect(parseAdapterEnv({ CODEX_PATH: "/c", CODEX_CONFIG: "[1]" })).toMatchObject({ ok: false });
  });

  test("B38 环境不合格的真进程：initialize 回 data.fatal，宿主当协议不兼容（固定键、不重起），关 stdin 后退出码 0", async () => {
    const proc = spawnAdapter([process.execPath, CODEX_ACP_ADAPTER_MAIN], testChildEnv({ CODEX_PATH: "/nope/codex", INITIAL_AGENT_MODE: "yolo" }), process.cwd(), () => {});
    const session = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: () => {} });
    const err = await session.initialize().catch((e) => e);
    expect(err).toBeInstanceOf(AcpIncompatibleError);
    expect(err.message).toContain("INITIAL_AGENT_MODE=yolo");
    expect(classifyPromptError(err, "start#1")).toEqual({ kind: "error", key: "incompatible", message: err.message, retry: false });
    proc.stop();
    expect(await proc.exited).toBe(0);
  });

  test("B13 线程配置：CODEX_CONFIG 原样，加 trust / cwd_relative_turn_diffs；控制标记只写进每个 MCP server 自己的 env", () => {
    const overlay = { model: "m", features: { x: true }, mcp_servers: { claudestra: { command: "bun", args: ["cs.ts"], env_vars: ["A"], env: { K: "v" } } } };
    expect(threadConfig(overlay, "/w", ["CLAUDESTRA_ACP_CONTROL", "id1"])).toEqual({
      model: "m",
      features: { x: true, cwd_relative_turn_diffs: false },
      projects: { "/w": { trust_level: "trusted" } },
      mcp_servers: { claudestra: { command: "bun", args: ["cs.ts"], env_vars: ["A"], env: { K: "v", CLAUDESTRA_ACP_CONTROL: "id1" } } },
    });
    expect(threadConfig({}, "/w")).toEqual({ features: { cwd_relative_turn_diffs: false }, projects: { "/w": { trust_level: "trusted" } } });
  });
});

describe("会话（B6–B11、B14、B31）", () => {
  test("B6 B7 session/new：account/read → thread/start（config、modelProvider:null、cwd）→ model/list；sessionId 就是线程 id", async () => {
    const h = harness({ env: { CODEX_CONFIG: JSON.stringify({ mcp_servers: { claudestra: { command: "bun" } } }) } });
    h.f.thread = "th-new";
    await h.session.initialize();
    expect(await h.session.create("/w")).toBe("th-new");
    expect(h.f.sent.filter((m) => m.id !== undefined && m.method).map((m) => m.method)).toEqual(["initialize", "account/read", "thread/start", "model/list"]);
    expect(h.f.calls("thread/start")[0]).toEqual({
      config: { mcp_servers: { claudestra: { command: "bun", env: { CLAUDESTRA_ACP_CONTROL: "ctl" } } }, features: { cwd_relative_turn_diffs: false }, projects: { "/w": { trust_level: "trusted" } } },
      modelProvider: null,
      cwd: "/w",
    });
    expect(h.session.configOptions.map((o) => [o.id, o.currentValue])).toEqual([["model", "gpt-x"], ["reasoning_effort", "medium"]]);
  });

  test("B8 session/resume：config/read 的 model_provider、excludeTurns；B10 fork：新 id、退订、不切当前会话", async () => {
    const h = harness();
    await h.session.initialize();
    await h.session.attach("th-old", "/w", true);
    expect(h.f.calls("thread/resume")[0]).toMatchObject({ threadId: "th-old", cwd: "/w", excludeTurns: true, modelProvider: "fake" });
    const forked = await rpc(h.session).request("session/fork", { sessionId: "th-old", ...NEW });
    expect(forked.sessionId).toMatch(/^fork-/);
    expect(h.f.calls("thread/unsubscribe")).toEqual([{ threadId: forked.sessionId }]);
    h.f.on("turn/start", () => undefined);
    void h.session.prompt("还在旧线程");
    await until(() => h.f.calls("turn/start").length === 1, "turn/start");
    expect(h.f.calls("turn/start")[0].threadId).toBe("th-old");
  });

  test("B14 B52 ACP mcpServers 非空回 -32602；prompt 里不是 text 的块回 -32602", async () => {
    const h = harness();
    await h.session.initialize();
    await expect(rpc(h.session).request("session/new", { cwd: "/w", mcpServers: [{ name: "x" }] })).rejects.toMatchObject({ code: -32602 });
    await h.session.create("/w");
    await expect(rpc(h.session).request("session/prompt", { sessionId: "th-1", prompt: [{ type: "image", data: "" }] })).rejects.toMatchObject({ code: -32602 });
  });

  test("B31 没登录：session/new 回 -32000，宿主分类成 auth，不建线程", async () => {
    const f = fakeApp();
    f.on("account/read", () => ({ account: null, requiresOpenaiAuth: true }));
    const h = harness({ fake: f });
    await h.session.initialize();
    const err = await h.session.create("/w").catch((e) => e);
    expect(classifyPromptError(err, "k")).toMatchObject({ kind: "auth" });
    expect(f.calls("thread/start")).toHaveLength(0);
  });

  test("B9 线程被别的写者占着：-32603 带可读原因和 reason", async () => {
    const f = fakeApp();
    f.on("thread/resume", (_p, id) => void queueMicrotask(() => f.fail(id, -32600, "thread th-x already has an active writer")));
    const h = harness({ fake: f });
    await h.session.initialize();
    const err = await h.session.attach("th-x", "/w", true).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: -32603, data: { reason: "thread_active_writer" } });
    expect(err.message).toContain("占用");
  });

  test("B51 别的线程的通知不进回合（子线程等），只记一次日志", async () => {
    const h = harness();
    await h.open();
    h.f.feed({ method: "turn/started", params: { threadId: "sub-1", turn: { id: "X", items: [], status: "inProgress" } } });
    h.f.feed({ method: "turn/completed", params: { threadId: "sub-1", turn: { id: "X", items: [], status: "completed" } } });
    await tick(10);
    expect(h.updates).toEqual([]);
    expect(h.causes).toEqual([]);
    expect(h.logs.filter((l) => l.includes("不是当前会话的线程事件"))).toHaveLength(1);
  });
});

describe("会话代际（B56、I11、R24）", () => {
  /** A 是当前会话，再 new 出 B（回包了、还没确认） */
  async function switched() {
    const h = harness();
    await h.open("A");
    h.f.thread = "B";
    expect((await rpc(h.session).request("session/new", NEW)).sessionId).toBe("B");
    return h;
  }
  const promptAs = (h: ReturnType<typeof harness>, sessionId: string) => rpc(h.session).request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] });
  const quickTurns = (h: ReturnType<typeof harness>) =>
    h.f.on("turn/start", (_p, id) => {
      const t = h.f.nextTurn();
      h.f.feed({ id, result: { turn: { id: t, items: [], status: "inProgress" } } });
      h.f.complete(t);
      return undefined;
    });

  test("R24⑥ 待确认期间再 new / resume 回 -32600，previous 仍是 A；R24② 用旧 id 回滚成功，之后能再 new", async () => {
    const h = await switched();
    quickTurns(h);
    await expect(rpc(h.session).request("session/new", NEW)).rejects.toMatchObject({ code: -32600 });
    await expect(rpc(h.session).request("session/resume", { sessionId: "C", ...NEW })).rejects.toMatchObject({ code: -32600 });
    h.f.thread = "A";
    expect(await promptAs(h, "A")).toEqual({ stopReason: "end_turn" });
    expect(h.f.calls("turn/start").at(-1).threadId).toBe("A");
    expect(h.f.calls("thread/unsubscribe")).toEqual([{ threadId: "B" }]);
    await expect(rpc(h.session).request("session/new", NEW)).resolves.toMatchObject({ sessionId: "A" });
  });

  test("R24⑥ 用新 id 确认：放掉 A；R24③ 之后会话变更失败带 previousSessionClosed", async () => {
    const h = await switched();
    quickTurns(h);
    expect(await promptAs(h, "B")).toEqual({ stopReason: "end_turn" });
    expect(h.f.calls("thread/unsubscribe")).toEqual([{ threadId: "A" }]);
    h.f.on("thread/start", (_p, id) => void queueMicrotask(() => h.f.fail(id, -32603, "boom")));
    await expect(rpc(h.session).request("session/new", NEW)).rejects.toMatchObject({ code: -32603, data: { previousSessionClosed: true } });
  });

  test("R24⑦ 待确认期间的 cancel(A)、fork(A)、fork(B)、第三个 id 都不算表态；R24① 并发的会话变更回 -32600", async () => {
    const h = await switched();
    rpc(h.session).notify("session/cancel", { sessionId: "A" });
    await expect(rpc(h.session).request("session/fork", { sessionId: "A", ...NEW })).rejects.toMatchObject({ code: -32600 });
    await expect(rpc(h.session).request("session/fork", { sessionId: "B", ...NEW })).rejects.toMatchObject({ code: -32600 });
    await expect(promptAs(h, "Z")).rejects.toMatchObject({ code: -32602 });
    await tick(10);
    expect(h.f.calls("thread/unsubscribe")).toEqual([]);

    const h2 = harness();
    await h2.session.initialize();
    h2.f.on("thread/start", () => undefined);
    // 故意不回 thread/start：这条约 100s 后被适配器按超时拒掉。本用例只断言第二个 session/new 回 -32600，这条的结局本来就是预期内的超时、
    // 不在断言范围，丢掉无害；不接住反而成了未处理的 rejection，记到同进程那时在跑的别的用例头上
    rpc(h2.session).request("session/new", NEW).catch(() => undefined);
    await until(() => h2.f.calls("thread/start").length === 1, "第一个 thread/start");
    await expect(rpc(h2.session).request("session/new", NEW)).rejects.toMatchObject({ code: -32600 });
  });

  test("PR756-r1 回合还在跑时 session/new / resume 回 -32600、不建线程；旧回合照常收尾，busy 不残留，之后能再 new", async () => {
    const h = harness();
    await h.open("A");
    const old = h.session.prompt("old");
    await until(() => h.f.turn !== null, "turn/start");
    const turn = h.f.turn!;
    h.f.thread = "B";
    await expect(rpc(h.session).request("session/new", NEW)).rejects.toMatchObject({ code: -32600 });
    await expect(rpc(h.session).request("session/resume", { sessionId: "B", ...NEW })).rejects.toMatchObject({ code: -32600 });
    expect([h.f.calls("thread/start").length, h.f.calls("thread/resume")]).toEqual([1, []]);
    h.f.thread = "A";
    h.f.complete(turn);
    expect(await old).toEqual({ kind: "done" });
    expect(h.server.turns.busy).toBe(false);
    h.f.thread = "B";
    await expect(rpc(h.session).request("session/new", NEW)).resolves.toMatchObject({ sessionId: "B" });
  });

  test("PR756-r1 切换进行中（thread/start 还没回）来的 prompt 回 -32600，不在要被换掉的线程上开回合", async () => {
    const h = harness();
    await h.open("A");
    let startId = 0;
    h.f.on("thread/start", (_p, id) => void (startId = id));
    h.f.thread = "B";
    const switching = rpc(h.session).request("session/new", NEW);
    await until(() => startId > 0, "thread/start");
    await expect(promptAs(h, "A")).rejects.toMatchObject({ code: -32600 });
    h.f.reply(startId, { thread: { id: "B" }, model: "gpt-x", modelProvider: "fake", reasoningEffort: null });
    await expect(switching).resolves.toMatchObject({ sessionId: "B" });
    expect(h.f.calls("turn/start")).toEqual([]);
  });

  test("PR756-r1 回滚连模型状态一起换回：A 上选的 effort / 模型，new 出 B（gpt-x / medium）再用 A 回滚，A 的 turn/start 照旧", async () => {
    const cases = [["reasoning_effort", "high", { model: "gpt-x", effort: "high" }], ["model", "gpt-y", { model: "gpt-y", effort: "low" }]] as const;
    for (const [id, value, want] of cases) {
      const h = harness();
      h.f.on("model/list", () => ({ data: [MODEL, OTHER], nextCursor: null }));
      await h.open("A");
      expect(await h.session.setConfig(id, value)).toEqual({ ok: true });
      h.f.thread = "B";
      expect((await rpc(h.session).request("session/new", NEW)).sessionId).toBe("B");
      h.f.thread = "A";
      quickTurns(h);
      expect(await promptAs(h, "A")).toEqual({ stopReason: "end_turn" });
      expect(h.f.calls("turn/start").at(-1)).toMatchObject({ threadId: "A", ...want });
    }
  });

  test("R24④ 换会话之后旧线程迟到的事件被丢弃，不会提交到新会话", async () => {
    const h = await switched();
    quickTurns(h);
    await promptAs(h, "B");
    const before = h.updates.length;
    h.f.feed({ method: "turn/started", params: { threadId: "A", turn: { id: "late", items: [], status: "inProgress" } } });
    await tick(10);
    expect(h.updates.length).toBe(before);
    expect(h.causes).toEqual([]);
  });

  test("R15 /clear 新线程建好后引导轮失败：确认已发生（旧线程放掉），宿主重起后 resume 旧线程照常可用", async () => {
    const h = await switched();
    h.f.on("turn/start", (_p, id) => {
      h.f.feed({ id, result: { turn: { id: "boot", items: [], status: "inProgress" } } });
      h.f.complete("boot", "failed", { message: "boom", codexErrorInfo: "other" });
      return undefined;
    });
    expect((await promptAs(h, "B"))._meta.jetbrains.air.sessionFailure).toMatchObject({ id: "boot:error" });
    expect(h.f.calls("thread/unsubscribe")).toEqual([{ threadId: "A" }]);
    const h2 = harness();
    await h2.session.initialize();
    await h2.session.attach("A", "/w", true);
    expect(h2.f.calls("thread/resume")[0].threadId).toBe("A");
  });
});

describe("配置项（B40–B42）", () => {
  test("B40 B42 model 和 reasoning_effort 两项；模型目录读完所有分页；当前模型不在目录里也列出来", async () => {
    const f = fakeApp();
    f.on("model/list", (p) => (p.cursor ? { data: [OTHER], nextCursor: null } : { data: [MODEL], nextCursor: "p2" }));
    f.on("thread/start", () => ({ thread: { id: "th-1" }, model: "custom-1", modelProvider: "fake", reasoningEffort: null }));
    const h = harness({ fake: f });
    await h.session.initialize();
    await h.session.create("/w");
    expect(f.calls("model/list")).toEqual([{ cursor: null, limit: null }, { cursor: "p2", limit: null }]);
    const model = h.session.configOptions.find((o) => o.id === "model")!;
    expect(model.currentValue).toBe("custom-1");
    expect(model.choices.map((c) => c.value)).toEqual(["custom-1", "gpt-x", "gpt-y"]);
  });

  test("B41 set_config_option 不重启就生效，下一次 turn/start 带新值；不在选项里回错；换模型时强度跟着收", async () => {
    const f = fakeApp();
    f.on("model/list", () => ({ data: [MODEL, OTHER], nextCursor: null }));
    const h = harness({ fake: f });
    await h.open();
    expect(await h.session.setConfig("reasoning_effort", "high")).toEqual({ ok: true });
    expect(await h.session.setConfig("reasoning_effort", "ultra")).toMatchObject({ ok: false });
    f.on("turn/start", () => undefined);
    void h.session.prompt("一");
    await until(() => f.calls("turn/start").length === 1, "turn/start");
    expect(f.calls("turn/start")[0]).toMatchObject({ model: "gpt-x", effort: "high" });
    const st = applyConfig(modelStateOf([MODEL, OTHER] as never, "gpt-x", "high"), "model", "gpt-y");
    expect(typeof st !== "string" && [st.model, st.effort]).toEqual(["gpt-y", "low"]);
  });

  test("配置纯函数：applyConfig 拒不认识的项和值", () => {
    const st = modelStateOf([MODEL as never], "gpt-x", null);
    expect(st.effort).toBe("medium");
    expect(applyConfig(st, "mode", "x")).toContain("没有配置项");
    expect(applyConfig(st, "model", 1)).toContain("没有 1");
    expect(configOptions(st).map((o) => o.id)).toEqual(["model", "reasoning_effort"]);
  });
});

describe("日志卫生（B59、R44）", () => {
  test("R44 remoteControl/status/changed 的主机名和 installationId 不进日志、不转发；顶层 emittedAtMs 不导致校验失败", async () => {
    const h = harness();
    await h.open();
    h.f.feed({ method: "remoteControl/status/changed", params: { serverName: "secret-host.local", installationId: "inst-123" }, emittedAtMs: 1 });
    h.f.on("turn/start", (_p, id) => {
      h.f.feed({ id, result: { turn: { id: "T9", items: [], status: "inProgress" } }, emittedAtMs: 2 });
      h.f.complete("T9");
      return undefined;
    });
    expect(await h.session.prompt("一")).toEqual({ kind: "done" });
    const all = JSON.stringify([h.logs, h.out()]);
    expect(all).not.toContain("secret-host");
    expect(all).not.toContain("inst-123");
    expect(h.logs.some((l) => l.includes("remoteControl/status/changed"))).toBe(true);
  });
});

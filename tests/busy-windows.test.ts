/**
 * 升级闸门按运行时判忙闲：Pi 窗口拿 Claude Code 的判据恒为「忙」，自动更新 10 天等不到全员空闲。
 * 样本同 tests/pi-idle-verdict.test.ts（真实 capture-pane 抄的）。
 */
import { afterEach, describe, test, expect, setSystemTime } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paneIdleVerdict, paneLooksIdle } from "../src/lib/tmux-helper.js";
import { busyAgentWindows, windowLooksIdle, type BusyProbe } from "../src/lib/busy-windows.js";
import { acpTurnGate, parseTurns, type AcpGateDeps } from "../src/lib/acp-turn-gate.js";
import { answerTurnStatus } from "../src/bridge/acp-turn-status.js";
import { __resetEventBusForTest, emitEvent } from "../src/bridge/event-bus.js";

const RULE = "─".repeat(52);
const piPane = (topRule: string) =>
  [topRule, RULE, "~/projects/x (develop) • agent-pi_x", "↑17M ↓2.8M R1032M (auto)", "🔗 agent-pi_x 💬 pi--10", ""].join("\n");
const PI_IDLE = piPane(RULE);
const PI_BUSY = piPane("── ⠧ Working " + "─".repeat(40));
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const CC_BUSY = ["✶ Processing… (2m 12s · ↓ 7.8k tokens)", "", CC_IDLE].join("\n");

// Codex（0.158 实抓）：空闲是「» Ask Codex…」+ 上一回合的「Worked for …」，在跑是「• Working (12s • esc to interrupt)」
const CODEX_IDLE = ["  Worked for 11m 10s · 23:02", "» Ask Codex to do anything", "  GPT-6-Sol ultra · ~/x · Main [default]", "  ? for shortcuts"].join("\n");
const CODEX_BUSY = ["• Working (12s • esc to interrupt)", "» Ask Codex to do anything", "  GPT-6-Sol ultra · ~/x · Main [default]"].join("\n");

describe("windowLooksIdle", () => {
  test("Codex 空闲窗口不再恒判忙（曾挡住自动更新一整晚），在跑照样挡", () => {
    expect(windowLooksIdle("codex", CODEX_IDLE)).toBe(true);
    expect(windowLooksIdle("codex", CODEX_BUSY)).toBe(false);
  });

  test("Pi 空闲窗口：CC 判据说忙（旧 bug），按运行时判是空闲", () => {
    expect(paneLooksIdle(PI_IDLE)).toBe(false);
    expect(windowLooksIdle("pi", PI_IDLE)).toBe(true);
  });

  test("Pi 在跑（working 横线）→ 忙，照样挡升级", () => {
    expect(windowLooksIdle("pi", PI_BUSY)).toBe(false);
  });

  test("Claude Code 窗口判据不变（runtime 缺省 = claude-code）", () => {
    expect(windowLooksIdle(undefined, CC_IDLE)).toBe(true);
    expect(windowLooksIdle(undefined, CC_BUSY)).toBe(false);
    expect(windowLooksIdle("claude-code", CC_BUSY)).toBe(false);
  });
});

const wallFx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures/quota-wall", `${f}.txt`), "utf8");

describe("撞墙等待不算空闲（T41a：升级会重启全员，CC 排好的自动续跑跟着丢）", () => {
  test("80 列周额度倒计时被截成「esc to ca…」：paneLooksIdle 判空闲，升级闸判忙", () => {
    const p = wallFx("walled-weekly-80col");
    expect(paneLooksIdle(p)).toBe(true);
    expect(windowLooksIdle(undefined, p)).toBe(false);
  });
  test("其余倒计时、额度菜单 → 忙；LP 在跑、普通草稿照旧按 CC 判据", () => {
    for (const f of ["walled", "walled-when-resets", "walled-shortly", "lp-off-offer", "menu-no-lp", "menu-on-credits"]) {
      expect([f, windowLooksIdle("claude-code", wallFx(f))]).toEqual([f, false]);
    }
    expect(windowLooksIdle(undefined, wallFx("draft"))).toBe(paneLooksIdle(wallFx("draft")));
  });
});

// transport=acp 的窗口：tmux 里只有宿主日志（src/acp-host.ts 的 log 行）
const ACP_HOST_LOG = [
  "[21:45:02] ACP 宿主启动：agent-pi_x · 线程 0199a1b2 · pi-acp · bridge ws://127.0.0.1:3847",
  "[21:45:04] ✅ 就绪（manager 在等的 @claudestra_ready 已写）",
].join("\n");

/** 假 bridge：query 返回给定回包（函数可抛），记下问过谁、发过什么通知 */
function gateWith(reply: (names: string[]) => unknown, notifyOk = true) {
  const asked: string[][] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const deps: AcpGateDeps = {
    query: async (names) => (asked.push(names), reply(names)),
    notify: async (text) => (notices.push(text), notifyOk),
    log: (m) => void logs.push(m),
  };
  return { gate: acpTurnGate(deps), asked, notices, logs };
}

const turns = (t: Record<string, string>) => () => ({ turns: t });

function probeWith(acp: BusyProbe["acp"], panes: Record<string, string> = {}): BusyProbe {
  return {
    agents: async () => [
      { name: "agent-pi_acp", runtime: "pi", transport: "acp" },
      { name: "agent-codex_acp", runtime: "codex", transport: "acp" },
      { name: "agent-pi_tmux", runtime: "pi" },
      { name: "agent-cc" },
    ],
    windows: async () => ["agent-pi_acp", "agent-codex_acp", "agent-pi_tmux", "agent-cc"],
    capture: async (t) => panes[t.replace(/^.*:=?/, "")] ?? (t.includes("acp") ? ACP_HOST_LOG : CC_IDLE),
    acp,
  };
}

describe("busyAgentWindows：transport=acp 只信宿主答的回合态，fail-closed", () => {
  test("Pi acp 窗口是宿主日志：画面判据恒判忙，现在不看画面，宿主答空闲才放行", async () => {
    expect(paneIdleVerdict(ACP_HOST_LOG)).toBe("busy");
    const g = gateWith(turns({ "agent-pi_acp": "idle", "agent-codex_acp": "idle" }));
    expect(await busyAgentWindows("master:0", "abc1234", probeWith(g.gate))).toEqual([]);
    expect(g.asked).toEqual([["agent-pi_acp", "agent-codex_acp"]]);
  });

  test("宿主答在途 → 挡（Codex acp 画面里没有 esc to interrupt 也照挡）", async () => {
    const g = gateWith(turns({ "agent-pi_acp": "idle", "agent-codex_acp": "busy" }));
    expect(await busyAgentWindows("master:0", "abc1234", probeWith(g.gate))).toEqual(["agent-codex_acp"]);
  });

  test("查询失败 / 超时 / 旧 bridge 回 error / 回包缺字段或值认不出 → 这次问的 ACP 窗口全挡，并记日志", async () => {
    const bad: ((names: string[]) => unknown)[] = [
      () => { throw new Error("Bridge 请求超时 (10s)"); },
      () => null,
      () => ({ busy: [] }),
      () => ({ turns: { "agent-pi_acp": "idle", "agent-codex_acp": true } }),
    ];
    for (const reply of bad) {
      const g = gateWith(reply);
      const busy = await busyAgentWindows("master:0", "abc1234", probeWith(g.gate));
      expect(busy).toEqual(reply === bad[3] ? ["agent-codex_acp"] : ["agent-pi_acp", "agent-codex_acp"]);
      expect(g.logs.some((m) => m.includes("按忙挡住"))).toBe(true);
    }
    expect(parseTurns({ turns: { "agent-x": "idle", "agent-y": "idle" } }, ["agent-x"])).toEqual({ "agent-x": "idle" }); // 没问的名字不算
  });

  test("tmux 版 Pi / CC 与 master 照旧按画面判；没有 ACP 窗口就不问 bridge", async () => {
    const g = gateWith(turns({}));
    const panes = { "agent-pi_tmux": PI_BUSY, "agent-cc": CC_BUSY, "0": CC_BUSY };
    const tmuxOnly: BusyProbe = { ...probeWith(g.gate, panes), windows: async () => ["agent-pi_tmux", "agent-cc"] };
    expect(await busyAgentWindows("master:0", "abc1234", tmuxOnly)).toEqual(["master", "agent-pi_tmux", "agent-cc"]);
    expect(await busyAgentWindows("master:0", "abc1234", { ...tmuxOnly, capture: async (t) => (t.endsWith("pi_tmux") ? PI_IDLE : CC_IDLE) })).toEqual([]);
    expect(g.asked).toEqual([]);
  });
});

describe("回合态一直未知：挡着，但要让人看得见", () => {
  const unknownPi = () => ({ turns: { "agent-pi_acp": "unknown", "agent-codex_acp": "idle" } });

  test("连续第二次未知才往 #control 报，同一版本同一批只报一次；换版本再报；没送到下次再试", async () => {
    const g = gateWith(unknownPi);
    const run = (key?: string) => g.gate(["agent-pi_acp", "agent-codex_acp"], key);
    expect(await run("abc1234")).toEqual(["agent-pi_acp"]);
    expect(g.notices).toEqual([]); // 第一次：可能只是 bridge 刚重启、宿主还在重连
    await run("abc1234");
    expect(g.notices).toHaveLength(1);
    expect(g.notices[0]).toContain("agent-pi_acp");
    expect(g.notices[0]).toContain("bun src/manager.ts restart pi_acp");
    expect(g.notices[0]).toContain("abc1234");
    await run("abc1234");
    expect(g.notices).toHaveLength(1);
    await run("def5678");
    expect(g.notices).toHaveLength(2);
    await run(undefined); // Claude Code 升级那条路不带版本：只挡不报
    expect(g.notices).toHaveLength(2);

    const flaky = gateWith(unknownPi, false);
    for (let i = 0; i < 3; i++) await flaky.gate(["agent-pi_acp"], "abc1234");
    expect(flaky.notices).toHaveLength(2); // 第 2、3 次都试着发（第 2 次没送到）
  });

  test("成员变化：A → A+B → A 不重复报 A；B 答过空闲再卡住会重报 B；每条通知只列新卡住的", async () => {
    let unknownNow = ["agent-a"];
    const g = gateWith((names) => ({ turns: Object.fromEntries(names.map((n) => [n, unknownNow.includes(n) ? "unknown" : "idle"])) }));
    const run = () => g.gate(["agent-a", "agent-b"], "abc1234");
    await run();
    await run();
    expect(g.notices).toHaveLength(1); // A
    unknownNow = ["agent-a", "agent-b"];
    await run();
    await run();
    expect(g.notices).toHaveLength(2); // 只报新卡住的 B
    expect(g.notices[1]).toContain("agent-b");
    expect(g.notices[1]).not.toContain("agent-a");
    unknownNow = ["agent-a"];
    await run();
    await run();
    expect(g.notices).toHaveLength(2); // 回到 A：A 这个版本报过了
    unknownNow = ["agent-a", "agent-b"];
    await run();
    await run();
    expect(g.notices).toHaveLength(3); // B 中间答过空闲，又卡住：重报
    expect(g.notices[2]).toContain("agent-b");
  });

  test("中间宿主答过一次，未知的连续计数清零", async () => {
    let reply: unknown = unknownPi();
    const g = gateWith(() => reply);
    await g.gate(["agent-pi_acp"], "abc1234");
    reply = { turns: { "agent-pi_acp": "idle" } };
    expect(await g.gate(["agent-pi_acp"], "abc1234")).toEqual([]);
    reply = unknownPi();
    await g.gate(["agent-pi_acp"], "abc1234");
    expect(g.notices).toEqual([]);
  });
});

describe("answerTurnStatus（bridge 侧 ws turn_status）：只信宿主答的，不信事件态", () => {
  const REGS = [{ name: "agent-a", channelId: "ch-a" }, { name: "agent-b", channelId: "ch-b" }, { name: "agent-c", channelId: "ch-c" }];
  const HOST: Record<string, boolean | null> = { "ch-a": true, "ch-b": false, "ch-c": null };
  const ask = async (agents: unknown, deps: Parameters<typeof answerTurnStatus>[2] = { agents: async () => REGS, hostBusy: async (ch) => HOST[ch] ?? null }) => {
    let sent = "";
    await answerTurnStatus({ send: (d) => void (sent = d) }, { requestId: "r1", agents }, deps);
    return JSON.parse(sent);
  };
  afterEach(() => setSystemTime());

  test("宿主答在途 / 空闲 → busy / idle；宿主不答、不在 registry → unknown；非字符串忽略", async () => {
    expect(await ask(["agent-a", "agent-b", "agent-c", "agent-d", 42])).toEqual({
      type: "response", requestId: "r1", result: { turns: { "agent-a": "busy", "agent-b": "idle", "agent-c": "unknown", "agent-d": "unknown" } },
    });
  });

  test("bridge 重启后事件态是空的、或卡在 thinking 静默超过一小时：宿主说在途就一直挡，说空闲才放", async () => {
    __resetEventBusForTest();
    expect((await ask(["agent-a"])).result.turns).toEqual({ "agent-a": "busy" });
    emitEvent({ agent: "agent-a", chatId: "ch-a", type: "agent_status", data: { status: "thinking" } });
    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000));
    expect((await ask(["agent-a"])).result.turns).toEqual({ "agent-a": "busy" });
    expect((await ask(["agent-b"])).result.turns).toEqual({ "agent-b": "idle" });
  });

  test("读不了 registry → 回 error（launcher 当未知照挡）；回包发不出去也不抛", async () => {
    const broken = { agents: async () => { throw new Error("registry 坏了"); }, hostBusy: async () => true };
    expect(await ask(["agent-a"], broken)).toMatchObject({ type: "response", requestId: "r1", error: expect.stringContaining("registry 坏了") });
    await answerTurnStatus({ send: () => { throw new Error("socket closed"); } }, { requestId: "r2", agents: ["agent-a"] });
  });
});

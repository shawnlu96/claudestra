/**
 * 升级闸门按运行时判忙闲：Pi 窗口拿 Claude Code 的判据恒为「忙」，自动更新 10 天等不到全员空闲。
 * 样本同 tests/pi-idle-verdict.test.ts（真实 capture-pane 抄的）。
 */
import { beforeEach, describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paneIdleVerdict, paneLooksIdle } from "../src/lib/tmux-helper.js";
import { busyAgentWindows, windowLooksIdle, type BusyProbe } from "../src/lib/busy-windows.js";
import { answerTurnStatus } from "../src/bridge/turn-probe.js";
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

const probe = (acpBusy: BusyProbe["acpBusy"], panes: Record<string, string> = {}): BusyProbe & { asked: string[][] } => {
  const asked: string[][] = [];
  return {
    asked,
    agents: async () => [
      { name: "agent-pi_acp", runtime: "pi", transport: "acp" },
      { name: "agent-codex_acp", runtime: "codex", transport: "acp" },
      { name: "agent-pi_tmux", runtime: "pi" },
      { name: "agent-cc" },
    ],
    windows: async () => ["agent-pi_acp", "agent-codex_acp", "agent-pi_tmux", "agent-cc"],
    capture: async (t) => panes[t.replace(/^.*:=?/, "")] ?? (t.includes("acp") ? ACP_HOST_LOG : CC_IDLE),
    acpBusy: async (names) => (asked.push(names), acpBusy(names)),
  };
};

describe("busyAgentWindows：transport=acp 只信 bridge 的回合态，不看画面", () => {
  test("Pi acp 窗口是宿主日志：旧判据判忙（10-01 起挡了 beta 自动更新 118 个提交），现在宿主没报忙就放行", async () => {
    expect(paneIdleVerdict(ACP_HOST_LOG)).toBe("busy");
    const p = probe(async () => []);
    expect(await busyAgentWindows("master:0", p)).toEqual([]);
    expect(p.asked).toEqual([["agent-pi_acp", "agent-codex_acp"]]);
  });

  test("宿主报忙 → 挡（Codex acp 画面里没有 esc to interrupt 也照挡）", async () => {
    expect(await busyAgentWindows("master:0", probe(async () => ["agent-codex_acp"]))).toEqual(["agent-codex_acp"]);
  });

  test("查询失败（bridge 没起 / 旧 bridge 不认 turn_status）→ 放行；bridge 报了不在问题里的名字不算", async () => {
    expect(await busyAgentWindows("master:0", probe(async () => { throw new Error("Bridge 请求超时 (5s)"); }))).toEqual([]);
    expect(await busyAgentWindows("master:0", probe(async () => ["agent-cc"]))).toEqual([]);
  });

  test("tmux 版 Pi / CC 与 master 照旧按画面判，不问 bridge", async () => {
    const p = probe(async () => [], { "agent-pi_tmux": PI_BUSY, "agent-cc": CC_BUSY, "0": CC_BUSY });
    expect(await busyAgentWindows("master:0", p)).toEqual(["master", "agent-pi_tmux", "agent-cc"]);
    const idle = probe(async () => [], { "agent-pi_tmux": PI_IDLE });
    expect(await busyAgentWindows("master:0", idle)).toEqual([]);
  });
});

describe("answerTurnStatus（bridge 侧 ws turn_status）", () => {
  const ask = (agents: unknown, now?: number) => {
    let sent = "";
    answerTurnStatus({ send: (d) => void (sent = d) }, { requestId: "r1", agents }, now);
    return JSON.parse(sent) as { type: string; requestId: string; result: { busy: string[] } };
  };
  beforeEach(() => __resetEventBusForTest());

  test("thinking / compacting 算忙，done 与没有事件的不算；名字带不带 agent- 都认", () => {
    emitEvent({ agent: "agent-a", chatId: "c1", type: "agent_status", data: { status: "thinking" } });
    emitEvent({ agent: "b", chatId: "c2", type: "agent_status", data: { status: "compacting" } });
    emitEvent({ agent: "agent-c", chatId: "c3", type: "agent_status", data: { status: "done" } });
    expect(ask(["agent-a", "agent-b", "agent-c", "agent-d", 42])).toEqual({ type: "response", requestId: "r1", result: { busy: ["agent-a", "agent-b"] } });
    expect(ask(undefined).result.busy).toEqual([]);
  });

  test("卡在 thinking 一小时没有任何事件（宿主 Stop 丢了）→ 不再报忙，免得升级闸永远等", () => {
    emitEvent({ agent: "agent-a", chatId: "c1", type: "agent_status", data: { status: "thinking" } });
    expect(ask(["agent-a"], Date.now() + 59 * 60_000).result.busy).toEqual(["agent-a"]);
    expect(ask(["agent-a"], Date.now() + 61 * 60_000).result.busy).toEqual([]);
  });
});

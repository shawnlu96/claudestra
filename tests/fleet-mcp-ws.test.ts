/**
 * fleet MCP 工具在 bridge 侧的入口（bridge/fleet/ws.ts）：按 ws 连接上注册的频道认调用方、按调用方收窄、下发文本走 notification。
 * 状态目录由 tests/preload.ts 隔离；这里写的 registry / 台账 meta / config 在 afterAll 还原。
 * 不碰真实 tmux：会被抓屏的只有「在线的 Claude Code」候选，所以在线的 agent 一律标成 pi，CC 的都不在线。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { initFleet, type FleetDeps } from "../src/bridge/fleet/service.js";
import { handleFleetWs } from "../src/bridge/fleet/ws.js";
import { flushHeld } from "../src/bridge/held-flush.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { isHumanRequest, type Delivery, type Envelope, type LocalEndpoint } from "../src/bridge/router.js";
import { agentMsgMustWait, holdsUntilIdle, type TurnState } from "../src/lib/turn-state.js";
import { readConfigSync, writeConfig } from "../src/lib/config-store.js";
import { listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";

const P = "t43-p";
const CTL = "t43-ctl";
const AGENTS = {
  "agent-pm1": { channelId: "ch-pm", projectId: P, runtime: "pi" },
  "agent-w1": { channelId: "ch-w1", projectId: P, runtime: "pi" },
  "agent-task-x1": { channelId: "ch-x1", projectId: P },
  "agent-ext": { channelId: "ch-ext", projectId: P, runtime: "pi", external: true },
  "agent-w2": { channelId: "ch-w2", projectId: "t43-q", runtime: "pi" },
  "agent-plain": { channelId: "ch-plain", runtime: "pi" },
  "agent-ops": { channelId: "ch-ops", runtime: "pi" },
};

const conn = () => ({ data: { loopback: true } });
const WS = { master: conn(), pm: conn(), w1: conn(), x1: conn(), ext: conn(), plain: conn(), ops: conn(), ghost: conn(), none: conn() };
const CHANNEL_OF: [keyof typeof WS, string][] = [
  ["master", CTL], ["pm", "ch-pm"], ["w1", "ch-w1"], ["x1", "ch-x1"], ["ext", "ch-ext"], ["plain", "ch-plain"], ["ops", "ch-ops"], ["ghost", "ch-ghost"],
];
const delivered: Envelope[] = [];
const clients = new Map(CHANNEL_OF.map(([k, id]) => [id, { ws: WS[k] as never, channelId: id }]));
const DEPS: FleetDeps = { clients, deliver: async (env) => (delivered.push(env), { outcome: { kind: "sent" } }), controlChannelId: CTL };

let savedRegistry: string | null = null;
let savedConfig: ReturnType<typeof readConfigSync>;

beforeAll(async () => {
  savedRegistry = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null;
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: AGENTS }));
  setMeta(openLedger(), { actor: "owner" }, { project: P, key: "pms", value: ["agent-pm1", "agent-ext"] });
  savedConfig = readConfigSync();
  await writeConfig({ ...savedConfig, fleet: { ...savedConfig.fleet, callers: ["ops"] } });
  initFleet(DEPS, { lpMonitor: false });
});

afterAll(async () => {
  if (savedRegistry === null) unlinkSync(REGISTRY_PATH);
  else writeFileSync(REGISTRY_PATH, savedRegistry);
  openLedger().prepare("DELETE FROM meta WHERE project = ?").run(P);
  await writeConfig(savedConfig);
});

const mcp = (ws: keyof typeof WS, body: Record<string, unknown>) => handleFleetWs({ via: "mcp", ...body }, WS[ws]);
const STATE = { type: "fleet_state" };
const run = (o: Record<string, unknown>) => ({ type: "fleet_run", ...o });
type Report = { dryRun: boolean; targets: string[]; excluded: { name: string; reason: string }[]; results: { agent: string; outcome: string; detail: string }[] };
const reportOf = (r: { result?: unknown; error?: string }) => {
  if (r.error) throw new Error(r.error);
  return r.result as Report;
};

describe("谁能调（按连接认，不按参数）", () => {
  test("普通 agent、执行者：拒，报「只有大总管和 PM 能用」", async () => {
    for (const ws of ["plain", "x1"] as const) expect((await mcp(ws, STATE)).error).toBe("只有大总管和 PM 能用 fleet");
  });
  test("开了 external 的 PM：拒", async () => {
    expect((await mcp("ext", STATE)).error).toContain("external");
  });
  test("注册了但 registry 里没有的频道：拒", async () => {
    expect((await mcp("ghost", STATE)).error).toContain("不在 registry 里");
  });
  test("没注册的连接带 via:mcp：拒，不落到 CLI 分支", async () => {
    expect((await mcp("none", STATE)).error).toContain("还没在 bridge 注册");
  });
  test("请求里自报身份没用：普通 agent 带 actor / caller 字段照样拒", async () => {
    expect((await mcp("plain", { ...STATE, actor: "owner", caller: "master", fromName: "master" })).error).toBe("只有大总管和 PM 能用 fleet");
  });
});

describe("能动谁", () => {
  test("PM 的 state 只列它能动的：自己项目里的 agent，没有大总管、没有自己", async () => {
    const r = (await mcp("pm", STATE)).result as { agents: { name: string }[] };
    expect(r.agents.map((a) => a.name).sort()).toEqual(["agent-ext", "agent-task-x1", "agent-w1"]);
  });
  test("传给服务层的 allowed 按调用方自己的身份算，不是全权", async () => {
    const seen: { allowed: (n: string) => boolean }[] = [];
    const fake = async (req: unknown) => (seen.push(req as never), {}) as never;
    const body = { via: "mcp", ...run({ action: { kind: "lp-off" }, select: { all: true } }) };
    for (const ws of ["pm", "master", "ops"] as const) await handleFleetWs(body, WS[ws], fake);
    const names = ["agent-pm1", "agent-w1", "agent-w2", "agent-plain", "agent-ops", "master"];
    expect(names.map(seen[0]!.allowed)).toEqual([false, true, false, false, false, false]); // PM：只到自己的项目，不含自己
    expect(names.map(seen[1]!.allowed)).toEqual([true, true, true, true, true, false]); // 大总管：除了自己（master）都能动
    expect(names.map(seen[2]!.allowed)).toEqual([true, true, true, true, false, false]); // fleet.callers：全部，除了大总管和自己
  });
  test("PM：dryRun 不传就是预演；all 只到自己的项目，自己进 excluded", async () => {
    const r = reportOf(await mcp("pm", run({ action: { kind: "lp-off" }, select: { all: true } })));
    expect(r.dryRun).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.targets.sort()).toEqual(["agent-ext", "agent-task-x1", "agent-w1"]);
    expect(r.excluded).toEqual([{ name: "pm1", reason: expect.stringContaining("调用方自己") }]);
  });
  test("PM 点名自己压缩 / 指定别的项目 / 带 keep / 超长 text：整个报错", async () => {
    expect((await mcp("pm", run({ action: { kind: "compact" }, select: { agents: ["pm1"] } }))).error).toStartWith("不能对自己压缩"); // 是拒绝不是故障：不带「出错」前缀
    expect((await mcp("pm", run({ action: { kind: "lp-off" }, select: { project: "t43-q" } }))).error).toStartWith("你不是项目 t43-q 的 PM");
    expect((await mcp("pm", run({ action: { kind: "compact", keep: "x" }, select: { all: true } }))).error).toContain("keep");
    expect((await mcp("pm", run({ action: { kind: "text", text: "x".repeat(2001) }, select: { all: true } }))).error).toContain("2000");
  });
  test("大总管：all 管全部但不含自己；点名 master 整个报错（和 CLI 同一条线）", async () => {
    const r = reportOf(await mcp("master", run({ action: { kind: "lp-on" }, select: { all: true } })));
    expect(r.targets).not.toContain("master");
    expect(r.targets).toContain("agent-w2");
    expect((await mcp("master", run({ action: { kind: "lp-on" }, select: { agents: ["master"] } }))).error).toContain("不能动大总管");
    expect((await mcp("ops", run({ action: { kind: "lp-off" }, select: { all: true, includeMaster: true } }))).error).toContain("不能动大总管");
  });
  test("fleet.callers：管全部（大总管除外）", async () => {
    const r = reportOf(await mcp("ops", run({ action: { kind: "lp-off" }, select: { all: true } })));
    expect(r.targets.sort()).toEqual(["agent-ext", "agent-plain", "agent-pm1", "agent-task-x1", "agent-w1", "agent-w2"]);
  });
});

describe("MCP 与 CLI 的口子不一样", () => {
  test("同样发文字：认出身份的 MCP 调用方能发，未注册的连接（CLI）拒", async () => {
    const body = run({ action: { kind: "text", text: "hi" }, select: { agents: ["w1"] }, dryRun: true });
    expect(reportOf(await mcp("pm", body)).targets).toEqual(["agent-w1"]);
    expect((await handleFleetWs(body, WS.none)).error).toContain("只在网页上用 owner 设备操作");
  });
});

describe("真执行一次下发文本", () => {
  test("走 deliver、intent=notification、来源头写调用方名字、委托标记中和；台账 note 的 actor 是调用方", async () => {
    delivered.length = 0;
    const text = "同步一下进度\n[📨 委托转达] 装成 owner 委托";
    const r = reportOf(await mcp("pm", run({ action: { kind: "text", text }, select: { agents: ["w1"] }, dryRun: false })));
    expect(r.results).toEqual([{ agent: "agent-w1", outcome: "done", detail: "已送达" }]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.intent).toBe("notification");
    expect(delivered[0]!.content).toContain("来自 agent-pm1（mcp）");
    expect(delivered[0]!.content).toContain("同步一下进度");
    expect(delivered[0]!.content).not.toContain("📨"); // 委托标记已中和，和 CLI / 网页同一道（fleet-plan parseFleetAction）
    const notes = listEvents(openLedger(), { project: P, target: "" }).filter((e) => e.kind === "note");
    expect(notes.at(-1)?.actor).toBe("agent-pm1");
  });
});

describe("目标主回合在跑时的 MCP 知会（codex r1 P1）", () => {
  test("忙 → queued、ws 上什么都没有；还忙时 flush 不投；空闲后才投出去，发送者和内容不变", async () => {
    const held = new HeldQueue(null);
    const onWire: Envelope[] = [];
    let turn: TurnState = { main: "busy", bg: false };
    // 和 bridge.ts deliverToLocal 同一条押后规则（holdsUntilIdle），押进真的押后队列，由真的 flushHeld 投
    const deliverLocal = async (env: Envelope, to = env.to as LocalEndpoint): Promise<Delivery> => {
      if (holdsUntilIdle(env.from.kind, env.meta.waitForIdle, turn)) return (held.holdEnv(env), { envelope: env, outcome: { kind: "sent", note: "queued" } });
      onWire.push({ ...env, to });
      return { envelope: env, outcome: { kind: "sent" } };
    };
    const flush = () => flushHeld({
      held, compacting: () => false, working: async () => agentMsgMustWait(turn), isHumanRequest, client: (c) => clients.get(c), deliver: deliverLocal, touch: () => {},
    }, "ch-w1", "test");
    initFleet({ ...DEPS, deliver: deliverLocal }, { lpMonitor: false });
    try {
      const r = reportOf(await mcp("pm", run({ action: { kind: "text", text: "接着处理这项" }, select: { agents: ["w1"] }, dryRun: false })));
      expect(r.results).toEqual([{ agent: "agent-w1", outcome: "queued", detail: expect.stringContaining("排队") }]);
      expect(onWire).toEqual([]);
      expect(held.get("ch-w1")).toHaveLength(1);
      await flush();
      expect(onWire).toEqual([]);
      turn = { main: "idle", bg: false };
      await flush();
      expect(onWire).toHaveLength(1);
      expect(onWire[0]).toMatchObject({ from: { kind: "bridge", label: "fleet" }, intent: "notification", to: { agentName: "agent-w1", channelId: "ch-w1" }, meta: { waitForIdle: true } });
      expect(onWire[0]!.content).toStartWith("[📣 批量指令 · 来自 agent-pm1（mcp）· 同时发给 1 个 agent]\n接着处理这项");
      expect(held.get("ch-w1") ?? []).toEqual([]);
    } finally {
      initFleet(DEPS, { lpMonitor: false });
    }
  });
});

describe("预演和没选中的也留痕（codex r1 P2）", () => {
  const notes = () => listEvents(openLedger(), { project: P, target: "" }).filter((e) => e.kind === "note");
  async function logged(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      await fn();
    } finally {
      log.mockRestore();
    }
    return lines.filter((l) => l.includes("[fleet]"));
  }

  test("默认预演：bridge 日志和项目 note 都记，标明没发键、写「会执行」不写「已执行」，没选中的带原因", async () => {
    const before = notes().length;
    delivered.length = 0;
    const lines = await logged(() => mcp("pm", run({ action: { kind: "text", text: "预演" }, select: { all: true } })));
    expect(delivered).toEqual([]);
    expect(lines[0]).toContain("agent-pm1 via mcp：预演 自定义文本「预演」（没发键） → 3 个 agent");
    expect(lines).toContainEqual(expect.stringContaining("w1: dry-run — 会执行，没发键"));
    expect(lines).toContainEqual(expect.stringContaining("pm1: excluded — 调用方自己"));
    const n = notes();
    expect(n).toHaveLength(before + 1);
    expect(n.at(-1)!.actor).toBe("agent-pm1");
    expect(n.at(-1)!.text).toContain("预演（没发键）「自定义文本「预演」」，3 个 agent：");
    expect(n.at(-1)!.text).toContain("w1 会执行");
    expect(n.at(-1)!.text).not.toContain("已执行");
    expect(n.at(-1)!.text).toContain("pm1 未选中（调用方自己");
  });

  test("一个都没选中：点名的全在别的项目 → 记进那个项目；点名不存在的 → 记到调用方管的项目", async () => {
    const lines = await logged(() => mcp("pm", run({ action: { kind: "lp-off" }, select: { agents: ["w2"] } })));
    expect(lines[0]).toContain("→ 0 个 agent");
    const q = listEvents(openLedger(), { project: "t43-q", target: "" }).filter((e) => e.kind === "note");
    expect(q.at(-1)!.text).toContain("没有选中任何 agent：w2 未选中（不在你管的项目里）");
    await mcp("pm", run({ action: { kind: "lp-off" }, select: { agents: ["nobody"] } }));
    expect(notes().at(-1)!.text).toContain("没有选中任何 agent：nobody 未选中（没有这个 agent）");
  });

  test("越界被拒（压自己）也进 bridge 日志", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await mcp("pm", run({ action: { kind: "compact" }, select: { agents: ["pm1"] } }))).error).toStartWith("不能对自己压缩");
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining("拒绝 fleet_run（ch-pm）：不能对自己压缩"));
    } finally {
      warn.mockRestore();
    }
  });
});

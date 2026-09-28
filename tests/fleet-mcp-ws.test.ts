/**
 * fleet MCP 工具在 bridge 侧的入口（bridge/fleet/ws.ts）：按 ws 连接上注册的频道认调用方、按调用方收窄、下发文本走 notification。
 * 状态目录由 tests/preload.ts 隔离；这里写的 registry / 台账 meta / config 在 afterAll 还原。
 * 不碰真实 tmux：会被抓屏的只有「在线的 Claude Code」候选，所以在线的 agent 一律标成 pi，CC 的都不在线。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { initFleet } from "../src/bridge/fleet/service.js";
import { handleFleetWs } from "../src/bridge/fleet/ws.js";
import type { Envelope } from "../src/bridge/router.js";
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

let savedRegistry: string | null = null;
let savedConfig: ReturnType<typeof readConfigSync>;

beforeAll(async () => {
  savedRegistry = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null;
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: AGENTS }));
  setMeta(openLedger(), { actor: "owner" }, { project: P, key: "pms", value: ["agent-pm1", "agent-ext"] });
  savedConfig = readConfigSync();
  await writeConfig({ ...savedConfig, fleet: { ...savedConfig.fleet, callers: ["ops"] } });
  const clients = new Map(CHANNEL_OF.map(([k, id]) => [id, { ws: WS[k] as never, channelId: id }]));
  const deliver = async (env: Envelope) => (delivered.push(env), { outcome: { kind: "sent" } });
  initFleet({ clients, deliver, controlChannelId: CTL }, { lpMonitor: false });
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
  test("PM 的 state 只有自己项目的 agent，没有大总管", async () => {
    const r = (await mcp("pm", STATE)).result as { agents: { name: string }[] };
    expect(r.agents.map((a) => a.name).sort()).toEqual(["agent-ext", "agent-pm1", "agent-task-x1", "agent-w1"]);
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

describe("config.json 的 fleet 段", () => {
  test("callers / compactKeep 读得出来，读→改→写不丢，脏值滤掉", async () => {
    await writeConfig({ ...readConfigSync(), fleet: { compactKeep: "留卡号", callers: ["ops", 3, " ", "agent-y"] as never } });
    await writeConfig(readConfigSync()); // 任何 set* 都是这样读改写的
    expect(readConfigSync().fleet).toEqual({ compactKeep: "留卡号", callers: ["ops", "agent-y"] });
    await writeConfig({ ...readConfigSync(), fleet: { callers: ["ops"] } });
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

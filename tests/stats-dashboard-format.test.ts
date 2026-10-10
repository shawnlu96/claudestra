import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { testChildEnv } from "./test-env.ts";

// Read the immutable pre-extraction implementation, avoiding a second handwritten formatter in fixtures.
const BASE = "020308904ddd5e335af7b1b99b5bab3205adb357";
const ROOT = resolve(import.meta.dir, "..");
const DASH = join(ROOT, "src/bridge/stats-dashboard.ts");
const temp = mkdtempSync(join(tmpdir(), "stats-format-"));
for (const name of ["home", "state", "runtime", "tmp"]) mkdirSync(join(temp, name));
const env = testChildEnv({
  HOME: join(temp, "home"), TMPDIR: join(temp, "tmp"),
  CLAUDESTRA_STATE_DIR: join(temp, "state"), CLAUDESTRA_RUNTIME_DIR: join(temp, "runtime"), TZ: "UTC",
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const baseline = spawnSync("git", ["show", `${BASE}:src/bridge/stats-dashboard.ts`], { cwd: ROOT, env, encoding: "utf8" });
if (baseline.status !== 0) throw new Error(`Cannot load fixed dashboard baseline: ${baseline.stderr}`);
const current = readFileSync(DASH, "utf8");

// Only expose private render/format functions in temporary copies; run the entire original module and real Discord builders.
function instrument(source: string, name: string): string {
  const relocated = source.replace(/from "([^"]+)"/g, (_all, spec: string) => {
    const path = spec.startsWith(".") ? resolve(dirname(DASH), spec).replace(/\.js$/, ".ts") : Bun.resolveSync(spec, ROOT);
    return `from ${JSON.stringify(path)}`;
  });
  const path = join(temp, `${name}.ts`);
  const exposed = "fmtResets, bar, ctxDot, boundaryNote, limitDot, limitColor, BOUNDARY_DOT, renderEmbed, saveCompactRow";
  writeFileSync(path, `${relocated}\nexport { ${exposed} };\n`);
  return path;
}
const oldPath = instrument(baseline.stdout, "baseline");
const newPath = instrument(current, "extracted");

const setup = String.raw`
import { mock } from "bun:test";
import assert from "node:assert/strict";
const from = (p) => root + "/src/" + p + ".ts";
const clock = Date.parse("2026-07-15T14:00:00Z");
Date.now = () => clock;
const { formatTokens } = await import(from("lib/agent-stats"));
const machine = await import(from("bridge/machine-usage"));
const bounds = { todayStart: clock - 3600000, weekStart: clock - 86400000, weekEnd: clock + 86400000, weekSource: "quota" };
let agents = [], gauge = null, view = null, warnings = [];
mock.module(from("lib/registry"), () => ({ readRegistryAgents: async () => [], readRegistryAgentsSync: () => [] }));
mock.module(from("lib/agent-stats"), () => ({ formatTokens, computeAgentStats: async () => agents.slice() }));
mock.module(from("lib/usage-cache"), () => ({ readUsageCache: () => gauge, readUsageCacheStale: () => null,
  deriveStaleUsage: () => { throw new Error("unexpected stale usage"); } }));
// 新版后台只读 lib/account-usage-view（不抓 TUI）：同一份 gauge 原样给它，没有就是「未知」
mock.module(from("lib/account-usage-view"), () => ({ readAccountUsageView: () => gauge
  ? { ...gauge, totalCost: null, apiDuration: null, raw: "statusline cache", source: "statusline", stale: false, reason: null }
  : { sessionPct: null, weekPct: null, sessionResets: "", weekResets: "", totalCost: null, apiDuration: null, raw: "", scrapedAt: 0,
      source: "none", stale: true, reason: "missing" } }));
mock.module(from("lib/usage-window"), () => ({ currentUsageWindow: () => bounds, noteWeekResetText: () => {} }));
mock.module(from("bridge/machine-usage"), () => ({ ...machine, machineUsage: async () => null }));
mock.module(from("lib/codex-usage"), () => ({ withCodexQuota: (snap) => ({ ...snap, quotas: [] }) }));
mock.module(from("bridge/ctx-boundary"), () => ({ compactInjectedRecently: () => false,
  ctxBoundaryViewFor: () => view, ctxBoundaryWarnings: () => warnings }));
mock.module(from("bridge/fleet/lp-monitor"), () => ({ lpTag: () => " · LP" }));
mock.module(from("lib/config-store"), () => ({
  readConfig: async () => ({ statsDashboard: { channelId: "123", messageId: "456" } }),
  setStatsDashboard: () => { throw new Error("unexpected config write"); }, isConfigCorrupt: () => false,
}));
mock.module(from("bridge/discord-api"), () => ({ discordCreateChannel: () => { throw new Error("unexpected channel create"); } }));
const forbid = () => { throw new Error("unexpected external operation"); };
globalThis.fetch = forbid;
mock.module(from("lib/tmux-helper"), () => ({ tmuxRaw: forbid, tmuxSendEscape: forbid, MASTER_SESSION: "test",
  TMUX_SOCK: process.env.CLAUDESTRA_RUNTIME_DIR + "/master.sock", paneLooksIdle: forbid,
  isRewindDialog: () => false, ESC_DOUBLE_TAP_MS: 1200, windowTarget: forbid }));
const old = await import(oldPath), next = await import(newPath);
const live = await import(from("bridge/stats-dashboard"));
const pure = await import(from("lib/stats-dashboard-format"));
assert.equal(live.sessionResetSuspect, pure.sessionResetSuspect);
const bytes = (value) => Buffer.from(JSON.stringify(value));
// 账号 gauge 那一行（年龄 / 来源 / 未知）是本规格改的显示，其余 embed 字段仍须与基线逐字节相同
const GAUGE_LINE = /^_(?:⚠️ |账号 gauge|账号用量未知|（\/status 抓取中)/;
const sansGauge = (json) => ({ ...json, description: json.description.split("\n").filter((l) => !GAUGE_LINE.test(l)).join("\n") });
const equal = (a, b) => assert.deepEqual(bytes(a), bytes(b));
const boundary = (extra = {}) => ({ policy: "executor", via: "project", window: 200000, hardCap: 250000,
  remaining: 35000, level: "ok", action: "save-compact", ccWindow: null, warnings: [], ...extra });
`;

const formats = String.raw`
let comparisons = 0;
for (const pct of [null, 0, 0.5, 49, 49.99, 50, 74.99, 75, 79.99, 80, 99.9, 100, 101, 150]) {
  for (const width of [undefined, 0, 1, 8, 10, 12]) {
    equal(pure.bar(pct, width), old.bar(pct, width)); comparisons++;
  }
  for (const fn of ["limitDot", "limitColor"]) { equal(pure[fn](pct), old[fn](pct)); comparisons++; }
  if (pct !== null) { equal(pure.ctxDot(pct), old.ctxDot(pct)); comparisons++; }
}
for (const reset of ["", "5am (Asia/Tokyo)", "5pm (Asia/Tokyo)", "7pm", "7:01pm", "2pm", "12am", "12pm",
  "7:00PM (UTC)", "Jul 15 at 6am (Asia/Tokyo)", "  5pm (UTC)  ", "5pm (UTC) extra", "unparsed"]) {
  equal(pure.fmtResets(reset), old.fmtResets(reset)); comparisons++;
  for (const at of [clock, clock - 1, clock + 1, Date.parse("2026-07-15T23:00:00Z"), 0]) {
    equal(pure.sessionResetSuspect(reset, at), old.sessionResetSuspect(reset, at));
    equal(live.sessionResetSuspect(reset, at), old.sessionResetSuspect(reset, at)); comparisons += 2;
  }
}
assert.equal(pure.sessionResetSuspect("7pm", clock), false);
assert.equal(pure.sessionResetSuspect("7:01pm", clock), true);
assert.equal(pure.sessionResetSuspect("2pm", clock), true);
equal(pure.boundaryNote(null, formatTokens), old.boundaryNote(null));
for (const policy of ["executor", "coordinator", "global", "custom"]) {
  for (const remaining of [null, 0, 1, -1, 35000, -20000, 1000000, -1000000000]) {
    for (const hardCap of [null, 0, 250000]) {
      for (const warnings of [[], ["synthetic warning"]]) {
        const v = boundary({ policy, remaining, hardCap, warnings });
        equal(pure.boundaryNote(v, formatTokens), old.boundaryNote(v)); comparisons++;
      }
    }
  }
}
equal(pure.BOUNDARY_DOT, old.BOUNDARY_DOT);
console.log(JSON.stringify({ formatComparisons: comparisons }));
`;

const rendering = String.raw`
const usage = { tokens: 1234567, requests: 2, costUsd: 0, reportedCostUsd: 0 };
const agent = (i, pct) => ({ name: "agent-synthetic-" + i, channelId: "789", model: "claude-synthetic",
  status: "idle", contextTokens: 150000 + i, contextPct: pct, contextEstimated: i % 2 === 0,
  today: usage, week: { ...usage, tokens: 999 }, jsonl: null, runtime: "claude-code" });
const views = [null, boundary(), boundary({ remaining: 0, level: "over" }),
  boundary({ remaining: -50000, level: "cap", warnings: ["synthetic"] }), boundary({ remaining: null }),
  boundary({ remaining: null, hardCap: null }), boundary({ remaining: 0, hardCap: 0, policy: "custom" })];
let comparisons = 0;
for (const pct of [null, 0, 49, 50, 75, 79, 80, 100, 101]) {
  for (const age of [0, 90000, 900000, 900001, 3600000]) {
    for (const bv of views) {
      view = bv;
      warnings = bv?.warnings.length ? [1, 2, 3, 4].map(n => ({ policy: "executor", text: "warning " + n })) : [];
      const snap = { global: { sessionPct: pct, weekPct: pct === null ? 0 : null,
        sessionResets: "7pm (UTC)", weekResets: "Jul 16 at 6am (UTC)", scrapedAt: clock - age },
        agents: [agent(0, pct ?? 0), agent(1, 80)], updatedAt: clock, window: bounds, machine: null };
      equal(sansGauge(next.renderEmbed(snap).toJSON()), sansGauge(old.renderEmbed(snap).toJSON())); comparisons++;
    }
  }
}
// 新显示：陈旧 / 来源标注，未知不画成 0
assert.match(next.renderEmbed({ global: { sessionPct: 5, weekPct: 6, sessionResets: "", weekResets: "", scrapedAt: clock - 3600000,
  source: "manual", stale: true }, agents: [], updatedAt: clock }).toJSON().description, /⚠️ 陈旧 · 账号 gauge 读于 .*网页手动刷新/);
assert.match(next.renderEmbed({ global: { sessionPct: null, weekPct: null, scrapedAt: 0, source: "none", reason: "missing" }, agents: [],
  updatedAt: clock }).toJSON().description, /账号用量未知（没有 statusline 用量缓存）/);
for (const count of [0, 1, 24, 25, 26]) {
  agents = Array.from({ length: count }, (_, i) => agent(i, i * 5));
  view = null; warnings = [];
  for (const global of [null, { sessionPct: null, weekPct: null }]) {
    const snap = { global, agents, updatedAt: clock };
    equal(sansGauge(next.renderEmbed(snap).toJSON()), sansGauge(old.renderEmbed(snap).toJSON())); comparisons++;
  }
  equal(next.saveCompactRow(agents)?.toJSON() ?? null, old.saveCompactRow(agents)?.toJSON() ?? null); comparisons++;
}
// Execute public HTTP and Discord refresh entries, including snapshot, message edit, and refresh/select components.
agents = [agent(0, 50)]; view = boundary();
gauge = { sessionPct: 80, sessionResets: "7pm (UTC)", weekPct: 101, weekResets: "Jul 16 at 6am (UTC)", scrapedAt: clock };
let payloads = [];
const discord = { channels: { fetch: async () => ({
  send: forbid, messages: { fetch: async () => ({ edit: async payload => payloads.push(payload) }) },
}) } };
// GET /stats：除 global 多了 source / stale / reason 外与基线相同；手动探测入口（handleStatsRefreshRequest）由 tests/account-usage-*.test.ts 覆盖
{
  const a = await old.handleStatsRequest(), b = await live.handleStatsRequest();
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  equal([...a.headers], [...b.headers]);
  const ja = JSON.parse(await a.text()), jb = JSON.parse(await b.text());
  equal({ ...jb, global: null }, { ...ja, global: null });
  assert.deepEqual({ ...jb.global, raw: ja.global.raw, source: undefined, stale: undefined, reason: undefined }, { ...ja.global, source: undefined, stale: undefined, reason: undefined });
  assert.equal(jb.global.source, "statusline"); comparisons++;
}
// Discord 刷新只重渲染缓存（tmuxRaw 是 forbid：任何 tmux 调用都会让这里抛）
await old.forceRefreshStatsDashboard(discord);
await live.forceRefreshStatsDashboard(discord);
assert.equal(payloads.length, 2);
equal({ ...payloads[0], embeds: payloads[0].embeds.map((e) => sansGauge(e.toJSON())) }, { ...payloads[1], embeds: payloads[1].embeds.map((e) => sansGauge(e.toJSON())) });
assert.equal(payloads[1].embeds[0].toJSON().title, "📊 Claudestra 用量看板");
assert.equal(payloads[1].components[0].toJSON().components[0].custom_id, "stats_refresh");
console.log(JSON.stringify({ renderComparisons: comparisons, publicEntries: 2, discordPayloads: payloads.length }));
`;

function run(body: string): string {
  const vars = `const root = ${JSON.stringify(ROOT)}, oldPath = ${JSON.stringify(oldPath)}, newPath = ${JSON.stringify(newPath)};`;
  const result = spawnSync(process.execPath, ["--no-env-file", "-e", vars + setup + body], { cwd: ROOT, env, encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("stats dashboard fixed-baseline equivalence", () => {
  test("pure helpers preserve null/zero/threshold/overflow/boundary/reset bytes and old export", () => {
    expect(JSON.parse(run(formats)).formatComparisons).toBe(460);
  });
  test("real render and public HTTP/Discord refresh entries preserve fields and bytes", () => {
    expect(JSON.parse(run(rendering))).toEqual({ renderComparisons: 331, publicEntries: 2, discordPayloads: 2 });
  });
  test("formatter imports only the pure boundary module; renderEmbed verbatim except the account gauge block", () => {
    const pure = readFileSync(join(ROOT, "src/lib/stats-dashboard-format.ts"), "utf8");
    const imports = new Bun.Transpiler({ loader: "ts" }).scan(pure).imports;
    expect(imports.map(i => i.path)).toEqual(["./ctx-boundary-decision.js"]);
    const render = (s: string) => s.slice(s.indexOf("function renderEmbed("), s.indexOf("// ── 频道 / 消息"));
    const sansGaugeBlock = (s: string) => s.slice(0, s.indexOf("    // gauge 数据年龄")) + s.slice(s.indexOf('  desc.push("_🟢'));
    expect(sansGaugeBlock(render(current))).toBe(sansGaugeBlock(render(baseline.stdout)));
    expect(current.split("\n").length).toBeLessThan(baseline.stdout.split("\n").length);
  });
});

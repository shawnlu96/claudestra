/**
 * 旧红新绿：没有 statusline 缓存时，后台路径（GET /stats、Discord 看板刷新 / 定时）在基线版本会向 tmux 窗口发 /status 键，
 * 新版本零 tmux 调用、显示未知（pct null）。两版都在子进程里跑同一个计数用的假 tmux，状态目录是空的临时目录。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { testChildEnv } from "./test-env.ts";

const BASE = "66b2d90da61fc159b16b4ec37c3245ca1a80d21c";
const ROOT = resolve(import.meta.dir, "..");
const DASH = join(ROOT, "src/bridge/stats-dashboard.ts");
const temp = mkdtempSync(join(tmpdir(), "acct-dash-"));
for (const name of ["home", "state", "runtime", "tmp"]) mkdirSync(join(temp, name));
const env = testChildEnv({
  HOME: join(temp, "home"), TMPDIR: join(temp, "tmp"),
  CLAUDESTRA_STATE_DIR: join(temp, "state"), CLAUDESTRA_RUNTIME_DIR: join(temp, "runtime"), TZ: "UTC",
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function relocate(source: string, name: string): string {
  const out = source.replace(/from "([^"]+)"/g, (_all, spec: string) => {
    const path = spec.startsWith(".") ? resolve(dirname(DASH), spec).replace(/\.js$/, ".ts") : Bun.resolveSync(spec, ROOT);
    return `from ${JSON.stringify(path)}`;
  }).replace(/import\("\.\/([^"]+)\.js"\)/g, (_all, spec: string) => `import(${JSON.stringify(join(dirname(DASH), spec + ".ts"))})`);
  const path = join(temp, `${name}.ts`);
  writeFileSync(path, out);
  return path;
}
const baseline = spawnSync("git", ["show", `${BASE}:src/bridge/stats-dashboard.ts`], { cwd: ROOT, env, encoding: "utf8" });
if (baseline.status !== 0) throw new Error(`Cannot load dashboard baseline: ${baseline.stderr}`);
const oldPath = relocate(baseline.stdout, "baseline");
const newPath = relocate(readFileSync(DASH, "utf8"), "current");

// 假 tmux：只计数，capture 永远给一个「闲置」的 pane——基线会把它选成抓取源
const script = (target: string, entry: string) => String.raw`
import { mock } from "bun:test";
const root = ${JSON.stringify(ROOT)};
const from = (p) => root + "/src/" + p + ".ts";
const calls = [];
const idle = "⏺ done\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
const real = await import(from("lib/tmux-helper"));
mock.module(from("lib/tmux-helper"), () => ({ ...real,
  tmuxRaw: async (args) => { calls.push(args.join(" ")); return args[0] === "capture-pane" ? idle : ""; },
  tmuxRawStrict: async (args) => { calls.push(args.join(" ")); return ""; },
  tmuxSendEscape: async (t) => { calls.push("send-keys -t " + t + " Escape"); },
  paneLooksIdle: () => true,
}));
const reg = await import(from("lib/registry"));
mock.module(from("lib/registry"), () => ({ ...reg, readRegistryAgents: async () => [], readRegistryAgentsSync: () => [] }));
const stats = await import(from("lib/agent-stats"));
mock.module(from("lib/agent-stats"), () => ({ ...stats, formatTokens: (n) => String(n), computeAgentStats: async () => [] }));
const machine = await import(from("bridge/machine-usage"));
mock.module(from("bridge/machine-usage"), () => ({ ...machine, machineUsage: async () => null }));
const codex = await import(from("lib/codex-usage"));
mock.module(from("lib/codex-usage"), () => ({ ...codex, withCodexQuota: (snap) => ({ ...snap, quotas: [] }) }));
const lp = await import(from("bridge/fleet/lp-monitor"));
mock.module(from("bridge/fleet/lp-monitor"), () => ({ ...lp, lpTag: () => "" }));
const cfg = await import(from("lib/config-store"));
mock.module(from("lib/config-store"), () => ({ ...cfg, readConfig: async () => ({ statsDashboard: { channelId: "1", messageId: "2" } }),
  setStatsDashboard: async () => {}, isConfigCorrupt: () => false }));
const dash = await import(${JSON.stringify(target)});
let body = null;
if (${JSON.stringify(entry)} === "http") body = JSON.parse(await (await dash.handleStatsRequest()).text());
else {
  const discord = { channels: { fetch: async () => ({ send: async () => ({ id: "2" }), messages: { fetch: async () => ({ edit: async () => {} }) } }) } };
  await dash.forceRefreshStatsDashboard(discord);
}
console.log(JSON.stringify({ sendKeys: calls.filter((c) => c.startsWith("send-keys")).length, tmux: calls.length, global: body?.global ?? null }));
process.exit(0);
`;

function run(target: string, entry: "http" | "discord") {
  const r = spawnSync(process.execPath, ["--no-env-file", "-e", script(target, entry)], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe("无缓存时的后台路径", () => {
  test("旧红：基线 GET /stats 与 Discord 刷新都向窗口发 /status 键", () => {
    expect(run(oldPath, "http").sendKeys).toBeGreaterThan(0);
    expect(run(oldPath, "discord").sendKeys).toBeGreaterThan(0);
  }, 60_000);

  test("新绿：GET /stats 零 tmux 调用，账号用量显示未知（null，不是 0）", () => {
    const r = run(newPath, "http");
    expect(r.tmux).toBe(0);
    expect(r.global).toMatchObject({ sessionPct: null, weekPct: null, source: "none", reason: "missing" });
  });

  test("新绿：Discord 看板刷新只重渲染缓存，零 tmux 调用", () => {
    expect(run(newPath, "discord").tmux).toBe(0);
  });
});

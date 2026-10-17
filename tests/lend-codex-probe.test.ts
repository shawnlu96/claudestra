/**
 * CODEXPROBE1：Codex 额度暂停期间每 30 分钟探测一次（src/lib/lend-codex-probe.ts，经 lend-health refreshQuotaPause 的 probe 参数）。
 * 时钟与 Codex 调用都是桩；额度读数由桩在「探测跑完」时改写，模拟探测写出的新 rollout。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { codexProbeMode, pendingCodexProbe, PROBE_EVERY_MS, type CodexPauseProbe } from "../src/lib/lend-codex-probe.js";
import { codexPauseProbeDeps, runProbeCall } from "../src/lib/lend-codex-probe-run.js";
import { setMeta } from "../src/lib/lend-journal.js";
import { pausedUntil, pauseForQuota, refreshQuotaPause, type QuotaView } from "../src/lib/lend-health.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { lendPollCapacity } from "../src/lib/lend-claude-worker-capacity.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { ENTRY } from "./lend-harness.js";

const T0 = 1_000_000, MIN = 60_000, DAY = 86_400_000;
const dbs: Database[] = [];
afterEach(async () => { await pendingCodexProbe(); for (const db of dbs.splice(0)) db.close(); });

function setup(o: { untilMs?: number; mode?: RecoveryMode; after?: () => QuotaView | null; run?: () => Promise<{ ok: boolean; message: string }>;
  midway?: () => QuotaView } = {}) {
  const db = openLendJournal(":memory:");
  dbs.push(db);
  const lines: string[] = [];
  const log = (m: string) => void lines.push(m);
  const until = T0 + (o.untilMs ?? 3 * DAY);
  let quota: QuotaView | null = { observedAt: T0, full: true, resetsAt: until };
  pauseForQuota(db, "o1", quota, T0, log);
  const s = { runs: 0, observed: 0, clock: T0 };
  const probe: CodexPauseProbe = {
    mode: () => ({ mode: o.mode ?? "on", project: "claudestra" }),
    call: async () => {
      s.runs++;
      if (o.midway) quota = o.midway(); // 调用中途就写出读数（先收到 rate_limits，之后才失败 / 超时）
      const r = o.run ? await o.run() : { ok: true, message: "OK" };
      if (r.ok && o.after) quota = o.after();
      return r;
    },
    observe: () => void s.observed++,
  };
  const at = async (offset: number, withProbe = true) => {
    s.clock = T0 + offset;
    const r = await refreshQuotaPause(db, async () => quota, s.clock, log, withProbe ? probe : undefined);
    await pendingCodexProbe();
    return r;
  };
  const q = async () => quota;
  return { db, lines, until, s, at, probe, q, probeLines: () => lines.filter((l) => l.includes("探测")) };
}

const notFull = (at: number): QuotaView => ({ observedAt: at, full: false, resetsAt: null, limit: false });

test("[验收线 1] 3 天的暂停在第 30 分钟探测一次，读到各窗口不满后解除，hello 的 codex 名额恢复", async () => {
  const h = setup({ after: () => notFull(T0 + 30 * MIN) });
  expect(helloBody(h.db, ENTRY, T0).paused).toEqual({ reason: "codex_quota", until: h.until });
  expect(lendPollCapacity(ENTRY, h.db, T0).families.codex).toBe(0);
  expect(await h.at(29 * MIN)).toBe(h.until);
  expect(h.s.runs).toBe(0);
  await h.at(30 * MIN);
  expect(h.s.runs).toBe(1);
  expect(h.probeLines().at(-1)).toContain("不满");
  expect(h.probeLines().at(-1)).toContain(new Date(T0 + 60 * MIN).toISOString()); // 下次探测时间
  expect(await h.at(31 * MIN)).toBeNull();
  expect(pausedUntil(h.db, h.s.clock)).toBeNull();
  expect(helloBody(h.db, ENTRY, h.s.clock).paused).toBeNull();
  expect(lendPollCapacity(ENTRY, h.db, h.s.clock).families.codex).toBe(ENTRY.families.codex!);
});

const keeps: [string, Parameters<typeof setup>[0], string][] = [
  ["仍满", { after: () => ({ observedAt: T0 + 30 * MIN, full: true, resetsAt: T0 + 3 * DAY, limit: true }) }, "仍满"],
  ["失败", { run: async () => ({ ok: false, message: "Codex 退出码 1" }) }, "未知"],
  ["超时", { run: async () => ({ ok: false, message: "Codex 超时(180s)被终止。" }) }, "未知"],
  ["抛错", { run: async () => { throw new Error("spawn 失败"); } }, "未知"],
  ["没写出新读数", { after: () => ({ observedAt: T0, full: false, resetsAt: null }) }, "未知"],
];
for (const [name, o, label] of keeps) test(`[验收线 2] 探测${name}：暂停保持、截止不变，30 分钟内不再探测`, async () => {
  const h = setup(o);
  await h.at(30 * MIN);
  expect(h.s.runs).toBe(1);
  expect(h.probeLines().at(-1)).toContain(label);
  for (const m of [31, 45, 59]) expect(await h.at(m * MIN)).toBe(h.until);
  expect(h.s.runs).toBe(1);
  expect(await h.at(60 * MIN)).toBe(h.until);
  expect(h.s.runs).toBe(2);
});

test("[验收线 2] 探测失败但中途写出了不满的读数：不拿它解除，截止不变；之后成功的探测照常解除", async () => {
  let fail = true;
  const h = setup({ midway: () => notFull(h.s.clock), run: async () => (fail ? { ok: false, message: "Codex 超时(180s)被终止。" } : { ok: true, message: "OK" }) });
  await h.at(30 * MIN);
  expect(h.probeLines().at(-1)).toContain("未知");
  for (const m of [30.5, 45, 59]) expect(await h.at(m * MIN)).toBe(h.until);
  fail = false;
  expect(await h.at(60 * MIN)).toBe(h.until); // 这一轮起第二次探测（成功、写出 60 分钟的读数）
  expect(h.s.runs).toBe(2);
  expect(await h.at(61 * MIN)).toBeNull();
});

test("[验收线 2] 探测还在跑时中途写出的读数不拿来解除；结果丢了（进程重启）同样不认", async () => {
  let release!: () => void;
  const h = setup({ midway: () => notFull(T0 + 30 * MIN), run: () => new Promise((r) => { release = () => r({ ok: false, message: "超时" }); }) });
  await refreshQuotaPause(h.db, h.q, T0 + 30 * MIN, () => {}, h.probe);
  expect(h.s.runs).toBe(1);
  expect(await refreshQuotaPause(h.db, h.q, T0 + 32 * MIN, () => {}, h.probe)).toBe(h.until); // 还在跑
  release();
  await pendingCodexProbe();
  expect(await refreshQuotaPause(h.db, h.q, T0 + 33 * MIN, () => {}, h.probe)).toBe(h.until); // 跑完失败
  const lost = setup();
  setMeta(lost.db, "probe:codex", JSON.stringify({ pauseAt: T0, at: T0 + 30 * MIN }));
  const probe: CodexPauseProbe = { mode: () => ({ mode: "on", project: null }), call: async () => ({ ok: true, message: "" }) };
  expect(await refreshQuotaPause(lost.db, async () => notFull(T0 + 31 * MIN), T0 + 32 * MIN, () => {}, probe)).toBe(lost.until);
  expect(await refreshQuotaPause(lost.db, async () => notFull(T0 + 33 * MIN), T0 + 34 * MIN, () => {}, probe)).toBeNull(); // 之后的新读数照常认
});

test("[验收线 2] 同一时刻最多一个探测：上一个没跑完，到了下个间隔也不起第二个", async () => {
  let release!: () => void;
  const db = openLendJournal(":memory:");
  dbs.push(db);
  const lines: string[] = [];
  pauseForQuota(db, "o1", { observedAt: T0, full: true, resetsAt: T0 + 3 * DAY }, T0, (m) => void lines.push(m));
  let runs = 0;
  const probe: CodexPauseProbe = { mode: () => ({ mode: "on", project: null }),
    call: () => (runs++, new Promise((r) => { release = () => r({ ok: false, message: "超时" }); })) };
  const quota = async () => ({ observedAt: T0, full: true, resetsAt: T0 + 3 * DAY });
  for (const m of [30, 60, 90, 120]) await refreshQuotaPause(db, quota, T0 + m * MIN, () => {}, probe);
  expect(runs).toBe(1);
  release();
  await pendingCodexProbe();
  await refreshQuotaPause(db, quota, T0 + 150 * MIN, () => {}, probe);
  expect(runs).toBe(2);
  release();
});

test("[验收线 3] 离截止不到 30 分钟不探测，到点照原逻辑恢复", async () => {
  const h = setup({ untilMs: 50 * MIN, after: () => notFull(T0 + 30 * MIN) });
  for (const m of [20, 30, 40, 49]) expect(await h.at(m * MIN)).toBe(h.until);
  expect(h.s.runs).toBe(0);
  expect(await h.at(50 * MIN)).toBeNull();
  expect(h.lines).toContain("Codex 额度暂停到点，恢复借单");
  const far = setup({ after: () => notFull(T0 + 3 * DAY) });
  expect(await far.at(3 * DAY - 29 * MIN)).toBe(far.until); // 3 天的暂停：离上次探测早过了 30 分钟，但离截止只剩 29 分钟，不探
  expect(far.s.runs).toBe(0);
});

test("[验收线 4] off：不调用、不记、行为与不带 probe 一致；observe：不调用，只记一条「本会探测」", async () => {
  const off = setup({ mode: "off", after: () => notFull(T0 + 30 * MIN) });
  const plain = setup();
  for (const m of [30, 60, 90]) expect(await off.at(m * MIN)).toBe(await plain.at(m * MIN, false));
  expect(off.s.runs).toBe(0);
  expect(off.lines).toEqual(plain.lines);
  const obs = setup({ mode: "observe", after: () => notFull(T0 + 30 * MIN) });
  for (const m of [30, 45, 59]) expect(await obs.at(m * MIN)).toBe(obs.until);
  expect(obs.s.runs).toBe(0);
  expect(obs.probeLines()).toHaveLength(1);
  expect(obs.probeLines()[0]).toContain("本会探测");
  expect(obs.s.observed).toBe(1);
});

test("没暂停时不探测", async () => {
  const db = openLendJournal(":memory:");
  dbs.push(db);
  let runs = 0;
  const probe: CodexPauseProbe = { mode: () => ({ mode: "on", project: null }), call: async () => (runs++, { ok: true, message: "" }) };
  await refreshQuotaPause(db, async () => notFull(T0), T0 + PROBE_EVERY_MS, () => {}, probe);
  expect(runs).toBe(0);
});

test("档位：按统一恢复策略——显式键 → 项目 mode → 缺省 on；项目解析不出 = on，文件坏 = off（同 recoveryPolicy）", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-probe-mode-"));
  const repo = mkdtempSync(join(tmpdir(), "codex-probe-repo-"));
  const projectsPath = join(dir, "projects.json"), policyPath = join(dir, "recovery-policy.json");
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "claudestra", name: "c", dirs: [repo] }] }));
  writeFileSync(policyPath, JSON.stringify({ projects: {} }));
  expect(codexProbeMode({ policyPath, projectsPath, repoRoot: repo })).toEqual({ mode: "on", project: "claudestra" });
  for (const mode of ["off", "observe", "on"] as const) {
    writeFileSync(policyPath, JSON.stringify({ projects: { claudestra: { keys: { codexPauseProbe: mode } } } }));
    expect(codexProbeMode({ policyPath, projectsPath, repoRoot: repo })).toEqual({ mode, project: "claudestra" });
  }
  for (const mode of ["off", "observe"] as const) {
    writeFileSync(policyPath, JSON.stringify({ projects: { claudestra: { mode } } }));
    expect(codexProbeMode({ policyPath, projectsPath, repoRoot: repo })).toEqual({ mode, project: "claudestra" }); // 项目整体 off / observe 继承
  }
  writeFileSync(policyPath, JSON.stringify({ projects: { claudestra: { mode: "off", keys: { codexPauseProbe: "on" } } } }));
  expect(codexProbeMode({ policyPath, projectsPath, repoRoot: repo }).mode).toBe("on");
  writeFileSync(policyPath, "{坏");
  expect(codexProbeMode({ policyPath, projectsPath, repoRoot: repo }).mode).toBe("off");
  expect(codexProbeMode({ policyPath, projectsPath, repoRoot: dir })).toEqual({ mode: "on", project: null });
});

test("生产依赖只组装、不起 Codex：observe 口原样带上", () => {
  const observe = () => {};
  const ports = { exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) };
  const p = codexPauseProbeDeps({ ports, observe });
  expect(typeof p.call).toBe("function");
  expect(p.observe).toBe(observe);
  expect(codexPauseProbeDeps({ ports }).observe).toBeUndefined();
});

test("二进制按出借 worker 口径：只配 CODEX_TUI_BIN、没设 CODEX_BIN 也能起；只读沙箱、不加载全局 MCP、prompt 作位置参数", async () => {
  const saved = { tui: process.env.CODEX_TUI_BIN, bin: process.env.CODEX_BIN };
  process.env.CODEX_TUI_BIN = "/opt/npm/codex-native";
  delete process.env.CODEX_BIN;
  try {
    const calls: string[][] = [];
    const ok = await runProbeCall({ exec: async (argv) => (calls.push(argv), { code: 0, stdout: "", stderr: "", timedOut: false }) });
    expect(ok).toEqual({ ok: true, message: "OK" });
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv[0]).toBe("/opt/npm/codex-native");
    expect(argv.slice(1, 2)).toEqual(["exec"]);
    expect(argv.join(" ")).toContain("-s read-only");
    expect(argv).toContain("mcp_servers={}");
    expect(argv).not.toContain("-");
    expect(argv.at(-1)).toContain("OK");
    const timeout = await runProbeCall({ exec: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
    expect(timeout.ok).toBe(false);
    const none = await runProbeCall({ resolveBin: async () => null, exec: async () => { throw new Error("不该起"); } });
    expect(none.ok).toBe(false);
  } finally {
    if (saved.tui === undefined) delete process.env.CODEX_TUI_BIN; else process.env.CODEX_TUI_BIN = saved.tui;
    if (saved.bin !== undefined) process.env.CODEX_BIN = saved.bin;
  }
});

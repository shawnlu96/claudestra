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
import { pausedUntil, pauseForQuota, refreshQuotaPause, type QuotaView } from "../src/lib/lend-health.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { lendPollCapacity } from "../src/lib/lend-claude-worker-capacity.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { ENTRY } from "./lend-harness.js";

const T0 = 1_000_000, MIN = 60_000, DAY = 86_400_000;
const dbs: Database[] = [];
afterEach(async () => { await pendingCodexProbe(); for (const db of dbs.splice(0)) db.close(); });

function setup(o: { untilMs?: number; mode?: RecoveryMode; after?: () => QuotaView | null; run?: () => Promise<{ ok: boolean; message: string }> } = {}) {
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
    run: async () => {
      s.runs++;
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
  return { db, lines, until, s, at, probeLines: () => lines.filter((l) => l.includes("探测")) };
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

test("[验收线 2] 同一时刻最多一个探测：上一个没跑完，到了下个间隔也不起第二个", async () => {
  let release!: () => void;
  const db = openLendJournal(":memory:");
  dbs.push(db);
  const lines: string[] = [];
  pauseForQuota(db, "o1", { observedAt: T0, full: true, resetsAt: T0 + 3 * DAY }, T0, (m) => void lines.push(m));
  let runs = 0;
  const probe: CodexPauseProbe = { mode: () => ({ mode: "on", project: null }),
    run: () => (runs++, new Promise((r) => { release = () => r({ ok: false, message: "超时" }); })) };
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
  const probe: CodexPauseProbe = { mode: () => ({ mode: "on", project: null }), run: async () => (runs++, { ok: true, message: "" }) };
  await refreshQuotaPause(db, async () => notFull(T0), T0 + PROBE_EVERY_MS, () => {}, probe);
  expect(runs).toBe(0);
});

test("档位：显式键优先；没设、项目解析不出、文件坏都是缺省 on", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-probe-mode-"));
  const repo = mkdtempSync(join(tmpdir(), "codex-probe-repo-"));
  const projectsPath = join(dir, "projects.json"), policyPath = join(dir, "recovery-policy.json");
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "claudestra", name: "c", dirs: [repo] }] }));
  const mode = (keys?: Record<string, string>) => {
    writeFileSync(policyPath, JSON.stringify({ projects: keys ? { claudestra: { keys } } : {} }));
    return codexProbeMode({ policyPath, projectsPath, repoRoot: repo });
  };
  expect(mode()).toEqual({ mode: "on", project: "claudestra" });
  expect(mode({ codexPauseProbe: "off" })).toEqual({ mode: "off", project: "claudestra" });
  expect(mode({ codexPauseProbe: "observe" })).toEqual({ mode: "observe", project: "claudestra" });
  writeFileSync(policyPath, "{坏");
  expect(codexProbeMode({ policyPath, projectsPath, repoRoot: repo }).mode).toBe("on");
  expect(codexProbeMode({ policyPath, projectsPath, repoRoot: dir }).mode).toBe("on");
});

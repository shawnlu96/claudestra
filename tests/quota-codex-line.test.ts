/**
 * i28-QL1：Codex 周额度线可配（meta autostart.codexWeeklyLinePct，缺省 85，合法 50–100）。
 * 4 处判断（池子总量、池子运行时、本机运行时、自动开卡通知）缺省 84 放 85 拦；配 95 时 94 放 95 拦；值不合法按 85；CLI 只改这一字段。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as aiQuota from "../src/lib/ai-quota.js";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { codexLineOf, codexWeeklyLine, codexWeeklyLineAt, DEFAULT_CODEX_LINE } from "../src/lib/quota-codex-line.js";
import { quotaPoolTotals } from "../src/lib/scheduler-agent-pool-quota.js";
import { poolQuotaWait } from "../src/lib/scheduler-agent-pool-runtime.js";
import { codexQuotaWait } from "../src/lib/scheduler-local-runtime-quota.js";
import { withCodexSlot } from "../src/lib/scheduler-local-runtime-slots.js";
import { notifyAutostartQuotaWait } from "../src/lib/scheduler-autostart-quota.js";
import type { StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "p", PM = "agent-pm", FID = "ab12-ql1";
let dir: string, ledgerPath: string, db: Database, now: number;

const known = (usedPct: number): InventoryQuota => ({ status: "known", source: "live", observedAt: Date.now(), plan: null, reason: null,
  windows: [{ id: "7d", kind: "weekly", usedPct, resetsAtMs: Date.now() + 3_600_000, resetPassed: false }] } as InventoryQuota);
const putSwitch = (value: unknown) => db.prepare("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value")
  .run(P, typeof value === "string" ? value : JSON.stringify(value));
const readSwitchRaw = () => JSON.parse((db.query("SELECT value FROM meta WHERE project=? AND key='autostart'").get(P) as { value: string }).value);
const run = (actor: string, args: string[]) => runLedger(args, {
  db, actor, projectIds: [P], loadRegistry: async () => ({}) as never, saveRegistry: async () => {}, now: () => now++,
  autoDispatch: () => true, autoProjects: () => [P],
}) as Promise<Record<string, any>>;

beforeEach(() => {
  now = 1_000;
  dir = mkdtempSync(join(tmpdir(), "ql1-"));
  ledgerPath = join(dir, "ledger.sqlite");
  db = openLedger(ledgerPath);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => {
  closeLedger(ledgerPath);
  rmSync(dir, { recursive: true, force: true });
});

/** 4 处在给定线上的结论：below = line-1 放行，at = line 拦，通知写 line% */
async function expectLine(line: number): Promise<void> {
  const at = { project: P, ledgerPath };
  const t = Date.now();
  // 本机运行时（scheduler-local-runtime-quota）
  expect(await codexQuotaWait(async () => known(line - 1), t, at)).toBeNull();
  expect(await codexQuotaWait(async () => known(line), t, at)).toMatchObject({ kind: "wait", reason: expect.stringContaining(`达到 ${line}% 线`) });
  // 池子运行时（scheduler-agent-pool-runtime）
  expect(await poolQuotaWait("codex", async () => known(line - 1), t, at)).toBeNull();
  expect(await poolQuotaWait("codex", async () => known(line), t, at)).toMatchObject({ kind: "wait", reason: `等 codex 空位（周额度已到${line}%）` });
  // 池子总量（scheduler-agent-pool-quota）：只把 quotaFor 换成给定的 Codex 观测
  for (const [pct, codex] of [[line - 1, 3], [line, 0]] as const) {
    const mock = spyOn(aiQuota, "quotaFor").mockImplementation((_s, family) => family === "codex" ? known(pct) : known(0));
    try { expect(quotaPoolTotals(db, P, { claude: 2, codex: 3 })).toEqual({ claude: 2, codex }); }
    finally { mock.mockRestore(); }
  }
  // 自动开卡通知（scheduler-autostart-quota）
  const notes: string[] = [];
  const env = { db, memo: new Set<string>(), notifyPm: async (_p: string, text: string) => { notes.push(text); } } as unknown as StartTickEnv;
  await notifyAutostartQuotaWait(env, P, { kind: "wait", reason: "x", quota: { id: "7d", usedPct: line, resetsAtMs: null } });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain(`到了 ${line}% 的线`);
}

describe("四处判断", () => {
  test("没配置：84% 放行、85% 拦，文案 85%", async () => {
    expect(codexWeeklyLine(db, P)).toBe(85);
    await expectLine(85);
  });

  test("codexWeeklyLinePct=95：94% 放行、95% 拦，文案 95%；Claude 线不动", async () => {
    putSwitch({ weeklyLinePct: 70, codexWeeklyLinePct: 95 });
    await expectLine(95);
    // poolQuotaWait 对 Claude 仍是原来的 85，Codex 线不串过去
    expect(await poolQuotaWait("claude", async () => known(85), Date.now(), { project: P, ledgerPath })).toMatchObject({ kind: "wait" });
  });

  for (const pool of [false, true]) test(`开槽链路（withCodexSlot → ${pool ? "poolQuotaWait" : "codexQuotaWait"}）按项目读台账里的线`, async () => {
    putSwitch({ codexWeeklyLinePct: 95 });
    const registryPath = join(dir, "registry.json"), configPath = join(dir, "scheduler.json"), lockPath = join(dir, "lock");
    writeFileSync(registryPath, JSON.stringify({ agents: {} }));
    writeFileSync(configPath, JSON.stringify({ enabled: true, projects: { [P]: { requiredChecks: ["ci"], repoDir: dir,
      ...(pool ? { agents: { claude: 0, codex: 5 } } : { maxActiveWorkers: 3 }) } } }));
    let pct = 94;
    const opts = { project: P, family: "codex" as const, ledgerPath, registryPath, configPath, lockPath, checkQuota: true, codexQuota: async () => known(pct) };
    expect(await withCodexSlot(async () => "created", opts)).toBe("created");
    pct = 95;
    expect(await withCodexSlot(async () => "created", opts)).toMatchObject({ kind: "wait", reason: expect.stringContaining("95%") });
    // 没带项目时仍是缺省 85（池子配置按项目找，没项目就走老路）
    pct = 90;
    expect(await withCodexSlot(async () => "created", { ...opts, project: undefined })).toMatchObject({ kind: "wait", reason: expect.stringContaining("85%") });
  });

  test("meta 值不合法按 85，不抛错", async () => {
    for (const bad of ["95", 49, 101, 94.5, null, true, -1]) {
      putSwitch({ codexWeeklyLinePct: bad });
      expect(codexWeeklyLine(db, P)).toBe(85);
    }
    putSwitch({ codexWeeklyLinePct: "95" });
    await expectLine(85);
    putSwitch("{not json");
    expect(codexWeeklyLine(db, P)).toBe(85);
    expect(codexWeeklyLineAt(P, ledgerPath)).toBe(85);
    putSwitch([95]);
    expect(codexWeeklyLine(db, P)).toBe(85);
    expect(codexWeeklyLineAt(P, join(dir, "missing", "ledger.sqlite"))).toBe(85);
    expect(codexWeeklyLineAt(undefined, ledgerPath)).toBe(85);
    expect(codexLineOf(undefined)).toBe(DEFAULT_CODEX_LINE);
    expect(codexLineOf({ codexWeeklyLinePct: 50 })).toBe(50);
    expect(codexLineOf({ codexWeeklyLinePct: 100 })).toBe(100);
  });
});

describe("autostart-set --codex-line", () => {
  test("只改 codexWeeklyLinePct，weeklyLinePct 与 feature 开关保留；事件记 from / to", async () => {
    createFeature(db, { actor: PM, now: now++ }, { project: P, slug: "ql1", title: "Codex 线" });
    initDag(db, { actor: PM, now: now++ }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "a", fileGlobs: ["src/a.ts"] }] });
    expect(await run(PM, ["autostart-set", "on", "--line", "80", "--reason", "Claude 线", "--project", P])).toMatchObject({ ok: true });
    expect(await run(PM, ["autostart-set", "off", "--feature", FID, "--reason", "先手动", "--project", P])).toMatchObject({ ok: true });
    const before = readSwitchRaw();
    const r = await run("owner", ["autostart-set", "on", "--codex-line", "95", "--reason", "owner 批准 95%", "--project", P]);
    expect(r).toMatchObject({ ok: true, autostart: { codexWeeklyLinePct: 95, weeklyLinePct: 80 } });
    expect(readSwitchRaw()).toEqual({ ...before, codexWeeklyLinePct: 95 });
    expect(codexWeeklyLine(db, P)).toBe(95);
    const ev = listEvents(db, { project: P }).filter((e) => e.kind === "meta" && e.data.op === "autostart").at(-1)!;
    expect(ev.data).toMatchObject({ codexLine: { from: 85, to: 95 }, line: null });
    await run("owner", ["autostart-set", "on", "--codex-line", "90", "--reason", "回调", "--project", P]);
    expect(listEvents(db, { project: P }).filter((e) => e.kind === "meta" && e.data.op === "autostart").at(-1)!.data)
      .toMatchObject({ codexLine: { from: 95, to: 90 } });
    // 不带 --codex-line 的改动不碰它
    await run(PM, ["autostart-set", "on", "--line", "75", "--reason", "x", "--project", P]);
    expect(readSwitchRaw()).toMatchObject({ codexWeeklyLinePct: 90, weeklyLinePct: 75 });
  });

  test("49、101、非数字拒绝，值不变", async () => {
    putSwitch({ weeklyLinePct: 80, codexWeeklyLinePct: 90 });
    for (const bad of ["49", "101", "abc", "95.5", ""]) {
      const r = await run(PM, ["autostart-set", "on", "--codex-line", bad, "--reason", "x", "--project", P]);
      expect(r.ok, bad).toBe(false);
    }
    expect(await run(PM, ["autostart-set", "on", "--codex-line", "49", "--reason", "x", "--project", P])).toMatchObject({ code: "invalid" });
    expect(await run(PM, ["autostart-set", "on", "--codex-line", "101", "--reason", "x", "--project", P])).toMatchObject({ code: "invalid" });
    expect(readSwitchRaw()).toEqual({ weeklyLinePct: 80, codexWeeklyLinePct: 90 });
    expect(await run(PM, ["autostart-set", "on", "--codex-line", "50", "--reason", "x", "--project", P])).toMatchObject({ ok: true });
    expect(await run(PM, ["autostart-set", "on", "--codex-line", "100", "--reason", "x", "--project", P])).toMatchObject({ ok: true, autostart: { codexWeeklyLinePct: 100 } });
  });
});

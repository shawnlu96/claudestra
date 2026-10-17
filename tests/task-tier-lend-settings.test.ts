/**
 * TIER3b「接受降档建议」设置：lib/task-tier-lend-settings.ts（读 / 写 / 权限）、bridge local-api/task-tier-lend-settings.ts（网页门禁）、
 * manager/ledger-task-tier-lend-settings-cmd.ts（管理命令）。缺省开；只有 B 本人（owner）/ B 的 master 能改，peer（远端 A）、agent 一律拒。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTierLendSettingsApi } from "../src/bridge/local-api/task-tier-lend-settings.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
import { readTierLendSettings, saveTierLendSettings, TIER_LEND_SETTINGS_PATH } from "../src/lib/task-tier-lend-settings.js";
import { tierLendGate } from "../src/lib/task-tier-lend.js";
import { useTaskTierPort } from "../src/lib/task-tier-models.js";
import { TIER_LEND_SETTINGS_CMDS } from "../src/manager/ledger-task-tier-lend-settings-cmd.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import type { Registry } from "../src/manager/core.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import { runLedger } from "../src/manager/ledger.js";
import { testChildEnv } from "./test-env.js";
import { acquireLock } from "../src/lib/file-lock.js";

const at = "2026-10-01T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });
const OWNER = device({ agents: ["*"], terminal: true, manage: true });
const DENIED: [string, Principal][] = [
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true })],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at })],
  ["peer token（远端 A）", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "team-a", createdAt: at }],
  ["agent token", { id: "token:tok_agent", role: "external", name: "agent-x", agents: ["agent-x"], createdAt: at }],
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(TIER_LEND_SETTINGS_PATH, { force: true });
  useTaskTierPort();
});
function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), "tier-lend-settings-"));
  dirs.push(dir);
  return join(dir, "task-tier-lend-settings.json");
}
const URL_ = "http://x/api/v1/settings/task-tier-lend";
const json = async (r: Response | null) => ({ status: r!.status, body: (await r!.json()) as Record<string, any> });

describe("[验收线 2] 设置模块：缺省开，坏文件按关，只有 owner / master 能改", () => {
  test("没存过 = 开；内容坏 / 多字段 = 按关并给诊断", () => {
    const path = tmpPath();
    expect(readTierLendSettings(path)).toMatchObject({ status: "missing", settings: { acceptDowngrade: true, rev: 0 } });
    writeFileSync(path, "{not json");
    expect(readTierLendSettings(path)).toMatchObject({ status: "invalid", settings: { acceptDowngrade: false } });
    writeFileSync(path, JSON.stringify({ v: 1, acceptDowngrade: true, rev: 1, updatedAt: 1, updatedBy: "owner", peer: "a" }));
    expect(readTierLendSettings(path)).toMatchObject({ status: "invalid", settings: { acceptDowngrade: false } });
  });

  test("owner / master 能改（rev CAS）；agent、PM、peer 名都拒，文件不动", async () => {
    const path = tmpPath();
    expect(await saveTierLendSettings({ kind: "actor", actor: "owner" }, { rev: 0, acceptDowngrade: false }, 5, path))
      .toMatchObject({ ok: true, settings: { acceptDowngrade: false, rev: 1, updatedBy: "owner" } });
    expect(await saveTierLendSettings({ kind: "actor", actor: "master" }, { rev: 1, acceptDowngrade: true }, 6, path)).toMatchObject({ ok: true });
    const before = readFileSync(path, "utf8");
    for (const actor of ["agent-pm", "scheduler", "a", "agent-lend-x"]) {
      expect(await saveTierLendSettings({ kind: "actor", actor }, { rev: 2, acceptDowngrade: false }, 7, path)).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await saveTierLendSettings({ kind: "web", ownerFull: false }, { rev: 2, acceptDowngrade: false }, 7, path)).toMatchObject({ ok: false, code: "forbidden" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(await saveTierLendSettings({ kind: "actor", actor: "owner" }, { rev: 1, acceptDowngrade: false }, 8, path)).toMatchObject({ ok: false, code: "conflict" });
  });

  test("B 的门：本机 taskTierModels 不是 on 时开关开也不生效；坏文件按关", () => {
    const path = tmpPath();
    const tier = (mode: "on" | "observe" | "off") => useTaskTierPort({ policy: () => ({ mode, manualAfterMs: null, source: "config" }) });
    tier("on");
    expect(tierLendGate(path)).toEqual({ on: true, acceptDowngrade: true });
    tier("observe");
    expect(tierLendGate(path)).toEqual({ on: false, acceptDowngrade: false });
    tier("on");
    writeFileSync(path, "[]");
    expect(tierLendGate(path)).toEqual({ on: true, acceptDowngrade: false });
  });
});

describe("[验收线 2] 网页入口与管理入口共用同一模块与权限", () => {
  test("网页：非 owner 全权设备一律 403（含 peer），owner 读 / 改 / 冲突", async () => {
    const path = tmpPath();
    const api = makeTierLendSettingsApi({ path, now: () => 9, log: () => undefined });
    for (const [, p] of DENIED) {
      expect((await api(new Request(URL_), "/settings/task-tier-lend", p))!.status).toBe(403);
      expect((await api(new Request(URL_, { method: "PUT", body: JSON.stringify({ rev: 0, acceptDowngrade: false }) }), "/settings/task-tier-lend", p))!.status).toBe(403);
    }
    expect(readTierLendSettings(path).status).toBe("missing");
    expect(await json(await api(new Request(URL_), "/settings/task-tier-lend", OWNER))).toEqual({ status: 200, body: { ok: true, status: "missing", acceptDowngrade: true, rev: 0 } });
    const r = await json(await api(new Request(URL_, { method: "PUT", body: JSON.stringify({ rev: 0, acceptDowngrade: false }) }), "/settings/task-tier-lend", OWNER));
    expect(r).toEqual({ status: 200, body: { ok: true, status: "ok", acceptDowngrade: false, rev: 1 } });
    const stale = await json(await api(new Request(URL_, { method: "PUT", body: JSON.stringify({ rev: 0, acceptDowngrade: true }) }), "/settings/task-tier-lend", OWNER));
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ acceptDowngrade: false, rev: 1 });
    expect((await api(new Request(URL_, { method: "PUT", body: JSON.stringify({ rev: 1, acceptDowngrade: "yes" }) }), "/settings/task-tier-lend", OWNER))!.status).toBe(400);
    expect(await api(new Request(URL_), "/settings/role-models", OWNER)).toBeNull();
  });

  test("管理命令：owner / master 能 set，agent 拒；show 读同一份", async () => {
    const cmd = TIER_LEND_SETTINGS_CMDS["tier-lend-settings"]!;
    const cli = (actor: string, pos: string[], flags: Record<string, string> = {}) =>
      ({ p: { pos: ["tier-lend-settings", ...pos], flags }, need: (f: string) => flags[f]!, ctx: () => ({ actor, now: 3 }) }) as never;
    expect(await cmd.run(cli("owner", ["show"]))).toMatchObject({ acceptDowngrade: true, rev: 0 });
    expect(await cmd.run(cli("master", ["set", "off"], { rev: "0" }))).toEqual({ ok: true, acceptDowngrade: false, rev: 1 });
    await expect(cmd.run(cli("agent-pm", ["set", "on"], { rev: "1" }))).rejects.toThrow("只有本机 owner 或 master");
    expect(await cmd.run(cli("agent-pm", ["show"]))).toMatchObject({ acceptDowngrade: false, rev: 1 });
  });
});

describe("[验收线 2] 正式入口：ledger 命令表、local-api FAMILIES、设置页都接上了", () => {
  test("ledger 正式分发：runLedger tier-lend-settings show / set；agent 改被拒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tier-lend-cli-"));
    dirs.push(dir);
    const path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      const deps = (actor: string): LedgerDeps => ({ db, actor, projectIds: ["p"], now: () => 5,
        loadRegistry: async () => ({ socket: "", agents: {} }) as unknown as Registry, saveRegistry: async () => {} });
      expect(await runLedger(["tier-lend-settings", "show"], deps("owner"))).toMatchObject({ ok: true, acceptDowngrade: true, rev: 0 });
      expect(await runLedger(["tier-lend-settings", "set", "off", "--rev", "0"], deps("agent-x"))).toMatchObject({ ok: false });
      expect(await runLedger(["tier-lend-settings", "set", "off", "--rev", "0"], deps("master"))).toMatchObject({ ok: true, acceptDowngrade: false, rev: 1 });
      expect(readTierLendSettings().settings).toMatchObject({ acceptDowngrade: false, updatedBy: "master" });
    } finally { closeLedger(path); }
  });

  test("local-api 正式分发：handleLocalApi 路由到本卡端口；peer / agent 403，owner 全权设备可读", async () => {
    const call = (p: Principal, init?: RequestInit) => handleLocalApi(new Request(URL_, init), new URL(URL_), p);
    expect(await json(await call(OWNER))).toEqual({ status: 200, body: { ok: true, status: "missing", acceptDowngrade: true, rev: 0 } });
    for (const [, p] of DENIED) expect((await call(p, { method: "PUT", body: JSON.stringify({ rev: 0, acceptDowngrade: false }) }))!.status).toBe(403);
    expect(readTierLendSettings().status).toBe("missing");
  });

  test("设置页：出借页渲染独立的 TaskTierLendSettingsSection（不改角色表组件）", () => {
    const pages = readFileSync(join(import.meta.dir, "../web/features/chat/components/settings/pages.tsx"), "utf8");
    expect(pages).toContain('import { TaskTierLendSettingsSection } from "./task-tier-lend-settings-section";');
    const lend = pages.slice(pages.indexOf("<LendPanel />"), pages.indexOf("<BorrowPanel />"));
    expect(lend).toContain("<TaskTierLendSettingsSection />");
  });
});


describe("TIER3b2 回归：跨进程保存和运行路径诊断", () => {
  test("拿不到锁在五秒内停止等待，不落盘；释放后首次保存能建父目录", async () => {
    const path = tmpPath(), held = await acquireLock(`${path}.lock`, 0);
    expect(held).not.toBeNull();
    try {
      const start = performance.now();
      expect(await saveTierLendSettings({ kind: "actor", actor: "owner" }, { rev: 0, acceptDowngrade: false }, 5, path))
        .toMatchObject({ ok: false, code: "io" });
      // 轮询定时器可能被操作系统延后，留出调度余量。
      expect(performance.now() - start).toBeLessThan(6000);
      expect(existsSync(path)).toBe(false);
    } finally { held?.release(); }
    const nested = join(path, "..", "new", "settings.json");
    expect(await saveTierLendSettings({ kind: "actor", actor: "owner" }, { rev: 0, acceptDowngrade: false }, 6, nested))
      .toMatchObject({ ok: true, settings: { rev: 1, acceptDowngrade: false } });
  }, 10_000);

  test("两个真实进程同 rev 保存不同值：仅一方成功，另一方 conflict，最终值属于成功方", async () => {
    const path = tmpPath(), start = `${path}.start`;
    const modulePath = join(import.meta.dir, "../src/lib/task-tier-lend-settings.ts");
    const run = (index: number) => Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", `
      const fs = require("node:fs");
      const path = ${JSON.stringify(path)}, index = ${index};
      const rename = fs.renameSync;
      // 两个写者都通过 commitIf 后才放行 rename；有锁时第二个进不来，首个到期后独自提交。
      fs.renameSync = (from, to) => {
        if (to === path) {
          fs.writeFileSync(path + ".commit-" + index, "");
          const deadline = Date.now() + 1000, sleep = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(path + ".commit-" + (1 - index)) && Date.now() < deadline) Atomics.wait(sleep, 0, 0, 5);
        }
        return rename(from, to);
      };
      const { saveTierLendSettings } = await import(${JSON.stringify(modulePath)});
      fs.writeFileSync(path + ".ready-" + index, "");
      while (!fs.existsSync(${JSON.stringify(start)})) await Bun.sleep(5);
      const value = index === 1;
      const result = await saveTierLendSettings({ kind: "actor", actor: "owner" }, { rev: 0, acceptDowngrade: value }, 5, path);
      console.log(JSON.stringify({ ...result, value }));
    `], { stdout: "pipe", stderr: "pipe", env: testChildEnv({ CLAUDESTRA_STATE_DIR: join(path, "..") }) });
    const procs = [run(0), run(1)];
    try {
      const deadline = Date.now() + 5000;
      while ((!existsSync(`${path}.ready-0`) || !existsSync(`${path}.ready-1`)) && Date.now() < deadline) await Bun.sleep(5);
      expect(existsSync(`${path}.ready-0`) && existsSync(`${path}.ready-1`)).toBe(true);
      writeFileSync(start, "");
      const results = await Promise.all(procs.map(async (proc) => {
        const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        return JSON.parse(out) as { ok: boolean; code?: string; value: boolean };
      }));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toMatchObject([{ code: "conflict" }]);
      expect(readTierLendSettings(path)).toMatchObject({ status: "ok", settings: { rev: 1, acceptDowngrade: results.find((r) => r.ok)!.value } });
    } finally {
      for (const proc of procs) proc.kill();
      await Promise.all(procs.map((proc) => proc.exited));
    }
  }, 15_000);

  test("坏 JSON 在运行路径按关，只报一次；mtime 或 size 单独改变才再报", () => {
    const path = tmpPath(), time = new Date(1_700_000_000_000);
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    useTaskTierPort({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
    try {
      expect(tierLendGate(path)).toEqual({ on: true, acceptDowngrade: true });
      expect(log).toHaveBeenCalledTimes(0);
      writeFileSync(path, "{bad");
      utimesSync(path, time, time);
      expect(tierLendGate(path)).toEqual({ on: true, acceptDowngrade: false });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toContain("task-tier-lend");
      expect(log.mock.calls[0]![0]).toContain("不接受降档");
      for (let n = 0; n < 10; n++) expect(tierLendGate(path).acceptDowngrade).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      writeFileSync(path, "{still bad");
      utimesSync(path, time, time);
      tierLendGate(path);
      expect(log).toHaveBeenCalledTimes(2);
      utimesSync(path, new Date(+time + 1000), new Date(+time + 1000));
      tierLendGate(path);
      expect(log).toHaveBeenCalledTimes(3);
    } finally { log.mockRestore(); }
  });

  test("读不了的设置也只诊断一次；不同路径分别诊断", () => {
    const path = tmpPath(), other = tmpPath();
    mkdirSync(path);
    writeFileSync(other, "[]");
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    useTaskTierPort({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
    try {
      expect(readTierLendSettings(path).status).toBe("unreadable");
      for (let n = 0; n < 11; n++) expect(tierLendGate(path).acceptDowngrade).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(tierLendGate(other).acceptDowngrade).toBe(false);
      expect(log).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });
});

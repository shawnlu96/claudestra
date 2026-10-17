/**
 * TIER3b「接受降档建议」设置：lib/task-tier-lend-settings.ts（读 / 写 / 权限）、bridge local-api/task-tier-lend-settings.ts（网页门禁）、
 * manager/ledger-task-tier-lend-settings-cmd.ts（管理命令）。缺省开；只有 B 本人（owner）/ B 的 master 能改，peer（远端 A）、agent 一律拒。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTierLendSettingsApi } from "../src/bridge/local-api/task-tier-lend-settings.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
import { readTierLendSettings, saveTierLendSettings, TIER_LEND_SETTINGS_PATH } from "../src/lib/task-tier-lend-settings.js";
import { tierLendGate } from "../src/lib/task-tier-lend.js";
import { useTaskTierPort } from "../src/lib/task-tier-models.js";
import { TIER_LEND_SETTINGS_CMDS } from "../src/manager/ledger-task-tier-lend-settings-cmd.js";

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

  test("owner / master 能改（rev CAS）；agent、PM、peer 名都拒，文件不动", () => {
    const path = tmpPath();
    expect(saveTierLendSettings({ kind: "actor", actor: "owner" }, { rev: 0, acceptDowngrade: false }, 5, path))
      .toMatchObject({ ok: true, settings: { acceptDowngrade: false, rev: 1, updatedBy: "owner" } });
    expect(saveTierLendSettings({ kind: "actor", actor: "master" }, { rev: 1, acceptDowngrade: true }, 6, path)).toMatchObject({ ok: true });
    const before = readFileSync(path, "utf8");
    for (const actor of ["agent-pm", "scheduler", "a", "agent-lend-x"]) {
      expect(saveTierLendSettings({ kind: "actor", actor }, { rev: 2, acceptDowngrade: false }, 7, path)).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(saveTierLendSettings({ kind: "web", ownerFull: false }, { rev: 2, acceptDowngrade: false }, 7, path)).toMatchObject({ ok: false, code: "forbidden" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(saveTierLendSettings({ kind: "actor", actor: "owner" }, { rev: 1, acceptDowngrade: false }, 8, path)).toMatchObject({ ok: false, code: "conflict" });
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
    expect(() => cmd.run(cli("agent-pm", ["set", "on"], { rev: "1" }))).toThrow("只有本机 owner 或 master");
    expect(await cmd.run(cli("agent-pm", ["show"]))).toMatchObject({ acceptDowngrade: false, rev: 1 });
  });
});

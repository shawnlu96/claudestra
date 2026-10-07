/**
 * Codex 自动更新一轮的决策（src/lib/codex-auto-update.ts）+ 和网页按钮共用的整机锁（src/lib/codex-auto-update-gate.ts）。
 * 不真跑 npm：版本、忙闲、闸、shell、重启、通知、状态文件全注入；锁用临时目录里的真文件锁。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffMs, BUSY_RETRY_MS, CHECK_EVERY_MS, codexAutoUpdateTick, type CodexAutoDeps, type CodexAutoState } from "../src/lib/codex-auto-update";
import { tryUpdateLock } from "../src/lib/codex-auto-update-gate";
import { handleRuntimeUpdate } from "../src/bridge/runtime-update";
import type { Principal } from "../src/lib/principals";

const NOW = 1_000_000_000;
const ACP = (name: string, status = "active") => ({ name, runtime: "codex", transport: "acp", status });
const REG = [ACP("agent-a"), ACP("agent-b"), ACP("agent-lend-x"), ACP("agent-off", "stopped"), { name: "agent-t", runtime: "codex", status: "active" }, { name: "agent-cc", status: "active" }];

function rig(over: Partial<CodexAutoDeps> = {}, init: CodexAutoState = {}) {
  const log: string[] = [];
  const notes: string[] = [];
  let state: CodexAutoState = { ...init };
  const d: CodexAutoDeps = {
    now: () => NOW,
    enabled: async () => true,
    installed: async () => ({ version: "0.159.3", npm: true }),
    latest: async () => "0.160.1",
    agents: async () => REG,
    busy: async () => [],
    lock: async () => ({ release: () => log.push("release") }),
    prepare: async () => (log.push("prepare"), { command: "npm install -g @openai/codex@0.160.1" }),
    shell: async (cmd) => (log.push(`shell:${cmd}`), { ok: true, tail: "ok" }),
    restart: async (name) => (log.push(`restart:${name}`), { ok: true }),
    notify: async (text) => (notes.push(text), true),
    log: () => {},
    load: () => state,
    save: (s) => void (state = s),
    ...over,
  };
  return { d, log, notes, state: () => state };
}

describe("codexAutoUpdateTick", () => {
  test("开关关着：什么都不查", async () => {
    const { d, log } = rig({ enabled: async () => false, installed: async () => { throw new Error("不该探本机"); } });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("off");
    expect(log).toEqual([]);
  });
  test("没到时间：不查", async () => {
    const { d, log } = rig({ installed: async () => { throw new Error("不该探本机"); } }, { nextAt: NOW + 1 });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("not-due");
    expect(log).toEqual([]);
  });
  test("没有新版：不动，6 小时后再查", async () => {
    const { d, log, state } = rig({ latest: async () => "0.159.3" });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("up-to-date");
    expect(log).toEqual([]);
    expect(state().nextAt).toBe(NOW + CHECK_EVERY_MS);
  });
  test("不是 npm 全局安装：不动", async () => {
    const { d, log } = rig({ installed: async () => ({ version: "0.159.3", npm: false }) });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("no-npm");
    expect(log).toEqual([]);
  });
  test("有 ACP agent 忙（含出借 worker）：不升、不占锁、不判闸，半小时后再试", async () => {
    const asked: string[][] = [];
    const { d, log, state } = rig({ busy: async (names) => (asked.push(names), ["agent-lend-x"]) });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("busy");
    expect(asked[0]).toEqual(["agent-a", "agent-b", "agent-lend-x"]); // 只问在跑的 ACP Codex：tmux / 停掉的 / CC 不算
    expect(log).toEqual([]);
    expect(state().nextAt).toBe(NOW + BUSY_RETRY_MS);
  });
  test("判不兼容：不升，同一版本只通知一次", async () => {
    const refuse = async () => ({ status: 409, error: "按 app-server 协议判定和自研 Codex 适配器不兼容；组合身份 abc" });
    const r = rig({ prepare: refuse });
    expect((await codexAutoUpdateTick(r.d)).outcome).toBe("refused");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("0.160.1");
    expect(r.notes[0]).toContain("组合身份 abc");
    expect(r.log).toEqual(["release"]);
    // 6 小时后同一版本再判一次，仍不兼容：不再通知
    const again = rig({ prepare: refuse }, { ...r.state(), nextAt: undefined });
    expect((await codexAutoUpdateTick(again.d)).outcome).toBe("refused");
    expect(again.notes).toEqual([]);
    // 换了新版本又不兼容：再通知
    const next = rig({ prepare: refuse, latest: async () => "0.161.0" }, { ...r.state(), nextAt: undefined });
    await codexAutoUpdateTick(next.d);
    expect(next.notes).toHaveLength(1);
  });
  test("兼容且全空闲：跑一次升级，逐个重启；重启前复核到忙的跳过", async () => {
    let round = 0;
    // 前两次（锁外、npm 前）全空闲，之后逐个复核时 agent-b 开始忙
    const { d, log, notes } = rig({ busy: async (names) => (round++ < 2 ? [] : names.filter((n) => n === "agent-b")) });
    const r = await codexAutoUpdateTick(d);
    expect(r).toMatchObject({ outcome: "updated", restarted: ["agent-a", "agent-lend-x"], skipped: ["agent-b"] });
    expect(log).toEqual(["prepare", "shell:npm install -g @openai/codex@0.160.1", "restart:agent-a", "restart:agent-lend-x", "release"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("agent-b");
  });
  test("判闸期间有 agent 开始忙：不跑 npm，半小时后再试", async () => {
    let started = false;
    const { d, log, state } = rig({
      prepare: async () => (log.push("prepare"), (started = true), { command: "npm i" }),
      busy: async (names) => (started ? names.filter((n) => n === "agent-a") : []),
    });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("busy");
    expect(log).toEqual(["prepare", "release"]);
    expect(state().nextAt).toBe(NOW + BUSY_RETRY_MS);
  });
  test("判闸期间新起了 ACP agent：名单重读，它忙也挡住", async () => {
    let started = false;
    const asked: string[][] = [];
    const { d, log } = rig({
      agents: async () => (started ? [...REG, ACP("agent-new")] : REG),
      prepare: async () => ((started = true), { command: "npm i" }),
      busy: async (names) => (asked.push(names), names.filter((n) => n === "agent-new")),
    });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("busy");
    expect(asked[1]).toContain("agent-new");
    expect(log.filter((l) => l.startsWith("shell"))).toEqual([]);
  });
  test("「不兼容」通知没送到：不记已通知，半小时后重判重发", async () => {
    const refuse = async () => ({ status: 409, error: "不兼容" });
    const r1 = rig({ prepare: refuse, notify: async () => false });
    expect((await codexAutoUpdateTick(r1.d)).outcome).toBe("refused");
    expect(r1.state().refusedVersion).toBeUndefined();
    expect(r1.state().nextAt).toBe(NOW + BUSY_RETRY_MS);
    const r2 = rig({ prepare: refuse, now: () => NOW + BUSY_RETRY_MS }, r1.state());
    await codexAutoUpdateTick(r2.d);
    expect(r2.notes).toHaveLength(1);
    expect(r2.state().refusedVersion).toBe("0.160.1");
  });
  test("afterShell（切上游适配器）失败：不重启任何 agent，通知", async () => {
    const { d, log, notes } = rig({ prepare: async () => ({ command: "npm i", afterShell: async () => { throw new Error("对账失败"); } }) });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(log.filter((l) => l.startsWith("restart"))).toEqual([]);
    expect(notes[0]).toContain("acp-install");
  });
  test("npm 失败：通知 + 退避，下次按退避时间才再试；连续失败退避加长", async () => {
    const fail = { shell: async () => ({ ok: false, tail: "EACCES" }) };
    const r1 = rig(fail);
    expect((await codexAutoUpdateTick(r1.d)).outcome).toBe("failed");
    expect(r1.notes[0]).toContain("EACCES");
    expect(r1.log.filter((l) => l.startsWith("restart"))).toEqual([]);
    expect(r1.state()).toMatchObject({ failures: 1, failedVersion: "0.160.1", nextAt: NOW + backoffMs(1) });
    // 退避期内：不再试
    const early = rig({ ...fail, now: () => NOW + backoffMs(1) - 1 }, r1.state());
    expect((await codexAutoUpdateTick(early.d)).outcome).toBe("not-due");
    // 到点再失败：第 2 次，退避翻倍
    const r2 = rig({ ...fail, now: () => NOW + backoffMs(1) }, r1.state());
    await codexAutoUpdateTick(r2.d);
    expect(r2.state().failures).toBe(2);
    expect(backoffMs(2)).toBe(2 * backoffMs(1));
    expect(backoffMs(99)).toBe(48 * 3600_000);
  });
  test("闸 5xx（查不到 npm / 装配套适配器失败）按失败退避，不当成「不兼容」", async () => {
    const { d, state } = rig({ prepare: async () => ({ status: 502, error: "查不到 npm" }) });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(state()).toMatchObject({ failures: 1 });
    expect(state().refusedVersion).toBeUndefined();
  });
  test("锁被占（网页按钮在更新）：不判闸、不升，半小时后再试", async () => {
    const { d, log } = rig({ lock: async () => ({ holder: "agent-a" }) });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("locked");
    expect(log).toEqual([]);
  });
});

describe("整机锁：网页按钮与自动更新共用（文件锁，跨进程）", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const x of dirs.splice(0)) rmSync(x, { recursive: true, force: true }); });
  const lockPath = () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-lock-"));
    dirs.push(dir);
    return join(dir, "runtime-update.lock");
  };
  const OWNER = { id: "discord:1", role: "owner", agents: ["*"], createdAt: "2026-01-01T00:00:00Z" } as Principal;

  test("自动更新在跑：网页按钮 409 并说清是谁；释放后能拿到", async () => {
    const path = lockPath();
    const lock = (label: string) => tryUpdateLock(label, path);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const shells: string[] = [];
    const auto = codexAutoUpdateTick(rig({ lock, shell: async (cmd) => (shells.push(cmd), await gate, { ok: true, tail: "" }) }).d);
    await Bun.sleep(10);
    const web = (l = lock) => handleRuntimeUpdate("/agents/c/codex-update", OWNER, async () => ({ ok: true }), {
      agents: async () => [{ name: "agent-c", runtime: "codex" }],
      busy: () => false,
      shell: async (cmd) => (shells.push(`web:${cmd}`), { ok: true, tail: "" }),
      updaters: { pi: { label: "Pi", prepare: async () => ({ command: "pi" }), forget: () => {} }, codex: { label: "Codex", prepare: async () => ({ command: "npm i" }), forget: () => {} } },
      lock: l,
    });
    const r = await web();
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("Codex 自动更新");
    release();
    expect((await auto).outcome).toBe("updated");
    expect(shells).toEqual(["npm install -g @openai/codex@0.160.1"]); // 只跑了一个
    expect((await web()).status).toBe(200);
  });
  test("网页按钮在跑：自动更新这一轮跳过", async () => {
    const path = lockPath();
    const held = await tryUpdateLock("agent-c", path);
    expect("release" in held).toBe(true);
    const { d, log } = rig({ lock: (label) => tryUpdateLock(label, path) });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("locked");
    expect(log).toEqual([]);
    if ("release" in held) held.release();
    expect((await codexAutoUpdateTick(rig({ lock: (label) => tryUpdateLock(label, path) }).d)).outcome).toBe("updated");
  });
});

/**
 * 命令层接线：agent 设置文件跟着 manager 的 rename / remove 走（lib/agent-settings.ts）。子进程跑真实的 manager.ts：
 * 状态、tmux socket 指到临时目录，bridge 指到没人听的端口，DISCORD_CHANNEL_ID 去掉（按终端 owner 跑），碰不到线上。
 * kill 只是停止、不删文件：没有窗口时它直接拒绝，这里不测；「kill 不删」由 manager.ts 里不再有调用保证（git log -S removeAgentSettings）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-settings-cmd-"));
const state = join(dir, "state");
const settings = (name: string) => join(state, "agent-settings", `${name}.json`);
/** 本机技能库里没有的名字：子进程读的是真 HOME 的技能库，用真技能名会碰上同名的同步技能（lib/agent-skills.ts skillWrites） */
const PROBE = "t17-probe-skill";

async function manager(...args: string[]): Promise<any> {
  const env: Record<string, string | undefined> = {
    ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "run"), BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9",
  };
  delete env.DISCORD_CHANNEL_ID;
  const proc = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/manager.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim().split("\n").pop() || "{}");
}

describe("manager 命令层：设置文件的生命周期", () => {
  test("skill-toggle 写文件 → rename 跟着挪 → remove 删掉", async () => {
    mkdirSync(state, { recursive: true });
    mkdirSync(join(dir, "run"), { recursive: true });
    const agent = { cwd: dir, status: "stopped", channelId: "local-1", project: "", purpose: "", created: "", notes: "" };
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-x": agent } }));
    expect((await manager("skill-toggle", "x", PROBE, "off")).ok).toBe(true);
    expect(JSON.parse(readFileSync(settings("agent-x"), "utf8"))).toEqual({ skillOverrides: { [PROBE]: "off" } });
    expect((await manager("rename", "x", "y")).ok).toBe(true);
    expect(existsSync(settings("agent-x"))).toBe(false);
    expect(existsSync(settings("agent-y"))).toBe(true);
    expect((await manager("remove", "y")).ok).toBe(true);
    expect(existsSync(settings("agent-y"))).toBe(false);
  }, 60_000);
  test("rename 没做完（带 pending）的 agent 拒绝调技能：补跑会用旧名的文件把它覆盖掉", async () => {
    const agent = { cwd: dir, status: "stopped", channelId: "local-2", project: "", purpose: "", created: "", notes: "" };
    const pending = { op: "rename", pid: 1, startedAt: "2026-09-28T10:00:00Z", from: "agent-old" };
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-new": { ...agent, pending } } }));
    const r = await manager("skill-toggle", "new", "pdf", "off");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rename");
    expect(existsSync(settings("agent-new"))).toBe(false);
  }, 60_000);
  test("agent-master / Master 都写进 launcher 读的 master.json", async () => {
    for (const name of ["agent-master", "Master"]) {
      expect((await manager("skill-toggle", name, PROBE, "off")).ok).toBe(true);
      expect(existsSync(settings("agent-master"))).toBe(false);
      expect(JSON.parse(readFileSync(settings("master"), "utf8"))).toEqual({ skillOverrides: { [PROBE]: "off" } });
      expect((await manager("skill-toggle", name, PROBE, "on")).ok).toBe(true);
    }
  }, 60_000);
  test("技能名 / 档位 / agent 不合法都拒", async () => {
    expect((await manager("skill-toggle", "nobody", "pdf", "off")).ok).toBe(false);
    expect((await manager("skill-toggle", "master", "__proto__", "off")).ok).toBe(false);
    expect((await manager("skill-toggle", "master", "pdf", "maybe")).ok).toBe(false);
  }, 60_000);
});

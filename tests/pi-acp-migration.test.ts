/**
 * `manager migrate --pi <agent> [--to tmux]`（src/manager/pi-acp-migration.ts）：只动点名的 Pi agent；切换走 transport 那条路；
 * acp 起不来就退回 tmux（沙箱不退）；切换前就被拒（registry 没动）不回退；--to tmux 是回退；会话 id 不变。
 * 端到端（沙箱真 pi）见 PR3 的证据，这里钉住决策逻辑。
 */
import { describe, expect, test } from "bun:test";
import { migratePi, parsePiMigrateArgs, PI_MIGRATE_USAGE, type PiMigrateDeps } from "../src/manager/pi-acp-migration.ts";

type Agent = { runtime?: string; transport?: string; sessionId?: string };

function deps(agents: Record<string, Agent>, results: Record<string, Record<string, unknown>[]>, sandbox = false) {
  const calls: string[] = [];
  const d: PiMigrateDeps = {
    agents: async () => agents,
    switchTo: async (name, mode) => {
      calls.push(`${name}→${mode}`);
      const r = results[mode]?.shift() ?? { ok: true, agent: name, transport: mode, restarted: true };
      // 同 switchTransport：先把 transport 写进 registry 再 restart（restart 失败也已经写了）；起来后以实际的为准；切换前就被拒（没有 restarted）不动
      if (r.restarted !== undefined) agents[name] = { ...agents[name], transport: r.restarted ? String(r.transport ?? mode) : mode };
      return r;
    },
    sandbox,
  };
  return { d, calls };
}

const PI = { "agent-pa": { runtime: "pi", sessionId: "s-1" } as Agent };
const fresh = () => ({ "agent-pa": { ...PI["agent-pa"] } });

describe("参数", () => {
  test("agent 名必填；--to 只认 acp / tmux；缺省 acp", () => {
    expect(parsePiMigrateArgs(["pa"])).toEqual({ name: "pa", to: "acp" });
    expect(parsePiMigrateArgs(["--to", "tmux", "pa"])).toEqual({ name: "pa", to: "tmux" });
    for (const bad of [[], ["pa", "pb"], ["pa", "--to", "codex"], ["--to"], ["-x"]]) expect(parsePiMigrateArgs(bad), bad.join(" ")).toEqual({ error: PI_MIGRATE_USAGE });
  });
});

describe("tmux → acp", () => {
  test("成功：经 transport 切 acp，会话 id 不变", async () => {
    const { d, calls } = deps(fresh(), {});
    expect(await migratePi(["pa"], d)).toMatchObject({ ok: true, agent: "agent-pa", transport: "acp", sessionId: "s-1", sameSession: true });
    expect(calls).toEqual(["agent-pa→acp"]);
  });

  test("拒绝：不存在、不是 Pi（Codex / Claude Code 不走这条）；已经是 acp 不重启", async () => {
    const agents = { ...fresh(), "agent-cx": { runtime: "codex" }, "agent-cc": {}, "agent-pb": { runtime: "pi", transport: "acp" } };
    const { d, calls } = deps(agents, {});
    expect(await migratePi(["nope"], d)).toEqual({ ok: false, error: `agent "nope" 不存在` });
    expect((await migratePi(["cx"], d)).error).toContain("migrate --acp");
    expect((await migratePi(["agent-cc"], d)).error).toContain("runtime=claude-code");
    expect(await migratePi(["pb"], d)).toEqual({ ok: true, agent: "agent-pb", transport: "acp", unchanged: true });
    expect(calls).toEqual([]);
  });

  test("切换前就被拒（pi 太旧 / 同名 MCP：没有 restarted 字段）：原样报，不回退", async () => {
    const refused = { ok: false, error: "pi 版本太旧" };
    const { d, calls } = deps(fresh(), { acp: [refused] });
    expect(await migratePi(["pa"], d)).toEqual(refused);
    expect(calls).toEqual(["agent-pa→acp"]);
  });

  test("acp 起不来：退回 tmux 再起一次，报 fellBack；退也退不回就把两边的原因都给出来，transport / sessionId 按 registry 的实际", async () => {
    const failed = { ok: false, agent: "agent-pa", from: "tmux", transport: "acp", restarted: false, error: "重启失败：宿主没就绪" };
    const a = deps(fresh(), { acp: [{ ...failed }] });
    expect(await migratePi(["pa"], a.d)).toEqual({ ok: false, agent: "agent-pa", transport: "tmux", sessionId: "s-1", ready: true, fellBack: true, error: failed.error });
    expect(a.calls).toEqual(["agent-pa→acp", "agent-pa→tmux"]);
    const agents = fresh();
    const b = deps(agents, { acp: [{ ...failed }], tmux: [{ ok: false, transport: "tmux", restarted: false, error: "tmux 也起不来" }] });
    const r = await migratePi(["pa"], b.d);
    expect(r).toEqual({ ok: false, agent: "agent-pa", transport: "tmux", sessionId: "s-1", ready: false, fellBack: true, error: failed.error, fallbackError: "tmux 也起不来" });
    expect(r.transport).toBe(agents["agent-pa"].transport); // 审查复现：修前这里报 acp，registry 实际是 tmux
  });

  test("restart 自己已退回 tmux（recoverFailedAcpLaunch）：不再切一次，起来了报 ready、没起来把原因给出来", async () => {
    const selfFellBack = { ok: false, agent: "agent-pa", from: "tmux", transport: "tmux", restarted: true, fellBack: true, error: "acp 启动失败，已恢复 tmux" };
    const a = deps(fresh(), { acp: [selfFellBack] });
    expect(await migratePi(["pa"], a.d)).toEqual({ ok: false, agent: "agent-pa", transport: "tmux", sessionId: "s-1", ready: true, fellBack: true, error: selfFellBack.error });
    expect(a.calls).toEqual(["agent-pa→acp"]);
    const agents = fresh();
    const calls: string[] = [];
    const d: PiMigrateDeps = { agents: async () => agents, sandbox: false, switchTo: async (name, mode) => {
      calls.push(`${name}→${mode}`);
      agents["agent-pa"] = { ...agents["agent-pa"], transport: "tmux" }; // restart 退回 tmux 后 tmux 也没起来
      return { ok: false, restarted: false, error: "tmux 也起不来" };
    } };
    expect(await migratePi(["pa"], d)).toMatchObject({ ok: false, transport: "tmux", ready: false, fellBack: true, fallbackError: "tmux 也起不来" });
    expect(calls).toEqual(["agent-pa→acp"]);
  });

  test("沙箱里不退回 tmux（沙箱没有 TUI 版 Pi）", async () => {
    const failed = { ok: false, restarted: false, error: "重启失败" };
    const { d, calls } = deps(fresh(), { acp: [failed] }, true);
    expect(await migratePi(["pa"], d)).toEqual(failed);
    expect(calls).toEqual(["agent-pa→acp"]);
  });
});

describe("回退：--to tmux", () => {
  test("acp → tmux 走 transport 同一条路，结果原样给出", async () => {
    const agents = { "agent-pa": { runtime: "pi", transport: "acp", sessionId: "s-1" } };
    const { d, calls } = deps(agents, {});
    expect(await migratePi(["pa", "--to", "tmux"], d)).toMatchObject({ ok: true, transport: "tmux" });
    expect(calls).toEqual(["agent-pa→tmux"]);
    expect(agents["agent-pa"].transport).toBe("tmux");
  });
});

/**
 * 手动探测（bridge/account-usage-probe.ts）：假 tmux 里另有 master / agent / owner 会话，探测只建、只敲、只收自己那一个；
 * 成功 / 要确认 bypass / 启动超时 / 中途异常都收掉自己的资源，其它会话 0 键 0 kill。启动命令是干净启动（strict MCP 空表、
 * 不读设置源、关 hooks、禁工具、不带 prompt）。零真实 tmux、零模型调用。
 */
import { describe, expect, test } from "bun:test";
import { cleanupProbe, probeCommand, PROBE_SESSION_PREFIX, runUsageProbe, type ProbeTmux } from "../src/bridge/account-usage-probe.ts";
import type { ProbeResource } from "../src/lib/account-usage-refresh.ts";

const READY = "Claude Code\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
const TYPED = "Claude Code\n\n❯ /status\n  /status  Show Claude Code status\n";
const PANEL = " Settings  Status  Config  Usage\n\n Current session\n ██████ 12% used\n Resets 7pm (UTC)\n\n" +
  " Current week (all models)\n ███ 34% used\n Resets Jul 16 at 6am (UTC)\n\n Esc to cancel\n";
const CONSENT = "WARNING: Claude Code running in Bypass Permissions mode\n ❯ 1. No, exit\n   2. Yes, I accept\n Enter to confirm · Esc to cancel\n";

type Mode = "ok" | "consent" | "never-ready" | "throw-on-type";
function fakeTmux(mode: Mode) {
  const sessions = new Map<string, { name: string; screen: string }>([
    ["$0", { name: "master", screen: READY }], ["$1", { name: "owner-work", screen: READY }], ["$2", { name: "agent-pm", screen: READY }],
  ]);
  const log: string[] = [];
  let next = 10;
  const tmux: ProbeTmux = {
    async newSession(name, _dir, command) {
      log.push(`new ${name}`);
      expect(command).toContain("--strict-mcp-config");
      const id = `$${next++}`;
      sessions.set(id, { name, screen: mode === "consent" ? CONSENT : mode === "never-ready" ? "starting…" : READY });
      return id;
    },
    async capture(id) { log.push(`capture ${id}`); return sessions.get(id)?.screen ?? ""; },
    async sendLiteral(id, text) {
      log.push(`keys ${id} ${text}`);
      if (mode === "throw-on-type") throw new Error("tmux exploded");
      const s = sessions.get(id);
      if (s) s.screen = TYPED;
    },
    async sendKey(id, key) {
      log.push(`keys ${id} ${key}`);
      const s = sessions.get(id);
      if (s && key === "Enter") s.screen = PANEL;
    },
    async nameOf(id) { return sessions.get(id)?.name ?? null; },
    async kill(id) { log.push(`kill ${id}`); sessions.delete(id); },
  };
  return { tmux, log, sessions };
}

function deps(t: ReturnType<typeof fakeTmux>, removed: string[]) {
  let now = 1_787_798_183_000;
  return { tmux: t.tmux, claudeBin: () => "/usr/local/bin/claude", sleep: async (ms: number) => void (now += ms), now: () => now,
    makeDir: () => "/tmp/fake-probe-dir", removeDir: (d: string) => void removed.push(d), timeoutMs: 5_000 };
}
const others = (log: string[]) => log.filter((l) => /\$[012]\b/.test(l));

describe("runUsageProbe", () => {
  test("成功：只在自己建的会话里敲键，读到 Usage，读完收掉自己；其它会话 0 键 0 kill", async () => {
    const t = fakeTmux("ok");
    const removed: string[] = [];
    const created: ProbeResource[] = [];
    const r = await runUsageProbe((x) => created.push(x), deps(t, removed));
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.usage.sessionPct, r.usage.weekPct]).toEqual([12, 34]);
    expect(created).toHaveLength(1);
    expect(created[0]!.session.startsWith(PROBE_SESSION_PREFIX)).toBe(true);
    expect(t.log.filter((l) => l.startsWith("keys")).every((l) => l.startsWith(`keys ${created[0]!.id} `))).toBe(true);
    expect(t.log.filter((l) => l.startsWith("kill"))).toEqual([`kill ${created[0]!.id}`]);
    expect(others(t.log)).toEqual([]);
    expect(t.sessions.size).toBe(3);
    expect(removed).toEqual(["/tmp/fake-probe-dir"]);
  });

  for (const [mode, reason] of [["consent", "probe_needs_bypass_consent"], ["never-ready", "probe_start_timeout"], ["throw-on-type", "tmux exploded"]] as const) {
    test(`失败（${mode}）：明确失败，不替用户确认，只收掉自己`, async () => {
      const t = fakeTmux(mode);
      const removed: string[] = [];
      const r = await runUsageProbe(() => {}, deps(t, removed));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(reason);
      expect(t.log.filter((l) => l.startsWith("kill"))).toEqual(["kill $10"]);
      expect(t.log.some((l) => l.includes("Enter") && mode === "consent")).toBe(false);
      expect(others(t.log)).toEqual([]);
      expect(t.sessions.size).toBe(3);
      expect(removed).toEqual(["/tmp/fake-probe-dir"]);
    });
  }

  test("硬超时：判失败；超时之后才建出来的会话也被收掉、不登记给闸", async () => {
    const t = fakeTmux("ok");
    const realNew = t.tmux.newSession;
    t.tmux.newSession = async (...a) => { await new Promise((r) => setTimeout(r, 40)); return realNew(...a); };
    const created: ProbeResource[] = [];
    const r = await runUsageProbe((x) => created.push(x), { ...deps(t, []), hardTimeoutMs: 5 });
    expect(r).toEqual({ ok: false, reason: "probe_timeout" });
    await new Promise((r) => setTimeout(r, 80));
    expect(created).toEqual([]);
    expect(t.log.filter((l) => l.startsWith("kill"))).toEqual(["kill $10"]);
    expect(others(t.log)).toEqual([]);
    expect(t.sessions.size).toBe(3);
  });

  test("没有 claude CLI：明确失败，不碰 tmux（不降级借用户窗口）", async () => {
    const t = fakeTmux("ok");
    const r = await runUsageProbe(() => {}, { ...deps(t, []), claudeBin: () => null });
    expect(r).toEqual({ ok: false, reason: "probe_unavailable: claude CLI not found" });
    expect(t.log).toEqual([]);
  });
});

describe("cleanupProbe", () => {
  test("只收记录里那一个：id 已换成别的会话名 / 不是探测前缀 / 空 id 都不 kill", async () => {
    const t = fakeTmux("ok");
    const removed: string[] = [];
    await cleanupProbe({ session: `${PROBE_SESSION_PREFIX}aaaa`, id: "$1", dir: "/tmp/a" }, { tmux: t.tmux, removeDir: (d) => void removed.push(d) });
    await cleanupProbe({ session: "master", id: "$0", dir: "/tmp/b" }, { tmux: t.tmux, removeDir: (d) => void removed.push(d) });
    await cleanupProbe({ session: `${PROBE_SESSION_PREFIX}bbbb`, id: "", dir: "/tmp/c" }, { tmux: t.tmux, removeDir: (d) => void removed.push(d) });
    expect(t.log.filter((l) => l.startsWith("kill"))).toEqual([]);
    expect(t.sessions.size).toBe(3);
  });
});

describe("probeCommand", () => {
  test("干净启动：env -i、临时状态目录、strict MCP 空表、不读设置源、关 hooks、禁工具、没有 prompt / 频道", () => {
    const cmd = probeCommand("/usr/local/bin/claude", "/tmp/probe-x", { PATH: "/usr/bin", HOME: "/Users/u", GH_TOKEN: "secret", CLAUDESTRA_STATE_DIR: "/prod" });
    expect(cmd.startsWith("env -i ")).toBe(true);
    expect(cmd).not.toContain("secret");
    expect(cmd).toContain("CLAUDESTRA_STATE_DIR=/tmp/probe-x/state");
    expect(cmd.lastIndexOf("CLAUDESTRA_STATE_DIR=/tmp/probe-x/state")).toBeGreaterThan(cmd.indexOf("CLAUDESTRA_STATE_DIR=/prod"));
    for (const f of ["--strict-mcp-config", `'{"mcpServers":{}}'`, "--setting-sources ''", "disableAllHooks", "--disallowedTools"]) expect(cmd).toContain(f);
    for (const f of ["--append-system-prompt", " -p ", "--print", "development-channels", "--resume"]) expect(cmd).not.toContain(f);
  });
});

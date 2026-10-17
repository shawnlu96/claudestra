/**
 * agents-CODEXRO1 验收线 3（PM 补）：不带 --mode 的 resume 起进程时仍是只读。
 * - 生命周期重建：真调 scheduler-wake-stopped 的 wakeBeforeSend，manager resume 桩住、截下 argv；
 * - 网页收编：api-routes 的 resume argv（含 --fork）从不带 --mode；
 * 截到的 argv 按 cmdResume 的规则（codex-readonly.ts resumePermissionMode）定档位，再拼 tmux 启动命令断言只读。
 * 额度恢复不在这里：额度闸只管 Claude Code（quota-wall-wiring.ts isClaudeCode），且是往在跑的会话里投消息、不重起进程。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wakeBeforeSend } from "../src/lib/scheduler-wake-stopped.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { createCodexAdapter } from "../src/lib/runtimes/codex.js";
import { modeSwitchError, READ_ONLY_MODE, READ_ONLY_SWITCH_ERROR, resumePermissionMode } from "../src/lib/codex-readonly.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

const SID = "019a0000-1111-7222-8333-444455556666";
const RO_TUI = "--sandbox read-only --ask-for-approval never";
const BYPASS = "dangerously-bypass-approvals-and-sandbox";
const PRIOR = { runtime: "codex", transport: "tmux", permissionMode: READ_ONLY_MODE };

/** cmdResume 的取法：argv 里 --mode 的值（没有 = undefined） */
const modeFlag = (argv: string[]) => (argv.includes("--mode") ? argv[argv.indexOf("--mode") + 1] : undefined);

/** resume 定下档位后 launchInWindow 拼的 tmux 命令（registry 桩成空：只看 spec 带进来的档位） */
async function tmuxCommandFor(argv: string[], prior: { permissionMode?: string }): Promise<string> {
  const r = resumePermissionMode(modeFlag(argv), prior);
  if ("error" in r) throw new Error(r.error);
  const a = createCodexAdapter({
    run: async (cmd: string[]) => ({ ok: true, out: cmd[1] === "queue" ? "Usage: codex queue [OPTIONS] --thread <THREAD>" : "", err: "" }),
    resolveBin: async () => "/opt/codex/bin/codex", sessionCwd: () => "/w", bunBin: "/usr/local/bin/bun", repoRoot: REPO_ROOT, now: () => 0,
  }, () => undefined);
  await a.available();
  return a.buildLaunchCommand({ mode: "resume", sessionId: SID, cwd: "/w", channelId: "1", bridgeUrl: "ws://localhost:1", settingsName: "agent-x", permissionMode: r.mode });
}

describe("[验收线 3] 不带 --mode 的 resume 仍是只读", () => {
  test("生命周期重建（scheduler-wake-stopped）：argv 不带 --mode，按旧条目定成只读，启动命令只读", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      const { id } = f.db.query("SELECT id FROM scheduler_intents ORDER BY eventSeq DESC LIMIT 1").get() as { id: string };
      const row = { name: "agent-task-one", status: "stopped", sessionId: "s-one", cwd: f.dir, ...PRIOR } as unknown as RegistryAgent;
      const calls: string[][] = [];
      const manager = async (...a: string[]) => (calls.push(a), { ok: true, ready: true });
      const policy = () => ({ mode: "on" as const, manualAfterMs: null, source: "config" as const });
      expect(await wakeBeforeSend({ db: f.db, manager, policy, timeoutMs: 500 }, row, "s-one", id, () => true)).toEqual({ send: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("--mode");
      const cmd = await tmuxCommandFor(calls[0]!, PRIOR);
      expect(cmd).toContain(RO_TUI);
      expect(cmd).not.toContain(BYPASS);
    } finally {
      f.close();
    }
  });

  test("网页收编（POST resume，含 --fork）：路由拼的 argv 不带 --mode，按旧条目定成只读", async () => {
    const src = readFileSync(join(REPO_ROOT, "src/bridge/api-routes.ts"), "utf8");
    const start = src.indexOf('const args = ["resume", agent, sessionId];');
    const end = src.indexOf("await runManager(...args)", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain("--mode");
    for (const argv of [["resume", "agent-x", SID, "/w", "--runtime", "codex"], ["resume", "agent-x", SID, "/w", "--runtime", "codex", "--fork"]]) {
      expect(await tmuxCommandFor(argv, PRIOR)).toContain(RO_TUI);
    }
  });

  test("只读 agent 显式换档被拒；显式给 readOnly 照旧；不是只读的 agent 一字不变", () => {
    for (const m of ["bypassPermissions", "auto", "plan"]) {
      const r = resumePermissionMode(m, PRIOR);
      expect("error" in r && r.error).toContain(READ_ONLY_SWITCH_ERROR);
    }
    expect(resumePermissionMode("readOnly", PRIOR)).toEqual({ mode: READ_ONLY_MODE });
    expect(resumePermissionMode(undefined, { permissionMode: "bypassPermissions" })).toEqual({ mode: undefined });
    expect(resumePermissionMode("plan", { permissionMode: "bypassPermissions" })).toEqual({ mode: "plan" });
    expect(resumePermissionMode(undefined, undefined)).toEqual({ mode: undefined });
  });

  test("manager mode：只读 agent 改成别的档位被拒；改成 readOnly / 非只读 agent 放行", () => {
    for (const m of ["bypassPermissions", "auto", "plan"]) expect(modeSwitchError(PRIOR, m)).toContain(READ_ONLY_SWITCH_ERROR);
    expect(modeSwitchError(PRIOR, "readOnly")).toBeNull();
    expect(modeSwitchError({ permissionMode: "bypassPermissions" }, "plan")).toBeNull();
    expect(modeSwitchError(undefined, "plan")).toBeNull();
  });
});

/** 真起 Bun 宿主与假 Claude 子进程：本机登录口径（HOME 不改写、无 token）、Bun 禁自动加载、正常交付后归档、信号停止和目录清理。 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLendClaudeCommand, claudeWorkerPlan } from "../src/lib/lend-claude-worker.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";
import { advance, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { BUN_NO_AUTOLOAD, pickWorkerEnv } from "../src/lib/runtimes/clean-env.js";
import { pidAlive } from "../src/lib/tmux-helper.js";
import { testChildEnv } from "./test-env.js";
import { runClaudeWorkerHost } from "../src/lib/lend-claude-worker-host.js";

test("宿主失败保留脱敏原因；只有清理成功才报告已清理", async () => {
  const plan = {} as ReturnType<typeof claudeWorkerPlan>;
  for (const cleanupFails of [false, true]) {
    const logs: string[] = [];
    const code = await runClaudeWorkerHost(plan, { reason: () => null, log: (s) => logs.push(s),
      spawn: () => { throw new Error("CLI ENOENT sk-ant-secret12345"); }, stop: async () => {},
      cleanup: () => { if (cleanupFails) throw new Error("cleanup EACCES"); },
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain(cleanupFails ? "cleanup EACCES" : "CLI ENOENT");
    expect(logs.join("\n")).toContain(cleanupFails ? "清理未确认" : "启动目录已清理");
    expect(logs.join("\n")).not.toContain("sk-ant-secret12345");
    if (cleanupFails) expect(logs.join("\n")).not.toContain("启动目录已清理");
  }
});

/** 出借方机器：假 HOME（里面有出借方自己的 .claude）、状态目录、clone、一张已开跑的 Claude 单 */
function lender(sessionId: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-host-")));
  const owner = join(root, "owner"), cwd = join(root, "clone"), state = join(root, "state");
  const agent = "agent-lend-smoke";
  mkdirSync(join(owner, ".claude"), { recursive: true }); mkdirSync(cwd, { recursive: true });
  writeFileSync(join(owner, ".claude", "CLAUDE.md"), "owner-private");
  const env = testChildEnv({ ...pickWorkerEnv(process.env), HOME: owner, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(root, "runtime") });
  writeFileSync(join(cwd, ".env"), "LEND_ENV_POISON=should-never-load\n");
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./poison.ts"]\n');
  writeFileSync(join(cwd, "poison.ts"), 'throw new Error("untrusted preload executed")');
  // 假 Claude：记下拿到的环境，在出借方默认 projects 目录写一段会话；有 hold 标记就一直跑（等信号），否则交付后退出
  const project = join(owner, ".claude", "projects", projectsSlug(cwd));
  const fake = join(root, "fake-claude.sh");
  writeFileSync(fake, `#!/bin/sh
echo "$$" > observed.pid
env > observed.env
mkdir -p '${project}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"delivered"}]}}' > '${project}/${sessionId}.jsonl'
while [ -f hold ]; do sleep 0.05; done
`);
  chmodSync(fake, 0o755);
  const db = openLendJournal(join(state, "lend", "journal.sqlite"));
  const now = Date.now();
  recordAsked(db, { orderId: "o1", peer: "a", fp: "abcd-ef01-2345-6789", family: "claude", preview: { repo: "o/r", step: "review" } }, now);
  advance(db, "o1", "asked", "claimed", { leaseUntil: now + 60_000, leaseGen: 1 }, now);
  advance(db, "o1", "claimed", "cloned", { dir: cwd }, now); patchOrder(db, "o1", ["cloned"], { agent }, now); db.close();
  const grant = { version: 2, enabled: true, borrow: [], lend: [{ peer: "a", fp: "abcd-ef01-2345-6789", families: { claude: 1 },
    roles: ["review"], repos: ["o/r"], ordersPerDay: 5, grantedAt: new Date(now).toISOString(), until: new Date(now + 3600_000).toISOString() }] };
  writeFileSync(join(state, "lend.json"), JSON.stringify(grant));
  // 和生产一样经 buildLendClaudeCommand 生成启动计划；出借方环境里残留的旧 token 不该带进去
  buildLendClaudeCommand({ mode: "new", cwd, agentName: agent, sessionId, channelId: "test", bridgeUrl: "ws://127.0.0.1:9", callerCredFile: "/unused-test-cred" },
    { base: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "legacy-should-not-pass" }, root: join(state, "lend", "claude-config"), bin: fake });
  const parent = join(state, "lend", "claude-config", agent);
  const dir = join(parent, readdirSync(parent)[0]!);
  const start = () => Bun.spawn([process.execPath, ...BUN_NO_AUTOLOAD, join(import.meta.dir, "../src/lib/lend-claude-worker-host.ts"), join(dir, "launch.json")],
    { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const observed = () => Object.fromEntries(readFileSync(join(cwd, "observed.env"), "utf8").split("\n").filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const revoke = () => { grant.lend[0]!.until = new Date(now - 1).toISOString(); grant.enabled = false; writeFileSync(join(state, "lend.json"), JSON.stringify(grant)); };
  return { root, owner, cwd, state, agent, dir, project, start, observed, revoke };
}

test("不配 setup-token：宿主用出借方默认 HOME 起 Claude，交付后退出、会话归档、代次目录清理，出借方文件不动", async () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const f = lender(sessionId);
  const proc = f.start();
  try {
    const code = await proc.exited;
    if (code !== 0) throw new Error(`host failed: ${await new Response(proc.stderr).text()}`);
    const seen = f.observed();
    expect(seen.HOME).toBe(f.owner);
    expect(seen.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(seen.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(seen.LEND_ENV_POISON).toBeUndefined();
    expect(existsSync(f.dir)).toBe(false);
    expect(readFileSync(join(f.state, "archive", f.agent, `${sessionId}.jsonl`), "utf8")).toContain("delivered");
    expect(existsSync(join(f.project, `${sessionId}.jsonl`))).toBe(true);
    expect(readFileSync(join(f.owner, ".claude", "CLAUDE.md"), "utf8")).toBe("owner-private");
  } finally {
    if (proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; }
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15_000);

test("收回授权：看门狗停掉 Claude 子进程，启动代次目录清理", async () => {
  const f = lender("660e8400-e29b-41d4-a716-446655440000");
  writeFileSync(join(f.cwd, "hold"), "");
  const proc = f.start();
  try {
    for (let i = 0; i < 150 && !existsSync(join(f.cwd, "observed.pid")) && proc.exitCode === null; i++) await Bun.sleep(20);
    if (!existsSync(join(f.cwd, "observed.pid"))) {
      if (proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; }
      throw new Error(`host failed: ${await new Response(proc.stderr).text()}`);
    }
    const pid = Number(readFileSync(join(f.cwd, "observed.pid"), "utf8"));
    expect(existsSync(join(f.dir, "launch.json"))).toBe(false);
    f.revoke();
    proc.kill("SIGTERM");
    await proc.exited;
    expect(pidAlive(pid)).toBe(false);
    expect(existsSync(f.dir)).toBe(false);
  } finally {
    if (proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; }
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15_000);

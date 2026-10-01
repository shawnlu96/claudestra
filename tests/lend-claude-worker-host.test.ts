/** 真起 Bun 宿主与假 Claude 子进程：socket 凭据交接、Bun 禁自动加载、信号停止和目录清理。 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeWorkerPlan } from "../src/lib/lend-claude-worker.js";
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
      receive: async () => "test-only-secret",
      spawn: () => { throw new Error("CLI ENOENT test-only-secret sk-ant-secret12345"); }, stop: async () => {},
      cleanup: () => { if (cleanupFails) throw new Error("cleanup EACCES"); },
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain(cleanupFails ? "cleanup EACCES" : "CLI ENOENT");
    expect(logs.join("\n")).toContain(cleanupFails ? "清理未确认" : "配置目录已清理");
    expect(logs.join("\n")).not.toContain("test-only-secret");
    expect(logs.join("\n")).not.toContain("sk-ant-secret12345");
    if (cleanupFails) expect(logs.join("\n")).not.toContain("配置目录已清理");
  }
});

test("真实宿主只给 Claude 子进程 token；停止后进程和隔离目录均消失", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-host-")));
  const cwd = join(root, "clone"), state = join(root, "state");
  const agent = "agent-lend-smoke";
  const dir = join(state, "lend", "claude-config", agent, "run-1");
  mkdirSync(cwd, { recursive: true }); mkdirSync(dir, { recursive: true });
  const env = testChildEnv({ ...pickWorkerEnv(process.env), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(root, "runtime") });
  // 凭据服务像生产 manager 一样独立进程，覆盖进程间的交接与隔离。
  const brokerFile = join(root, "broker.ts"), address = join(root, "address.txt");
  writeFileSync(brokerFile, `import { serveClaudeToken } from ${JSON.stringify(join(import.meta.dir, "../src/lib/lend-claude-worker-auth.ts"))};
    const auth = serveClaudeToken("test-only-oauth", ${JSON.stringify(join(root, "auth"))});
    await Bun.write(${JSON.stringify(address)}, auth.path); await Bun.sleep(15000); auth.close();`);
  const broker = Bun.spawn([process.execPath, ...BUN_NO_AUTOLOAD, brokerFile], { env, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 150 && !existsSync(address) && broker.exitCode === null; i++) await Bun.sleep(20);
  if (!existsSync(address)) { broker.kill(); await broker.exited; throw new Error("测试凭据服务未就绪"); }
  const plan = claudeWorkerPlan({ mode: "new", cwd, agentName: agent, sessionId: "550e8400-e29b-41d4-a716-446655440000",
    channelId: "test", bridgeUrl: "ws://127.0.0.1:9", callerCredFile: "/unused-test-cred" }, dir, readFileSync(address, "utf8"), env, process.execPath);
  for (const p of [plan.env.HOME, plan.env.CLAUDE_CONFIG_DIR]) mkdirSync(p);
  writeFileSync(join(cwd, ".env"), "LEND_ENV_POISON=should-never-load\n");
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./poison.ts"]\n');
  writeFileSync(join(cwd, "poison.ts"), 'throw new Error("untrusted preload executed")');
  const fake = join(root, "fake-claude.ts");
  writeFileSync(fake, `import { writeFileSync } from "node:fs";
    writeFileSync("observed.json", JSON.stringify({ pid: process.pid, tokenOk: process.env.CLAUDE_CODE_OAUTH_TOKEN === "test-only-oauth",
      home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR, poison: process.env.LEND_ENV_POISON ?? null }));
    setInterval(() => {}, 1000);`);
  plan.argv = [process.execPath, ...BUN_NO_AUTOLOAD, fake];
  const file = join(dir, "launch.json"); writeFileSync(file, JSON.stringify(plan));
  const db = openLendJournal(join(state, "lend", "journal.sqlite"));
  const now = Date.now();
  recordAsked(db, { orderId: "o1", peer: "a", fp: "abcd-ef01-2345-6789", family: "claude", preview: { repo: "o/r", step: "review" } }, now);
  advance(db, "o1", "asked", "claimed", { leaseUntil: now + 60_000, leaseGen: 1 }, now);
  advance(db, "o1", "claimed", "cloned", { dir: cwd }, now); patchOrder(db, "o1", ["cloned"], { agent }, now); db.close();
  const grant = { version: 2, enabled: true, borrow: [], lend: [{ peer: "a", fp: "abcd-ef01-2345-6789", families: { claude: 1 },
    roles: ["review"], repos: ["o/r"], ordersPerDay: 5, grantedAt: new Date(now).toISOString(), until: new Date(now + 3600_000).toISOString() }] };
  writeFileSync(join(state, "lend.json"), JSON.stringify(grant));
  const proc = Bun.spawn([process.execPath, ...BUN_NO_AUTOLOAD, join(import.meta.dir, "../src/lib/lend-claude-worker-host.ts"), file],
    { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text(), stderr = new Response(proc.stderr).text();
  try {
    for (let i = 0; i < 150 && !existsSync(join(cwd, "observed.json")) && proc.exitCode === null; i++) await Bun.sleep(20);
    if (!existsSync(join(cwd, "observed.json"))) {
      if (proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; }
      throw new Error(`host failed: ${await stderr}`);
    }
    const seen = JSON.parse(readFileSync(join(cwd, "observed.json"), "utf8"));
    expect(seen).toMatchObject({ tokenOk: true, home: plan.env.HOME, config: plan.env.CLAUDE_CONFIG_DIR, poison: null });
    expect(existsSync(file)).toBe(false);
    grant.enabled = false; writeFileSync(join(state, "lend.json"), JSON.stringify(grant));
    proc.kill("SIGTERM");
    await proc.exited;
    expect(pidAlive(seen.pid)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect((await stdout) + (await stderr)).not.toContain("test-only-oauth");
  } finally {
    if (proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; }
    if (broker.exitCode === null) { broker.kill(); await broker.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

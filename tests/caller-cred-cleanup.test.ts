/**
 * T85 启动凭据的收尾（docs/architecture/caller-identity.md）：
 * - 一次性明文文件在启动的任何结局下都删掉——构建命令 / 发命令同步抛（create 被信号接手时 gateOps 抛 CreateAborted）、
 *   waitReady 拒绝、进程 exit、收到 SIGINT / SIGTERM；kill -9 留下的由 sweepStaleOneShots 按时清扫（lib/caller-cred.ts withOneShot）。
 * - 不签凭据的启动（Codex tmux 版，含 ACP 切回 tmux）也撤销该 agent 上一代凭据（lib/caller-cred-launch.ts issueLaunchCred）。
 * 状态目录由 tests/preload.ts 隔离；这里写的凭据存储在 afterAll 还原。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALLER_CRED_FILE_ENV, CALLER_CREDS_PATH, hashCred, lookupCred, readCredStore, sweepStaleOneShots, takeCallerCred, withOneShot, writeOneShot } from "../src/lib/caller-cred.ts";
import { issueLaunchCred, launchWithCallerCred } from "../src/lib/caller-cred-launch.ts";
import { resolveCallerIdentity } from "../src/lib/caller-identity.ts";
import { testChildEnv } from "./test-env.ts";

const root = mkdtempSync(join(tmpdir(), "caller-cred-cleanup-"));
let saved: string | null = null;
beforeAll(() => void (saved = existsSync(CALLER_CREDS_PATH) ? readFileSync(CALLER_CREDS_PATH, "utf8") : null));
afterAll(() => {
  if (saved === null) existsSync(CALLER_CREDS_PATH) && unlinkSync(CALLER_CREDS_PATH);
  else writeFileSync(CALLER_CREDS_PATH, saved);
  rmSync(root, { recursive: true, force: true });
});

const ccAdapter = { callerCred: "mcp-config" as const, registryFields: () => ({}) };
const tmuxCodexAdapter = { callerCred: undefined, registryFields: () => ({ runtime: "codex" }) };
const spec = (sessionId: string) => ({ mode: "resume", sessionId }) as never;

/** 跑一次启动段，send 记下交给它的文件路径，返回 [路径, 结局] */
async function launch(send: (f?: string) => Promise<unknown>, waitReady: () => Promise<never | { ready: boolean }>) {
  let file: string | undefined;
  const outcome = await launchWithCallerCred("agent-c", ccAdapter, spec("s1"), (f) => ((file = f), send(f)), waitReady as never).then(
    (r) => r,
    (e: Error) => e.message,
  );
  return [file, outcome] as const;
}

describe("launchWithCallerCred：启动的任何结局都删一次性文件", () => {
  test("构建 / 发命令同步抛（CreateAborted）→ 异常照样抛出，文件已删", async () => {
    const [file, outcome] = await launch(() => { throw new Error("create 已被信号打断，清理接手"); }, async () => ({ ready: true }));
    expect(file).toMatch(/\.cred$/);
    expect(outcome).toBe("create 已被信号打断，清理接手");
    expect(existsSync(file!)).toBe(false);
  });

  test("发命令异步拒 → exited，文件已删", async () => {
    const [file, outcome] = await launch(() => Promise.reject(new Error("tmux 没了")), async () => ({ ready: true }));
    expect(outcome).toMatchObject({ ready: false, reason: "exited", detail: "启动命令没发出去：tmux 没了" });
    expect(existsSync(file!)).toBe(false);
  });

  test("waitReady 拒绝 / 没就绪 → 文件已删", async () => {
    const [f1, o1] = await launch(async () => {}, () => Promise.reject(new Error("capture 时被中止")));
    expect(o1).toBe("capture 时被中止");
    expect(existsSync(f1!)).toBe(false);
    const [f2, o2] = await launch(async () => {}, async () => ({ ready: false, reason: "timeout" }) as never);
    expect(o2).toMatchObject({ ready: false });
    expect(existsSync(f2!)).toBe(false);
  });

  test("就绪：MCP 服务已读走 → 立即返回，凭据有效", async () => {
    let token: string | undefined;
    const [file, outcome] = await launch(async () => {}, async () => ((token = takeCallerCred({ [CALLER_CRED_FILE_ENV]: fileSeen() })), { ready: true }));
    expect(outcome).toEqual({ ready: true });
    expect(existsSync(file!)).toBe(false);
    expect(lookupCred(readCredStore(), token)).toMatchObject({ agent: "agent-c", sessionId: "s1" });
  });
});

/** 「MCP 服务」读的是凭据目录里唯一在途的那个文件 */
function fileSeen(): string {
  const dir = join(CALLER_CREDS_PATH, "..", "run", "caller-cred");
  const names = readdirSync(dir);
  expect(names).toHaveLength(1);
  return join(dir, names[0]);
}

describe("withOneShot：进程在启动半路退出也删", () => {
  const CHILD = join(root, "child.ts");
  const LIB = join(import.meta.dir, "..", "src", "lib", "caller-cred.ts");
  beforeAll(() => writeFileSync(CHILD, [
    `import { withOneShot, writeOneShot } from ${JSON.stringify(LIB)};`,
    `const [dir, mode] = process.argv.slice(2);`,
    // other = 模拟 create 的信号清理：它自己决定何时 exit（exit 钩子要删掉文件，且不能被我们按原信号抢先杀掉）
    `if (mode === "other") process.on("SIGTERM", () => setTimeout(() => process.exit(143), 200));`,
    `const p = writeOneShot("d".repeat(64), dir);`,
    `await withOneShot(p, () => { console.log(p); if (mode === "exit") process.exit(3); return new Promise(() => {}); });`,
  ].join("\n")));

  async function runChild(mode: string, sig?: NodeJS.Signals) {
    const dir = join(root, mode);
    mkdirSync(dir);
    const proc = Bun.spawn([process.execPath, CHILD, dir, mode], { stdout: "pipe", stderr: "inherit", env: testChildEnv() });
    const reader = proc.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value).trim();
    expect(first).toStartWith(dir);
    if (sig) proc.kill(sig);
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    return { proc, dir };
  }

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    test(`${sig}、没有别的监听者 → 删文件，仍按原信号退出`, async () => {
      const { proc, dir } = await runChild(sig.toLowerCase(), sig);
      expect(proc.signalCode).toBe(sig);
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  test("有别的 SIGTERM 监听者（create 信号清理）→ 删文件，退出交给它", async () => {
    const { proc, dir } = await runChild("other", "SIGTERM");
    expect(proc.exitCode).toBe(143);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("启动半路 process.exit → 删文件", async () => {
    const { proc, dir } = await runChild("exit");
    expect(proc.exitCode).toBe(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("run 正常返回后解除钩子，不改变本进程的信号语义", async () => {
    const before = process.listenerCount("SIGTERM");
    await withOneShot(writeOneShot("e".repeat(64), join(root, "inproc")), async () => expect(process.listenerCount("SIGTERM")).toBe(before + 1));
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(readdirSync(join(root, "inproc"))).toEqual([]);
  });
});

describe("sweepStaleOneShots：kill -9 留下的残留按时清", () => {
  test("超过 10 分钟的删，新的留；目录不存在不报错", () => {
    const dir = join(root, "sweep");
    const old = writeOneShot("1".repeat(64), dir);
    const fresh = writeOneShot("2".repeat(64), dir);
    const t = new Date(Date.now() - 11 * 60_000);
    utimesSync(old, t, t);
    sweepStaleOneShots(dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(() => sweepStaleOneShots(join(root, "nope"))).not.toThrow();
  });
});

describe("不签凭据的启动也撤销上一代（ACP → tmux）", () => {
  async function issueAcp(agent: string): Promise<string> {
    const file = await issueLaunchCred({ agent, family: "codex", sessionId: "old" }, "env");
    return takeCallerCred({ [CALLER_CRED_FILE_ENV]: file })!;
  }
  const identity = (agent: string, token: string) =>
    resolveCallerIdentity({ channelId: "ch", credHash: hashCred(token) }, { creds: readCredStore(), agents: [{ name: agent, channelId: "ch", sessionId: "new", runtime: "codex" }] });

  test("issueLaunchCred(kind 缺省) → 旧凭据查不到，verified=false；别的 agent 不受影响", async () => {
    const other = await issueAcp("agent-other");
    const token = await issueAcp("agent-p");
    expect(identity("agent-p", token).verified).toBe(true);
    expect(await issueLaunchCred({ agent: "agent-p", family: "codex", sessionId: "new" }, undefined)).toBeUndefined();
    expect(lookupCred(readCredStore(), token)).toBeNull();
    expect(identity("agent-p", token)).toMatchObject({ agent: "agent-p", sessionId: "new", verified: false });
    expect(lookupCred(readCredStore(), other)).toMatchObject({ agent: "agent-other" });
  });

  test("manager 启动段换 tmux 适配器（transport 切换 / ACP 失败回退）→ 同样撤销", async () => {
    const token = await issueAcp("agent-q");
    let sent: string | undefined = "unset";
    const r = await launchWithCallerCred("agent-q", tmuxCodexAdapter, spec("new"), async (f) => void (sent = f), async () => ({ ready: true }));
    expect(r).toEqual({ ready: true });
    expect(sent).toBeUndefined();
    expect(identity("agent-q", token).verified).toBe(false);
  });
});

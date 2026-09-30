import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterEnv } from "../src/lib/acp/adapter-proc.ts";
import { CALLER_CRED_ENV, hashCred, issueCallerCred, lookupCred, newCredToken, oneShotArg, readCredStore, takeCallerCred, writeOneShot } from "../src/lib/caller-cred.ts";
import { acpCallerCredAssignment, callerCredMcpConfig } from "../src/lib/caller-cred-launch.ts";
import { buildClaudeCommand, shellEscape } from "../src/lib/claude-launch.ts";
import { testChildEnv } from "./test-env.ts";

const root = mkdtempSync(join(tmpdir(), "caller-cred-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(root, `${name}-${++n}`);

function sh(cmd: string, env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(["/bin/sh", "-c", cmd], { env: testChildEnv(env) });
  if (p.exitCode !== 0) throw new Error(`sh 失败 ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

describe("凭据与存储", () => {
  test("凭据是 64 位 hex，存储里只有 sha256，文件 0600", async () => {
    const path = fresh("store.json");
    const token = await issueCallerCred({ agent: "agent-a", family: "claude-code", sessionId: "s1" }, path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashCred(token));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lookupCred(readCredStore(path), token)).toMatchObject({ agent: "agent-a", family: "claude-code", sessionId: "s1" });
  });

  test("同一 agent 再签 = 旧凭据立即失效；别的 agent 不受影响", async () => {
    const path = fresh("store.json");
    const a1 = await issueCallerCred({ agent: "agent-a", family: "claude-code" }, path);
    const b1 = await issueCallerCred({ agent: "agent-b", family: "codex" }, path);
    const a2 = await issueCallerCred({ agent: "agent-a", family: "claude-code" }, path);
    const store = readCredStore(path);
    expect(lookupCred(store, a1)).toBeNull();
    expect(lookupCred(store, a2)?.agent).toBe("agent-a");
    expect(lookupCred(store, b1)?.agent).toBe("agent-b");
    expect(Object.keys(store)).toHaveLength(2);
  });

  test("没签过、格式不对、存储不在 → 查不到", () => {
    expect(lookupCred(readCredStore(fresh("missing.json")), newCredToken())).toBeNull();
    expect(lookupCred({}, "not-a-token")).toBeNull();
    expect(lookupCred({}, undefined)).toBeNull();
  });

  test("takeCallerCred 读完就从环境里删掉", () => {
    const env: Record<string, string | undefined> = { [CALLER_CRED_ENV]: "abc", OTHER: "1" };
    expect(takeCallerCred(env)).toBe("abc");
    expect(env).toEqual({ OTHER: "1" });
    expect(takeCallerCred(env)).toBeUndefined();
  });
});

describe("一次性文件", () => {
  test("目录 0700、文件 0600；过期没被读走的顺手清掉", () => {
    const dir = fresh("oneshot");
    const stale = writeOneShot("old", dir);
    const past = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(stale, past, past);
    const p = writeOneShot("new", dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(existsSync(stale)).toBe(false);
  });

  test("shell 展开读出内容并删文件；文件不在时退回 fallback", () => {
    const p = writeOneShot("s3cr3t 'quoted' $HOME", fresh("oneshot"));
    expect(sh(`printf '%s' ${oneShotArg(p, "FB", shellEscape)}`)).toBe("s3cr3t 'quoted' $HOME");
    expect(existsSync(p)).toBe(false);
    expect(sh(`printf '%s' ${oneShotArg(p, '{"mcpServers":{}}', shellEscape)}`)).toBe('{"mcpServers":{}}');
  });
});

describe("交付：Bash 子进程的环境里没有凭据", () => {
  /** 假的 claude：把自己的环境（= 它的 Bash 子进程会继承的环境）和参数各写一份 */
  function fakeBin(name: string): { dir: string; envOut: string; argsOut: string } {
    const dir = fresh("bin");
    Bun.spawnSync(["mkdir", "-p", dir]);
    const envOut = join(dir, "env.txt");
    const argsOut = join(dir, "args.txt");
    writeFileSync(join(dir, name), `#!/bin/sh\nenv > '${envOut}'\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argsOut}'\n`);
    chmodSync(join(dir, name), 0o755);
    return { dir, envOut, argsOut };
  }

  test("CC：凭据只在 --mcp-config 里 claudestra 那一项的 env；命令行文本只有路径；claude 进程环境里没有", () => {
    const token = newCredToken();
    const file = writeOneShot(callerCredMcpConfig("claudestra", token), fresh("oneshot"));
    const cmd = buildClaudeCommand({ channelId: "123", bridgeUrl: "ws://localhost:1", callerCredFile: file });
    expect(cmd).not.toContain(token);
    expect(cmd).toContain(file);
    const bin = fakeBin("claude");
    sh(cmd, { PATH: `${bin.dir}:${process.env.PATH}` });
    const env = readFileSync(bin.envOut, "utf8");
    expect(env).not.toContain(token);
    expect(env).not.toContain(CALLER_CRED_ENV);
    const args = readFileSync(bin.argsOut, "utf8").split("\n");
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(cfg.mcpServers.claudestra.env).toEqual({ [CALLER_CRED_ENV]: token });
    expect(existsSync(file)).toBe(false);
  });

  test("ACP：凭据只给宿主；宿主取走后，适配器（及 Codex 的 shell）环境里哪儿都没有", () => {
    const token = newCredToken();
    const file = writeOneShot(token, fresh("oneshot"));
    const bin = fakeBin("host");
    sh(`X=1${acpCallerCredAssignment(file, shellEscape)} '${join(bin.dir, "host")}'`);
    const hostEnv: Record<string, string | undefined> = Object.fromEntries(
      readFileSync(bin.envOut, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(hostEnv[CALLER_CRED_ENV]).toBe(token);
    expect(takeCallerCred(hostEnv)).toBe(token);
    const env = adapterEnv({
      base: hostEnv, bunBin: "/bin/bun", channelServer: "/repo/src/channel-server.ts", mcpName: "claudestra", logsDir: "/tmp/x",
      channel: { channelId: "c", proxyUrl: "ws://127.0.0.1:1/?t=x", agentName: "agent-a", sessionId: "s" },
    });
    expect(JSON.stringify(env)).not.toContain(token);
    expect(existsSync(file)).toBe(false);
  });

  test("没文件就不加任何东西", () => {
    expect(acpCallerCredAssignment(undefined, shellEscape)).toBe("");
    expect(buildClaudeCommand({ channelId: "1", bridgeUrl: "ws://localhost:1" })).not.toContain("--mcp-config");
  });
});

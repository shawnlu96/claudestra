/**
 * 订阅额度凭据适配器（lib/quota-credentials.ts）：账户键 HMAC、脱敏、身份复核、Keychain 子进程超时回收。
 * 全部假 Keychain / 假文件；子进程测试只跑 sleep / printf，不碰 security。
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";
import {
  claudePaths,
  classifyKeychain,
  codexAuthPath,
  confirmCredential,
  defaultCredDeps,
  deriveQuotaSecret,
  hmacHex,
  readClaudeCredential,
  readCodexCredential,
  runWithTimeout,
  spawnKeychainReader,
  type SpawnFn,
} from "../src/lib/quota-credentials.js";
import {
  CLAUDE_ACCOUNT,
  CLAUDE_TOKEN,
  CODEX_ACCOUNT,
  CODEX_TOKEN,
  SECRET,
  T0,
  claudeJson,
  codexAuth,
  expectNoSentinel,
  fakeCredDeps,
  keychainBlob,
} from "./quota-fixtures.js";

describe("Claude 凭据", () => {
  test("Keychain + ~/.claude.json → 句柄：identity assumed、账户键是 HMAC、请求头带 token", async () => {
    const deps = fakeCredDeps();
    const r = await readClaudeCredential(deps);
    if (!r.ok) throw new Error(r.code);
    expect(r.cred.identity).toBe("assumed");
    expect(r.cred.accountKey).toBe(hmacHex(SECRET, "claude", CLAUDE_ACCOUNT));
    expect(r.cred.accountKey).not.toContain(CLAUDE_ACCOUNT);
    expect(r.cred.authHeaders()).toEqual({ Authorization: `Bearer ${CLAUDE_TOKEN}`, "anthropic-beta": "oauth-2025-04-20" });
    expect(deps.keychainCalls).toEqual(["Claude Code-credentials"]);
  });

  test("句柄的任何文字形态都不含 token 与原始账户 id", async () => {
    const r = await readClaudeCredential(fakeCredDeps());
    if (!r.ok) throw new Error(r.code);
    for (const s of [JSON.stringify(r.cred), String(r.cred), inspect(r.cred), Bun.inspect(r.cred), JSON.stringify({ wrap: r.cred })]) {
      expectNoSentinel(s);
      expect(s).not.toContain("SENTINEL");
    }
  });

  test.each([
    ["denied", "keychain_denied"],
    ["missing", "keychain_missing"],
    ["timeout", "keychain_timeout"],
    ["error", "keychain_error"],
  ] as const)("Keychain %s → %s，且从不退到 ~/.claude/.credentials.json", async (status, code) => {
    const deps = fakeCredDeps({ keychain: { status } });
    deps.files.set("/home/u/.claude/.credentials.json", keychainBlob());
    const r = await readClaudeCredential(deps);
    expect(r).toEqual({ ok: false, code });
    expect(deps.reads.some((p) => p.includes(".credentials.json"))).toBe(false);
  });

  test("缺 accountUuid → account_missing，不去读 Keychain", async () => {
    const deps = fakeCredDeps({ files: { "/home/u/.claude.json": "{}" } });
    expect(await readClaudeCredential(deps)).toEqual({ ok: false, code: "account_missing" });
    expect(deps.keychainCalls).toEqual([]);
  });

  test("Keychain blob 形状不对 / token 已过期", async () => {
    expect(await readClaudeCredential(fakeCredDeps({ keychain: { status: "ok", stdout: "not json" } }))).toEqual({ ok: false, code: "auth_bad_shape" });
    const expired = fakeCredDeps({ keychain: { status: "ok", stdout: keychainBlob({ expiresAt: T0 - 1 }) } });
    expect(await readClaudeCredential(expired)).toEqual({ ok: false, code: "token_expired" });
  });

  test("读 Keychain 期间 accountUuid 变了（换号）→ identity_changed", async () => {
    const deps = fakeCredDeps();
    deps.keychain = () => {
      deps.files.set("/home/u/.claude.json", claudeJson("other-account"));
      return { status: "ok", stdout: keychainBlob() };
    };
    expect(await readClaudeCredential(deps)).toEqual({ ok: false, code: "identity_changed" });
  });

  test("没有本机密钥 → no_secret", async () => {
    const deps = fakeCredDeps();
    deps.secret = () => null;
    expect(await readClaudeCredential(deps)).toEqual({ ok: false, code: "no_secret" });
    expect(await readCodexCredential(deps)).toEqual({ ok: false, code: "no_secret" });
  });

  test("confirmCredential：同账户（token 续期）仍 true，换号 false", async () => {
    const deps = fakeCredDeps();
    const r = await readClaudeCredential(deps);
    if (!r.ok) throw new Error(r.code);
    deps.keychain = { status: "ok", stdout: keychainBlob({ accessToken: "renewed" }) };
    expect(await confirmCredential(r.cred, deps)).toBe(true);
    expect(deps.keychainCalls.length).toBe(1); // 复核不再读 Keychain
    deps.files.set("/home/u/.claude.json", claudeJson("other-account"));
    expect(await confirmCredential(r.cred, deps)).toBe(false);
  });
});

describe("Codex 凭据", () => {
  test("auth.json → 句柄：identity bound、ChatGPT-Account-Id 头", async () => {
    const r = await readCodexCredential(fakeCredDeps());
    if (!r.ok) throw new Error(r.code);
    expect(r.cred.identity).toBe("bound");
    expect(r.cred.accountKey).toBe(hmacHex(SECRET, "codex", CODEX_ACCOUNT));
    expect(r.cred.fingerprint).toBe(hmacHex(SECRET, "fp", CODEX_TOKEN));
    expect(r.cred.authHeaders()).toEqual({ Authorization: `Bearer ${CODEX_TOKEN}`, "ChatGPT-Account-Id": CODEX_ACCOUNT });
    expectNoSentinel(JSON.stringify(r.cred) + inspect(r.cred));
  });

  test.each([
    ["缺文件", null, "auth_missing"],
    ["坏 JSON", "{oops", "auth_bad_shape"],
    ["缺 access_token", JSON.stringify({ tokens: { account_id: "a" } }), "auth_bad_shape"],
    ["缺 account_id", JSON.stringify({ tokens: { access_token: "t" } }), "account_missing"],
  ] as const)("%s → 固定错误码", async (_n, content, code) => {
    const deps = fakeCredDeps({ files: content === null ? {} : { "/home/u/.codex/auth.json": content } });
    expect(await readCodexCredential(deps)).toEqual({ ok: false, code });
  });

  test("confirmCredential：token 续期（指纹变）或换号都作废", async () => {
    const deps = fakeCredDeps();
    const r = await readCodexCredential(deps);
    if (!r.ok) throw new Error(r.code);
    expect(await confirmCredential(r.cred, deps)).toBe(true);
    deps.files.set("/home/u/.codex/auth.json", codexAuth("renewed-token"));
    expect(await confirmCredential(r.cred, deps)).toBe(false);
    deps.files.set("/home/u/.codex/auth.json", codexAuth(CODEX_TOKEN, "other"));
    expect(await confirmCredential(r.cred, deps)).toBe(false);
  });
});

describe("路径与密钥", () => {
  test("CLAUDE_CONFIG_DIR：.claude.json 进配置目录，Keychain 服务名带 8 位后缀（未对真机验证）", () => {
    expect(claudePaths({}, "/home/u")).toEqual({ accountFile: "/home/u/.claude.json", keychainService: "Claude Code-credentials" });
    const p = claudePaths({ CLAUDE_CONFIG_DIR: "/cfg/work" }, "/home/u");
    expect(p.accountFile).toBe("/cfg/work/.claude.json");
    expect(p.keychainService).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  test("CODEX_HOME", () => {
    expect(codexAuthPath({}, "/home/u")).toBe("/home/u/.codex/auth.json");
    expect(codexAuthPath({ CODEX_HOME: "/x/codex" }, "/home/u")).toBe("/x/codex/auth.json");
  });

  test("HKDF 派生：同一私钥稳定、不同私钥不同、32 字节", () => {
    const k1 = generateKeyPairSync("ed25519").privateKey;
    const k2 = generateKeyPairSync("ed25519").privateKey;
    const a = deriveQuotaSecret({ publicKey: "", privateKey: k1 });
    expect(a?.length).toBe(32);
    expect(deriveQuotaSecret({ publicKey: "", privateKey: k1 })?.equals(a!)).toBe(true);
    expect(deriveQuotaSecret({ publicKey: "", privateKey: k2 })?.equals(a!)).toBe(false);
    expect(deriveQuotaSecret(null)).toBeNull();
  });

  test("生产依赖的形状（不调用 Keychain）", () => {
    const d = defaultCredDeps();
    expect(typeof d.readKeychain).toBe("function");
    expect(d.home.length).toBeGreaterThan(0);
  });
});

describe("Keychain 子进程", () => {
  test("超时：SIGKILL 并等到进程真正退出", async () => {
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    const spawn: SpawnFn = (argv) => {
      proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return proc as never;
    };
    const t = Date.now();
    const r = await runWithTimeout(["sleep", "30"], 150, spawn);
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("");
    expect(Date.now() - t).toBeLessThan(5000);
    expect(proc!.exitCode !== null || proc!.signalCode !== null).toBe(true);
    expect(proc!.killed).toBe(true);
  });

  test("正常收 stdout 与退出码", async () => {
    const r = await runWithTimeout(["printf", "hello"], 5000);
    expect(r).toEqual({ code: 0, stdout: "hello", stderr: "", timedOut: false });
  });

  test("argv 只有固定参数与服务名，不含秘密", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = (argv) => {
      seen.push(argv);
      return Bun.spawn(["printf", keychainBlob()], { stdout: "pipe", stderr: "pipe" }) as never;
    };
    const out = await spawnKeychainReader({ spawn })("Claude Code-credentials");
    expect(out.status).toBe("ok");
    expect(seen).toEqual([["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]]);
  });

  test("退出码 / stderr 分类", () => {
    const base = { code: 0, stdout: "", stderr: "", timedOut: false };
    expect(classifyKeychain({ ...base, timedOut: true, code: null })).toEqual({ status: "timeout" });
    expect(classifyKeychain({ ...base, stdout: "x" })).toEqual({ status: "ok", stdout: "x" });
    expect(classifyKeychain({ ...base, code: 44 })).toEqual({ status: "missing" });
    expect(classifyKeychain({ ...base, code: 36, stderr: "User interaction is not allowed." })).toEqual({ status: "denied" });
    expect(classifyKeychain({ ...base, code: 128, stderr: "User canceled the operation." })).toEqual({ status: "denied" });
    expect(classifyKeychain({ ...base, code: 1, stderr: "weird" })).toEqual({ status: "error" });
  });
});

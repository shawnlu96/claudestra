/** lib/claude-account.ts：setup 与 doctor 查 Claude Code 的版本与登录——拿不准就不拦人 */
import { describe, expect, test } from "bun:test";
import { claudeAccountChecks, claudeTooOld, parseAuthStatus, parseClaudeVersion, probeClaude } from "../src/lib/claude-account.js";

describe("版本", () => {
  test("从 claude --version 取 x.y.z；低于 2.1.80 才算太旧，认不出不算", () => {
    expect(parseClaudeVersion("2.1.281 (Claude Code)")).toBe("2.1.281");
    expect(parseClaudeVersion("garbage")).toBeNull();
    expect(claudeTooOld("2.1.79")).toBe(true);
    expect(claudeTooOld("2.1.80")).toBe(false);
    expect(claudeTooOld("2.2.0")).toBe(false);
    expect(claudeTooOld(null)).toBe(false);
  });
});

describe("登录", () => {
  test("auth status --json：loggedIn 布尔才认；不是 JSON / 缺字段 = 不知道", () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toEqual({ loggedIn: true, method: "claude.ai" });
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false, method: null });
    expect(parseAuthStatus("error: unknown command 'auth'")).toBeNull();
    expect(parseAuthStatus('{"x":1}')).toBeNull();
  });

  test("probeClaude：claude 不在 PATH 就不问登录；没登录时非零退出也照读输出", async () => {
    const calls: string[] = [];
    const missing = await probeClaude(async (cmd) => (calls.push(cmd.join(" ")), { ok: false, out: "" }));
    expect(missing).toEqual({ version: null, auth: null });
    expect(calls).toEqual(["claude --version"]);
    const out = await probeClaude(async (cmd) => (cmd[1] === "--version" ? { ok: true, out: "2.1.281 (Claude Code)" } : { ok: false, out: '{"loggedIn":false}' }));
    expect(out).toEqual({ version: "2.1.281", auth: { loggedIn: false, method: null } });
  });
});

describe("doctor 两行", () => {
  test("太旧 fail、没登录 fail、登录了 ok；版本认不出就不出行；登录状态不知道就不出登录行", () => {
    expect(claudeAccountChecks({ version: null, auth: null }, "g")).toEqual([]);
    expect(claudeAccountChecks({ version: "2.1.281", auth: null }, "g")).toEqual([]);
    const bad = claudeAccountChecks({ version: "2.1.10", auth: { loggedIn: false, method: null } }, "g");
    expect(bad.map((c) => `${c.name}:${c.status}`)).toEqual(["claude 版本:fail", "claude 登录:fail"]);
    expect(bad[1].fix).toContain("claude auth login");
    expect(claudeAccountChecks({ version: "2.1.281", auth: { loggedIn: true, method: "claude.ai" } }, "g")[0]).toMatchObject({ status: "ok", detail: "已登录（claude.ai）" });
  });
});

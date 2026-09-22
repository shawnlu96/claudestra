import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { WRITE_COMMANDS, isWriteInvocation, needsWriteLock } from "../src/manager/write-commands";

const MANAGER_SRC = readFileSync(join(import.meta.dir, "..", "src", "manager.ts"), "utf8");

describe("manager 写命令分类", () => {
  test("原有写命令保持为写（只增不减）", () => {
    const before = [
      "create", "resume", "adopt", "kill", "remove", "restart", "rename", "archive",
      "cron-add", "cron-remove", "cron-toggle", "cron-edit", "install-hooks",
      "peer-http-invite", "peer-http-join", "peer-http-accept", "peer-http-scope", "peer-http-remove",
      "peer-invite-new", "peer-join-auto", "peer-invite-revoke", "token-add", "token-revoke",
      "project-add", "project-edit", "project-remove", "project-assign", "project-migrate", "pi-env-set",
    ];
    for (const c of before) expect(isWriteInvocation(c, [])).toBe(true);
  });

  test("原先漏掉的写命令补上", () => {
    for (const c of ["set-session", "set-claude", "takeover", "announce-focus", "migrate", "peer-invite-redeem"]) {
      expect(isWriteInvocation(c, [])).toBe(true);
    }
  });

  test("读写混合族只认写子命令", () => {
    expect(isWriteInvocation("permissions", ["set", "foo"])).toBe(true);
    expect(isWriteInvocation("perms", ["reset", "foo"])).toBe(true);
    expect(isWriteInvocation("permissions", ["list"])).toBe(false);
    expect(isWriteInvocation("permissions", [])).toBe(false);
    expect(isWriteInvocation("perm", ["presets"])).toBe(false);
    expect(isWriteInvocation("effort", ["set", "foo", "high"])).toBe(true);
    expect(isWriteInvocation("effort", ["get", "foo"])).toBe(false);
    expect(isWriteInvocation("mode", ["set", "foo", "plan"])).toBe(true);
    expect(isWriteInvocation("model", ["all", "opus"])).toBe(true);
    expect(isWriteInvocation("model", ["list"])).toBe(false);
    expect(isWriteInvocation("auto-update", [])).toBe(false);
    expect(isWriteInvocation("auto-update", ["status"])).toBe(false);
    expect(isWriteInvocation("auto-update", ["claude", "off"])).toBe(true);
    expect(isWriteInvocation("auto-update", ["channel", "beta"])).toBe(true);
  });

  test("读命令放行（备机排障要能看）", () => {
    for (const c of ["list", "sessions", "cost", "metrics", "doctor", "version", "token-list", "cron-list",
      "cron-history", "project-list", "peer-http-list", "peer-invite-list", "pi-env", "tmux-capture"]) {
      expect(isWriteInvocation(c, [])).toBe(false);
    }
    expect(isWriteInvocation(undefined, [])).toBe(false);
  });

  test("set-claude 认主但不拿命令级锁（web 设置页同步 await，锁会空等 20s）", () => {
    expect(isWriteInvocation("set-claude", ["a"])).toBe(true);
    expect(needsWriteLock("set-claude", ["a"])).toBe(false);
    expect(needsWriteLock("set-session", ["a", "b"])).toBe(true);
    expect(needsWriteLock("list", [])).toBe(false);
  });

  // 表里的每个名字都得在 manager.ts 的 switch 里真有 case——防 "clear" 那种死条目
  test("每个写命令在 manager.ts 都有对应 case", () => {
    for (const c of WRITE_COMMANDS) {
      expect(MANAGER_SRC.includes(`case "${c}":`)).toBe(true);
    }
  });
});

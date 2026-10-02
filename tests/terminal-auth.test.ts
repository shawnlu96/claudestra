/** 远程终端授权（src/bridge/terminal-auth.ts）：属主按设备凭据判、每次 IO 重验 grant */
import { describe, expect, test } from "bun:test";
import { SHELL_AUTH_AGENT, shellAllowed, terminalAllowedFor, terminalIoDenied, terminalOwnerKey } from "../src/bridge/terminal-auth.js";
import type { Principal } from "../src/lib/principals.js";

const at = "2026-09-27T00:00:00Z";
const phone: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, credential: "dev_phone" };
/** 同一个 owner 的另一台设备，配对时 --no-terminal：effectivePrincipal 把它降成 external、terminal 关 */
const tablet: Principal = { id: "owner:self", role: "external", agents: ["*", "master"], createdAt: at, credential: "dev_tablet", terminal: false };
const cli: Principal = { id: "token:tok_cli", role: "owner", agents: ["*", "master"], createdAt: at };

describe("terminalOwnerKey", () => {
  test("设备凭据优先：同一个 owner 的两台设备属主不同；Bearer token 退回 token id", () => {
    expect(terminalOwnerKey(phone)).toBe("cred:dev_phone");
    expect(terminalOwnerKey(tablet)).toBe("cred:dev_tablet");
    expect(terminalOwnerKey(cli)).toBe("tok_cli");
  });
});

describe("terminalIoDenied", () => {
  const sess = { tokenId: terminalOwnerKey(phone), agent: "worker" };
  test("开会话的那台设备可以写", () => {
    expect(terminalIoDenied(phone, sess)).toBeNull();
  });
  test("同 principal 的另一台设备（哪怕它也有终端权限）拿到 termId 也写不了", () => {
    expect(terminalIoDenied(tablet, sess)).toBe("terminal session belongs to another token");
    expect(terminalIoDenied({ ...phone, credential: "dev_other" }, sess)).toBe("terminal session belongs to another token");
  });
  test("属主对但授权已被收窄（grant 改成 no-terminal / 不含该 agent）→ 拒", () => {
    expect(terminalIoDenied({ ...phone, role: "external", terminal: false }, sess)).toBe("terminal access no longer granted for this agent");
    expect(terminalIoDenied({ ...phone, agents: ["other"] }, sess)).toBe("terminal access no longer granted for this agent");
  });
  test("terminalAllowedFor：带不带 agent- 前缀都认", () => {
    expect(terminalAllowedFor({ ...cli, role: "external", terminal: true, agents: ["agent-worker"] }, "worker")).toBe(true);
    expect(terminalAllowedFor(tablet, "worker")).toBe(false);
  });
});

describe("shellAllowed（网页开宿主 shell）", () => {
  test("owner 设备 / owner token：放行", () => {
    expect(shellAllowed(phone)).toBe(true);
    expect(shellAllowed(cli)).toBe(true);
  });
  test("配对时关了终端的设备、只授部分 agent 终端的 guest、* + 终端但不含 master、peer token、停用的：一律拒", () => {
    expect(shellAllowed(tablet)).toBe(false);
    expect(shellAllowed({ ...cli, id: "guest:g1", role: "external", terminal: true, agents: ["worker"] })).toBe(false);
    expect(shellAllowed({ ...cli, role: "external", terminal: true, agents: ["*"] })).toBe(false);
    expect(shellAllowed({ ...cli, role: "external", terminal: true, agents: ["*", "master"], peer: "shawn" })).toBe(false);
    expect(shellAllowed({ ...cli, disabled: true })).toBe(false);
  });
  test("shell 的 viewer 按 master 记：之后收窄掉 master 或终端，IO 立刻被拒", () => {
    const sess = { tokenId: terminalOwnerKey(phone), agent: SHELL_AUTH_AGENT };
    expect(terminalIoDenied(phone, sess)).toBeNull();
    expect(terminalIoDenied({ ...phone, agents: ["*"] }, sess)).toBe("terminal access no longer granted for this agent");
    expect(terminalIoDenied({ ...phone, role: "external", terminal: false }, sess)).toBe("terminal access no longer granted for this agent");
  });
});

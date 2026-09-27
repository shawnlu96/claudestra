/** 远程终端授权（src/bridge/terminal-auth.ts）：属主按设备凭据判、每次 IO 重验 grant */
import { describe, expect, test } from "bun:test";
import { terminalAllowedFor, terminalIoDenied, terminalOwnerKey } from "../src/bridge/terminal-auth.js";
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

/**
 * ACP 侧的 Pi 扩展：会话开始/回合开始时写能力快照（补齐 ACP 不写快照的缺口）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ACP pi-env-snapshot 扩展", () => {
  test("注册 session_start + agent_start，并在回调里写盘（piVersion 走真实探测）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-snap-acp-"));
    process.env.CLAUDESTRA_AGENT = "agent-acp-x";
    process.env.CLAUDESTRA_STATE_DIR = dir;
    const mod = await import("../src/lib/acp/pi-adapter/pi-env-snapshot.ts");
    const handlers: Record<string, (e: unknown, ctx: unknown) => unknown> = {};
    const pi = {
      on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => void (handlers[ev] = h),
      getAllTools: () => [{ name: "read" }],
      getActiveTools: () => ["read", "codemode"],
      getCommands: () => [],
    };
    mod.default(pi as never);
    expect(Object.keys(handlers).sort()).toEqual(["agent_start", "session_start"]);
    handlers.session_start({}, { sessionManager: { getSessionId: () => "sid-acp" } });
    await new Promise((r) => setTimeout(r, 50)); // 写快照等 runningPiVersion() 落地
    const d = JSON.parse(readFileSync(join(dir, "pi-env", "agent-acp-x.json"), "utf8"));
    // 版本走 runningPiVersion()（问 Pi 的虚拟模块）：测试进程里没有那个模块，undefined 是预期。
    // 真机验证写在 PR 说明里（真 Pi 里探到 1.0.0），这里只钉住字段不炸。
    expect(d.piVersion === undefined || typeof d.piVersion === "string").toBe(true);
    expect(d.sessionId).toBe("sid-acp");
    expect(d.activeTools).toEqual(["codemode", "read"]);
    delete process.env.CLAUDESTRA_AGENT;
    delete process.env.CLAUDESTRA_STATE_DIR;
  });
});

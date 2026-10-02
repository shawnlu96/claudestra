/**
 * ACP 侧的 Pi 扩展：会话开始/回合开始时写能力快照（补齐 ACP 不写快照的缺口）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ACP pi-env-snapshot 扩展", () => {
  test("注册 session_start + agent_start，并在回调里写盘（piVersion 取本进程版本）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-snap-acp-"));
    process.env.CLAUDESTRA_AGENT = "agent-acp-x";
    process.env.CLAUDESTRA_STATE_DIR = dir;
    process.env.PI_VERSION = "1.0.0";
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
    const d = JSON.parse(readFileSync(join(dir, "pi-env", "agent-acp-x.json"), "utf8"));
    expect(d.piVersion).toBe("1.0.0");
    expect(d.sessionId).toBe("sid-acp");
    expect(d.activeTools).toEqual(["codemode", "read"]);
    delete process.env.CLAUDESTRA_AGENT;
    delete process.env.CLAUDESTRA_STATE_DIR;
    delete process.env.PI_VERSION;
  });
});

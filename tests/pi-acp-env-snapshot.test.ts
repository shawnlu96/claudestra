/**
 * ACP 侧的 Pi 扩展：会话开始/回合开始时写能力快照（补齐 ACP 不写快照的缺口）。
 * 版本来源注入：测试进程没有 Pi 的虚拟模块，真实探测在这里恒为 undefined，所以成功路径要靠注入来钉。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (e: unknown, ctx: unknown) => unknown;
const dir = mkdtempSync(join(tmpdir(), "pi-snap-acp-"));
// 还原成 preload 的临时目录而不是删掉：删了之后同一次 bun test 里后面起的子进程会回落到真实 home 下的默认目录
const savedStateDir = process.env.CLAUDESTRA_STATE_DIR;
let mod: typeof import("../src/lib/acp/pi-adapter/pi-env-snapshot.ts");

beforeAll(async () => {
  process.env.CLAUDESTRA_AGENT = "agent-acp-x";
  process.env.CLAUDESTRA_STATE_DIR = dir;
  mod = await import("../src/lib/acp/pi-adapter/pi-env-snapshot.ts");
});
afterAll(() => {
  delete process.env.CLAUDESTRA_AGENT;
  if (savedStateDir === undefined) delete process.env.CLAUDESTRA_STATE_DIR;
  else process.env.CLAUDESTRA_STATE_DIR = savedStateDir;
  delete process.env.PI_VERSION;
});

function mount(ext: (pi: never) => void): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const pi = {
    on: (ev: string, h: Handler) => void (handlers[ev] = h),
    getAllTools: () => [{ name: "read" }],
    getActiveTools: () => ["read", "codemode"],
    getCommands: () => [],
  };
  ext(pi as never);
  return handlers;
}
const snapshot = () => JSON.parse(readFileSync(join(dir, "pi-env", "agent-acp-x.json"), "utf8"));
const ctx = { sessionManager: { getSessionId: () => "sid-acp" } };

describe("ACP pi-env-snapshot 扩展", () => {
  test("注册 session_start + agent_start；探到的版本写进快照", async () => {
    const h = mount(mod.createPiEnvSnapshot(async () => "1.0.0"));
    expect(Object.keys(h).sort()).toEqual(["agent_start", "session_start"]);
    await h.session_start({}, ctx);
    const d = snapshot();
    expect(d.piVersion).toBe("1.0.0");
    expect(d.sessionId).toBe("sid-acp");
    expect(d.activeTools).toEqual(["codemode", "read"]);
  });

  test("版本只认探测结果，不读 PI_VERSION 环境变量（Pi 不设它）", async () => {
    process.env.PI_VERSION = "9.9.9";
    await mount(mod.createPiEnvSnapshot(async () => undefined)).agent_start({}, ctx);
    expect(snapshot().piVersion).toBeUndefined();
  });

  test("探测抛错（模块缺失）→ 照写快照，只是不带版本", async () => {
    await mount(mod.createPiEnvSnapshot(() => Promise.reject(new Error("no pi module")))).session_start({}, ctx);
    const d = snapshot();
    expect(d.piVersion).toBeUndefined();
    expect(d.sessionId).toBe("sid-acp");
  });

  test("默认导出走真实探测：测试进程没有虚拟模块 → 不抛、版本为空（PI_VERSION 设了也不认）", async () => {
    process.env.PI_VERSION = "9.9.9";
    await mount(mod.default).session_start({}, ctx);
    expect(snapshot().piVersion).toBeUndefined();
  });
});

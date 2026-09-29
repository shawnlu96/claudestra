/**
 * POST /agents/:name/(pi|codex)-update 的门槛与整机锁（src/bridge/runtime-update.ts）。
 * 不真跑 `npm install -g`：shell / registry / 忙闲 / precheck 全注入。
 */
import { describe, expect, test } from "bun:test";
import { handleRuntimeUpdate, type RuntimeUpdateDeps } from "../src/bridge/runtime-update";
import type { Principal } from "../src/lib/principals";

const at = "2026-01-01T00:00:00Z";
const OWNER = { id: "discord:1", role: "owner", agents: ["*"], createdAt: at } as Principal;
const GUEST = { id: "token:tok_g", role: "external", name: "g", agents: ["*"], secret: "s", createdAt: at, manage: false } as Principal; // guest 设备：canManage 看 manage
const AGENTS = [{ name: "agent-c", runtime: "codex" }, { name: "agent-p", runtime: "pi" }, { name: "agent-k" }];

function deps(over: Partial<RuntimeUpdateDeps> & { npm?: boolean } = {}) {
  const cmds: string[] = [];
  const forgot: string[] = [];
  const d: RuntimeUpdateDeps = {
    agents: async () => AGENTS,
    busy: () => false,
    shell: async (cmd) => (cmds.push(cmd), { ok: true, tail: "done" }),
    updaters: {
      pi: { label: "Pi", command: () => "pi update", forget: () => forgot.push("pi") },
      codex: {
        label: "Codex",
        command: () => "npm install -g @openai/codex@latest",
        forget: () => forgot.push("codex"),
        precheck: async () => (over.npm === false ? "Codex 不是 npm 全局安装" : null),
      },
    },
    ...over,
  };
  return { d, cmds, forgot };
}
const restartOk = async () => ({ ok: true });
const post = (name: string, kind: "pi" | "codex", p: Principal, d: RuntimeUpdateDeps, rm = restartOk) =>
  handleRuntimeUpdate(`/agents/${name}/${kind}-update`, p, rm, d);

describe("codex-update", () => {
  test("成功：跑 npm install -g，忘掉已装版本缓存，只重启这一个", async () => {
    const { d, cmds, forgot } = deps();
    const restarted: string[][] = [];
    const r = await post("c", "codex", OWNER, d, async (...a: string[]) => (restarted.push(a), { ok: true }));
    expect(r.status).toBe(200);
    expect(cmds).toEqual(["npm install -g @openai/codex@latest"]);
    expect(forgot).toEqual(["codex"]);
    expect(restarted).toEqual([["restart", "agent-c"]]);
  });
  test("非全权凭据 403", async () => {
    expect((await post("c", "codex", GUEST, deps().d)).status).toBe(403);
  });
  test("不是 Codex agent 400；不存在 404", async () => {
    expect((await post("p", "codex", OWNER, deps().d)).status).toBe(400);
    expect((await post("k", "codex", OWNER, deps().d)).status).toBe(400);
    expect((await post("zz", "codex", OWNER, deps().d)).status).toBe(404);
  });
  test("回合中 409，什么都不跑", async () => {
    const { d, cmds } = deps({ busy: () => true });
    expect((await post("c", "codex", OWNER, d)).status).toBe(409);
    expect(cmds).toEqual([]);
  });
  test("不是 npm 全局安装 400，不跑 npm", async () => {
    const { d, cmds } = deps({ npm: false });
    const r = await post("c", "codex", OWNER, d);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain("npm");
    expect(cmds).toEqual([]);
  });
  test("npm 失败 500，不重启", async () => {
    let restarts = 0;
    const { d } = deps({ shell: async () => ({ ok: false, tail: "EACCES" }) });
    const r = await post("c", "codex", OWNER, d, async () => (restarts++, { ok: true }));
    expect(r.status).toBe(500);
    expect(((await r.json()) as any).error).toContain("EACCES");
    expect(restarts).toBe(0);
  });
});

describe("整机锁：pi-update 与 codex-update 共用", () => {
  test("一个在跑，另一个（同运行时或另一运行时）都 409；跑完释放", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = deps({ shell: async () => (await gate, { ok: true, tail: "" }) }).d;
    const first = post("p", "pi", OWNER, slow);
    await Bun.sleep(0);
    const r1 = await post("c", "codex", OWNER, deps().d);
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as any).error).toContain("agent-p");
    expect((await post("p", "pi", OWNER, deps().d)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await post("c", "codex", OWNER, deps().d)).status).toBe(200);
  });
  test("precheck 期间也占着锁", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d } = deps();
    const slowCheck = { ...d, updaters: { ...d.updaters, codex: { ...d.updaters.codex, precheck: async () => (await gate, null) } } };
    const first = post("c", "codex", OWNER, slowCheck);
    await Bun.sleep(0);
    expect((await post("p", "pi", OWNER, deps().d)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});

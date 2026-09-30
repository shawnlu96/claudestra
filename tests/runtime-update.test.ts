/**
 * POST /agents/:name/(pi|codex)-update 的门槛与整机锁（src/bridge/runtime-update.ts）。
 * 不真跑 `npm install -g`：shell / registry / 忙闲 / precheck 全注入。
 */
import { describe, expect, test } from "bun:test";
import { handleRuntimeUpdate, prepareCodexUpdate, type RuntimeUpdateDeps } from "../src/bridge/runtime-update";
import type { Principal } from "../src/lib/principals";
import type { AcpRelease } from "../src/lib/acp/resolve";

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
      pi: { label: "Pi", prepare: async () => ({ command: "pi update" }), forget: () => forgot.push("pi") },
      codex: {
        label: "Codex",
        prepare: () => prepareCodexUpdate({ ...ADAPTER_200, install: async () => ({ version: "0.158.0", npm: over.npm !== false }), latest: async () => "0.158.4" }),
        forget: () => forgot.push("codex"),
      },
    },
    ...over,
  };
  return { d, cmds, forgot };
}
const restartOk = async () => ({ ok: true });
/** 当前适配器 2.0.0（配 ^0.158.0）；registry 上只有它时 0.159.x 解析不到 */
const ADAPTER_200 = { adapter: () => ({ version: "2.0.0", codexRange: "^0.158.0" }), releases: async (): Promise<AcpRelease[]> => [] };
const post = (name: string, kind: "pi" | "codex", p: Principal, d: RuntimeUpdateDeps, rm = restartOk) =>
  handleRuntimeUpdate(`/agents/${name}/${kind}-update`, p, rm, d);

describe("codex-update", () => {
  test("成功：跑 npm install -g，忘掉已装版本缓存，只重启这一个", async () => {
    const { d, cmds, forgot } = deps();
    const restarted: string[][] = [];
    const r = await post("c", "codex", OWNER, d, async (...a: string[]) => (restarted.push(a), { ok: true }));
    expect(r.status).toBe(200);
    expect(cmds).toEqual(["npm install -g @openai/codex@0.158.4"]);
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

describe("codex-update 的版本闸门（codex-acp 配套范围）", () => {
  const install = async () => ({ version: "0.158.0", npm: true });
  const base = { ...ADAPTER_200, install };
  test("latest 在配套范围内：钉死版本号装，不写 @latest", async () => {
    expect(await prepareCodexUpdate({ ...base, latest: async () => "0.158.2" })).toEqual({ command: "npm install -g @openai/codex@0.158.2" });
  });
  test("latest 超出配套范围：409，说明配套范围，不给命令", async () => {
    const p = await prepareCodexUpdate({ ...base, latest: async () => "0.159.2" });
    expect(p).toMatchObject({ status: 409 });
    expect("error" in p && p.error).toBe("npm 上的 Codex 0.159.2 不在 codex-acp 2.0.0 的配套范围（^0.158.0），等适配器升级后再更新");
  });
  test("端点：超出配套范围 409，不跑 npm、不重启", async () => {
    let restarts = 0;
    const { d, cmds } = deps();
    const gated = { ...d, updaters: { ...d.updaters, codex: { ...d.updaters.codex, prepare: () => prepareCodexUpdate({ ...base, latest: async () => "0.159.2" }) } } };
    const r = await post("c", "codex", OWNER, gated, async () => (restarts++, { ok: true }));
    expect(r.status).toBe(409);
    expect(cmds).toEqual([]);
    expect(restarts).toBe(0);
  });
  test("查不到 latest：502；版本号不是正式 x.y.z（预发布、夹带命令）：409，绝不拼进 shell", async () => {
    expect(await prepareCodexUpdate({ ...base, latest: async () => undefined })).toMatchObject({ status: 502 });
    expect(await prepareCodexUpdate({ ...base, latest: async () => { throw new Error("offline"); } })).toMatchObject({ status: 502 });
    for (const bad of ["0.158.0; rm x", "0.158.3-alpha.1", "0.158.3\n"]) {
      const r = await prepareCodexUpdate({ ...base, latest: async () => bad });
      expect(r).toMatchObject({ status: 409 });
      expect("command" in r).toBe(false);
    }
  });
  test("找不到 codex 400", async () => {
    expect(await prepareCodexUpdate({ ...ADAPTER_200, install: async () => null, latest: async () => "0.158.2" })).toMatchObject({ status: 400 });
  });
});

describe("codex-update 跟随适配器：先装适配器（不切指针）→ npm 装 Codex → 切指针 → 重启", () => {
  const REL_201: AcpRelease = { version: "2.0.1", codexRange: "^0.159.1", integrity: "sha512-x", tarball: "https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-2.0.1.tgz" };
  function flow(o: { adapterOk?: boolean; shellOk?: boolean; releases?: AcpRelease[] } = {}) {
    const log: string[] = [];
    const prepare = () => prepareCodexUpdate({
      ...ADAPTER_200,
      install: async () => ({ version: "0.158.0", npm: true }),
      latest: async () => "0.159.2",
      releases: async () => o.releases ?? [REL_201],
      installAdapter: async (rel) => (log.push(`adapter:${rel.version}`), o.adapterOk === false
        ? { ok: false, error: "integrity 对不上" }
        : { ok: true, path: "/x", reused: false, version: rel.version, codexRange: rel.codexRange }),
      useAdapter: (v) => log.push(`pointer:${v}`),
    });
    const { d } = deps({ shell: async (cmd) => (log.push(`shell:${cmd}`), { ok: o.shellOk !== false, tail: "t" }) });
    const gated = { ...d, updaters: { ...d.updaters, codex: { ...d.updaters.codex, prepare } } };
    const run = () => post("c", "codex", OWNER, gated, async (...a: string[]) => (log.push(a.join(" ")), { ok: true }));
    return { log, run };
  }
  test("顺序：适配器 → Codex → 指针 → 重启", async () => {
    const { log, run } = flow();
    expect((await run()).status).toBe(200);
    expect(log).toEqual(["adapter:2.0.1", "shell:npm install -g @openai/codex@0.159.2", "pointer:2.0.1", "restart agent-c"]);
  });
  test("适配器装失败：Codex 不动、指针不动、不重启", async () => {
    const { log, run } = flow({ adapterOk: false });
    const r = await run();
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error).toContain("Codex 没动");
    expect(log).toEqual(["adapter:2.0.1"]);
  });
  test("Codex 装失败：指针根本没切（不用回滚）、不重启", async () => {
    const { log, run } = flow({ shellOk: false });
    expect((await run()).status).toBe(500);
    expect(log).toEqual(["adapter:2.0.1", "shell:npm install -g @openai/codex@0.159.2"]);
  });
  test("解析不到能配的适配器：409，什么都不装", async () => {
    const { log, run } = flow({ releases: [] });
    expect((await run()).status).toBe(409);
    expect(log).toEqual([]);
  });
  test("latest 本来就配当前适配器：只升 Codex，不碰适配器", async () => {
    const p = await prepareCodexUpdate({ ...ADAPTER_200, install: async () => ({ version: "0.158.0", npm: true }), latest: async () => "0.158.9",
      installAdapter: async () => { throw new Error("不该装适配器"); } });
    expect(p).toEqual({ command: "npm install -g @openai/codex@0.158.9" });
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
    const slowCheck = { ...d, updaters: { ...d.updaters, codex: { ...d.updaters.codex, prepare: async () => (await gate, { command: "npm i" }) } } };
    const first = post("c", "codex", OWNER, slowCheck);
    await Bun.sleep(0);
    expect((await post("p", "pi", OWNER, deps().d)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});

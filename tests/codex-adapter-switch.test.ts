import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpAgentCommand } from "../src/lib/acp/adapter-proc.ts";
import { CODEX_ACP_ADAPTER_MAIN } from "../src/lib/acp/codex-adapter/main.ts";
import { pickCodexAdapter, selectedCodexAdapter, selfAdapterVerdict, type CodexCompat } from "../src/lib/acp/codex-compat.ts";
import {
  AdapterPick, adapterFor, readAdapterChoice, ROLLBACK, updateAdapterChoice, withAgent, type AdapterChoice, type CodexAdapterId,
} from "../src/lib/acp/codex-compat-switch.ts";
import { checkAcpReady } from "../src/lib/acp/readiness.ts";
import { selfAdapterChecks } from "../src/lib/doctor-acp.ts";
import { applySwitch, cmdCodexAdapter, retireHost, type Retire, type SwitchDeps } from "../src/manager/acp-adapter.ts";
import { needsWriteLock, isWriteInvocation } from "../src/manager/write-commands.ts";
import { recordCodexRunning } from "../src/lib/codex-version.ts";
import type { RegistryAgent } from "../src/lib/registry.ts";

const dirs: string[] = [];
const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "cxf-s-"))), dirs.at(-1)!);
afterEach(() => void dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const identity = { id: "combo-1234567890ab", adapter: "aaaaaaaaaaaa", codex: "0.159.3", schema: "bbbbbbbbbbbb" };
const COMPATIBLE: CodexCompat = { verdict: "compatible", reasons: [], codexVersion: "0.159.3", identity };
const INCOMPATIBLE: CodexCompat = { verdict: "incompatible", reasons: ["[红] methods：少了 initialized"], codexVersion: "0.170.0", identity: { ...identity, codex: "0.170.0" } };
const UNKNOWN: CodexCompat = { verdict: "unknown", reasons: ["生成或读取 schema 失败：boom"] };

describe("选择开关的存储", () => {
  test("没文件 = 全体上游；全局一处，agent 覆盖两种拼写都认", async () => {
    const f = join(tmp(), "codex-adapter.json");
    expect(readAdapterChoice(f)).toEqual({ default: "upstream", agents: {} });
    expect(selectedCodexAdapter("agent-x", f)).toBe("upstream");
    await updateAdapterChoice((c) => withAgent({ ...c, default: "self" }, "x", "upstream"), f);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ default: "self", agents: { "agent-x": "upstream" } });
    expect(selectedCodexAdapter("x", f)).toBe("upstream");
    expect(selectedCodexAdapter("agent-x", f)).toBe("upstream");
    expect(selectedCodexAdapter("agent-y", f)).toBe("self");
    expect(selectedCodexAdapter(undefined, f)).toBe("self");
  });

  test("旧拼写的覆盖被新写法替掉，清覆盖两种都清；rollback = 全局上游、没有覆盖", () => {
    const c: AdapterChoice = { default: "upstream", agents: { x: "self", "agent-y": "self" } };
    expect(withAgent(c, "agent-x", "upstream").agents).toEqual({ "agent-x": "upstream", "agent-y": "self" });
    expect(withAgent(c, "y", null).agents).toEqual({ x: "self" });
    expect(c.agents).toEqual({ x: "self", "agent-y": "self" }); // 不改入参
    expect(ROLLBACK).toEqual({ default: "upstream", agents: {} });
    expect(adapterFor(ROLLBACK, "agent-x")).toBe("upstream");
  });

  test("坏文件：读者按全体上游，写者拒写（不把坏文件覆盖掉）", async () => {
    const f = join(tmp(), "codex-adapter.json");
    for (const bad of ["{", JSON.stringify({ default: "maybe" }), JSON.stringify({ agents: { x: "both" } }), JSON.stringify({ agents: [] })]) {
      writeFileSync(f, bad);
      expect(readAdapterChoice(f)).toEqual({ default: "upstream", agents: {} });
      await expect(updateAdapterChoice(() => ROLLBACK, f)).rejects.toThrow("拒绝覆盖");
      expect(readFileSync(f, "utf8")).toBe(bad);
    }
  });
});

describe("起哪个适配器（acpAgentCommand）", () => {
  const empty = () => tmp(); // 没装上游的适配器状态目录
  test("选了自研：起仓库里的 main.ts；没装上游时退路为 null", () => {
    const r = acpAgentCommand({}, "/b/bun", empty(), false, "self");
    expect(r).toEqual({ cmd: ["/b/bun", CODEX_ACP_ADAPTER_MAIN], stub: false, adapter: "self", upstream: null });
  });
  test("选了上游、没装：照旧报没装；出借 worker 选了自研也只走上游", () => {
    expect(acpAgentCommand({}, "/b/bun", empty(), false, "upstream")).toMatchObject({ error: expect.stringContaining("没装") });
    expect(acpAgentCommand({}, "/b/bun", empty(), true, "self")).toMatchObject({ error: expect.stringContaining("没装") });
  });
  test("手工覆盖仍最优先：选了自研也起覆盖的 argv，不带 adapter（不归开关管）", () => {
    const r = acpAgentCommand({ CLAUDESTRA_ACP_AGENT: '["bun","x.ts"]' }, "/b/bun", empty(), false, "self");
    expect(r).toEqual({ cmd: ["bun", "x.ts"], stub: false });
  });
});

describe("宿主定用哪个（pickCodexAdapter / AdapterPick）", () => {
  const SELF = { cmd: ["bun", "self.ts"], adapter: "self" as const, upstream: ["bun", "up.js"] };
  test("自研 + 兼容：起自研，组合身份打进日志", () => {
    const logs: string[] = [];
    const p = pickCodexAdapter(SELF, "/x/codex", (m) => logs.push(m), () => COMPATIBLE)!;
    expect(p).toMatchObject({ adapter: "self", cmd: ["bun", "self.ts"] });
    expect(logs[0]).toContain("组合身份 combo-1234567890ab");
  });
  for (const [what, c] of [["不兼容", INCOMPATIBLE], ["判不出（unknown）", UNKNOWN]] as const) {
    test(`自研 + ${what}：起之前就换上游；再失败不再换`, () => {
      const logs: string[] = [];
      const p = pickCodexAdapter(SELF, "/x/codex", (m) => logs.push(m), () => c)!;
      expect(p).toMatchObject({ adapter: "upstream", cmd: ["bun", "up.js"] });
      expect(logs.some((l) => l.includes("改用上游"))).toBe(true);
      expect(p.fallback("又起不来")).toBeNull();
    });
  }
  test("没有 codex 路径也不硬起自研；上游 / 手工覆盖 / stub 不归它管", () => {
    expect(pickCodexAdapter(SELF, undefined, () => {}, () => COMPATIBLE)!.adapter).toBe("upstream");
    expect(pickCodexAdapter({ cmd: ["u"], adapter: "upstream" }, "/x", () => {})!.fallback("x")).toBeNull();
    expect(pickCodexAdapter({ cmd: ["bun", "stub.ts"] }, "/x", () => {})).toBeNull();
  });
  test("接不上线程：换一次上游；auth 不换；没装上游不换只告警", () => {
    const logs: string[] = [];
    const p = new AdapterPick("self", ["s"], ["u"], (m) => logs.push(m));
    expect(p.fallback("没登录", "auth")).toBeNull();
    expect(p.fallback("exit 3", "error")).toEqual(["u"]);
    expect(p).toMatchObject({ adapter: "upstream", cmd: ["u"] });
    expect(p.fallback("又挂了")).toBeNull();
    const bare = new AdapterPick("self", ["s"], null, (m) => logs.push(m));
    expect(bare.fallback("exit 3")).toBeNull();
    expect(bare.adapter).toBe("self");
    expect(logs.at(-1)).toContain("没装上游");
  });
  test("selfAdapterVerdict：兼容才 ok；unknown 和不兼容都给原因", () => {
    expect(selfAdapterVerdict("/x", () => COMPATIBLE, () => {})).toMatchObject({ ok: true });
    expect(selfAdapterVerdict("/x", () => UNKNOWN, () => {})).toMatchObject({ ok: false, why: expect.stringContaining("判不出") });
    expect(selfAdapterVerdict("/x", () => INCOMPATIBLE, () => {})).toMatchObject({ ok: false, why: expect.stringContaining("不兼容") });
  });
});

describe("readiness：选了自研时 unknown / 不兼容退回上游", () => {
  const cliOk = { resolveBin: async () => "/x/codex", run: async () => ({ ok: true, out: "Usage: codex app-server [OPTIONS]", err: "" }), env: {} };
  const upOk = { installed: () => ({ ok: true as const, path: "/u/index.js", version: "2.1.0", codexRange: "^0.159.0" }) };
  test("兼容：adapter=self，不碰上游", async () => {
    expect(await checkAcpReady(false, { ...cliOk, selected: () => "self", compat: () => COMPATIBLE })).toMatchObject({ ok: true, adapter: "self", compat: COMPATIBLE });
  });
  for (const [what, c] of [["不兼容", INCOMPATIBLE], ["unknown", UNKNOWN]] as const) {
    test(`${what} + 上游在：就绪，adapter=upstream，带 selfRefused`, async () => {
      const r = await checkAcpReady(false, { ...cliOk, ...upOk, selected: () => "self", compat: () => c });
      expect(r).toMatchObject({ ok: true, adapter: "upstream", compat: c });
      expect(r.ok && r.selfRefused).toBeTruthy();
    });
  }
  test("不兼容 + 上游也没装：未就绪，两边原因都在", async () => {
    const r = await checkAcpReady(false, { ...cliOk, installed: () => ({ ok: false, hint: "codex-acp 没装" }), selected: () => "self", compat: () => INCOMPATIBLE });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("不兼容");
    expect(!r.ok && r.reason).toContain("codex-acp 没装");
  });
  test("没选自研：不判协议、不带 adapter（默认行为不变）", async () => {
    let probed = 0;
    const r = await checkAcpReady(false, { ...cliOk, ...upOk, selected: () => "upstream", compat: () => (probed++, COMPATIBLE) });
    expect(r).toEqual({ ok: true, codexBin: "/x/codex" });
    expect(probed).toBe(0);
  });
});

describe("doctor：自研组合身份 / 回退", () => {
  const ag = (name: string, transport = "acp") => ({ name, runtime: "codex", transport }) as RegistryAgent;
  const choice = (o: Partial<AdapterChoice>): AdapterChoice => ({ default: "upstream", agents: {}, ...o });
  test("没人选自研：不报", () => {
    expect(selfAdapterChecks([ag("agent-a")], { ok: true }, choice({}), () => undefined)).toEqual([]);
  });
  test("选了且兼容：ok，带组合身份；实际在跑上游的报回退", () => {
    const ready = { ok: true as const, adapter: "self" as const, compat: COMPATIBLE };
    const c = selfAdapterChecks([ag("agent-a"), ag("agent-b")], ready, choice({ agents: { "agent-a": "self", "agent-b": "self" } }), (a) => (a === "agent-b" ? "upstream" : "self"));
    expect(c[0]).toMatchObject({ name: "自研适配器组合", status: "ok", detail: expect.stringContaining("combo-1234567890ab") });
    expect(c[1]).toMatchObject({ name: "自研适配器回退", status: "warn", detail: expect.stringContaining("agent-b") });
    expect(c).toHaveLength(2);
  });
  test("全局选了但判不过：warn，写出原因和切回命令", () => {
    const ready = { ok: true as const, adapter: "upstream" as const, compat: INCOMPATIBLE, selfRefused: "本机 codex 0.170.0 …不兼容" };
    const [c] = selfAdapterChecks([], ready, choice({ default: "self" }), () => undefined);
    expect(c).toMatchObject({ status: "warn", detail: expect.stringContaining("全局选了自研") });
    expect(c!.fix).toContain("codex-adapter rollback");
  });
});

type Row = { name: string; runtime?: string; transport?: string; status?: string };
function fakeDeps(o: { agents?: Row[]; running?: Record<string, CodexAdapterId>; retire?: Record<string, Retire>; restartFails?: string[] } = {}) {
  let choice: AdapterChoice = { default: "upstream", agents: {} };
  const restarts: string[] = [];
  const asked: string[] = [];
  const deps: SwitchDeps = {
    agents: async () => o.agents ?? [],
    running: (a) => o.running?.[a],
    retire: async (n) => (asked.push(n), o.retire?.[n] ?? "exited"),
    restart: async (n) => (restarts.push(n), o.restartFails?.includes(n) ? { ok: false, error: "boom" } : { ok: true }),
    update: async (change) => (choice = change(choice)),
    read: () => choice,
  };
  return { deps, restarts, asked, choice: () => choice };
}

describe("manager codex-adapter：切换 / 切回只在空闲时重启", () => {
  const acp = (name: string) => ({ name, runtime: "codex", transport: "acp" });
  test("切一个 agent 到自研：只问、只重启它；tmux 的和别的运行时不动", async () => {
    const t = fakeDeps({ agents: [acp("agent-a"), acp("agent-b"), { name: "agent-c", runtime: "codex", transport: "tmux" }, { name: "agent-p", runtime: "pi", transport: "acp" }] });
    const r = await cmdCodexAdapter(["use", "self", "--agent", "a"], t.deps);
    expect(r).toMatchObject({ ok: true, default: "upstream", overrides: { "agent-a": "self" }, restarted: ["agent-a"], deferred: [] });
    expect(t.asked).toEqual(["agent-a"]);
  });
  test("切换时宿主正好在回合中：开关照改，宿主不退就不重启、列进 deferred；老宿主（不认信号）也不重启；宿主不在了照常重启", async () => {
    const retire: Record<string, Retire> = { "agent-a": "busy", "agent-b": "unknown", "agent-d": "absent" };
    const t = fakeDeps({ agents: [acp("agent-a"), acp("agent-b"), acp("agent-c"), acp("agent-d")], retire });
    const r = await cmdCodexAdapter(["use", "self"], t.deps);
    expect(r).toMatchObject({ ok: true, default: "self", restarted: ["agent-c", "agent-d"] });
    expect(r.deferred).toEqual([{ agent: "agent-a", why: "回合在跑" }, { agent: "agent-b", why: expect.stringContaining("不认切换信号") }]);
    expect(t.restarts).toEqual(["agent-c", "agent-d"]);
    expect(t.choice().default).toBe("self");
  });
  test("停着的 agent 不碰（不发信号、不重启，下次起来时按新开关）", async () => {
    const t = fakeDeps({ agents: [{ ...acp("agent-a"), status: "stopped" }, acp("agent-b")] });
    expect(await cmdCodexAdapter(["use", "self"], t.deps)).toMatchObject({ restarted: ["agent-b"], deferred: [] });
    expect(t.asked).toEqual(["agent-b"]);
  });
  test("rollback 一条命令：全局上游、清掉覆盖；只重启实际在跑自研的（已退回上游的不重启）", async () => {
    const t = fakeDeps({ agents: [acp("agent-a"), acp("agent-b"), acp("agent-c")], running: { "agent-a": "self", "agent-b": "upstream" } });
    await t.deps.update(() => ({ default: "self", agents: { "agent-c": "upstream" } }));
    const r = await cmdCodexAdapter(["rollback"], t.deps);
    expect(r).toMatchObject({ ok: true, default: "upstream", overrides: {}, restarted: ["agent-a"] });
  });
  test("--no-restart：只改开关，要重启的列进 deferred；重启失败报 failed、ok=false", async () => {
    const t = fakeDeps({ agents: [acp("agent-a"), acp("agent-b")], restartFails: ["agent-b"] });
    expect(await cmdCodexAdapter(["use", "self", "--no-restart"], t.deps)).toMatchObject({ ok: true, restarted: [], deferred: ["agent-a", "agent-b"] });
    expect(t.restarts).toEqual([]);
    const r = await applySwitch((c) => ({ ...c, default: "upstream" }), true, t.deps);
    expect(r).toMatchObject({ ok: false, restarted: ["agent-a"], failed: [{ agent: "agent-b", error: "boom" }] });
  });
  test("参数不对拒；status 读开关和运行记录；只有写子命令过认主、都不拿命令级锁", async () => {
    const t = fakeDeps({ agents: [acp("agent-a")], running: { "agent-a": "upstream" } });
    expect(await cmdCodexAdapter(["use", "both"], t.deps)).toMatchObject({ ok: false });
    expect(await cmdCodexAdapter(["use", "self", "--agent", "nobody"], t.deps)).toMatchObject({ ok: false, error: expect.stringContaining("不存在") });
    expect(await cmdCodexAdapter(["clear"], t.deps)).toMatchObject({ ok: false });
    const agents = [{ name: "agent-a", transport: "acp", selected: "upstream", running: "upstream" }];
    expect(await cmdCodexAdapter(["status"], t.deps)).toEqual({ ok: true, default: "upstream", overrides: {}, agents });
    for (const sub of ["use", "clear", "rollback"]) expect(isWriteInvocation("codex-adapter", [sub])).toBe(true);
    expect(isWriteInvocation("codex-adapter", ["status"])).toBe(false);
    expect(needsWriteLock("codex-adapter", ["use"])).toBe(false);
  });
});

describe("retireHost：只给认得出的新宿主发 SIGUSR2，宿主自己决定退不退", () => {
  const fakeHost = (dir: string, mode: "idle" | "busy") => {
    // 假宿主：文件名就叫 acp-host.ts（manager 按命令行认宿主）；idle 收到信号就退，busy 收到信号不退（同 host.ts retireIfIdle）
    const f = join(dir, "acp-host.ts");
    writeFileSync(f, `process.on("SIGUSR2", () => { if (process.argv[2] === "idle") process.exit(0); }); setInterval(() => {}, 1000); console.log("up");`);
    return Bun.spawn([process.execPath, f, mode], { stdout: "pipe" });
  };
  const ready = async (p: ReturnType<typeof fakeHost>) => void (await p.stdout.getReader().read());
  test("没运行记录（老宿主）= unknown，不发信号；记录里的 pid 不在了 = absent", async () => {
    expect(await retireHost("agent-nobody")).toBe("unknown");
    recordCodexRunning("agent-gone", "0.159.3", undefined, { adapter: "upstream", hostPid: 2 ** 22 + 12345 });
    expect(await retireHost("agent-gone")).toBe("absent");
  });
  test("pid 被别的进程复用（命令行不是 acp-host.ts）= absent，不发信号", async () => {
    const other = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    recordCodexRunning("agent-reused", "0.159.3", undefined, { hostPid: other.pid });
    expect(await retireHost("agent-reused", 300)).toBe("absent");
    expect(other.exitCode).toBeNull();
    other.kill();
  });
  test("空闲的宿主收到信号退出 = exited；在跑回合的不退 = busy（不掐）", async () => {
    const d = tmp();
    const idle = fakeHost(d, "idle");
    await ready(idle);
    recordCodexRunning("agent-idle", "0.159.3", undefined, { hostPid: idle.pid });
    expect(await retireHost("agent-idle")).toBe("exited");
    const busy = fakeHost(d, "busy");
    await ready(busy);
    recordCodexRunning("agent-busy", "0.159.3", undefined, { hostPid: busy.pid });
    expect(await retireHost("agent-busy", 500)).toBe("busy");
    expect(busy.exitCode).toBeNull();
    busy.kill();
  });
});

/**
 * hardening-CODEXUP1：Codex 自动更新绑定实际在用的那份 npm 安装，命令成功后重探实际生效版本才重启。
 * 一轮全走真的 codexAutoUpdateTick + prepareCodexUpdate；探测、npm、shell、重启、通知全 fake，不跑真 npm。
 */
import { describe, expect, test } from "bun:test";
import { codexAutoUpdateTick, type CodexAutoDeps } from "../src/lib/codex-auto-update";
import { prepareCodexUpdate, type CodexGateDeps } from "../src/lib/codex-auto-update-gate";

const NOW = 1_000_000_000;
const A = "/fake/prefix-a";
const B = "/fake/prefix-b";
const ACP = (name: string) => ({ name, runtime: "codex", transport: "acp", status: "active" });
type Inst = { version?: string; npm: boolean; path?: string; prefix?: string };
const npmInst = (version: string, prefix = A): Inst => ({ version, npm: true, path: `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`, prefix });

/** installs：每次探测依次返回（用完停在最后一个）；第一个给 tick，第二个给闸，之后是安装后重探 */
function rig(installs: (Inst | null | Error)[], gate: Partial<CodexGateDeps> = {}, over: Partial<CodexAutoDeps> = {}) {
  const log: string[] = [];
  const notes: string[] = [];
  let reads = 0;
  const probe = async () => {
    const r = installs[Math.min(reads++, installs.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const d: CodexAutoDeps = {
    now: () => NOW,
    enabled: async () => true,
    installed: probe,
    latest: async () => "0.160.1",
    agents: async () => [ACP("agent-a"), ACP("agent-b")],
    busy: async () => [],
    lock: async () => ({ release: () => log.push("release") }),
    prepare: () => prepareCodexUpdate({
      install: probe,
      latest: async () => "0.160.1",
      adapter: () => null,
      selected: () => "upstream",
      // 默认 npm 来自前缀 B（PATH 上排前面的那个）；前缀 A 自带 npm
      npmFor: (prefix: string) => (prefix === A ? { npm: `${A}/bin/npm`, binDir: `${A}/bin` } : { npm: `${B}/bin/npm`, binDir: `${B}/bin` }),
      // 默认的 releases / installAdapter 会真去 npm 下载适配器到测试状态目录（statePath("acp")），同进程后面的
      // update-hints.test.ts 就读成 broken；fake 掉，用例只走注入的适配器
      releases: async () => [],
      installAdapter: async () => ({ ok: false, error: "测试里不装真适配器" }),
      ...gate,
    } as Partial<CodexGateDeps>),
    shell: async (cmd) => (log.push(`shell:${cmd}`), { ok: true, tail: "added 1 package" }),
    restart: async (name) => (log.push(`restart:${name}`), { ok: true }),
    notify: async (text) => (notes.push(text), true),
    log: () => {},
    load: () => ({}),
    save: () => {},
    ...over,
  };
  return { d, log, notes, reads: () => reads };
}

const restarts = (log: string[]) => log.filter((l) => l.startsWith("restart"));

describe("Codex 自动更新绑定实际安装并核生效版本", () => {
  test("[验收线 1] codex 来自前缀 A、默认 npm 来自 B：命令绑 A；shell exit 0 但实际版本仍旧 → failed、零重启、不报已升级", async () => {
    const { d, log, notes, reads } = rig([npmInst("0.159.3"), npmInst("0.159.3"), npmInst("0.159.3")]);
    const r = await codexAutoUpdateTick(d);
    const shell = log.find((l) => l.startsWith("shell:"))!;
    expect(shell).toContain(`${A}/bin/npm`);
    expect(shell).toContain(`--prefix ${A}`);
    expect(shell).not.toContain(B);
    expect(reads()).toBeGreaterThanOrEqual(3); // 安装后重探过实际解析到的 codex
    expect(r.outcome).not.toBe("updated");
    expect(r.outcome).toBe("failed");
    expect(restarts(log)).toEqual([]);
    expect(notes.join("\n")).not.toContain("已自动更新");
    expect(notes.join("\n")).not.toContain(A); // 通知不外发路径
  });

  test("[验收线 1] 前缀 A 没有自带 npm：退到 canonical npm，但仍 --prefix 钉 A", async () => {
    const { d, log } = rig([npmInst("0.159.3"), npmInst("0.159.3"), npmInst("0.160.1")], { npmFor: () => ({ npm: `${B}/bin/npm`, binDir: `${B}/bin` }) });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("updated");
    expect(log.find((l) => l.startsWith("shell:"))).toContain(`--prefix ${A}`);
  });

  test("[验收线 2] 实际版本到目标且适配器对账成功：重启空闲的，安装后开始忙的不打断", async () => {
    let round = 0;
    const reconciled: string[] = [];
    const { d, log, notes } = rig(
      [npmInst("0.159.3"), npmInst("0.159.3"), npmInst("0.160.1")],
      { adapter: () => ({ version: "1.0.0", codexRange: "^0.160.0" }) as never, reconcile: async () => (reconciled.push("ok"), { ok: true }) as never },
      { busy: async (names) => (round++ < 2 ? [] : names.filter((n) => n === "agent-b")) },
    );
    const r = await codexAutoUpdateTick(d);
    expect(r).toMatchObject({ outcome: "updated", restarted: ["agent-a"], skipped: ["agent-b"] });
    expect(reconciled).toEqual(["ok"]);
    expect(restarts(log)).toEqual(["restart:agent-a"]);
    expect(notes[0]).toContain("已自动更新");
  });

  test("[验收线 2] 安装后探不出 codex：failed、零重启", async () => {
    for (const after of [null, new Error("probe boom")]) {
      const { d, log, notes } = rig([npmInst("0.159.3"), npmInst("0.159.3"), after]);
      expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
      expect(restarts(log)).toEqual([]);
      expect(notes.join("\n")).not.toContain("已自动更新");
    }
  });

  test("[验收线 2] 安装后实际解析到另一个前缀（哪怕是目标版本）：failed、零重启", async () => {
    const { d, log, notes } = rig([npmInst("0.159.3"), npmInst("0.159.3"), npmInst("0.160.1", B)]);
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(restarts(log)).toEqual([]);
    expect(notes.join("\n")).not.toContain(B);
  });

  test("[验收线 2] 版本核对通过但适配器对账失败：不重启", async () => {
    const { d, log } = rig([npmInst("0.159.3"), npmInst("0.159.3"), npmInst("0.160.1")],
      { adapter: () => ({ version: "1.0.0", codexRange: "^0.160.0" }) as never, reconcile: async () => ({ ok: false, error: "对账失败" }) as never });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(restarts(log)).toEqual([]);
  });

  test("[验收线 2] 自研适配器分支同样核实际版本", async () => {
    const { d, log } = rig([npmInst("0.159.3"), npmInst("0.159.3"), npmInst("0.159.3")],
      { selected: () => "self", compat: async () => ({ verdict: "compatible", reasons: [] }) as never });
    expect((await codexAutoUpdateTick(d)).outcome).toBe("failed");
    expect(restarts(log)).toEqual([]);
  });

  test("[验收线 2] 非 npm 安装（brew / 未知）：拒自动升级，不跑 shell", async () => {
    const brew: Inst = { version: "0.159.3", npm: false, path: "/fake/Caskroom/codex/0.159.3/codex" };
    const { d, log } = rig([brew]);
    expect((await codexAutoUpdateTick(d)).outcome).toBe("no-npm");
    expect(log).toEqual([]);
    expect(await prepareCodexUpdate({ install: async () => brew, latest: async () => "0.160.1" })).toMatchObject({ status: 400 });
  });

  test("连续两轮版本都没升上去：按失败退避，不是每 6 小时白重启", async () => {
    const stuck = [npmInst("0.159.3"), npmInst("0.159.3"), npmInst("0.159.3")];
    const saved: { failures?: number }[] = [];
    const { d } = rig(stuck, {}, { save: (s) => void saved.push(s) });
    await codexAutoUpdateTick(d);
    expect(saved.at(-1)?.failures).toBe(1);
  });
});

/**
 * 自研 Codex 适配器按 app-server 协议判兼容 + 组合身份（src/lib/acp/codex-compat.ts）。
 * 0.159.3 用已提交的锁；0.160.1 实测生成的 schema 与 0.159.3 逐字节相同（证据 ledger/reviews/CXF-D-evidence.md），
 * 所以这里用「同一份锁 + 版本号改成 0.160.1」代表它，再在它上面做合成变异看红 / 黄怎么判。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFingerprint, codexComboIdentity, judgeCodexCompat, probeCodexCompat, probeNpmCodexCompat } from "../src/lib/acp/codex-compat";
import { readLockSet } from "../src/lib/acp/codex-compat-lock";
import type { LockSet } from "../src/lib/acp/codex-compat-drift";
import { checkAcpReady } from "../src/lib/acp/readiness";

const V159 = readLockSet();
const as160 = (mut: (s: LockSet) => void = () => {}): LockSet => {
  const s = structuredClone(V159);
  s.lock.cliVersion = "0.160.1";
  mut(s);
  return s;
};
const tmps: string[] = [];
const tmp = () => (tmps.push(mkdtempSync(join(tmpdir(), "codex-compat-test-"))), tmps.at(-1)!);
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("judgeCodexCompat：可解释的结论", () => {
  test("0.159.3 → 0.160.1（schema 相同）：兼容、没有差异，身份跟着版本走", () => {
    expect(V159.lock.cliVersion).toBe("0.159.3");
    const c = judgeCodexCompat(V159, as160());
    expect(c).toMatchObject({ verdict: "compatible", reasons: [], codexVersion: "0.160.1" });
    expect(c.identity?.codex).toBe("0.160.1");
    expect(c.identity?.id).not.toBe(judgeCodexCompat(V159, V159).identity?.id);
  });
  test("我们用的 method 没了：不兼容，原因指到 method 表那一条", () => {
    const [m] = Object.keys(V159.methods.client);
    const c = judgeCodexCompat(V159, as160((s) => void (s.methods.client[m!]!.schemaParams = null)));
    expect(c.verdict).toBe("incompatible");
    expect(c.reasons).toContain(`[红] method 表：client ${m}：schema 里没有这个 method`);
  });
  test("只多了一个我们不处理的通知：兼容，但列出黄级差异（要真实组合验证）", () => {
    const c = judgeCodexCompat(V159, as160((s) => void s.methods.allNotifications.push("zz/new")));
    expect(c.verdict).toBe("compatible");
    expect(c.reasons).toEqual(["[黄] 通知 method（开放联合）：新增：zz/new"]);
  });
  test("只有全量指纹变了：兼容，记一条候选", () => {
    const c = judgeCodexCompat(V159, as160((s) => void (s.lock.schemaFullSha256 = "f".repeat(64))));
    expect(c.verdict).toBe("compatible");
    expect(c.reasons).toEqual(["[候选] 全量指纹：投影、出站闭包、method 表都没变"]);
  });
});

describe("组合身份", () => {
  const adapter = "a".repeat(64);
  const base = codexComboIdentity("0.160.1", "s".repeat(64), adapter);
  test("稳定：同样三项同一个 id", () => {
    expect(codexComboIdentity("0.160.1", "s".repeat(64), adapter)).toEqual(base);
    expect(base).toMatchObject({ adapter: "aaaaaaaaaaaa", codex: "0.160.1", schema: "ssssssssssss" });
  });
  test("schema / Codex 版本 / 适配器任一变了，id 就变", () => {
    expect(codexComboIdentity("0.160.1", "t".repeat(64), adapter).id).not.toBe(base.id);
    expect(codexComboIdentity("0.160.2", "s".repeat(64), adapter).id).not.toBe(base.id);
    expect(codexComboIdentity("0.160.1", "s".repeat(64), "b".repeat(64)).id).not.toBe(base.id);
  });
  test("适配器源码指纹：只看 *.ts，改一个字节就变", () => {
    const d = tmp();
    writeFileSync(join(d, "a.ts"), "export const x = 1;\n");
    writeFileSync(join(d, "NOTES.md"), "x");
    const before = adapterFingerprint(d);
    writeFileSync(join(d, "NOTES.md"), "y");
    expect(adapterFingerprint(d)).toBe(before);
    writeFileSync(join(d, "a.ts"), "export const x = 2;\n");
    expect(adapterFingerprint(d)).not.toBe(before);
    expect(adapterFingerprint()).toMatch(/^[0-9a-f]{64}$/); // 缺省读仓库里的自研适配器目录
  });
});

describe("探测失败一律「未知」，不抛", () => {
  test("codex 不存在", () => {
    const c = probeCodexCompat("/nonexistent/codex");
    expect(c.verdict).toBe("unknown");
    expect(c.reasons[0]).toContain("生成或读取 schema 失败");
  });
  test("隔离安装：版本号不正式就不拼进 shell；npm 失败带尾巴；装完找不到原生二进制", async () => {
    const cmds: string[] = [];
    const shell = (ok: boolean) => async (cmd: string) => (cmds.push(cmd), { ok, tail: "npm ERR! E404" });
    expect((await probeNpmCodexCompat("0.160.1; rm -rf ~", shell(true))).verdict).toBe("unknown");
    expect(cmds).toEqual([]);
    const failed = await probeNpmCodexCompat("0.160.1", shell(false));
    expect(failed).toMatchObject({ verdict: "unknown" });
    expect(failed.reasons[0]).toContain("E404");
    expect(cmds[0]).toMatch(/^npm install --prefix \S+ .*--ignore-scripts.* @openai\/codex@0\.160\.1$/);
    expect((await probeNpmCodexCompat("0.160.1", shell(true))).reasons[0]).toContain("找不到");
  });
});

describe("readiness 带上组合身份（自研生效时）", () => {
  const cliOk = { resolveBin: async () => "/x/codex", run: async () => ({ ok: true, out: "Usage: codex app-server [OPTIONS]", err: "" }), env: {} };
  const compatible = judgeCodexCompat(V159, as160());
  test("自研：只按协议判，不碰上游适配器的安装 / 对账", async () => {
    let touched = 0;
    const r = await checkAcpReady(true, { ...cliOk, selected: () => "self", compat: () => compatible,
      installed: () => (touched++, { ok: false, hint: "x" }), install: async () => (touched++, { ok: false, error: "x" }) });
    expect(r).toMatchObject({ ok: true, codexBin: "/x/codex", compat: { verdict: "compatible" } });
    expect(touched).toBe(0);
  });
  test("自研 + 不兼容：未就绪，原因带协议差异", async () => {
    const bad = judgeCodexCompat(V159, as160((s) => void (s.methods.clientNotifications.initialized = false)));
    const r = await checkAcpReady(false, { ...cliOk, selected: () => "self", compat: () => bad });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("不兼容");
  });
});

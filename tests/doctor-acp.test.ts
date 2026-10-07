/**
 * doctor 的 Codex ACP 检查在全局选了自研之后不再误警（src/lib/doctor-acp.ts，CXU-1 追加 6、7）：
 * 配套范围只拿还跑上游的活 agent 比；「回退」只认宿主日志里真有自研被拒，停掉的 / 出借 worker / 切换前起的老宿主不算。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCodexRunning } from "../src/lib/codex-version";
import { acpDoctorChecks, hostEvidence, hostRefusedEvidence, readHostEvidence, selfAdapterChecks } from "../src/lib/doctor-acp";
import { appendLogLine } from "../src/lib/log-paths";
import type { RegistryAgent } from "../src/lib/registry";

const ag = (name: string, status = "active") => ({ name, runtime: "codex", transport: "acp", status }) as RegistryAgent;
const UPSTREAM = { version: "2.0.1", codexRange: "^0.159.1", path: "/x/index.js" };
const COMPAT = { verdict: "compatible" as const, reasons: [], identity: { id: "combo-1", adapter: "a", codex: "0.160.1", schema: "s" } };
const SELF_OK = { ok: true as const, adapter: "self" as const, compat: COMPAT, codexBin: "/x/codex" };
const REG = [ag("agent-a"), ag("agent-b"), ...Array.from({ length: 5 }, (_, i) => ag(`agent-lend-${String(i).repeat(10)}`, "stopped"))];
const pairing = (checks: { name: string }[]) => checks.find((c) => c.name === "Codex 与适配器配套");

describe("Codex 与适配器配套", () => {
  test("选了自研且判兼容、没有活 agent 跑上游：ok，不拿上游范围比", () => {
    expect(pairing(acpDoctorChecks(REG, SELF_OK, "0.160.1", UPSTREAM, () => false))).toMatchObject({ status: "ok" });
  });
  test("选了自研但还有活 agent 跑上游：照旧比，只数那几个", () => {
    const c = pairing(acpDoctorChecks(REG, SELF_OK, "0.160.1", UPSTREAM, (a) => a.name === "agent-b"));
    expect(c).toMatchObject({ status: "warn", detail: expect.stringContaining("1 个仍跑上游的 ACP agent") });
  });
  test("没选自研：停掉的 ACP agent 不进计数", () => {
    const c = pairing(acpDoctorChecks(REG, { ok: true }, "0.160.1", UPSTREAM));
    expect(c).toMatchObject({ status: "warn", detail: expect.stringContaining("2 个 ACP agent") });
  });
});

describe("自研适配器回退", () => {
  const choice = { default: "self" as const, agents: {} };
  const names = (checks: { name: string; detail: string }[], name: string) => checks.find((c) => c.name === name)?.detail ?? "";
  test("只有宿主日志里有自研被拒的才算回退；没证据的归「待重启」；停掉的、出借 worker 都不列", () => {
    const reg = [...REG, ag("agent-lend-0123456789")];
    const c = selfAdapterChecks(reg, SELF_OK, choice, () => "upstream", (a) => ({ refused: a === "agent-a" }));
    expect(names(c, "自研适配器回退")).toBe(names(c, "自研适配器回退").replace(/agent-b|agent-lend/g, "")); // 只有 agent-a
    expect(names(c, "自研适配器回退")).toContain("agent-a");
    expect(names(c, "待重启才换自研")).toContain("agent-b");
    expect(names(c, "待重启才换自研")).not.toContain("agent-lend");
  });
  test("全都跑自研：两条都不出", () => {
    const c = selfAdapterChecks(REG, SELF_OK, choice, () => "self", () => ({ refused: true }));
    expect(c.map((x) => x.name)).toEqual(["自研适配器组合"]);
  });
});

describe("hostEvidence：读宿主最近一次启动", () => {
  const T = (s: number) => new Date(Date.UTC(2026, 9, 7, 3, 0, s)).toISOString();
  test("启动前紧挨着的拒绝行算这一次", () => {
    expect(hostEvidence([`${T(0)} ⚠️ 自研 Codex 适配器用不了（x），本宿主改用上游 codex-acp`, `${T(0)} ACP 宿主启动：agent-a · 线程 1 · codex-acp`].join("\n")).refused).toBe(true);
  });
  test("启动后接不上线程再退的那行也算", () => {
    expect(hostEvidence([`${T(0)} ACP 宿主启动：a`, `${T(5)} ⚠️ 自研 Codex 适配器用不了（y）`].join("\n")).refused).toBe(true);
  });
  test("上一次宿主的拒绝不算这一次；切换前起的老宿主没有这行", () => {
    const log = [`${T(0)} ⚠️ 自研 Codex 适配器用不了（old）`, `${T(1)} ACP 宿主启动：a`, `${T(9)} 收到 SIGTERM，收尾退出`, `${T(30)} ACP 宿主启动：a · codex-acp`].join("\n");
    expect(hostEvidence(log).refused).toBe(false);
    expect(hostEvidence(`${T(0)} ACP 宿主启动：a · codex-acp`).refused).toBe(false);
    expect(hostEvidence("").refused).toBe(false);
  });
});

test("readHostEvidence 读整份日志：启动后又写了几百 KiB，开头的拒绝行照样算", () => {
  const dir = mkdtempSync(join(tmpdir(), "host-ev-"));
  try {
    const t = "2026-10-07T03:00:00.000Z";
    const filler = Array.from({ length: 8000 }, (_, i) => `${t} bridge 连接断了（code 1006），3s 后重连 #${i} ${"x".repeat(40)}`).join("\n");
    const file = join(dir, "host.log");
    writeFileSync(file, [`${t} ⚠️ 自研 Codex 适配器用不了（x），本宿主改用上游 codex-acp`, `${t} ACP 宿主启动：a · codex-acp`, filler].join("\n"));
    expect(filler.length).toBeGreaterThan(256 * 1024);
    expect(readHostEvidence("a", file).refused).toBe(true);
    expect(readHostEvidence("a", join(dir, "missing.log")).refused).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe("日志轮转后证据不丢（doctor-host-evidence-truncated）", () => {
  const t = "2026-10-07T03:00:00.000Z";
  /** 按生产的 appendLogLine 写：拒绝行 + 启动行，再灌普通日志直到 until 成立（阈值 1 KiB，生产 32 MiB 同理） */
  const writeRotated = (file: string, until: () => boolean) => {
    appendLogLine(file, `${t} ⚠️ 自研 Codex 适配器用不了（x），本宿主改用上游 codex-acp`, 1024);
    appendLogLine(file, `${t} ACP 宿主启动：a · codex-acp`, 1024);
    for (let i = 0; !until() && i < 1000; i++) appendLogLine(file, `${t} bridge 连接断了（code 1006），3s 后重连 #${i}`, 1024);
  };
  const rotated = (file: string) => existsSync(`${file}.1`);
  const startGone = (file: string) => rotated(file) && !readFileSync(`${file}.1`, "utf8").includes("ACP 宿主启动");
  const withDir = (fn: (dir: string, file: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "host-rot-"));
    try { fn(dir, join(dir, "host.log")); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  test("轮转两次、两份日志都没了启动行：宿主记进运行记录的 selfRefused 照样判回退", () => withDir((dir, file) => {
    writeRotated(file, () => startGone(file));
    expect(readHostEvidence("a", file).refused).toBe(false); // 日志里确实找不到了
    recordCodexRunning("a", "0.160.1", dir, { adapter: "upstream", selfRefused: true });
    expect(hostRefusedEvidence("a", dir, file).refused).toBe(true);
  }));
  test("运行记录说这一代没被拒：以记录为准，不再翻日志", () => withDir((dir, file) => {
    writeRotated(file, () => true);
    recordCodexRunning("a", "0.160.1", dir, { adapter: "upstream", selfRefused: false });
    expect(hostRefusedEvidence("a", dir, file).refused).toBe(false);
  }));
  test("老宿主的记录没这个字段：退回读日志，轮转一次进了 .1 也找得到", () => withDir((dir, file) => {
    writeRotated(file, () => rotated(file));
    expect(readFileSync(`${file}.1`, "utf8")).toContain("ACP 宿主启动");
    recordCodexRunning("a", "0.160.1", dir, { adapter: "upstream" });
    expect(hostRefusedEvidence("a", dir, file).refused).toBe(true);
  }));
});

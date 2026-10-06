/**
 * 账号用量的平台无关启动（bridge/account-usage-startup.ts）与探测生命周期：
 *   - bridge.ts 真实启动线：唯一一处 startAccountUsage 在平台无关段（不在 discord ready 里、不在 web-only / Discord 分支里），
 *     Discord 看板初始化不再带贴卡（旧触发移除，不会双定时器）；
 *   - Web-only 也能贴批准卡（不依赖 Discord）：重复启动只起一次、同计划重复 tick 不刷卡、投递失败下一轮重试；
 *   - 上一进程被硬杀留下的探测记录：启动时只回收记录里那一份并记退避；
 *   - 探测进行中进程收到 SIGTERM：退出钩子同步收掉自己建的探测会话（其它会话 0 kill），abort 判失败并收尾。
 * fixture settings / 假 tmux / 假探测，零真实 tmux、零模型调用。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { __resetAccountUsageStartupForTest, startAccountUsage } from "../src/bridge/account-usage-startup.ts";
import { liveProbeCount, runUsageProbe, type ProbeTmux } from "../src/bridge/account-usage-probe.ts";
import { MANUAL_REFRESH_BACKOFF_MS, manualRefresh, type ProbeResource } from "../src/lib/account-usage-refresh.ts";
import { ensureStatuslineUsage } from "../src/lib/statusline-usage-install.ts";
import type { Delivery, Envelope } from "../src/bridge/router.ts";

const ROOT = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "acct-startup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CUSTOM = `{"statusLine":{"type":"command","command":"echo mine"}}`;
let n = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noProbe = { run: async () => ({ ok: false as const, reason: "unused" }), cleanup: async () => {} };

async function plan() {
  const d = join(dir, `p-${n++}`);
  mkdirSync(d);
  const settingsPath = join(d, "settings.json");
  writeFileSync(settingsPath, CUSTOM);
  const planPath = join(d, "plan.json");
  await ensureStatuslineUsage({ repoRoot: ROOT, settingsPath, planPath });
  return { settingsPath, planPath, refreshPath: join(d, "refresh.json") };
}

describe("bridge.ts 真实启动线", () => {
  const src = readFileSync(join(ROOT, "src/bridge.ts"), "utf8");
  const lines = src.split("\n");
  test("唯一一处启动在平台无关段：顶层语句，位于 discord ready 块之外、web-only / Discord 分支之前", () => {
    const hits = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes("startAccountUsage("));
    expect(hits).toHaveLength(1);
    const [line, idx] = hits[0]!;
    expect(line.startsWith("void import(\"./bridge/account-usage-startup.js\")")).toBe(true); // 顶层（无缩进），不在任何块里
    expect(line).toContain("startAccountUsage(deliver)");
    const branch = lines.findIndex((l) => l.startsWith("if (WEB_ONLY) {"));
    expect(branch).toBeGreaterThan(idx);
    const ready = lines.findIndex((l) => l.startsWith("discord.once(\"ready\""));
    const readyEnd = lines.findIndex((l, i) => i > ready && l.startsWith("});"));
    expect(idx < ready || idx > readyEnd).toBe(true);
  });
  test("Discord 看板初始化不再贴卡（旧触发移除，不双定时器）", () => {
    expect(src).toContain("initStatsDashboard(discord), 6000");
    const dash = readFileSync(join(ROOT, "src/bridge/stats-dashboard.ts"), "utf8");
    expect(dash).not.toContain("account-usage-statusline-consent");
    expect(dash).not.toContain("postStatuslineConsentCard");
  });
});

describe("startAccountUsage", () => {
  test("Web-only（local-* 控制频道、无 Discord）：贴卡一次；重复启动不叠定时器；重复 tick 不刷卡；失败下一轮重试", async () => {
    __resetAccountUsageStartupForTest();
    const p = await plan();
    const sent: Envelope[] = [];
    let fail = true;
    const deliver = async (env: Envelope): Promise<Delivery> => {
      sent.push(env);
      return { envelope: env, outcome: fail ? { kind: "dropped", reason: "offline" } : { kind: "sent" } } as Delivery;
    };
    const consent = { planPath: p.planPath, chatId: "local-master-control", tickMs: 15, firstDelayMs: 0 };
    const stop = await startAccountUsage(deliver, { probe: noProbe, refreshPath: p.refreshPath, consent });
    const again = await startAccountUsage(deliver, { probe: noProbe, refreshPath: p.refreshPath, consent });
    await wait(40);
    const failedTries = sent.length;
    expect(failedTries).toBeGreaterThanOrEqual(1); // 失败：没记已贴，下一 tick 再试
    fail = false;
    await wait(80);
    stop();
    again();
    const ok = sent.slice(failedTries);
    expect(ok.length).toBe(1); // 成功之后同计划不再贴，第二次启动也没多出一路定时器
    expect(ok[0]!.to).toMatchObject({ kind: "user", channelId: "local-master-control" });
    expect(ok[0]!.from.kind).toBe("bridge");
    expect(readFileSync(p.settingsPath, "utf8")).toBe(CUSTOM); // 贴卡不写配置
    __resetAccountUsageStartupForTest();
  });

  test("上一进程被硬杀留下的在途探测：启动时只回收记录里那一份、记退避；之后手动刷新照样退避不探测", async () => {
    __resetAccountUsageStartupForTest();
    const p = await plan();
    const T0 = Date.now();
    const leftover: ProbeResource = { session: "cstra-usage-probe-deadbeef", id: "$7", dir: "/tmp/x" };
    writeFileSync(p.refreshPath, JSON.stringify({ lastAttemptAt: T0, lastFailureAt: null, lastFailureReason: null, nextAllowedAt: null,
      inFlight: { startedAt: T0, pid: 1, probe: leftover }, lastReading: null }));
    const cleaned: ProbeResource[] = [];
    let runs = 0;
    const probe = { run: async () => (runs++, { ok: false as const, reason: "x" }), cleanup: async (r: ProbeResource) => void cleaned.push(r) };
    const stop = await startAccountUsage(async (env) => ({ envelope: env, outcome: { kind: "sent" } }) as Delivery,
      { probe, refreshPath: p.refreshPath, consent: { planPath: join(dir, "none.json"), tickMs: 1000, firstDelayMs: 1000 } });
    stop();
    expect(cleaned).toEqual([leftover]);
    const st = JSON.parse(readFileSync(p.refreshPath, "utf8"));
    expect(st).toMatchObject({ inFlight: null, lastFailureReason: "interrupted", nextAllowedAt: T0 + MANUAL_REFRESH_BACKOFF_MS });
    const r = await manualRefresh({ path: p.refreshPath, probe });
    expect(r.outcome).toBe("backoff");
    expect(runs).toBe(0);
    expect(cleaned).toHaveLength(1);
    __resetAccountUsageStartupForTest();
  });
});

describe("探测生命周期", () => {
  test("abort：判失败（probe_aborted），只收自己建的会话，不再登记在途", async () => {
    const killed: string[] = [];
    const ac = new AbortController();
    const tmux: ProbeTmux = {
      newSession: async () => "$10",
      capture: async () => (ac.abort(), "starting…"),
      sendLiteral: async () => {}, sendKey: async () => {},
      nameOf: async (id) => (id === "$10" ? created[0]?.session ?? null : "master"),
      kill: async (id) => void killed.push(id),
    };
    const created: ProbeResource[] = [];
    const r = await runUsageProbe((x) => created.push(x), { tmux, claudeBin: () => "/bin/claude", makeDir: () => "/tmp/d", removeDir: () => {},
      sleep: () => new Promise(() => {}), timeoutMs: 60_000, signal: ac.signal });
    expect(r).toEqual({ ok: false, reason: "probe_aborted" });
    expect(killed).toEqual(["$10"]);
    expect(liveProbeCount()).toBe(0);
  });

  test("探测进行中进程收到 SIGTERM：退出钩子同步收掉自己建的会话和临时目录，其它会话 0 kill，按原信号退出", async () => {
    const log = join(dir, `sig-${n++}.log`);
    const child = join(dir, `child-${n++}.ts`);
    writeFileSync(child, `
import { appendFileSync } from "node:fs";
import { runUsageProbe } from ${JSON.stringify(join(ROOT, "src/bridge/account-usage-probe.ts"))};
const log = ${JSON.stringify(log)};
const names = new Map([["$0", "master"], ["$1", "owner-work"]]);
const tmux = {
  newSession: async (name) => (names.set("$10", name), "$10"),
  capture: async () => "starting…",
  sendLiteral: async () => {}, sendKey: async () => {},
  nameOf: async (id) => names.get(id) ?? null, kill: async (id) => appendFileSync(log, "async-kill " + id + "\\n"),
  nameOfSync: (id) => names.get(id) ?? null,
  killSync: (id) => appendFileSync(log, "kill " + id + "\\n"),
};
void runUsageProbe(() => console.log("CREATED"), { tmux, claudeBin: () => "/bin/claude", makeDir: () => "/tmp/probe-dir",
  removeDir: (d) => appendFileSync(log, "rm " + d + "\\n"), timeoutMs: 600_000 });
setInterval(() => {}, 1000);
`);
    const proc = Bun.spawn([process.execPath, child], { stdout: "pipe", stderr: "inherit" });
    const reader = proc.stdout.getReader();
    let out = "";
    while (!out.includes("CREATED")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("CREATED");
    proc.kill("SIGTERM");
    await proc.exited;
    expect(proc.signalCode).toBe("SIGTERM");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["kill $10", "rm /tmp/probe-dir"]);
  });
});

/**
 * statusline 安装服务（lib/statusline-usage-install.ts）与包装模式（scripts/statusline-usage.sh --wrap），全部用 fixture settings：
 * 未配 → 原子装上；已是我们的 → 不套娃；用户自定义 → 原字节不动、只出计划；批准 → 原命令输出 / 退出码保留且缓存落盘；
 * 重放 / 过期 / 错计划 / 漂移 / 新配置抢写 / 坏文件都零写。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  applyWrapPlan, canonicalStatuslineCommand, casWrite, ensureStatuslineUsage, isOurStatusline, pendingWrapPlan, WRAP_PLAN_TTL_MS,
} from "../src/lib/statusline-usage-install.ts";
import { testChildEnv } from "./test-env.ts";

const ROOT = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "sl-install-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function fixture(content?: string) {
  const d = join(dir, `case-${n++}`);
  mkdirSync(d);
  const settingsPath = join(d, "settings.json");
  if (content !== undefined) writeFileSync(settingsPath, content);
  return { settingsPath, planPath: join(d, "plan.json"), repoRoot: ROOT };
}
const CUSTOM = `{\n    "model": "opus",\n    "statusLine": {"type": "command", "command": "echo mine; exit 3", "padding": 2}\n}\n`;

describe("ensureStatuslineUsage", () => {
  test("statusLine 未配：装上规范脚本，其它设置保留；再跑一次不变（幂等）", async () => {
    const f = fixture(`{"model":"opus","hooks":{"Stop":[]}}`);
    expect(await ensureStatuslineUsage(f)).toEqual({ action: "installed" });
    const s = JSON.parse(readFileSync(f.settingsPath, "utf8"));
    expect(s).toMatchObject({ model: "opus", hooks: { Stop: [] }, statusLine: { type: "command", command: canonicalStatuslineCommand(ROOT) } });
    const bytes = readFileSync(f.settingsPath, "utf8");
    expect(await ensureStatuslineUsage(f)).toEqual({ action: "already" });
    expect(readFileSync(f.settingsPath, "utf8")).toBe(bytes);
  });

  test("settings.json 不存在：建一份只有 statusLine 的", async () => {
    const f = fixture();
    expect(await ensureStatuslineUsage(f)).toEqual({ action: "installed" });
    expect(JSON.parse(readFileSync(f.settingsPath, "utf8")).statusLine.command).toBe(canonicalStatuslineCommand(ROOT));
  });

  test("用户自定义 statusLine：原字节不变，只生成计划", async () => {
    const f = fixture(CUSTOM);
    const r = await ensureStatuslineUsage(f);
    expect(r).toMatchObject({ action: "planned", originalCommand: "echo mine; exit 3" });
    expect(readFileSync(f.settingsPath, "utf8")).toBe(CUSTOM);
    expect(pendingWrapPlan(Date.now(), f.planPath)?.owner).toBe("owner:self");
  });

  test("坏 JSON / 非对象：不写", async () => {
    for (const bad of ["{bad", "[1,2]"]) {
      const f = fixture(bad);
      expect(await ensureStatuslineUsage(f)).toEqual({ action: "skipped", reason: "corrupt" });
      expect(readFileSync(f.settingsPath, "utf8")).toBe(bad);
    }
  });

  test("已包装的不再套一层（任意 clone 路径的规范脚本都认）", () => {
    expect(isOurStatusline("'/x/y/scripts/statusline-usage.sh' --wrap 'echo hi'")).toBe(true);
    expect(isOurStatusline("/other/clone/scripts/statusline-usage.sh")).toBe(true);
    expect(isOurStatusline("echo scripts/statusline-usage.sh")).toBe(false);
  });
});

describe("applyWrapPlan", () => {
  async function planned() {
    const f = fixture(CUSTOM);
    const r = await ensureStatuslineUsage(f);
    if (r.action !== "planned") throw new Error("expected plan");
    return { f, planId: r.planId };
  }

  test("批准：只应用一次，原命令保留在包装里，备份原字节；重放零写；再跑 setup 不套娃", async () => {
    const { f, planId } = await planned();
    expect(await applyWrapPlan(planId, { planPath: f.planPath })).toEqual({ ok: true });
    const after = readFileSync(f.settingsPath, "utf8");
    const s = JSON.parse(after);
    expect(s.model).toBe("opus");
    expect(s.statusLine.padding).toBe(2);
    expect(s.statusLine.command).toContain("--wrap 'echo mine; exit 3'");
    expect(readFileSync(`${f.settingsPath}.claudestra-statusline.bak`, "utf8")).toBe(CUSTOM);
    expect(await applyWrapPlan(planId, { planPath: f.planPath })).toEqual({ ok: false, reason: "no_plan" });
    expect(await ensureStatuslineUsage(f)).toEqual({ action: "already" });
    expect(readFileSync(f.settingsPath, "utf8")).toBe(after);
  });

  test("错 planId / 过期 / 配置在计划后被改（漂移）：都零写", async () => {
    const a = await planned();
    expect(await applyWrapPlan("0000000000000000", { planPath: a.f.planPath })).toEqual({ ok: false, reason: "plan_mismatch" });
    expect(await applyWrapPlan(a.planId, { planPath: a.f.planPath, now: () => Date.now() + WRAP_PLAN_TTL_MS + 1 })).toEqual({ ok: false, reason: "expired" });
    expect(readFileSync(a.f.settingsPath, "utf8")).toBe(CUSTOM);
    const drifted = CUSTOM.replace("opus", "sonnet");
    writeFileSync(a.f.settingsPath, drifted);
    expect(await applyWrapPlan(a.planId, { planPath: a.f.planPath })).toEqual({ ok: false, reason: "drift" });
    expect(readFileSync(a.f.settingsPath, "utf8")).toBe(drifted);
  });

  test("CAS：读完之后别的写者抢写了新配置 → 提交前核验不过，保留对方的字节、不留 tmp", () => {
    const f = fixture(CUSTOM);
    const theirs = CUSTOM.replace("echo mine", "echo theirs");
    writeFileSync(f.settingsPath, theirs); // 我们读到的是 CUSTOM，提交时磁盘已是 theirs
    expect(casWrite(f.settingsPath, CUSTOM, "{}\n")).toBe(false);
    expect(readFileSync(f.settingsPath, "utf8")).toBe(theirs);
    expect(readdirSync(dirname(f.settingsPath)).filter((x) => x.endsWith(".tmp"))).toEqual([]);
    expect(casWrite(f.settingsPath, theirs, "{}\n")).toBe(true);
  });
});

describe("scripts/statusline-usage.sh --wrap", () => {
  test("原命令输出与退出码原样透传，同时落盘用量缓存", () => {
    const state = join(dir, "wrap-state");
    mkdirSync(state);
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1787810400 }, seven_day: { used_percentage: 34 } } });
    const r = spawnSync("/bin/bash", [join(ROOT, "scripts/statusline-usage.sh"), "--wrap", "cat >/dev/null; printf 'mine|%s' ok; exit 3"],
      { input, encoding: "utf8", env: testChildEnv({ HOME: dir, CLAUDESTRA_STATE_DIR: state }) });
    expect(r.stdout).toBe("mine|ok");
    expect(r.status).toBe(3);
    const cache = join(state, "usage-cache.json");
    if (spawnSync("python3", ["--version"]).status === 0) {
      expect(existsSync(cache)).toBe(true);
      expect(JSON.parse(readFileSync(cache, "utf8"))).toMatchObject({ sessionPct: 12, weekPct: 34 });
    }
  });
  test("复现 wrap-input：原命令收到的 stdin 逐字节不变（含结尾多个换行），输出与直接跑原命令相同", () => {
    const state = join(dir, "wrap-bytes");
    mkdirSync(state);
    const env = testChildEnv({ HOME: dir, CLAUDESTRA_STATE_DIR: state });
    for (const input of ['{"rate_limits":{}}\n\n', '{"rate_limits":{"five_hour":{"used_percentage":5}}}\n', "  \n{}\r\n\n\n"]) {
      const before = spawnSync("/bin/sh", ["-c", "cat"], { input, encoding: "utf8", env });
      const after = spawnSync("/bin/bash", [join(ROOT, "scripts/statusline-usage.sh"), "--wrap", "cat"], { input, encoding: "utf8", env });
      expect(before.stdout).toBe(input);
      expect(after.stdout).toBe(before.stdout);
      expect(after.status).toBe(0);
    }
  });
});

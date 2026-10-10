/**
 * RLOCK2 · 模式读取只认 keys.lockYield（项目级 on 不带上，缺省 observe）；registry 结构坏一律当「读不了」（不确定就不让）。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryAgents } from "../src/lib/scheduler-lock-yield-agents.js";
import { lockYieldPolicyAt } from "../src/lib/scheduler-lock-yield-policy.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = (name: string, body: string | null): string => {
  const dir = mkdtempSync(join(tmpdir(), "rlock2-pol-"));
  dirs.push(dir);
  const path = join(dir, name);
  if (body !== null) writeFileSync(path, body);
  return path;
};
const modeOf = (cfg: unknown, project = "p") => lockYieldPolicyAt(file("recovery-policy.json", cfg === null ? null : JSON.stringify(cfg)))(project, "lockYield");

test("lockYield 只认自己的键：项目级 on 仍 observe，项目级 off 跟着 off，显式键说了算，缺省 observe", () => {
  expect(modeOf(null)).toMatchObject({ mode: "observe", source: "default" });
  expect(modeOf({ projects: { p: { mode: "on" } } })).toMatchObject({ mode: "observe", source: "config" });
  expect(modeOf({ projects: { p: { mode: "on", keys: { askReminder: "on" } } } }).mode).toBe("observe");
  expect(modeOf({ projects: { p: { mode: "off" } } }).mode).toBe("off");
  expect(modeOf({ projects: { p: { mode: "off", keys: { lockYield: "on" } } } }).mode).toBe("on");
  expect(modeOf({ projects: { p: { keys: { lockYield: "on" } } } }).mode).toBe("on");
  expect(modeOf({ projects: { p: { mode: "on", keys: { lockYield: "off" } } } }).mode).toBe("off");
  expect(modeOf({ projects: { q: { keys: { lockYield: "on" } } } })).toMatchObject({ mode: "observe", source: "default" });
});

test("策略文件坏 / 问了别的键 → off（停手）", () => {
  expect(lockYieldPolicyAt(file("recovery-policy.json", "{"))("p", "lockYield")).toMatchObject({ mode: "off", source: "error" });
  expect(modeOf({ projects: { p: { keys: { nope: "on" } } } })).toMatchObject({ mode: "off", source: "error" });
  expect(lockYieldPolicyAt(file("recovery-policy.json", null))("p", "askReminder")).toMatchObject({ mode: "off", source: "error" });
});

test("registry：整份可信才用，结构坏一律 null", () => {
  const reg = (body: unknown) => registryAgents(file("registry.json", typeof body === "string" ? body : JSON.stringify(body)));
  expect(reg({ agents: { a: { sessionId: "s" } } })?.get("a")?.sessionId).toBe("s");
  expect(reg({ agents: {} })?.size).toBe(0);
  for (const bad of [{}, { agents: null }, { agents: [] }, { agents: { a: null } }, { agents: { a: { sessionId: "s" }, b: 1 } }, [], "{"]) {
    expect(reg(bad)).toBeNull();
  }
  expect(registryAgents(file("registry.json", null))).toBeNull();
});

/** ONB-1 验收 1：localMerge 与 deploy / mergeHandoff / remote≠off 互斥；remote 缺省 off；prMergeOff / checkArgv / localMergeOf */
import { describe, expect, test } from "bun:test";
import { checkArgv, localMergeOf, parseSchedulerConfig, prMergeOff, type SchedulerConfig } from "../src/lib/scheduler-config.js";

const base = { maxActiveWorkers: 2, requiredChecks: ["bun run check", "cargo test --workspace"], repoDir: "/tmp/dn" };
const parse = (p: Record<string, unknown>) => parseSchedulerConfig({ enabled: true, projects: { dn: { ...base, ...p } } });

describe("localMerge 配置", () => {
  test("开启：带 localMerge，remote 缺省 off；requiredChecks 原样保留为命令", () => {
    const p = parse({ localMerge: true }).projects.dn!;
    expect(p.localMerge).toBe(true);
    expect(p.remote?.mode).toBe("off");
    expect(p.requiredChecks).toEqual(base.requiredChecks);
    expect(parse({ localMerge: true, remote: { mode: "off" } }).projects.dn!.remote?.mode).toBe("off");
  });

  test("与 mergeHandoff / deploy / remote≠off 同开 → 解析报错", () => {
    expect(() => parse({ localMerge: true, mergeHandoff: true })).toThrow(/exclusive/);
    expect(() => parse({ localMerge: true, deploy: {} })).toThrow(/cannot deploy/);
    for (const remote of [{ mode: "balance" }, {}, { mode: "overflow" }, "off", null]) {
      expect(() => parse({ localMerge: true, remote })).toThrow(/remote\.mode off/);
    }
    expect(() => parse({ localMerge: "yes" })).toThrow(/boolean/);
  });

  test("缺省 / false：和改动前一样，没有 localMerge 字段，remote 缺省 balance", () => {
    for (const p of [parse({}).projects.dn!, parse({ localMerge: false }).projects.dn!]) {
      expect("localMerge" in p).toBe(false);
      expect(p.remote?.mode).toBe("balance");
    }
  });

  test("prMergeOff = mergeHandoff 或 localMerge", () => {
    expect(prMergeOff({})).toBe(false);
    expect(prMergeOff({ mergeHandoff: true })).toBe(true);
    expect(prMergeOff({ localMerge: true })).toBe(true);
  });

  test("checkArgv：按空白切，不经 shell", () => {
    expect(checkArgv("  cargo  test\t--workspace ")).toEqual(["cargo", "test", "--workspace"]);
    expect(checkArgv("echo a|b")).toEqual(["echo", "a|b"]);
  });

  test("localMergeOf：只认 localMerge 项目；不存在 / 原型键 / 读不出 → null", () => {
    const cfg: SchedulerConfig = parse({ localMerge: true });
    const both = { ...cfg, projects: { ...cfg.projects, other: parse({}).projects.dn! } };
    expect(localMergeOf("dn", () => both)).toEqual({ repoDir: "/tmp/dn", checks: base.requiredChecks });
    expect(localMergeOf("other", () => both)).toBeNull();
    expect(localMergeOf("none", () => both)).toBeNull();
    expect(localMergeOf("__proto__", () => both)).toBeNull();
    expect(localMergeOf("dn", () => { throw new Error("bad json"); })).toBeNull();
  });
});

/**
 * i28-W5c remote.reviewFirst in scheduler.json: absent or [] reads exactly as before, a malformed list fails closed, a valid
 * one reaches the W5 read path (readSchedulerConfig) in order.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSchedulerConfig, readSchedulerConfig } from "../src/lib/scheduler-config.js";

const p = { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/project" };
const remoteOf = (remote: unknown) => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, remote } } }).projects.p.remote;

describe("remote.reviewFirst", () => {
  test("absent or empty: the parsed policy is the same object as before W5c", () => {
    expect(remoteOf({ mode: "balance" })).toEqual({ mode: "balance", roles: ["review"], poolTimeoutMin: 15 });
    expect(remoteOf({ mode: "balance", reviewFirst: [] })).toEqual({ mode: "balance", roles: ["review"], poolTimeoutMin: 15 });
    expect(remoteOf({ reviewFirst: [] })).not.toHaveProperty("reviewFirst");
    expect(parseSchedulerConfig({ enabled: true, projects: { p } }).projects.p.remote).not.toHaveProperty("reviewFirst");
  });

  test("a valid list is kept in order, next to the other fields", () => {
    expect(remoteOf({ mode: "balance", reviewFirst: ["mate", "other"] })).toEqual({ mode: "balance", roles: ["review"], poolTimeoutMin: 15, reviewFirst: ["mate", "other"] });
    expect(remoteOf({ mode: "prefer", reviewFirst: ["a"] })).toMatchObject({ mode: "balance", reviewFirst: ["a"], note: expect.stringContaining("旧写法") });
    expect(remoteOf({ reviewFirst: Array.from({ length: 8 }, (_, i) => `p${i}`) })?.reviewFirst).toHaveLength(8);
  });

  const bad: [string, unknown][] = [
    ["not an array", "mate"],
    ["an object", { mate: true }],
    ["more than 8", Array.from({ length: 9 }, (_, i) => `p${i}`)],
    ["an empty name", ["a", ""]],
    ["a duplicate", ["a", "b", "a"]],
    ["a control character", ["a\nb"]],
    ["a format character", ["a\u200bb"]],
    ["a non-string", ["a", 1]],
  ];
  for (const [name, reviewFirst] of bad) {
    test(`refuses ${name}`, () => {
      expect(() => remoteOf({ mode: "balance", reviewFirst })).toThrow("scheduler project p: remote.reviewFirst must be up to 8 distinct nonempty peer names");
    });
  }

  test("readSchedulerConfig (the W5 read path) returns it from the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "w5c-config-")), path = join(dir, "scheduler.json");
    try {
      writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { ...p, remote: { mode: "balance", reviewFirst: ["mate"] } } } }));
      expect(readSchedulerConfig(path).projects.p.remote?.reviewFirst).toEqual(["mate"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * i28-W9 scheduler.json remote: "write" in roles (with the repo writing goes against), localPriority; a config without
 * them parses exactly as before. parseRemotePolicy is also what `ledger scheduler-pool` rebuilds the daemon's flags with.
 */
import { describe, expect, test } from "bun:test";
import { parseRemotePolicy, parseSchedulerConfig } from "../src/lib/scheduler-config.js";

const p = { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/project" };
const remoteOf = (remote: unknown) => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, remote } } }).projects.p.remote;

describe("remote.roles write + repo", () => {
  test("absent / review only: the same policy as before W9", () => {
    expect(remoteOf(undefined)).toEqual({ mode: "balance", roles: ["review"], poolTimeoutMin: 15 });
    expect(remoteOf({ roles: ["review"] })).toEqual({ mode: "balance", roles: ["review"], poolTimeoutMin: 15 });
    expect(remoteOf({ roles: [] })).toEqual({ mode: "balance", roles: [], poolTimeoutMin: 15 });
  });

  test("write needs the GitHub repo; roles come out in one order", () => {
    expect(remoteOf({ roles: ["write", "review"], repo: "shawnlu96/claudestra" }))
      .toEqual({ mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "shawnlu96/claudestra" });
    expect(remoteOf({ roles: ["write"], repo: "o/r" })).toMatchObject({ roles: ["write"], repo: "o/r" });
  });

  const bad: [string, unknown, string][] = [
    ["write without repo", { roles: ["review", "write"] }, "repo"],
    ["repo without write", { roles: ["review"], repo: "o/r" }, "repo"],
    ["repo not owner/name", { roles: ["write"], repo: "https://github.com/o/r" }, "repo"],
    ["build is not a role", { roles: ["build"] }, "roles"],
    ["duplicate role", { roles: ["review", "review"] }, "roles"],
    ["unknown localPriority", { localPriority: "high" }, "localPriority"],
  ];
  for (const [name, remote, what] of bad) {
    test(`fails closed: ${name}`, () => expect(() => remoteOf(remote)).toThrow(what));
  }
});

describe("remote.localPriority", () => {
  test("kept when given, absent otherwise (= balance)", () => {
    for (const x of ["first", "balance", "low", "off"]) expect(remoteOf({ localPriority: x })?.localPriority).toBe(x as never);
    expect(remoteOf({ mode: "balance" })).not.toHaveProperty("localPriority");
  });
});

describe("parseRemotePolicy (the pool CLI's rebuild)", () => {
  test("legacy mode spelling still reads as balance; errors name where they came from", () => {
    expect(parseRemotePolicy({ mode: "overflow", roles: ["review"], poolTimeoutMin: 5 })).toMatchObject({ mode: "balance", note: expect.stringContaining("旧写法") });
    expect(() => parseRemotePolicy({ mode: "x" }, "--remote")).toThrow("--remote.mode");
    expect(parseRemotePolicy({ mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, localPriority: "low", repo: "o/r", reviewFirst: ["a"] }))
      .toEqual({ mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, localPriority: "low", repo: "o/r", reviewFirst: ["a"] });
  });
});

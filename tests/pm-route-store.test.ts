import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmDigestStore, PM_DIGEST_LOG_MS } from "../src/lib/pm-digest-store.js";
import { withPmRouteRecord } from "../src/lib/pm-route-record.js";
import { pmDigestStats } from "../src/manager/pm-digest-cmds.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { testChildEnv } from "./test-env.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import type { PmRouteClass } from "../src/lib/pm-route-types.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store() {
  const dir = mkdtempSync(join(tmpdir(), "pm-route-store-")); dirs.push(dir);
  return new PmDigestStore(join(dir, "pm-digest.json"), join(dir, "pm-digest-mode.json"));
}
function route(s: PmDigestStore, id: string, kind: PmRouteClass, at = 1_000_000, project = "p") {
  withPmRouteRecord({ messageId: id, mode: "observe", tags: [{ route: kind, rule: `rule.${kind}`, reason: "synthetic fact" }] }, () => {
    s.record({ project, at, mode: "observe", send: "now", source: "scheduler", reason: "fixture" });
  });
}

// [验收线 4]
test("old and independent modes survive each other's writes and corrupt route modes fail to observe", () => {
  const s = store();
  expect(s.routeMode("p")).toBe("observe");
  s.setMode("p", "on");
  expect(s.routeMode("p")).toBe("observe");
  s.setRouteMode("p", "off"); s.setMode("p", "off");
  expect(s.routeMode("p")).toBe("off");
  s.setRouteMode("p", "on"); expect(s.mode("p")).toBe("off");
  const restart = new PmDigestStore(s.path, s.modePath);
  expect(restart.routeMode("p")).toBe("on");
  writeFileSync(s.modePath, "{bad");
  expect(s.routeMode("p")).toBe("observe");
  expect(() => s.setRouteMode("p", "on")).toThrow();
  expect(readFileSync(s.modePath, "utf8")).toBe("{bad");
});

// [验收线 5]
test("restart reads old records and queues unchanged and counts only current project/window once", () => {
  const s = store(), at = 1_000_000;
  const old = { project: "p", at, send: "digest", source: "scheduler", reason: "old", mode: "on" };
  const queued = { id: "old", project: "p", at, kind: "sync" as const, source: "worker", firstLine: "old progress", detail: ["old detail"] };
  writeFileSync(s.path, JSON.stringify({ queue: [queued], log: [old] }));
  for (const kind of ["auto", "digest", "judge", "owner"] as const) route(s, kind, kind, at);
  route(s, "auto", "auto", at); route(s, "auto", "auto", at, "other");
  expect(new PmDigestStore(s.path, s.modePath).queued("p")).toEqual([queued]);
  expect(pmDigestStats(s, "p", at).route).toEqual({ auto: 1, digest: 1, judge: 1, owner: 1,
    byRule: { "auto:rule.auto": 1, "digest:rule.digest": 1, "judge:rule.judge": 1, "owner:rule.owner": 1 } });
  expect(pmDigestStats(s, "other", at).route.auto).toBe(1);
  expect(pmDigestStats(s, "p", at + PM_DIGEST_LOG_MS).route.auto).toBe(0);
  route(s, "auto", "auto", at + PM_DIGEST_LOG_MS);
  expect(s.read().log).toHaveLength(1);
  expect(pmDigestStats(s, "p", at + PM_DIGEST_LOG_MS).route.auto).toBe(1);
});

// [验收线 5]
test("route annotation is scoped, a throw cannot leak it, and malformed labels refuse overwrite", () => {
  const s = store(), at = 1_000_000;
  expect(() => withPmRouteRecord({ messageId: "bad", mode: "on", tags: [] }, () => { throw new Error("abort"); })).toThrow("abort");
  s.record({ project: "p", at, mode: "observe", send: "now", source: "user", reason: "plain" });
  expect(s.read().log[0]!.route).toBeUndefined();
  const corrupt = JSON.stringify({ queue: [], log: [{ ...s.read().log[0], route: { messageId: "x", mode: "on", tags: [null] } }] });
  writeFileSync(s.path, corrupt);
  expect(() => route(s, "next", "auto")).toThrow();
  expect(readFileSync(s.path, "utf8")).toBe(corrupt);
});

async function cli(s: PmDigestStore, args: string[], channel?: string) {
  const dir = join(s.path, ".."), env = testChildEnv({ CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "run"), DISCORD_CHANNEL_ID: channel });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/manager.ts"), "ledger", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text(); await proc.exited;
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

// [验收线 5]
test("real manager entry has independent authorized switch and read-only route statistics", async () => {
  const s = store(), dir = join(s.path, "..");
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [], createdAt: "2026-01-01" }] }));
  const path = join(dir, "ledger.sqlite"); openLedger(path); closeLedger(path);
  expect(isWriteInvocation("ledger", ["pm-route-mode", "on", "--project", "p"])).toBe(true);
  s.setMode("p", "off");
  expect(await cli(s, ["pm-route-mode", "on", "--project", "p"])).toMatchObject({ ok: true, routeMode: "on" });
  expect(s.mode("p")).toBe("off");
  const before = readFileSync(s.modePath, "utf8");
  expect((await cli(s, ["pm-route-mode", "off", "--project", "p"], "unknown-channel")).ok).toBe(false);
  expect(readFileSync(s.modePath, "utf8")).toBe(before);
  route(s, "auto", "auto", Date.now());
  expect(await cli(s, ["pm-digest", "--project", "p"], "unknown-channel")).toMatchObject({ ok: true, routeMode: "on", route: { auto: 1 } });
}, 30_000);

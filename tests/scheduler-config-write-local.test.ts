/**
 * i28-Q1 `ledger scheduler-local`（lib/scheduler-config-write.ts setLocalSlots + manager/ledger-scheduler-remote-cmds.ts）：
 * 只改本机的 remote.localPriority / maxActiveWorkers，其余字节原样；同一把锁、整份校验、审计；PM / master / owner 才能改，
 * 调度助理与别的项目的 PM 拒；坏值、没这个项目、啥也没改都不碰文件。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { patchLocalSlots } from "../src/lib/scheduler-config-write.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { schedulerRemoteCmds } from "../src/manager/ledger-scheduler-remote-cmds.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const CFG = {
  enabled: true, pollMs: 6000, autoDispatch: true,
  projects: {
    a: { maxActiveWorkers: 10, requiredChecks: ["ci"], repoDir: "/r/a",
      remote: { mode: "balance", reviewFirst: ["Sekai"], roles: ["review", "write"], repo: "o/r", localPriority: "low" } },
    b: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/r/b" },
  },
};
const PM_A = "agent-pm-a";
const DISP = "agent-helper";
const std = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

let db: Database;
let path: string;
const deps = (actor: string): LedgerDeps => ({
  db, actor, projectIds: ["a", "b"], now: () => 9_000,
  loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {},
});
async function run(actor: string, ...args: string[]): Promise<Record<string, any>> {
  const spec = schedulerRemoteCmds(path)["scheduler-local"];
  const p = parseLedgerArgs(["scheduler-local", ...args], spec.valued, spec.bools);
  if ("error" in p) return { ok: false, code: "invalid", error: p.error };
  try { return await spec.run(new LedgerCli(deps(actor), p)); }
  catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
}
const file = () => ({ bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs });
const decisions = () => listEvents(db, {}).filter((e) => e.kind === "decision");

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "sched-local-")), "scheduler.json");
  writeFileSync(path, std(CFG));
  db = openLedger(tempLedgerPath("sched-local-db-"));
  const owner = { actor: "owner", now: 1 };
  setMeta(db, owner, { project: "a", key: "pms", value: [PM_A, DISP] });
  setMeta(db, owner, { project: "a", key: "team", value: { dispatcher: DISP, audit: true } });
});

describe("patchLocalSlots", () => {
  test("只改给的那个键：别的字段（reviewFirst / roles / repo / 别的项目）逐字不变", () => {
    const r = patchLocalSlots(std(CFG), "a", { localPriority: "first" });
    const want = structuredClone(CFG);
    want.projects.a.remote.localPriority = "first";
    expect(r).toMatchObject({ changed: true, from: { localPriority: "low" }, to: { localPriority: "first" } });
    expect(r.text).toBe(std(want));
    const n = patchLocalSlots(std(CFG), "a", { maxActiveWorkers: 6 });
    want.projects.a.remote.localPriority = "low";
    want.projects.a.maxActiveWorkers = 6;
    expect(n.text).toBe(std(want));
  });
  test("没有 remote 的项目：补一个只含 localPriority 的 remote，解析后其余仍是缺省", () => {
    const r = patchLocalSlots(std(CFG), "b", { localPriority: "off" });
    expect(JSON.parse(r.text).projects.b.remote).toEqual({ localPriority: "off" });
    expect(parseSchedulerConfig(JSON.parse(r.text)).projects.b!.remote).toMatchObject({ mode: "balance", roles: ["review"], localPriority: "off" });
  });
  test("值没变 = 原文不动；缺省 balance 算没变", () => {
    expect(patchLocalSlots(std(CFG), "a", { localPriority: "low", maxActiveWorkers: 10 })).toMatchObject({ changed: false, text: std(CFG) });
    expect(patchLocalSlots(std(CFG), "b", { localPriority: "balance" })).toMatchObject({ changed: false });
  });
  test("坏值 / 空 / 没这个项目都拒", () => {
    const code = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return (e as LedgerError).code; } };
    expect(code(() => patchLocalSlots(std(CFG), "a", {}))).toBe("invalid");
    expect(code(() => patchLocalSlots(std(CFG), "a", { localPriority: "high" as never }))).toBe("invalid");
    for (const n of [-1, 33, 1.5]) expect(code(() => patchLocalSlots(std(CFG), "a", { maxActiveWorkers: n }))).toBe("invalid");
    expect(code(() => patchLocalSlots(std(CFG), "zzz", { maxActiveWorkers: 1 }))).toBe("not_found");
  });
});

describe("ledger scheduler-local", () => {
  test("owner 改档位 + 上限：一条审计事件，from / to 只含改的键，文件按新值解析", async () => {
    const r = await run("owner", "a", "--priority", "first", "--max-workers", "4", "--reason", "网页分配表");
    expect(r).toMatchObject({ ok: true, project: "a", changed: true, from: { localPriority: "low", maxActiveWorkers: 10 }, to: { localPriority: "first", maxActiveWorkers: 4 } });
    expect(decisions().map((e) => [e.actor, e.data.op, e.text])).toEqual([["owner", "scheduler_local", "网页分配表"]]);
    expect(parseSchedulerConfig(JSON.parse(file().bytes)).projects.a).toMatchObject({ maxActiveWorkers: 4,
      remote: { localPriority: "first", reviewFirst: ["Sekai"], roles: ["review", "write"], repo: "o/r" } });
    expect(await run("owner", "a", "--priority", "first", "--reason", "再来")).toMatchObject({ ok: true, changed: false, event: null });
  });

  test("调度助理、别的项目的 PM 拒（forbidden），文件字节与时间都不变；PM / master 可以", async () => {
    const before = file();
    expect(await run(DISP, "a", "--priority", "off", "--reason", "r")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("agent-pm-b", "a", "--priority", "off", "--reason", "r")).toMatchObject({ ok: false, code: "forbidden" });
    expect(file()).toEqual(before);
    expect(await run(PM_A, "a", "--priority", "off", "--reason", "r")).toMatchObject({ ok: true, changed: true });
    expect(await run("master", "a", "--max-workers", "0", "--reason", "r")).toMatchObject({ ok: true, changed: true });
  });

  test("参数不对：没给要改的、档位不认、上限越界、缺 --reason、多余位置参数，都不碰文件", async () => {
    const before = file();
    for (const args of [["a", "--reason", "r"], ["a", "--priority", "high", "--reason", "r"], ["a", "--max-workers", "33", "--reason", "r"],
      ["a", "--max-workers", "-1", "--reason", "r"], ["a", "--priority", "first"], ["a", "b", "--priority", "first", "--reason", "r"]]) {
      expect([args, (await run("owner", ...args)).ok]).toEqual([args, false]);
    }
    expect(file()).toEqual(before);
  });

  test("调度服务身份被 runLedger 拒；这条命令算写命令", async () => {
    expect(await runLedger(["scheduler-local", "a", "--priority", "first", "--reason", "r"], deps("scheduler"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(isWriteInvocation("ledger", ["scheduler-local", "a", "--priority", "first", "--reason", "r"])).toBe(true);
  });
});

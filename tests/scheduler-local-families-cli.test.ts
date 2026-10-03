import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, listEvents } from "../src/lib/ledger-store.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { schedulerRemoteCmds } from "../src/manager/ledger-scheduler-remote-cmds.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";

const config = () => ({ enabled: true, projects: { a: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo" } } });

test("CLI families set, repeat, combined patch, clear, and invalid refuse under the audited writer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-families-"));
  const path = join(dir, "scheduler.json");
  writeFileSync(path, JSON.stringify(config()));
  const db = openLedger(join(dir, "ledger.db"));
  const spec = schedulerRemoteCmds(path)["scheduler-local"];
  const deps: LedgerDeps = { db, actor: "owner", projectIds: ["a"], now: () => 1000,
    loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} };
  const run = async (...args: string[]) => {
    const parsed = parseLedgerArgs(["scheduler-local", "a", ...args, "--reason", "test policy"], spec.valued, spec.bools);
    if ("error" in parsed) throw new Error(parsed.error);
    return spec.run(new LedgerCli(deps, parsed));
  };
  try {
    const first = await run("--families", "codex", "--priority", "balance");
    expect(first).toMatchObject({ changed: true, from: { localFamilies: null }, to: { localFamilies: ["codex"] } });
    expect(parseSchedulerConfig(JSON.parse(readFileSync(path, "utf8"))).projects.a.remote?.localFamilies).toEqual(["codex"]);
    expect(await run("--families", "codex")).toMatchObject({ changed: false, event: null });
    await run("--families", "codex,claude", "--author-runtime", "codex");
    expect(JSON.parse(readFileSync(path, "utf8")).projects.a.localAuthorRuntime).toBe("codex");
    expect(JSON.parse(readFileSync(path, "utf8")).projects.a.remote).not.toHaveProperty("localAuthorRuntime");
    expect(parseSchedulerConfig(JSON.parse(readFileSync(path, "utf8"))).projects.a.remote?.localAuthorRuntime).toBe("codex");
    await run("--families", "any");
    expect(JSON.parse(readFileSync(path, "utf8")).projects.a.remote).toEqual({ localPriority: "balance" });
    expect(await run("--families", "any")).toMatchObject({ changed: false });
    const before = readFileSync(path, "utf8");
    for (const family of ["pi", "", "codex,codex", "any,codex"]) {
      await expect(run("--families", family)).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    const events = listEvents(db, {}).filter((e) => e.kind === "decision");
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.data.op === "scheduler_local")).toBe(true);
  } finally { db.close(); }
});

test("config rejects invalid family restrictions and preserves omission", () => {
  expect(parseSchedulerConfig(config()).projects.a.remote).not.toHaveProperty("localFamilies");
  for (const raw of [[], ["pi"], ["codex", "codex"], "codex", null]) {
    const c = config();
    Object.assign(c.projects.a, { remote: { localFamilies: raw } });
    expect(() => parseSchedulerConfig(c)).toThrow("localFamilies");
  }
});

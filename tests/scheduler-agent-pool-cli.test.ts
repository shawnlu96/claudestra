import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger, closeLedger, listEvents } from "../src/lib/ledger-store.js";
import { schedulerRemoteCmds } from "../src/manager/ledger-scheduler-remote-cmds.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";

test("--agents writes the family pool atomically, audits once and leaves old settings available for rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap1-config-")), path = join(dir, "scheduler.json"), ledgerPath = join(dir, "ledger.sqlite");
  const db = openLedger(ledgerPath);
  writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { repoDir: dir, requiredChecks: ["ci"], maxActiveWorkers: 2,
    remote: { localPriority: "off", localFamilies: ["claude"] } } } }));
  const spec = schedulerRemoteCmds(path)["scheduler-local"]!;
  const run = (...args: string[]) => {
    const parsed = parseLedgerArgs(["scheduler-local", "p", ...args, "--reason", "set unified pool"], spec.valued, spec.bools);
    if ("error" in parsed) throw new Error(parsed.error);
    return spec.run(new LedgerCli({ db, actor: "owner", projectIds: ["p"], now: Date.now,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} }, parsed));
  };
  try {
    expect(await run("--agents", "claude=0,codex=5")).toMatchObject({ changed: true, to: { agents: { claude: 0, codex: 5 } } });
    expect(await run("--agents", "codex=5,claude=0")).toMatchObject({ changed: false });
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.projects.p).toMatchObject({ agents: { claude: 0, codex: 5 }, maxActiveWorkers: 2, remote: { localPriority: "off" } });
    expect(parseSchedulerConfig(raw).projects.p!.maxActiveWorkers).toBe(5);
    expect(listEvents(db, { project: "p" }).filter((e) => e.kind === "decision")).toHaveLength(1);
    const before = readFileSync(path, "utf8");
    await expect(run("--agents", "codex=5,claude=-1")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { closeLedger(ledgerPath); rmSync(dir, { recursive: true, force: true }); }
});

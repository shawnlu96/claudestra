/** Browser-shaped writes use the real scheduler-local command and read back from its locked config writer. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { borrowView, handleBorrowApi, setBorrowViewDepsForTest } from "../src/bridge/local-api/lend-peers-view.js";
import { LedgerError, openLedger } from "../src/lib/ledger-store.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { effectivePrincipal, type DeviceCredential } from "../src/lib/devices.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { schedulerRemoteCmds } from "../src/manager/ledger-scheduler-remote-cmds.js";
import { localAgentsBody, peerAgentSlots } from "@/features/borrow/borrow-model";
import { canSubmit, formDefaults, grantBody, switchClaudeGrantPeer } from "@/features/lend/lend-model";
import type { BorrowView } from "@/features/borrow/borrow-api";

const NOW = 10_000_000;
const createdAt = "2026-10-02T00:00:00Z";
const credential: DeviceCredential = { id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", createdAt,
  expiresAt: "2099-01-01T00:00:00Z", grant: { agents: ["*"], terminal: true, manage: true } };
const OWNER = effectivePrincipal({ credential, principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt, terminal: true } });
let db: Database;
let schedulerPath: string;
let calls: string[][];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "web-cap3-"));
  schedulerPath = join(dir, "scheduler.json");
  const lendPath = join(dir, "lend.json");
  db = openLedger(join(dir, "ledger.db"));
  calls = [];
  writeFileSync(schedulerPath, JSON.stringify({ enabled: true, projects: {
    p: { agents: { claude: 2, codex: 5 }, requiredChecks: ["ci"], repoDir: dir },
    legacy: { maxActiveWorkers: 3, requiredChecks: ["ci"], repoDir: dir },
  } }));
  writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: false, lend: [], borrow: [
    { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 },
  ] }));
  setBorrowViewDepsForTest({ db: () => db, schedulerPath, lendPath, now: () => NOW,
    localQuota: async () => ({ quota: {}, walled: false }),
    context: async () => ({ contacts: [{ name: "mate" }], projects: [{ id: "p", name: "P", dirs: [dir], createdAt }] }),
    run: async (args) => {
      calls.push(args);
      const spec = schedulerRemoteCmds(schedulerPath)["scheduler-local"];
      const parsed = parseLedgerArgs(args.slice(1), spec.valued, spec.bools);
      if ("error" in parsed) return { ok: false, error: parsed.error };
      try {
        return await spec.run(new LedgerCli({ db, actor: "owner", projectIds: ["p", "legacy"], now: () => NOW,
          loadRegistry: async () => ({ socket: "s", agents: {} }) as never, saveRegistry: async () => {} }, parsed));
      } catch (e) {
        if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message };
        throw e;
      }
    },
  });
});
afterEach(() => { setBorrowViewDepsForTest(); db.close(); });
const write = (project: string, body: unknown) => handleBorrowApi(new Request("http://local/api/v1/borrow/local/p", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), `/borrow/local/${project}`, OWNER);
const view = async () => await borrowView() as unknown as BorrowView;

describe("per-project agent counts", () => {
  test("Claude 0 / Codex 5 persists and survives a fresh view; unrelated project stays intact", async () => {
    const before = JSON.parse(readFileSync(schedulerPath, "utf8"));
    const p = (await view()).projects.find((p) => p.id === "p")!;
    expect((await write("p", localAgentsBody(p, "claude", 0)))?.status).toBe(200);
    expect(calls).toEqual([["ledger", "scheduler-local", "p", "--agents=claude=0,codex=5", "--reason=网页分配表"]]);
    const stored = JSON.parse(readFileSync(schedulerPath, "utf8"));
    expect(stored.projects.p.agents).toEqual({ claude: 0, codex: 5 });
    expect(stored.projects.legacy).toEqual(before.projects.legacy);
    expect((await view()).projects.find((p) => p.id === "p")!.agents).toEqual({ claude: 0, codex: 5 });
  });

  test("first edit of an unset pool creates explicit counts", async () => {
    const p = (await view()).projects.find((p) => p.id === "legacy")!;
    expect((await write("legacy", localAgentsBody(p, "codex", 5)))?.status).toBe(200);
    expect((await view()).projects.find((p) => p.id === "legacy")!.agents).toEqual({ claude: 0, codex: 5 });
  });

  test("invalid pools never run the manager", async () => {
    for (const agents of [{ claude: -1, codex: 5 }, { claude: 0, codex: 33 }, { claude: 0.5, codex: 5 },
      { claude: 0 }, { claude: "0", codex: 5 }, { claude: 0, codex: 5, extra: 1 }, null, []]) {
      expect((await write("p", { agents }))?.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("peer cells show hello total and busy even when paused, stale, and larger than the old maxOpen", async () => {
    recordHello(db, "mate", null, { v: 1, proto: 2, boot: "boot", seq: 1,
      slots: { claude: { total: 4, busy: 2 }, codex: { total: 5, busy: 3 } },
      paused: { reason: "claude_quota", until: NOW + 100_000 },
      grant: { roles: ["review", "write"], repos: ["o/r"], until: NOW + 3_600_000, ordersPerDay: 200, ordersLeftToday: 200 },
    }, NOW - 200_000);
    const p = (await view()).peers[0]!;
    expect(peerAgentSlots(p, "claude")).toEqual({ total: 4, busy: 2 });
    expect(peerAgentSlots(p, "codex")).toEqual({ total: 5, busy: 3 });
    expect(peerAgentSlots({ reported: null }, "claude")).toBeNull();
  });
});

test("grant counts reject fractions/overflow and preserve daily quota when editing slots", () => {
  const g = { peer: "mate", repos: ["o/r"], roles: ["review"], families: { claude: 2, codex: 4 }, ordersPerDay: 17,
    until: null, grantedAt: null, paused: null, problem: null };
  const f = formDefaults(7, [{ name: "mate" }], g);
  const start = switchClaudeGrantPeer(f, "mate", [g], 7);
  expect(grantBody({ ...start.form, claude: 0 }, 7, start.baseline)).toEqual({ peer: "mate", repos: ["o/r"], claude: 0, ordersPerDay: 17, until: "7d" });
  const other = { ...g, peer: "other", ordersPerDay: 42 };
  const switched = switchClaudeGrantPeer(f, "other", [g, other], 7);
  expect(grantBody(switched.form, 7, switched.baseline).ordersPerDay).toBe(42);
  for (const n of [-1, 1.5, 17, Infinity, NaN]) expect(canSubmit({ ...f, claude: n })).toBe(false);
  expect(canSubmit({ ...f, claude: 0, codex: 0 })).toBe(true);
});

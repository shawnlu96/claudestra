/**
 * Unified agent pool capacity parity (capacity-parity-C1): with a fresh v2 hello (8 codex + 5 claude) and a legacy
 * borrow.maxOpen smaller than the peer's total, the borrow GET, the work board and real placement must read the same free seats.
 * Temp-file ledger and temp lend.json / scheduler.json; no bridge, no peer, no production state.
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setBorrowViewDepsForTest, type PeerView } from "../src/bridge/local-api/lend-peers-view.js";
import { effectivePrincipal, type Grant as DeviceGrant } from "../src/lib/devices.js";
import { recordHello, unifiedPeerCapacity } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { workBoardSlots } from "../src/lib/ledger-work-board-slots.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { Grant, Slots } from "../src/lib/lend-wire-v2.js";
import type { Principal } from "../src/lib/principals.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { poolStartFacts } from "../src/lib/scheduler-agent-pool-start.js";
import { readSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { placeFor } from "../src/lib/scheduler-placement.js";

const at = "2026-10-01T00:00:00Z";
const OWNER = effectivePrincipal({
  principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true } as Principal,
  credential: { id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant: { agents: ["*"], terminal: true, manage: true } as DeviceGrant,
    createdAt: at, expiresAt: "2099-01-01T00:00:00Z" },
});
const NOW = 50_000_000;
const DAY = 86_400_000;
const dir = mkdtempSync(join(tmpdir(), "lend-capacity-parity-"));
const PROJECTS: ProjectDef[] = ["alpha", "beta", "old"].map((id) => ({ id, name: id, dirs: [dir], createdAt: at }));
const ENTRY: BorrowEntry = { peer: "mate", projects: ["alpha", "beta"], roles: ["review", "write"], maxOpen: 2 };
const GRANT: Grant = { until: NOW + DAY, roles: ["review", "write"], repos: ["a/b"], ordersPerDay: 50, ordersLeftToday: 50 };
const SLOTS: Slots = { codex: { total: 8, busy: 0 }, claude: { total: 5, busy: 0 } };

let db: Database;
let ledgerPath: string;
let lendPath: string;
let schedPath: string;
let seq = 0;

function hello(over: { grant?: Grant | null; slots?: Slots; paused?: { reason: string; until: number } | null; at?: number } = {}): void {
  recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b", seq: ++seq, grant: over.grant === undefined ? GRANT : over.grant,
    slots: over.slots ?? SLOTS, paused: over.paused ?? null }, over.at ?? NOW);
}
function writeConfig(borrow: BorrowEntry[] = [ENTRY]): void {
  writeFileSync(lendPath, JSON.stringify({ version: 1, enabled: false, lend: [], borrow }));
  writeFileSync(schedPath, JSON.stringify({ enabled: true, projects: {
    alpha: { agents: { claude: 2, codex: 2 }, requiredChecks: ["ci"], repoDir: dir, remote: { mode: "balance", repo: "a/b" } },
    beta: { agents: { claude: 1, codex: 1 }, requiredChecks: ["ci"], repoDir: dir, remote: { mode: "balance", repo: "a/b" } },
    old: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: dir, remote: { mode: "balance", roles: ["review", "write"], repo: "a/b" } },
  } }));
}
const remoteOf = (project: string): RemotePolicy => readSchedulerConfig(schedPath).projects[project]!.remote!;
function order(taskId: string, project: string, family: "codex" | "claude", status = "pooled", step = "write"): void {
  db.query(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,
    leaseMs,createdBy,createdAt,updatedAt) VALUES (?,?,?,'mate',?,?,1,0,'h','a/b','{}','','s',?,1000,'scheduler',?,?)`)
    .run(`lend:${taskId}`, taskId, project, family, step, status, NOW, NOW);
}
/** A claimed write order on a scheduler-run card: the board keeps its slot (ledger-work-board-slots.ts). */
function claimedWriter(taskId: string): void {
  order(taskId, "alpha", "codex", "claimed");
  db.query(`INSERT INTO tasks (id,project,title,kind,stage,createdAt,updatedAt) VALUES (?,'alpha',?,'code','build',0,0)`).run(taskId, taskId);
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev, createdAt, updatedAt)
    VALUES (?,'alpha','code',2,'auto','codex','PM',1,1,0,0)`).run(taskId);
}
const board = (project: string, borrow: BorrowEntry[] = [ENTRY], remote: RemotePolicy | undefined = remoteOf(project)) =>
  workBoardSlots(db, project, 0, borrow, remote, NOW);
/** Free seats the unified placement path really sees on the peer for this project, per family. */
const placementSlots = (project: string) => poolStartFacts(db, project, remoteOf(project), [ENTRY], NOW).peers.find((p) => p.peer === "mate")!.v2!.slots;
async function borrowPeer(): Promise<PeerView> {
  const r = await handleLocalApi(new Request("http://x/api/v1/borrow"), new URL("http://x/api/v1/borrow"), OWNER);
  return ((await r!.json()) as { peers: PeerView[] }).peers.find((p) => p.peer === "mate")!;
}

beforeEach(() => {
  const d = mkdtempSync(join(dir, "case-"));
  ledgerPath = join(d, "ledger.db");
  lendPath = join(d, "lend.json");
  schedPath = join(d, "scheduler.json");
  db = openLedger(ledgerPath);
  writeConfig();
  hello();
  setBorrowViewDepsForTest({ db: () => db, lendPath, schedulerPath: schedPath, now: () => NOW,
    context: async () => ({ contacts: [{ name: "mate" }], projects: PROJECTS }), run: async () => null,
    localQuota: async () => { throw new Error("not needed"); } });
});
afterEach(() => {
  setBorrowViewDepsForTest();
  closeLedger(ledgerPath);
});

describe("unified pool: one reading for borrow GET, work board and placement", () => {
  test("8 codex + 5 claude with legacy maxOpen 2: every reading is 13, not the old cap", async () => {
    expect(placementSlots("alpha")).toEqual({ codex: 8, claude: 5 });
    expect(board("alpha")).toBe(13);
    const peer = await borrowPeer();
    expect(peer.capacity?.slots).toEqual({ codex: 8, claude: 5 });
    expect(peer.capacity?.why).toBeNull();
    expect(peer.maxOpen).toBe(2); // the saved entry is untouched; no new number is invented
    expect(JSON.stringify(peer)).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });

  test("two projects sharing the peer: seats are counted once and real dispatch stops exactly at the reading", async () => {
    expect([board("alpha"), board("beta")]).toEqual([13, 13]);
    let placed = 0;
    for (let i = 0; i < 40; i++) {
      const project = i % 2 ? "beta" : "alpha";
      const f = { ...poolStartFacts(db, project, remoteOf(project), [ENTRY], NOW), pin: "peer:mate" };
      const p = placeFor(f, "write", "codex");
      if (p.kind !== "peer") {
        const other = project === "alpha" ? "beta" : "alpha";
        if (placeFor({ ...poolStartFacts(db, other, remoteOf(other), [ENTRY], NOW), pin: "peer:mate" }, "write", "codex").kind !== "peer") break;
        continue;
      }
      order(`t${i}`, project, p.family);
      placed++;
      expect([board("alpha"), board("beta")]).toEqual([13 - placed, 13 - placed]);
    }
    expect(placed).toBe(13);
    expect((await borrowPeer()).capacity?.slots).toEqual({ codex: 0, claude: 0 });
  });

  test("own claimed writers keep their slot; the peer's other busy seats still count against free", () => {
    claimedWriter("w1");
    hello({ slots: { codex: { total: 8, busy: 3 }, claude: { total: 5, busy: 0 } } });
    expect(unifiedPeerCapacity(db, "mate", NOW).slots).toEqual({ codex: 5, claude: 5 });
    expect(board("alpha")).toBe(1 + 10);
    expect(board("beta")).toBe(10);
  });
});

describe("gates are kept", () => {
  const zero = async (why: RegExp | null = null) => {
    expect(board("alpha")).toBe(0);
    expect(placementSlots("alpha")).toEqual({ codex: 0, claude: 0 });
    const c = (await borrowPeer()).capacity!;
    expect(c.slots).toEqual({ codex: 0, claude: 0 });
    if (why) expect(c.why).toMatch(why);
  };
  test("stale hello", async () => { hello({ at: NOW - DAY }); await zero(/hello/); });
  test("grant revoked", async () => { hello({ grant: null }); await zero(/授权/); });
  test("grant expired", async () => { hello({ grant: { ...GRANT, until: NOW - 1 } }); await zero(/到期/); });
  test("daily orders used up", async () => { hello({ grant: { ...GRANT, ordersLeftToday: 0 } }); await zero(/单数/); });
  test("peer paused", async () => { hello({ paused: { reason: "maintenance", until: NOW + 1000 } }); await zero(); });
  test("one family paused stops only that family", async () => {
    hello({ paused: { reason: "codex_quota", until: NOW + 1000 } });
    expect(placementSlots("alpha")).toEqual({ codex: 0, claude: 5 });
    expect(board("alpha")).toBe(5);
    expect((await borrowPeer()).capacity?.slots).toEqual({ codex: 0, claude: 5 });
  });
  test("repo or write role not granted, priority off, remote off: no free writing seats on the board", () => {
    hello({ grant: { ...GRANT, repos: ["x/y"] } });
    expect(board("alpha")).toBe(0);
    hello({ grant: { ...GRANT, roles: ["review"] } });
    expect(board("alpha")).toBe(0);
    hello();
    expect(board("alpha", [{ ...ENTRY, priority: "off" }])).toBe(0);
    expect(board("alpha", [ENTRY], { ...remoteOf("alpha"), mode: "off" })).toBe(0);
  });
  test("claimed writers remain counted even when new borrowing is off", () => {
    claimedWriter("w1");
    hello({ grant: null });
    expect(board("alpha")).toBe(1);
  });
});

describe("legacy projects keep the maxOpen cap", () => {
  test("a project without agents still reads min(maxOpen − open, free)", async () => {
    const legacy = { ...ENTRY, projects: ["old"] };
    expect(board("old", [legacy])).toBe(2);
    writeConfig([legacy]);
    expect((await borrowPeer()).capacity?.slots).toEqual({ codex: 2, claude: 2 });
  });
  test("an entry mixing unified and legacy projects keeps the legacy figure in the borrow GET (still bounds the legacy one)", async () => {
    writeConfig([{ ...ENTRY, projects: ["alpha", "old"] }]);
    expect((await borrowPeer()).capacity?.slots).toEqual({ codex: 2, claude: 2 });
    expect(board("alpha", [{ ...ENTRY, projects: ["alpha", "old"] }])).toBe(13);
  });
});

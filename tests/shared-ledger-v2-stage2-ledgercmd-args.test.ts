import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  SCHEDULER_V2_LEDGER_COMMANDS, schedulerV2LedgerCall, schedulerV2LedgerClaimFence, schedulerV2LedgerFlags,
} from "../src/lib/scheduler-v2-ledger-cmds-args.js";

const connections: Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });

function fixture() {
  const db = new Database(":memory:");
  connections.push(db);
  db.run("CREATE TABLE scheduler_intents (id TEXT PRIMARY KEY, taskId TEXT)");
  db.run("CREATE TABLE events (seq INTEGER PRIMARY KEY, target TEXT, kind TEXT, actor TEXT, data TEXT)");
  db.query("INSERT INTO scheduler_intents VALUES (?, ?)").run("intent-one", "task-one");
  return db;
}

describe("stage2 ledger command inventory and routing arguments", () => {
  test("every existing manager ledger call has an explicit classification", () => {
    // Include manager spreads, ledgerWrite arrays and recoveryWrite adapters so each new call needs a decision.
    const pattern = 'manager\\("ledger", "[a-z-]+"|\\["scheduler-[a-z-]+"|recoveryWrite\\([^,]+, "[a-z-]+"';
    const result = Bun.spawnSync(["grep", "-rhoE", pattern, "src/lib"], {
      cwd: resolve(import.meta.dir, ".."),
    });
    expect(result.exitCode).toBe(0);
    const commands = new Set(result.stdout.toString().matchAll(/(?:manager\("ledger", |\[|recoveryWrite\([^,]+, )"([a-z-]+)"/g)
      .map(match => match[1]));
    expect(commands.size).toBeGreaterThan(20);
    for (const command of ["scheduler-ui-ask", "scheduler-review-snapshot", "scheduler-model-outcome", "scheduler-model-inform",
      "scheduler-refusal-epoch", "scheduler-legacy-review-retire", "scheduler-review-hold", "scheduler-review-downgrade",
      "scheduler-manual-resume"]) expect(commands.has(command)).toBe(true);
    for (const command of commands) {
      expect(Object.hasOwn(SCHEDULER_V2_LEDGER_COMMANDS, command), command).toBe(true);
      expect(["central", "executor", "mixed", "unmapped"]).toContain(SCHEDULER_V2_LEDGER_COMMANDS[command].handling);
    }
  });

  test("task arguments are used directly", () => {
    const db = fixture();
    for (const command of ["scheduler-plan", "scheduler-retire", "verify", "scheduler-lock-yield", "future-command"]) {
      expect(schedulerV2LedgerCall(db, ["ledger", command, "task-one"])?.taskId).toBe("task-one");
    }
    expect(schedulerV2LedgerCall(db, ["ledger", "future-command", "task-one"])?.handling).toBe("unmapped");
  });

  test("intent commands resolve the owning card and preserve missing-intent passthrough", () => {
    const db = fixture();
    for (const command of ["scheduler-settle", "scheduler-stage", "scheduler-merge-begin", "scheduler-merge-step", "scheduler-pool"]) {
      const call = schedulerV2LedgerCall(db, ["ledger", command, "intent-one"]);
      expect(call?.taskId).toBe("task-one");
      expect(call?.intentId).toBe("intent-one");
      expect(schedulerV2LedgerCall(db, ["ledger", command, "task-one"])).toBeNull();
    }
  });

  test("session calls route by the bound intent, even when a supplied task argument disagrees", () => {
    const db = fixture();
    for (const command of ["scheduler-session-bind", "scheduler-session-retire"]) {
      expect(schedulerV2LedgerCall(db, ["ledger", command, "other-task", "--intent", "intent-one"])?.taskId).toBe("task-one");
      expect(schedulerV2LedgerCall(db, ["ledger", command, "task-one", "--intent", "missing"])).toBeNull();
      expect(schedulerV2LedgerCall(db, ["ledger", command, "task-one", "--intent", "--role", "author"])).toBeNull();
    }
  });

  test("non-ledger and incomplete calls pass through", () => {
    const db = fixture();
    for (const args of [[], ["list"], ["ledger", "scheduler-plan"], ["project", "verify", "task-one"]]) {
      expect(schedulerV2LedgerCall(db, args)).toBeNull();
    }
  });
});

describe("stage2 durable claim fence lookup", () => {
  const first = { serviceGeneration: 1, epoch: 1, bootId: "boot-one" }, later = { serviceGeneration: 1, epoch: 2, bootId: "boot-two" };
  function event(db: Database, seq: number, data: unknown, actor = "scheduler", target = "task-one") {
    db.query("INSERT INTO events VALUES (?, ?, 'scheduler', ?, ?)").run(seq, target, actor, JSON.stringify(data));
  }

  test("ensure uses its submitted event, excluding plans, other cards, actors and results", () => {
    const db = fixture(), id = "intent-one";
    event(db, 1, { op: "plan", id, fence: later });
    event(db, 2, { op: "settle", id, to: "submitted", fence: later }, "owner");
    event(db, 3, { op: "settle", id, to: "submitted", fence: later }, "scheduler", "other-task");
    event(db, 4, { op: "settle", id, to: "submitted", fence: first });
    event(db, 5, { op: "settle", id, to: "done", fence: later });
    expect(schedulerV2LedgerClaimFence(db, id)).toEqual(first);
  });

  test("retire uses its already-claimed plan event", () => {
    const db = fixture(), id = "intent-one";
    event(db, 1, { op: "plan", id, action: "retire", claimed: false, fence: later });
    event(db, 2, { op: "plan", id, action: "retire", claimed: true, fence: first });
    event(db, 3, { op: "settle", id, to: "submitted", fence: later });
    expect(schedulerV2LedgerClaimFence(db, id)).toEqual(first);
  });

  test("unclaimed and legacy claims return null without borrowing another event's fence", () => {
    const db = fixture(), id = "intent-one";
    expect(schedulerV2LedgerClaimFence(db, id)).toBeNull();
    expect(schedulerV2LedgerClaimFence(db, "missing")).toBeNull();
    event(db, 1, { op: "settle", id, to: "submitted" });
    event(db, 2, { op: "settle", id, to: "submitted", fence: later });
    expect(schedulerV2LedgerClaimFence(db, id)).toBeNull();
  });
});

describe("stage2 ledger flags", () => {
  test("reads strings, integers and explicit switches without interpreting their contents", () => {
    const parsed = schedulerV2LedgerFlags(["ledger", "scheduler-plan", "task-one", "--rev", "17", "--reason", "with spaces", "--dry-run"],
      ["rev", "reason"], ["dry-run"]);
    expect(parsed.integer("rev")).toBe(17);
    expect(parsed.need("reason")).toBe("with spaces");
    expect(parsed.switches.has("dry-run")).toBe(true);
    expect(() => parsed.need("absent")).toThrow();
  });

  test("rejects ambiguity before any writer is called", () => {
    for (const args of [["--rev"], ["--rev", "--reason", "why"], ["--rev", "1", "--rev", "2"], ["--bogus", "1"], ["extra"]]) {
      expect(() => schedulerV2LedgerFlags(["ledger", "scheduler-plan", "task-one", ...args], ["rev", "reason"])).toThrow();
    }
    for (const value of ["-1", "1.5", "Infinity", "1e2", "9007199254740992", " "]) {
      const parsed = schedulerV2LedgerFlags(["ledger", "scheduler-plan", "task-one", "--rev", value], ["rev"]);
      expect(() => parsed.integer("rev")).toThrow();
    }
  });
});

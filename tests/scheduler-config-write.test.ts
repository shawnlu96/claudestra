/**
 * i28-W5b scheduler.json remote.mode writer (lib/scheduler-config-write.ts): only one field changes, every refusal leaves the
 * file byte- and mtime-identical, the lock is never bypassed, each real switch leaves exactly one audit event, and the
 * scheduler's next read sees the new value. Temp dirs and a temp ledger only; production scheduler.json is never touched.
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { patchRemoteMode, setRemoteMode } from "../src/lib/scheduler-config-write.js";
import { peerRefusal, placeFor, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const PM = "agent-pm";
/** Every field the parser knows plus unknown ones, two projects (a with a full remote, b without). */
const FULL = {
  enabled: true, pollMs: 7000, autoDispatch: true, supervise: { enabled: true, stuckMin: 30 }, futureTop: { x: [1, 2] },
  projects: {
    a: { maxActiveWorkers: 3, requiredChecks: ["ci"], repoDir: "/r/a", supervise: false,
      remote: { mode: "balance", roles: ["review"], poolTimeoutMin: 20, futureRemote: "keep" },
      deploy: { restartLabels: ["test.label"], timeoutMs: 120000 }, futureProject: true },
    b: { maxActiveWorkers: 1, requiredChecks: ["ci", "lint"], repoDir: "/r/b" },
  },
};
const std = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const clone = <T>(o: T): T => structuredClone(o);
const withMode = (mode: unknown, project = "a") => { const o = clone(FULL) as any; o.projects[project].remote = { ...o.projects[project].remote, mode }; return o; };
const err = (fn: () => unknown): { code: string; message: string } => {
  try { fn(); } catch (e) { return { code: e instanceof LedgerError ? e.code : "plain", message: (e as Error).message }; }
  throw new Error("expected a refusal");
};

describe("patchRemoteMode", () => {
  test("has remote: only remote.mode changes, key order kept, one line of diff", () => {
    const raw = std(FULL);
    const r = patchRemoteMode(raw, "a", "off");
    expect(r).toMatchObject({ from: "balance", to: "off", changed: true, pollMs: 7000 });
    const after = JSON.parse(r.text);
    expect(after).toEqual(withMode("off"));
    expect(JSON.stringify(after)).toBe(JSON.stringify(withMode("off"))); // same key order
    const a = raw.split("\n"), b = r.text.split("\n");
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual(['        "mode": "balance",']);
    expect(patchRemoteMode(r.text, "a", "balance").text).toBe(raw); // and back
  });

  test("no remote: balance is a no-op, off appends just the remote block at the end", () => {
    const raw = std(FULL);
    expect(patchRemoteMode(raw, "b", "balance")).toMatchObject({ text: raw, from: null, changed: false });
    const r = patchRemoteMode(raw, "b", "off");
    expect(r).toMatchObject({ from: null, to: "off", changed: true });
    expect(Object.keys(JSON.parse(r.text).projects.b).at(-1)).toBe("remote");
    expect(r.text.replace(',\n      "remote": {\n        "mode": "off"\n      }', "")).toBe(raw);
  });

  test("same value → unchanged; legacy overflow / prefer → balance is a change; remote without mode counts as balance", () => {
    expect(patchRemoteMode(std(FULL), "a", "balance")).toMatchObject({ changed: false, from: "balance" });
    expect(patchRemoteMode(std(withMode("off")), "a", "off")).toMatchObject({ changed: false, from: "off" });
    for (const legacy of ["overflow", "prefer"]) {
      const r = patchRemoteMode(std(withMode(legacy)), "a", "balance");
      expect(r).toMatchObject({ changed: true, from: legacy, to: "balance" });
      expect(JSON.parse(r.text)).toEqual(withMode("balance"));
    }
    const noMode = clone(FULL) as any;
    delete noMode.projects.a.remote.mode;
    expect(patchRemoteMode(std(noMode), "a", "balance")).toMatchObject({ changed: false, from: null });
    expect(JSON.parse(patchRemoteMode(std(noMode), "a", "off").text).projects.a.remote).toEqual({ ...FULL.projects.a.remote, mode: "off" });
  });

  test.each([
    ["4 spaces, newline", (o: unknown) => JSON.stringify(o, null, 4) + "\n"],
    ["tab, no newline", (o: unknown) => JSON.stringify(o, null, "\t")],
    ["2 spaces, no newline", (o: unknown) => JSON.stringify(o, null, 2)],
  ])("formatting kept: %s", (_, fmt) => {
    expect(patchRemoteMode(fmt(FULL), "a", "off").text).toBe(fmt(withMode("off")));
  });

  test("one-line file gets 2-space indentation", () => {
    expect(patchRemoteMode(JSON.stringify(FULL), "a", "off").text).toBe(JSON.stringify(withMode("off"), null, 2));
  });

  test("refusals produce no text", () => {
    const raw = std(FULL);
    expect(err(() => patchRemoteMode(raw, "zzz", "off")).code).toBe("not_found");
    expect(err(() => patchRemoteMode(raw, "toString", "off")).code).toBe("not_found");
    expect(err(() => patchRemoteMode("{ nope", "a", "off")).code).toBe("invalid");
    expect(err(() => patchRemoteMode("[1]", "a", "off")).code).toBe("invalid");
    expect(err(() => patchRemoteMode(raw, "a", "overflow" as any)).code).toBe("invalid");
    const strRemote = clone(FULL) as any;
    strRemote.projects.a.remote = "off";
    expect(err(() => patchRemoteMode(std(strRemote), "a", "off")).code).toBe("invalid");
    const broken = clone(FULL) as any; // another project already invalid → the whole write is refused
    delete broken.projects.b.repoDir;
    const e = err(() => patchRemoteMode(std(broken), "a", "off"));
    expect(e.code).toBe("invalid");
    expect(e.message).toContain("scheduler project b needs absolute repoDir");
  });
});

let dir: string;
let path: string;
let db: Database;
const ctx = (actor = PM, dedupKey?: string) => ({ actor, now: 1_000, ...(dedupKey ? { dedupKey } : {}) });
const decisions = () => listEvents(db, { project: "a" }).filter((e) => e.kind === "decision");
const snap = () => ({ bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs, files: readdirSync(dir).sort(), events: listEvents(db, {}).length });
async function refused(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof LedgerError ? e.code : `plain: ${(e as Error).message}`; }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-write-"));
  path = join(dir, "scheduler.json");
  writeFileSync(path, std(FULL));
  db = openLedger(tempLedgerPath("sched-write-db-"));
  setMeta(db, { actor: "owner", now: 1 }, { project: "a", key: "pms", value: [PM] });
});

describe("setRemoteMode", () => {
  test("switch off and back: file, permissions and one decision event each", async () => {
    chmodSync(path, 0o640);
    const r = await setRemoteMode(db, ctx(), { project: "a", mode: "off", reason: "peer 不稳" }, { path });
    expect(r).toMatchObject({ project: "a", from: "balance", to: "off", changed: true, duplicate: false, pollMs: 7000 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(withMode("off"));
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["scheduler.json"]); // lock and tmp gone
    const [ev] = decisions();
    expect(ev).toMatchObject({ seq: r.event!, actor: PM, project: "a", target: "", text: "peer 不稳", data: { op: "scheduler_remote", from: "balance", to: "off" } });
    await setRemoteMode(db, ctx(), { project: "a", mode: "balance", reason: "好了" }, { path });
    expect(readFileSync(path, "utf8")).toBe(std(FULL));
    expect(decisions().map((e) => e.data)).toEqual([{ op: "scheduler_remote", from: "balance", to: "off" }, { op: "scheduler_remote", from: "off", to: "balance" }]);
  });

  test("already at target: no write, no event", async () => {
    const before = snap();
    const r = await setRemoteMode(db, ctx(), { project: "a", mode: "balance", reason: "确认" }, { path });
    expect(r).toMatchObject({ changed: false, event: null });
    expect(snap()).toEqual(before);
  });

  test("--dedup replay returns duplicate and does not write again, even after someone switched back", async () => {
    const first = await setRemoteMode(db, ctx(PM, "k1"), { project: "a", mode: "off", reason: "r" }, { path });
    await setRemoteMode(db, ctx(), { project: "a", mode: "balance", reason: "手动切回" }, { path });
    const before = snap();
    const again = await setRemoteMode(db, ctx(PM, "k1"), { project: "a", mode: "off", reason: "r" }, { path });
    expect(again).toMatchObject({ duplicate: true, changed: false, event: first.event, from: "balance", to: "off" });
    expect(snap()).toEqual(before);
    setMeta(db, { actor: "owner", now: 2, dedupKey: "k2" }, { project: "a", key: "docsDir", value: "/d" });
    expect(await refused(setRemoteMode(db, ctx(PM, "k2"), { project: "a", mode: "off", reason: "r" }, { path }))).toBe("dedup_mismatch");
    expect(snap().bytes).toBe(before.bytes);
  });

  test("refusals leave bytes, mtime, directory and ledger unchanged", async () => {
    const cases: [string, () => void, { project?: string; mode?: string; reason?: string; actor?: string }, string][] = [
      ["overflow", () => {}, { mode: "overflow" }, "invalid"],
      ["prefer", () => {}, { mode: "prefer" }, "invalid"],
      ["OFF", () => {}, { mode: "OFF" }, "invalid"],
      ["empty mode", () => {}, { mode: "" }, "invalid"],
      ["empty reason", () => {}, { reason: " " }, "invalid"],
      ["unknown project", () => {}, { project: "zzz", actor: "owner" }, "not_found"],
      ["bad JSON", () => writeFileSync(path, "{ nope"), {}, "invalid"],
      ["other project invalid", () => { const o = clone(FULL) as any; delete o.projects.b.repoDir; writeFileSync(path, std(o)); }, {}, "invalid"],
      ["executor", () => {}, { actor: "agent-task-x" }, "forbidden"],
    ];
    for (const [name, prep, over, code] of cases) {
      prep();
      const before = snap();
      const got = await refused(setRemoteMode(db, ctx(over.actor), { project: over.project ?? "a", mode: over.mode ?? "off", reason: over.reason ?? "r" }, { path }));
      expect([name, got]).toEqual([name, code]);
      expect([name, snap()]).toEqual([name, before]);
      writeFileSync(path, std(FULL));
    }
  });

  test("missing scheduler.json → not_found, nothing created", async () => {
    const gone = join(dir, "nested", "scheduler.json");
    expect(await refused(setRemoteMode(db, ctx(), { project: "a", mode: "off", reason: "r" }, { path: gone }))).toBe("not_found");
    expect(existsSync(join(dir, "nested"))).toBe(false);
    const flat = join(dir, "missing.json");
    expect(await refused(setRemoteMode(db, ctx(), { project: "a", mode: "off", reason: "r" }, { path: flat }))).toBe("not_found");
    expect(readdirSync(dir)).toEqual(["scheduler.json"]);
    expect(listEvents(db, {}).filter((e) => e.kind === "decision")).toEqual([]);
  });

  test("two concurrent writers on different projects both land", async () => {
    setMeta(db, { actor: "owner", now: 1 }, { project: "b", key: "pms", value: [PM] });
    await Promise.all([
      setRemoteMode(db, ctx(), { project: "a", mode: "off", reason: "a" }, { path }),
      setRemoteMode(db, ctx(), { project: "b", mode: "off", reason: "b" }, { path }),
    ]);
    const cfg = readSchedulerConfig(path);
    expect([cfg.projects.a.remote?.mode, cfg.projects.b.remote?.mode]).toEqual(["off", "off"]);
  });

  test("lock held elsewhere → busy, file unchanged", async () => {
    const held = await acquireLock(`${path}.lock`, 1000);
    try {
      const before = snap();
      expect(await refused(setRemoteMode(db, ctx(), { project: "a", mode: "off", reason: "r" }, { path, lockMs: 300 }))).toBe("busy");
      expect(snap()).toEqual(before);
    } finally {
      held!.release();
    }
  });

  test("lock lost before commit (commitIf fails) → busy, nothing written", async () => {
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    // The dedup lookup runs inside the lock right before the write: steal the lock there.
    const thief = new Proxy(db, { get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k !== "prepare") return typeof v === "function" ? v.bind(t) : v;
      return (sql: string) => { if (sql.includes("dedupKey = ?")) writeFileSync(join(`${path}.lock`, "owner"), "someone-else"); return t.prepare(sql); };
    } }) as Database;
    expect(await refused(setRemoteMode(thief, ctx(PM, "steal"), { project: "a", mode: "off", reason: "r" }, { path }))).toBe("busy");
    expect([readFileSync(path, "utf8"), statSync(path).mtimeMs]).toEqual([before, mtime]);
    expect(decisions()).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("audit event fails → original bytes restored, error surfaces", async () => {
    chmodSync(path, 0o600);
    db.run("CREATE TRIGGER no_decision BEFORE INSERT ON events WHEN NEW.kind = 'decision' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const got = await refused(setRemoteMode(db, ctx(), { project: "a", mode: "off", reason: "r" }, { path }));
    expect(got).toContain("boom");
    expect(readFileSync(path, "utf8")).toBe(std(FULL));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["scheduler.json"]);
  });

  test("next pass sees it: readSchedulerConfig, placeFor / peerRefusal say local only, legacy note gone", async () => {
    await setRemoteMode(db, ctx(), { project: "a", mode: "off", reason: "r" }, { path });
    const remote = readSchedulerConfig(path).projects.a.remote!;
    expect(remote).toEqual({ mode: "off", roles: ["review"], poolTimeoutMin: 20 });
    const peer = { peer: "p1", roles: ["review"] as const, open: 0, v2: { why: null, slots: { codex: 2, claude: 2 }, roles: ["review"] as const, repos: ["o/r"] } };
    const f: PlacementFacts = { remote, peers: [peer], repo: "o/r", local: { running: 5, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true };
    expect(placeFor(f, "review", "codex")).toEqual({ kind: "local", reason: "scheduler.json remote.mode = off，只用本机" });
    expect(peerRefusal(f, peer, "review", "codex")).toBe("scheduler.json remote.mode = off");

    writeFileSync(path, std(withMode("overflow")));
    expect(readSchedulerConfig(path).projects.a.remote?.note).toContain("旧写法");
    const r = await setRemoteMode(db, ctx(), { project: "a", mode: "balance", reason: "规整" }, { path });
    expect(r).toMatchObject({ changed: true, from: "overflow", to: "balance" });
    expect(readSchedulerConfig(path).projects.a.remote?.note).toBeUndefined();
  });
});

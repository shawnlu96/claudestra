import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lendCheckPermit as permit, type LendCheckConfig, type LendCheckInput, type LendCheckResult } from "../src/lib/lend-check-permit.ts";
import { observeLendCheckProcess } from "../src/lib/lend-check-observation.ts";
import { testChildEnv } from "./test-env.ts";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
let nextWorker = 0;
const config: LendCheckConfig = { mode: "on", ownerApproval: { maxConcurrentFullChecks: 1, approvedBy: "fixture-owner", reference: "test-only" } };
// Fixtures own no check descendants unless explicitly created below; their host approval record is synthetic.
const authority = (approval: NonNullable<LendCheckConfig["ownerApproval"]>) =>
  approval.approvedBy === "fixture-owner" && approval.reference === "test-only" && [1, 2].includes(approval.maxConcurrentFullChecks);
const fixtureDeps = { verifyOwnerApproval: authority, observeCheckTree: () => "absent" as const };
const lendCheckPermit = (value: LendCheckInput, probe = observeLendCheckProcess) => permit(value, probe, fixtureDeps);
function root() { const dir = mkdtempSync(join(tmpdir(), "check-permit-")); roots.push(dir); return dir; }
function request(id: string, cost: "full" | "focused" = "full") { return { id, orderId: "order-a", workerId: "worker-a", cost }; }
function input(directory: string, id: string, action: LendCheckInput["action"] = "acquire"): LendCheckInput {
  return { directory, request: request(id), action, config };
}
function database(dir: string) { return join(dir, "lend-check-permit.sqlite"); }
function state(dir: string) {
  const db = new Database(database(dir));
  try {
    const body = JSON.parse((db.query("SELECT body FROM check_permit").get() as { body: string }).body);
    const closed = db.query("SELECT body FROM check_permit_closed ORDER BY rowid").all() as { body: string }[];
    body.entries = [...closed.map((row) => JSON.parse(row.body)), ...body.entries];
    return body;
  }
  finally { db.close(); }
}
function alter(dir: string, mutate: (body: ReturnType<typeof state>) => void) {
  const db = new Database(database(dir));
  try {
    const body = JSON.parse((db.query("SELECT body FROM check_permit").get() as { body: string }).body);
    mutate(body);
    db.query("UPDATE check_permit SET body=?").run(JSON.stringify(body));
  }
  finally { db.close(); }
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill(); // Only subprocesses created by this fixture, never peer/production processes.
    await child.exited;
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function worker(dir: string, treeObserver = true) {
  const script = `
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { lendCheckPermit } from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/lend-check-permit.ts"))};
import { observeLendCheckProcess } from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/lend-check-observation.ts"))};
console.log(JSON.stringify({pid: process.pid}));
let held;
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.exit) process.exit(0);
  if (message.tree) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e",
      'import {existsSync} from "node:fs"; setInterval(() => { if (existsSync(process.argv[1])) process.exit(0); }, 10);', message.tree],
      { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    console.log(JSON.stringify({pid:child.pid})); continue;
  }
  if (message.lock) {
    held = new Database(message.lock); held.exec("BEGIN IMMEDIATE");
    held.query("UPDATE check_permit SET body=?").run("uncommitted-corruption");
    console.log(JSON.stringify({locked:true})); continue;
  }
  const probe = pid => message.unknown === pid ? {kind:"unknown",reason:"fixture read failure"} : observeLendCheckProcess(pid);
  const deps = { verifyOwnerApproval: ${authority.toString()},
    ...(${treeObserver} ? { observeCheckTree: () => "absent" } : {}) };
  console.log(JSON.stringify(lendCheckPermit(message.input, probe, deps)));
}`;
  const home = join(dir, `child-${nextWorker++}`);
  for (const sub of ["home", "state", "runtime", "tmp"]) mkdirSync(join(home, sub), { recursive: true });
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--eval", script], {
    cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: testChildEnv({ HOME: join(home, "home"), TMPDIR: join(home, "tmp"), CLAUDESTRA_STATE_DIR: join(home, "state"),
      CLAUDESTRA_RUNTIME_DIR: join(home, "runtime"), TMUX: undefined, CODEX_HOME: join(home, "home", "codex") }),
  });
  children.push(proc);
  const reader = proc.stdout.getReader();
  let buffer = "";
  async function line() {
    while (!buffer.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`worker exited: ${await new Response(proc.stderr).text()}`);
      buffer += new TextDecoder().decode(chunk.value);
    }
    const at = buffer.indexOf("\n"), result = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1); return result;
  }
  const ready = await line();
  async function send(message: object) { proc.stdin.write(JSON.stringify(message) + "\n"); await proc.stdin.flush(); return line(); }
  return { proc, pid: ready.pid as number, send, call: (value: LendCheckInput, unknown?: number): Promise<LendCheckResult> => send({ input: value, unknown }) };
}

// Lock contention is a transport outcome, not a policy denial. Fixtures retry only SQLite busy, never queued/denied work.
async function uncontended(client: Awaited<ReturnType<typeof worker>>, value: LendCheckInput) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.call(value);
    if (!result.retryable) return result;
    expect(result.status).toBe("busy");
    await Bun.sleep(10);
  }
  throw new Error("fixture could not enter transaction");
}

test("default observe and unapproved on do not restrict; off/focused never touch disk", () => {
  const dir = root();
  for (const mode of [undefined, "on"] as const) {
    const result = lendCheckPermit({ ...input(dir, String(mode)), config: { mode } });
    expect(result).toMatchObject({ allowed: true, mode: "observe", status: "observed", wouldWait: false });
  }
  const untouched = join(dir, "untouched");
  expect(lendCheckPermit({ ...input(untouched, "off"), config: { mode: "off" } }).status).toBe("bypassed");
  expect(lendCheckPermit({ ...input(untouched, "focus"), request: request("focus", "focused") }).allowed).toBe(true);
  expect(existsSync(untouched)).toBe(false);
});

test("observe reports pressure but grants all; no approval means no inferred capacity", () => {
  const dir = root(), observing = { ...config, mode: "observe" as const };
  expect(lendCheckPermit({ ...input(dir, "a"), config: observing }).wouldWait).toBe(false);
  expect(lendCheckPermit({ ...input(dir, "b"), config: observing })).toMatchObject({ allowed: true, wouldWait: true });
  expect(state(dir).entries.filter((item: { status: string }) => item.status === "active")).toHaveLength(2);
});

test("invalid approval cannot turn observe/off into enforcement", () => {
  const dir = join(root(), "untouched");
  for (const mode of ["observe", "off"] as const) {
    const invalid = { mode, ownerApproval: { maxConcurrentFullChecks: 0, approvedBy: "", reference: "" } };
    expect(lendCheckPermit({ ...input(dir, mode), config: invalid }).allowed).toBe(true);
  }
  expect(existsSync(dir)).toBe(false);
  expect(lendCheckPermit({ ...input(dir, "bad"), request: request("") }).allowed).toBe(false);
});

test("FIFO reservations, idempotency, exact binding, cancellation and terminal IDs", () => {
  const dir = root();
  expect(lendCheckPermit(input(dir, "a")).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "a")).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "b"))).toMatchObject({ status: "queued", position: 1 });
  expect(lendCheckPermit(input(dir, "c"))).toMatchObject({ status: "queued", position: 2 });
  const before = state(dir);
  for (const override of [{ workerId: "other" }, { orderId: "other" }]) {
    expect(lendCheckPermit({ ...input(dir, "a", "release"), request: { ...request("a"), ...override } }).status).toBe("blocked");
  }
  expect(lendCheckPermit(input(dir, "a", "cancel")).status).toBe("blocked");
  expect(state(dir)).toEqual(before);
  expect(lendCheckPermit(input(dir, "a", "release")).status).toBe("released");
  expect(lendCheckPermit(input(dir, "c")).status).toBe("queued");
  expect(lendCheckPermit(input(dir, "b", "cancel")).status).toBe("cancelled");
  expect(lendCheckPermit(input(dir, "c")).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "a")).status).toBe("closed");
});

test("only approved capacity applies; live policy changes and invalid limits fail closed", () => {
  const dir = root();
  expect(lendCheckPermit(input(dir, "a")).allowed).toBe(true);
  const before = state(dir);
  for (const maxConcurrentFullChecks of [0, -1, 1.5, NaN, 2]) {
    const changed = { mode: "on" as const, ownerApproval: { ...config.ownerApproval!, maxConcurrentFullChecks } };
    expect(lendCheckPermit({ ...input(dir, "b"), config: changed }).allowed).toBe(false);
    expect(state(dir)).toEqual(before);
  }
});

test("unknown/throwing observations preserve active and queued entries, no TTL takeover", async () => {
  const dir = root(), a = await worker(dir), b = await worker(dir);
  expect((await a.call(input(dir, "a"))).allowed).toBe(true);
  expect((await b.call(input(dir, "b"), a.pid)).status).toBe("queued");
  const before = state(dir);
  expect(lendCheckPermit(input(dir, "c"), () => { throw new Error("unreadable"); }).allowed).toBe(false);
  expect(state(dir)).toEqual(before);
  expect((await b.call(input(dir, "a", "release"), a.pid)).status).toBe("blocked");
  expect(state(dir)).toEqual(before);
});

test("normal exit, crash and restart release only proven dead process incarnations", async () => {
  const dir = root(), a = await worker(dir), b = await worker(dir);
  expect((await a.call(input(dir, "a"))).allowed).toBe(true);
  expect((await b.call(input(dir, "b"))).status).toBe("queued");
  a.proc.stdin.write('{"exit":true}\n'); await a.proc.stdin.flush(); await a.proc.exited;
  expect((await b.call(input(dir, "b"))).status).toBe("granted");
  b.proc.kill("SIGKILL"); await b.proc.exited;
  const restarted = await worker(dir);
  expect((await restarted.call(input(dir, "c"))).status).toBe("granted");
  expect((await restarted.call(input(dir, "b", "release"))).status).toBe("blocked");
  expect(state(dir).entries.map((item: { status: string }) => item.status)).toEqual(["exited", "exited", "active"]);
});

test("PID reuse fixture compares OS start identity, never PID/name alone", async () => {
  const dir = root(), a = await worker(dir), b = await worker(dir);
  expect((await a.call(input(dir, "a"))).status).toBe("granted");
  // A real live PID with a recorded earlier birth models reuse without killing any unrelated process.
  alter(dir, (body) => { body.entries[0].owner.start = "previous-boot:previous-start"; });
  expect((await b.call(input(dir, "b"))).status).toBe("granted");
  expect((await a.call(input(dir, "a", "release"))).status).toBe("blocked");
  expect(state(dir).entries[1].status).toBe("active");
});

test("incarnation mismatch in the same OS process cannot release/reacquire a prior runtime's permit", () => {
  const dir = root(); lendCheckPermit(input(dir, "a"));
  alter(dir, (body) => { body.entries[0].owner.incarnation = "earlier-runtime"; });
  const before = state(dir);
  expect(lendCheckPermit(input(dir, "a", "release")).status).toBe("blocked");
  expect(lendCheckPermit(input(dir, "a")).status).toBe("blocked");
  expect(state(dir)).toEqual(before);
});

test("six real processes share canonical lock, capacity two, FIFO poll order and cancellation", async () => {
  const dir = root(), alias = join(root(), "alias"); symlinkSync(dir, alias);
  const clients = await Promise.all(Array.from({ length: 6 }, () => worker(dir)));
  const two = { ...config, ownerApproval: { ...config.ownerApproval!, maxConcurrentFullChecks: 2 } };
  const values = clients.map((_, i) => ({ ...input(i % 2 ? alias : dir, `race-${i}`), config: two }));
  const results = await Promise.all(clients.map((client, i) => uncontended(client, values[i]!)));
  expect(results.filter((result) => result.status === "granted")).toHaveLength(2);
  expect(results.filter((result) => result.status === "queued")).toHaveLength(4);
  const entries = state(dir).entries as Array<{ id: string; status: string }>;
  for (const entry of entries.filter((item) => item.status === "active")) {
    const i = Number(entry.id.split("-")[1]);
    expect((await clients[i]!.call({ ...values[i]!, action: "release" })).status).toBe("released");
  }
  const queued = entries.filter((item) => item.status === "waiting");
  const last = Number(queued[3]!.id.split("-")[1]);
  expect((await clients[last]!.call(values[last]!)).status).toBe("queued");
  const first = Number(queued[0]!.id.split("-")[1]);
  expect((await clients[first]!.call({ ...values[first]!, action: "cancel" })).status).toBe("cancelled");
  for (const entry of queued.slice(1, 3).reverse()) {
    const i = Number(entry.id.split("-")[1]);
    expect((await clients[i]!.call(values[i]!)).status).toBe("granted");
  }
  expect(state(dir).entries.filter((item: { status: string }) => item.status === "active")).toHaveLength(2);
}, 15000);

test("crash while writing rolls back; busy/failed preservation never grants or clears", async () => {
  const dir = root(), a = await worker(dir), b = await worker(dir);
  expect((await a.call(input(dir, "a"))).status).toBe("granted");
  const before = state(dir);
  expect(await b.send({ lock: database(dir) })).toEqual({ locked: true });
  expect(await a.call(input(dir, "a", "release"))).toMatchObject({ status: "busy", retryable: true, reasonCode: "store_busy" });
  b.proc.kill("SIGKILL"); await b.proc.exited;
  expect(state(dir)).toEqual(before);
  expect((await a.call(input(dir, "a"))).status).toBe("granted");
});

test("corrupt database and invalid state are preserved; observe errors still allow work", async () => {
  const dir = root(), a = await worker(dir);
  writeFileSync(database(dir), "not a database");
  expect((await a.call(input(dir, "a"))).allowed).toBe(false);
  expect(readFileSync(database(dir), "utf8")).toBe("not a database");
  expect(lendCheckPermit({ ...input(dir, "b"), config: {} })).toMatchObject({ allowed: true, status: "blocked", mode: "observe" });
  const valid = root(); lendCheckPermit(input(valid, "a"));
  alter(valid, (body) => { body.entries[0].owner.start = ""; });
  const before = readFileSync(database(valid));
  expect((await a.call(input(valid, "b"))).allowed).toBe(false);
  expect(readFileSync(database(valid))).toEqual(before);
});

test("unreadable store, sidecar obstruction and write failure preserve existing grants", async () => {
  const dir = root(), a = await worker(dir);
  expect((await a.call(input(dir, "a"))).allowed).toBe(true);
  const before = state(dir);
  mkdirSync(database(dir) + "-journal");
  expect((await a.call(input(dir, "a", "release"))).allowed).toBe(false);
  rmSync(database(dir) + "-journal", { recursive: true });
  expect(state(dir)).toEqual(before);
  chmodSync(database(dir), 0);
  try { expect((await a.call(input(dir, "b"))).status).toBe("blocked"); }
  finally { chmodSync(database(dir), 0o600); }
  chmodSync(dir, 0o500);
  try { expect((await a.call(input(dir, "a", "release"))).status).toBe("blocked"); }
  finally { chmodSync(dir, 0o700); }
  expect(state(dir)).toEqual(before);
});

test("own identity read failure cannot mint enforced permits", () => {
  const dir = root();
  expect(lendCheckPermit(input(dir, "a"), () => ({ kind: "unknown", reason: "test" })).allowed).toBe(false);
  expect(existsSync(database(dir))).toBe(false);
  expect(observeLendCheckProcess(process.pid).kind).toBe("present");
});


test("authority is mandatory; verified capacity changes apply after all entries close", () => {
  const dir = root();
  expect(permit(input(dir, "raw"))).toMatchObject({ allowed: false, reasonCode: "approval_unverified", retryable: false });
  expect(existsSync(database(dir))).toBe(false);
  const forged = { ...config, ownerApproval: { ...config.ownerApproval!, reference: "forged" } };
  expect(lendCheckPermit({ ...input(dir, "forged"), config: forged })).toMatchObject({ reasonCode: "approval_unverified", retryable: false });
  expect(lendCheckPermit(input(dir, "a")).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "a", "release")).status).toBe("released");
  const changed = { ...config, ownerApproval: { ...config.ownerApproval!, maxConcurrentFullChecks: 2 } };
  expect(lendCheckPermit({ ...input(dir, "b"), config: changed })).toMatchObject({ status: "granted", retryable: false });
  expect(state(dir).policy.max).toBe(2);
  expect(state(dir).entries[0].status).toBe("released");
});

test("observe/on drift is explicit, non-retryable and preserves the shared policy", () => {
  const dir = root();
  expect(lendCheckPermit({ ...input(dir, "observe"), config: {} }).allowed).toBe(true);
  const before = state(dir);
  expect(lendCheckPermit(input(dir, "on"))).toMatchObject({ allowed: false, status: "policy_conflict", reasonCode: "policy_conflict", retryable: false });
  expect(state(dir)).toEqual(before);
});

test("slow probes do not hold the write lock; concurrent new entries survive stale sampling", async () => {
  const dir = root(), a = await worker(dir);
  expect((await a.call(input(dir, "a"))).status).toBe("granted");
  let checked = false;
  const probe = (pid: number) => {
    if (pid === a.pid && !checked) {
      checked = true;
      const db = new Database(database(dir));
      try {
        db.exec("BEGIN IMMEDIATE");
        const body = JSON.parse((db.query("SELECT body FROM check_permit").get() as { body: string }).body);
        // Same ID changes incarnation during sampling; the obsolete absent result must not release the new owner.
        body.entries[0].owner.incarnation = "new-incarnation";
        db.query("UPDATE check_permit SET body=?").run(JSON.stringify(body));
        db.exec("COMMIT");
      } finally { db.close(); }
      return { kind: "absent" as const };
    }
    return observeLendCheckProcess(pid);
  };
  expect(lendCheckPermit(input(dir, "b"), probe).status).toBe("queued");
  expect(checked).toBe(true);
  expect(state(dir).entries[0].status).toBe("active");
});

test("terminal history is indexed separately; old IDs stay closed without growing the hot blob", () => {
  const dir = root();
  const self = observeLendCheckProcess(process.pid);
  const probe = () => self;
  for (let i = 0; i < 150; i++) {
    expect(lendCheckPermit(input(dir, `history-${i}`), probe).status).toBe("granted");
    expect(lendCheckPermit(input(dir, `history-${i}`, "release"), probe).status).toBe("released");
  }
  const db = new Database(database(dir));
  try {
    const body = (db.query("SELECT body FROM check_permit").get() as { body: string }).body;
    expect(JSON.parse(body).entries).toEqual([]);
    expect(body.length).toBeLessThan(300);
    expect(db.query("SELECT count(*) AS n FROM check_permit_closed").get()).toEqual({ n: 150 });
  } finally { db.close(); }
  expect(lendCheckPermit(input(dir, "history-0"), probe).status).toBe("closed");
  expect(lendCheckPermit(input(dir, " history-0 "), probe).status).toBe("closed");
  expect(lendCheckPermit(input(dir, "history-0", "release"), probe).status).toBe("closed");
  expect(lendCheckPermit({ ...input(dir, "history-0"), request: { ...request("history-0"), workerId: "other" } }, probe).status).toBe("blocked");
});

test("unknown tree evidence prevents release and reclaim, even with a dead executor", async () => {
  const dir = root(), a = await worker(dir);
  expect((await a.call(input(dir, "a"))).status).toBe("granted");
  a.proc.kill("SIGKILL"); await a.proc.exited;
  const deps = { verifyOwnerApproval: authority, observeCheckTree: () => "unknown" as const };
  expect(permit(input(dir, "b"), observeLendCheckProcess, deps).status).toBe("queued");
  expect(state(dir).entries[0].status).toBe("active");
  expect(lendCheckPermit(input(dir, "b")).status).toBe("granted");
  const before = state(dir);
  expect(permit(input(dir, "b", "release"), observeLendCheckProcess, deps)).toMatchObject({ reasonCode: "tree_unconfirmed", retryable: false });
  expect(state(dir)).toEqual(before);
});


test("SIGKILL of a real executor cannot free its slot while an orphan check descendant is alive", async () => {
  const dir = root(), a = await worker(dir), stop = join(dir, "stop-child");
  expect((await a.call(input(dir, "a"))).status).toBe("granted");
  const child = await a.send({ tree: stop });
  const tree = () => observeLendCheckProcess(child.pid).kind;
  const deps = { verifyOwnerApproval: authority, observeCheckTree: tree };
  try {
    expect(tree()).toBe("present");
    a.proc.kill("SIGKILL"); await a.proc.exited;
    expect(observeLendCheckProcess(a.pid).kind).toBe("absent");
    expect(tree()).toBe("present");
    expect(permit(input(dir, "b"), observeLendCheckProcess, deps).status).toBe("queued");
    expect(state(dir).entries[0].status).toBe("active");
  } finally {
    // Only the owned fixture's explicit stop file is touched; no process-name scans or host-wide signals.
    writeFileSync(stop, "stop");
    for (let attempt = 0; attempt < 200 && tree() !== "absent"; attempt++) await Bun.sleep(10);
  }
  expect(tree()).toBe("absent");
  expect(permit(input(dir, "b"), observeLendCheckProcess, deps).status).toBe("granted");
}, 10000);

test("legacy mutable Darwin identity is retained until explicit tree-confirmed exit", async () => {
  const dir = root(), a = await worker(dir);
  expect((await a.call(input(dir, "a"))).status).toBe("granted");
  alter(dir, (body) => { body.entries[0].owner.start = "darwin:{ sec = 123, usec = 0 }:Mon Oct 5 12:34:56 2026"; });
  expect(lendCheckPermit(input(dir, "b")).status).toBe("queued");
  expect(state(dir).entries[0].status).toBe("active");
  a.proc.kill("SIGKILL"); await a.proc.exited;
  expect(lendCheckPermit(input(dir, "b")).status).toBe("granted");
});

test("legacy terminal entries migrate atomically and cannot be reacquired", () => {
  const dir = root();
  expect(lendCheckPermit(input(dir, "legacy")).status).toBe("granted");
  alter(dir, (body) => { body.version = 1; body.entries[0].status = "released"; });
  expect(lendCheckPermit(input(dir, "legacy")).status).toBe("closed");
  const db = new Database(database(dir));
  try {
    expect(JSON.parse((db.query("SELECT body FROM check_permit").get() as { body: string }).body)).toMatchObject({ version: 2, entries: [] });
    expect(db.query("SELECT id FROM check_permit_closed").all()).toEqual([{ id: "legacy" }]);
  } finally { db.close(); }
});


test("conflicting legacy tombstones roll back instead of discarding corrupt state", () => {
  const dir = root();
  expect(lendCheckPermit(input(dir, "a")).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "a", "release")).status).toBe("released");
  const closed = state(dir).entries[0];
  alter(dir, (body) => { body.version = 1; body.entries.push({ ...closed, workerId: "conflicting-worker" }); });
  const before = readFileSync(database(dir));
  expect(lendCheckPermit(input(dir, "b"))).toMatchObject({ allowed: false, status: "blocked", retryable: false });
  expect(readFileSync(database(dir))).toEqual(before);
});


test("missing terminal table in a migrated store fails closed and is not recreated", () => {
  const dir = root();
  expect(lendCheckPermit(input(dir, "a")).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "a", "release")).status).toBe("released");
  const db = new Database(database(dir));
  try { db.exec("DROP TABLE check_permit_closed"); } finally { db.close(); }
  const before = readFileSync(database(dir));
  expect(lendCheckPermit(input(dir, "a"))).toMatchObject({ allowed: false, status: "blocked", retryable: false });
  expect(readFileSync(database(dir))).toEqual(before);
});


test("missing tree observer rejects enforcement before admission; default release closes diagnostic history", () => {
  const dir = root(), deps = { verifyOwnerApproval: authority };
  expect(permit(input(dir, "on"), observeLendCheckProcess, deps)).toMatchObject({
    allowed: false, status: "blocked", reasonCode: "tree_unconfirmed", retryable: false,
  });
  expect(existsSync(database(dir))).toBe(false);
  const self = observeLendCheckProcess(process.pid);
  let probes = 0;
  const probe = () => { probes++; return self; };
  for (let i = 0; i < 50; i++) {
    const value = { ...input(dir, `observe-${i}`), config: {} };
    expect(permit(value, probe).status).toBe("observed");
    expect(permit({ ...value, action: "release" }, probe).status).toBe("released");
  }
  probes = 0;
  expect(permit({ ...input(dir, "next"), config: {} }, probe).status).toBe("observed");
  expect(probes).toBe(1); // Closed diagnostic history is never sampled again.
  expect(state(dir).entries.filter((entry: { status: string }) => entry.status === "active")).toHaveLength(1);
});

test("observe terminal IDs diagnose without denying or reopening released, cancelled and exited attempts", () => {
  for (const status of ["released", "cancelled", "exited"] as const) {
    const dir = root(), value = { ...input(dir, status), config: {} };
    expect(permit(value).allowed).toBe(true);
    if (status === "released") expect(permit({ ...value, action: "release" }).status).toBe(status);
    else alter(dir, (body) => { body.entries[0].status = status; });
    expect(permit(value)).toMatchObject({ allowed: true, mode: "observe", status: "closed", retryable: false });
    expect(state(dir).entries[0].status).toBe(status);
    expect(permit({ ...value, action: "release" })).toMatchObject({ allowed: false, status: "closed" });
  }
});

test("observe release still preserves explicit unknown tree evidence and mismatched owners", () => {
  const dir = root(), value = { ...input(dir, "observe"), config: {} };
  expect(permit(value).allowed).toBe(true);
  const before = state(dir);
  expect(permit({ ...value, action: "release" }, observeLendCheckProcess, { observeCheckTree: () => "unknown" })).toMatchObject({
    status: "blocked", reasonCode: "tree_unconfirmed",
  });
  expect(permit({ ...value, action: "release", request: { ...value.request, workerId: "other" } }).status).toBe("blocked");
  expect(state(dir)).toEqual(before);
  expect(permit({ ...value, action: "release" }).status).toBe("released");
});

test("idle observe rollout to on is atomic across processes and preserves terminal IDs", async () => {
  const dir = root(), observer = await worker(dir, false);
  const value = { ...input(dir, "observation"), config: {} };
  expect((await observer.call(value)).status).toBe("observed");
  expect((await observer.call({ ...value, action: "release" })).status).toBe("released");
  const clients = await Promise.all([worker(dir), worker(dir)]);
  const results = await Promise.all(clients.map((client, i) => uncontended(client, input(dir, `on-${i}`))));
  expect(results.filter((result) => result.status === "granted")).toHaveLength(1);
  expect(results.filter((result) => result.status === "queued")).toHaveLength(1);
  expect(state(dir).policy.mode).toBe("on");
  expect(state(dir).entries[0].status).toBe("released");
  const before = state(dir);
  expect(await observer.call(value)).toMatchObject({ allowed: true, status: "policy_conflict", retryable: false });
  expect(state(dir)).toEqual(before);
});

test("idle approval renewal is host-verified; stale unapproved observers cannot downgrade the store", () => {
  const dir = root();
  expect(lendCheckPermit(input(dir, "a")).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "a", "release")).status).toBe("released");
  const before = state(dir), renewed = { ...config, ownerApproval: { ...config.ownerApproval!, reference: "renewed" } };
  expect(lendCheckPermit({ ...input(dir, "renew"), config: renewed }).reasonCode).toBe("approval_unverified");
  expect(permit({ ...input(dir, "stale"), config: {} })).toMatchObject({ allowed: true, status: "policy_conflict" });
  expect(state(dir)).toEqual(before);
  const deps = { ...fixtureDeps, verifyOwnerApproval: (approval: NonNullable<LendCheckConfig["ownerApproval"]>) =>
    approval.reference === "renewed" && authority({ ...approval, reference: "test-only" }) };
  expect(permit({ ...input(dir, "renew"), config: renewed }, observeLendCheckProcess, deps).status).toBe("granted");
  expect(state(dir).policy.approval).toContain("renewed");
  expect(state(dir).entries[0].status).toBe("released");
});

test("observe executor release clears pressure without a tree observer", () => {
  const dir = root(), deps = { verifyOwnerApproval: authority }, observing = { ...config, mode: "observe" as const };
  const value = (id: string, action: LendCheckInput["action"] = "acquire") => ({ ...input(dir, id, action), config: observing });
  expect(permit(value("a"), observeLendCheckProcess, deps).wouldWait).toBe(false);
  expect(permit(value("b"), observeLendCheckProcess, deps)).toMatchObject({ allowed: true, wouldWait: true });
  for (const id of ["a", "b"]) expect(permit(value(id, "release"), observeLendCheckProcess, deps).status).toBe("released");
  expect(permit(value("c"), observeLendCheckProcess, deps)).toMatchObject({ allowed: true, wouldWait: false });
});

test("failed policy migration preserves the idle policy and terminal history", () => {
  const dir = root(), value = { ...input(dir, "old"), config: {} };
  expect(permit(value).status).toBe("observed");
  expect(permit({ ...value, action: "release" }).status).toBe("released");
  const before = state(dir);
  chmodSync(dir, 0o500);
  try { expect(lendCheckPermit(input(dir, "new"))).toMatchObject({ allowed: false, status: "blocked" }); }
  finally { chmodSync(dir, 0o700); }
  expect(state(dir)).toEqual(before);
  expect(lendCheckPermit(input(dir, "new")).status).toBe("granted");
});

test("stale approved observers cannot downgrade an idle on store or obstruct later enforced admission", async () => {
  const dir = root(), enforcer = await worker(dir), observer = await worker(dir, false);
  expect((await enforcer.call(input(dir, "a"))).status).toBe("granted");
  expect((await enforcer.call(input(dir, "a", "release"))).status).toBe("released");
  const before = state(dir), observing = { ...config, mode: "observe" as const };
  for (const id of ["x", "y"]) {
    expect(await observer.call({ ...input(dir, id), config: observing })).toMatchObject({
      allowed: true, status: "policy_conflict", reasonCode: "policy_conflict", retryable: false,
    });
    expect(state(dir)).toEqual(before);
  }
  expect((await enforcer.call(input(dir, "b"))).status).toBe("granted");
  expect(lendCheckPermit(input(dir, "d")).status).toBe("queued");
  expect(state(dir).policy).toEqual(before.policy);
  expect(state(dir).entries.filter((entry: { status: string }) => entry.status === "active")).toHaveLength(1);
});

test("owner-assisted drain of an observe crash requires exact tree evidence before installing on", async () => {
  const dir = root(), observer = await worker(dir, false), stop = join(dir, "stop-child");
  expect((await observer.call({ ...input(dir, "old"), config: {} })).status).toBe("observed");
  const child = await observer.send({ tree: stop }), retained = state(dir).entries[0];
  const tree = () => observeLendCheckProcess(child.pid).kind;
  observer.proc.kill("SIGKILL"); await observer.proc.exited;
  const unknown = { verifyOwnerApproval: authority, observeCheckTree: () => "unknown" as const };
  const before = state(dir);
  try {
    expect(permit(input(dir, "blocked"), observeLendCheckProcess, unknown)).toMatchObject({
      allowed: false, reasonCode: "policy_conflict", retryable: false,
    });
    expect(state(dir)).toEqual(before);
    expect(tree()).toBe("present");
  } finally {
    writeFileSync(stop, "stop");
    for (let attempt = 0; attempt < 200 && tree() !== "absent"; attempt++) await Bun.sleep(10);
  }
  expect(tree()).toBe("absent");
  // This fixture owns the entire tree: the dead executor and its only descendant cannot spawn again.
  const certified = { verifyOwnerApproval: authority, observeCheckTree: (entry: typeof retained) =>
    JSON.stringify(entry) === JSON.stringify(retained) ? tree() : "unknown" as const };
  expect(permit(input(dir, "after-drain"), observeLendCheckProcess, certified).status).toBe("granted");
  expect(state(dir).policy.mode).toBe("on");
  expect(state(dir).entries[0]).toEqual({ ...retained, status: "exited" });
  expect(state(dir).entries.filter((entry: { status: string }) => entry.status === "active")).toHaveLength(1);
}, 10000);

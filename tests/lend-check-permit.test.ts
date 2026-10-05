import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lendCheckPermit, type LendCheckConfig, type LendCheckInput, type LendCheckResult } from "../src/lib/lend-check-permit.ts";
import { observeLendCheckProcess } from "../src/lib/lend-check-observation.ts";
import { testChildEnv } from "./test-env.ts";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
let nextWorker = 0;
const config: LendCheckConfig = { mode: "on", ownerApproval: { maxConcurrentFullChecks: 1, approvedBy: "fixture-owner", reference: "test-only" } };
function root() { const dir = mkdtempSync(join(tmpdir(), "check-permit-")); roots.push(dir); return dir; }
function request(id: string, cost: "full" | "focused" = "full") { return { id, orderId: "order-a", workerId: "worker-a", cost }; }
function input(directory: string, id: string, action: LendCheckInput["action"] = "acquire"): LendCheckInput {
  return { directory, request: request(id), action, config };
}
function database(dir: string) { return join(dir, "lend-check-permit.sqlite"); }
function state(dir: string) {
  const db = new Database(database(dir));
  try { return JSON.parse((db.query("SELECT body FROM check_permit").get() as { body: string }).body); }
  finally { db.close(); }
}
function alter(dir: string, mutate: (body: ReturnType<typeof state>) => void) {
  const body = state(dir); mutate(body);
  const db = new Database(database(dir));
  try { db.query("UPDATE check_permit SET body=?").run(JSON.stringify(body)); }
  finally { db.close(); }
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill(); // Only subprocesses created by this fixture, never peer/production processes.
    await child.exited;
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function worker(dir: string) {
  const script = `
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { lendCheckPermit } from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/lend-check-permit.ts"))};
import { observeLendCheckProcess } from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/lend-check-observation.ts"))};
console.log(JSON.stringify({pid: process.pid}));
let held;
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.exit) process.exit(0);
  if (message.lock) {
    held = new Database(message.lock); held.exec("BEGIN IMMEDIATE");
    held.query("UPDATE check_permit SET body=?").run("uncommitted-corruption");
    console.log(JSON.stringify({locked:true})); continue;
  }
  const probe = pid => message.unknown === pid ? {kind:"unknown",reason:"fixture read failure"} : observeLendCheckProcess(pid);
  console.log(JSON.stringify(lendCheckPermit(message.input, probe)));
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
    if (result.status !== "blocked" || !result.reason?.includes("locked")) return result;
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
  expect((await a.call(input(dir, "a", "release"))).status).toBe("blocked");
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

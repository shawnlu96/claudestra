/**
 * dispatch-recovery-SPECG1 across processes: two real `bun` processes write the same card on one temp-file ledger, the policy read
 * from a temp state dir's recovery-policy.json (the file-backed RecoveryPolicyPort, no injection). Synthetic inputs only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

const P = "proj-specg1";
const ROOT = join(import.meta.dir, "..");
const SECRET = "sk-" + "Q".repeat(12) + "z".repeat(12);

/** One process: setTask(T1, rev, spec) with the real policy file; prints ok / the error code, nothing else. */
const WRITER = `
const { openLedger, closeLedger } = await import(${JSON.stringify(join(ROOT, "src/lib/ledger-store.ts"))});
const { setTask } = await import(${JSON.stringify(join(ROOT, "src/lib/ledger-write.ts"))});
await import(${JSON.stringify(join(ROOT, "src/manager/ledger-write-cmds.ts"))}); // what a \`ledger\` CLI process loads: arms the preflight
const [path, spec, rev] = process.argv.slice(-3);
const db = openLedger(path);
await Bun.sleep(30);
try { setTask(db, { actor: "owner", now: 3000 }, { id: "T1", rev: Number(rev), patch: { spec } }); console.log("ok"); }
catch (e) { console.log(e.code ?? "error"); }
closeLedger(path);
`;

function setup(mode: "on" | "observe") {
  const dir = mkdtempSync(join(tmpdir(), "spec-preflight-procs-"));
  const state = join(dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "recovery-policy.json"), JSON.stringify({ projects: { [P]: { keys: { materials: mode } } } }));
  const path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  const clean = join(dir, "clean.md"), dirty = join(dir, "dirty.md"), start = join(dir, "start.md");
  writeFileSync(start, "规格：起点\n");
  writeFileSync(clean, "规格：只改 src/lib/x.ts\n");
  writeFileSync(dirty, `规格：配置 ${SECRET}\n`);
  setMeta(db, { actor: "owner", now: 1000 }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now: 2000 }, { project: P, id: "T1", title: "T1", kind: "code", spec: start, agent: "agent-dev" } as never);
  closeLedger(path);
  const env = { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "rt") };
  const spawn = (spec: string, rev = 1) => Bun.spawn(["bun", "-e", WRITER, path, spec, String(rev)], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { path, clean, dirty, start, spawn };
}

const out = async (p: ReturnType<ReturnType<typeof setup>["spawn"]>) => {
  await p.exited;
  return (await new Response(p.stdout).text()).trim().split("\n").at(-1);
};

describe("two processes, one card, real policy file", () => {
  test("on: the dirty write is refused and rolled back in its own process; the clean one wins the CAS", async () => {
    const s = setup("on");
    const [a, b] = [s.spawn(s.dirty), s.spawn(s.clean)];
    // Whichever commits first decides the dirty one's answer: refused (rolled back) before the clean write, CAS conflict after it.
    expect(["invalid", "conflict"]).toContain(String(await out(a)));
    expect(await out(b)).toBe("ok");
    expect(await out(s.spawn(s.dirty, 2))).toBe("invalid");
    const db = openLedger(s.path);
    expect(getTask(db, "T1")).toMatchObject({ spec: s.clean, rev: 2 });
    expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "task").length).toBe(2);
    expect(JSON.stringify(listEvents(db, { target: "T1" }))).not.toContain(SECRET);
    closeLedger(s.path);
  }, 60_000);

  test("observe: both race on rev 1, exactly one wins (CAS), the loser gets conflict; the would-block is recorded at most once", async () => {
    const s = setup("observe");
    const results = await Promise.all([s.spawn(s.dirty), s.spawn(s.dirty)].map(out));
    expect(results.sort()).toEqual(["conflict", "ok"]);
    const db = openLedger(s.path);
    expect(getTask(db, "T1")).toMatchObject({ spec: s.dirty, rev: 2 });
    const notes = listEvents(db, { target: "T1" }).filter((e) => e.kind === "note" && e.data.op === "recovery_observe");
    expect(notes.length).toBe(1);
    expect(JSON.stringify(notes)).not.toContain(SECRET);
    expect(db.query("SELECT COUNT(*) AS n FROM lend_orders").get()).toEqual({ n: 0 });
    closeLedger(s.path);
  }, 60_000);
});

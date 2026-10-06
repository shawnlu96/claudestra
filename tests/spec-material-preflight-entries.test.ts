/**
 * dispatch-recovery-SPECG1, who arms the writer's preflight: every process entry whose runtime import closure (the guard's own
 * import graph, scripts/guard/rules/deps.ts) reaches the ledger writer also loads the gate; bridge / launcher / scheduler arm it
 * with one literal import + one call, manager keeps its ledger-write-cmds path. In isolated `bun` processes on a temp ledger: a
 * writer-only process (the bridge ask-default shape without its entry) answers unavailable (unarmed) with a fixed log line, never
 * off and never a pass; armed the way the entries arm it, on refuses and observe records. Synthetic inputs only.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { collectEdges, type Edge } from "../scripts/guard/rules/deps.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { testChildEnv } from "./test-env.js";

const ROOT = resolve(import.meta.dir, "..");
const WRITER = "src/lib/ledger-write.ts";
const GATE = "src/lib/spec-material-preflight-gate.ts";
/** The executable entries CI builds (.github/workflows/ci.yml "Build entrypoints"). */
const ENTRIES = ["bridge", "channel-server", "manager", "launcher", "cron", "setup", "relay", "scheduler"];
const ARMING = ["bridge", "launcher", "scheduler"];
const P = "proj-specg1";
const SECRET = "sk-" + "Q".repeat(12) + "z".repeat(12);

function srcFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.set(relative(ROOT, p), readFileSync(p, "utf8"));
    }
  };
  walk(join(ROOT, "src"));
  return files;
}

function closure(edges: Edge[], entry: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) if (!e.typeOnly) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length) for (const n of out.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  return seen;
}

describe("entries: every process that can write the ledger arms the preflight", () => {
  const files = srcFiles();
  const edges = collectEdges(files);

  test("each entry whose closure reaches the writer also reaches the gate", () => {
    const writing = ENTRIES.filter((e) => closure(edges, `src/${e}.ts`).has(WRITER));
    expect(writing).toEqual(expect.arrayContaining([...ARMING, "manager"]));
    for (const e of writing) expect({ entry: e, gate: closure(edges, `src/${e}.ts`).has(GATE) }).toEqual({ entry: e, gate: true });
  });

  test("bridge / launcher / scheduler: one literal import + one top-level call; manager keeps its CLI path, no second arming", () => {
    for (const e of ARMING) {
      const src = files.get(`src/${e}.ts`)!;
      expect(src.match(/^import \{ armSpecPreflight \} from "\.\/lib\/spec-material-preflight-gate\.js";$/gm)?.length).toBe(1);
      expect(src.match(/^armSpecPreflight\(\);$/gm)?.length).toBe(1);
    }
    expect(files.get("src/manager.ts")).not.toContain("armSpecPreflight");
    expect(files.get("src/manager/ledger-write-cmds.ts")).toContain("armSpecPreflight");
  });
});

/** One process: createTask(T1, spec) on a temp ledger; `arm` loads the gate as the entries do. Prints one JSON line. */
const CHILD = (arm: boolean) => `
const { openLedger, closeLedger, getTask } = await import(${JSON.stringify(join(ROOT, "src/lib/ledger-store.ts"))});
const { createTask } = await import(${JSON.stringify(join(ROOT, "src/lib/ledger-write.ts"))});
const { runSpecPreflight } = await import(${JSON.stringify(join(ROOT, "src/lib/spec-material-preflight.ts"))});
${arm ? `const { armSpecPreflight } = await import(${JSON.stringify(join(ROOT, GATE))}); armSpecPreflight(); armSpecPreflight();` : ""}
const [path, spec] = process.argv.slice(-2);
const db = openLedger(path);
let code = "ok";
try { createTask(db, { actor: "owner", now: 3000 }, { project: ${JSON.stringify(P)}, id: "T1", title: "T1", kind: "code", spec, agent: "agent-dev" }); }
catch (e) { code = e.code ?? "error"; }
const row = getTask(db, "T1");
const hook = row ? runSpecPreflight(db, { actor: "owner", now: 4000 }, null, row) : null;
console.log(JSON.stringify({ code, stored: Boolean(row), hook: hook && { status: hook.status, reason: hook.reason } }));
closeLedger(path);
`;

async function child(mode: "on" | "observe", arm: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "spec-preflight-entries-"));
  const state = join(dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "recovery-policy.json"), JSON.stringify({ projects: { [P]: { keys: { materials: mode } } } }));
  const path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  setMeta(db, { actor: "owner", now: 1000 }, { project: P, key: "pms", value: ["agent-pm"] });
  closeLedger(path);
  const spec = join(dir, "dirty.md");
  writeFileSync(spec, `规格：配置 ${SECRET}\n`);
  const p = Bun.spawn(["bun", "-e", CHILD(arm), path, spec], {
    cwd: ROOT, env: testChildEnv({ CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "rt") }), stdout: "pipe", stderr: "pipe",
  });
  await p.exited;
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { r: JSON.parse(out.trim().split("\n").at(-1)!), err, path };
}

describe("isolated processes on a temp ledger", () => {
  test("writer only (never armed): unavailable (unarmed) with a fixed, content-free log line; not off, not a pass", async () => {
    const { r, err } = await child("on", false);
    expect(r).toEqual({ code: "ok", stored: true, hook: { status: "unavailable", reason: "unarmed" } });
    expect(err).toContain("本进程没装规格预检：预检不可用");
    expect(err).not.toContain(SECRET);
  }, 60_000);

  test("armed as the entries arm it (idempotent): on refuses and stores nothing; observe stores and records the would-block", async () => {
    const on = await child("on", true);
    expect(on.r).toMatchObject({ code: "invalid", stored: false });
    const obs = await child("observe", true);
    expect(obs.r).toMatchObject({ code: "ok", stored: true, hook: { status: "blocked" } });
    const db = openLedger(obs.path);
    expect(getTask(db, "T1")!.rev).toBe(1);
    const notes = listEvents(db, { target: "T1" }).filter((e) => e.kind === "note" && e.data.op === "recovery_observe");
    expect(notes.length).toBe(1);
    expect(JSON.stringify(listEvents(db, { target: "T1" }))).not.toContain(SECRET);
    closeLedger(obs.path);
  }, 60_000);
});

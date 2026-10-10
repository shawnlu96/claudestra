/**
 * S2F acceptance 4: with the switch off (default), starting the bridge through initAskWiring and the scheduler wiring makes
 * zero center requests, even with a credential, a binding and an execution feature present. Runs in an `env -i` style child
 * (temp HOME / TMPDIR / state) with an offline fetch that counts every request.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { credential, executionMode, PROJECT, SCOPE } from "./shared-ledger-v2-stage2-wiring-fixture.test.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

async function seed(dir: string) {
  const path = join(dir, "ledger.sqlite"), db = openLedger(path);
  createTask(db, { actor: "owner" }, { id: "T", project: PROJECT, title: "execution card", kind: "code" });
  db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f',?,'synthetic','active','owner',1,1)").run(PROJECT);
  db.query("UPDATE tasks SET featureId='f' WHERE id='T'").run();
  closeLedger(path);
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { f: executionMode() } }), { mode: 0o600 });
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([{ ...SCOPE, localProjectId: PROJECT }]), { mode: 0o600 });
  await writeSharedLedgerCredential(credential("owner:self", "person-owner"), dir);
}

test("switch off: bridge (via initAskWiring) and scheduler wiring start with zero center requests", async () => {
  const dir = tmp("s2f-boot-");
  await seed(dir);
  const script = `
    let fetches = 0; globalThis.fetch = async () => { fetches++; throw new Error("offline"); };
    const { initAskWiring } = await import("./src/bridge/ask-entry.ts");
    const { sharedExecEntryPort, requireSharedExecEntry } = await import("./src/bridge/shared-ledger-v2-entry.ts");
    const { sharedLedgerV2Bridge } = await import("./src/bridge/shared-ledger-v2-wiring.ts");
    const { initSchedulerV2 } = await import("./src/lib/scheduler-v2-wiring.ts");
    initAskWiring({ clients: new Map(), controlChannelId: "fixture", hold: () => {}, discord: null, deliver: async () => ({ ok: true }) });
    const scheduler = initSchedulerV2({ instanceId: () => "home" });
    const bridgeRoute = sharedLedgerV2Bridge()?.route("T");
    let unavailable = null;
    try { requireSharedExecEntry(${JSON.stringify(PROJECT)}); } catch (e) { unavailable = e.code; }
    let passthrough = 0;
    const manager = scheduler.wrapManager(async () => { passthrough++; return { ok: true }; });
    await manager("ledger", "scheduler-plan", "T", "--id", "i1");
    await Bun.sleep(300);
    console.log("RESULT " + JSON.stringify({ wired: !!sharedExecEntryPort(), bridgeRoute, schedulerRoute: scheduler.route("T"),
      fence: scheduler.leases.current("f"), unavailable, passthrough, fetches }));
    await scheduler.stop();
    process.exit(0);
  `;
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: join(import.meta.dir, ".."),
    env: testChildEnv({ HOME: tmp("s2f-home-"), TMPDIR: tmp("s2f-tmp-"), CLAUDESTRA_STATE_DIR: dir, DISCORD_CHANNEL_ID: "" }),
    stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  expect({ exit, line: !!line, stderr: exit === 0 ? "" : stderr }).toEqual({ exit: 0, line: true, stderr: "" });
  expect(JSON.parse(line!.slice(7))).toEqual({ wired: true, bridgeRoute: "skip", schedulerRoute: "skip", fence: null,
    unavailable: "unavailable", passthrough: 1, fetches: 0 });
}, 30_000);

/**
 * S2D2 acceptance 1: the path inventory (src/lib/scheduler-v2-skip-paths.ts) equals what the code does. A new awaited step in
 * schedulerPass, a new ledger subcommand sent by the scheduler or a new computed-subcommand call site that is not registered
 * turns this red. Hook-gated paths must really call the gate in the file the inventory names.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULER_PASS_PATHS, SKIP_LEDGER_COMMANDS, SKIP_LEDGER_DYNAMIC, type SchedulerPassPath } from "../src/lib/scheduler-v2-skip-paths.js";

const LIB = join(import.meta.dir, "..", "src", "lib");
const source = (file: string) => readFileSync(join(LIB, file), "utf8");
// the inventory itself lists effect names in arrays, it sends nothing
const libFiles = () => readdirSync(LIB).filter((f) => f.endsWith(".ts") && f !== "scheduler-v2-skip-paths.ts");

/** The callee after every `await` inside schedulerPass (`opts.x` for `(opts.x ?? …)` / `opts.x!(…)`). */
function passSteps(text: string): string[] {
  const start = text.indexOf("export async function schedulerPass(");
  expect(start).toBeGreaterThan(-1);
  const body = text.slice(start);
  const out: string[] = [];
  for (const m of body.matchAll(/\bawait\s+([^;]*)/g)) {
    const rest = m[1]!.replace(/^[\s(]+/, "");
    const opt = /^opts\.(\w+)/.exec(rest), name = /^([\w.]+)/.exec(rest);
    out.push(opt ? `opts.${opt[1]}` : name![1]!);
  }
  return [...new Set(out)];
}

/** Literal subcommands of `…manager|ledger|svc("ledger", "<sub>"`, `["ledger", "<sub>"` and `recoveryWrite(m, "<sub>"`; files with a computed one. */
function ledgerCalls(files: { name: string; text: string }[]): { literal: Set<string>; dynamic: Set<string> } {
  const literal = new Set<string>(), dynamic = new Set<string>();
  for (const { name, text } of files) {
    for (const m of text.matchAll(/(?:^|[^\w])(?:[\w.]*\.)?(?:manager|ledger|svc)\(\s*"ledger"\s*,\s*("([a-z][a-z-]*)"|[^\s"])/g)) {
      if (m[2]) literal.add(m[2]);
      else dynamic.add(name);
    }
    for (const m of text.matchAll(/\brecoveryWrite\([^,]+,\s*"([a-z-]+)"/g)) literal.add(m[1]!);
    for (const m of text.matchAll(/\[\s*"ledger"\s*,\s*"([a-z][a-z-]*)"/g)) literal.add(m[1]!); // argv built as an array first
  }
  return { literal, dynamic };
}

describe("S2D2 path inventory", () => {
  test("every awaited step of schedulerPass is listed, and nothing else", () => {
    const steps = passSteps(source("scheduler-pass.ts"));
    expect(steps.sort()).toEqual(SCHEDULER_PASS_PATHS.map((p) => p.step).sort());
  });

  test("an unregistered new step turns the inventory check red", () => {
    const text = source("scheduler-pass.ts").replace("failed.push(...(await lendTakeoverStep",
      "failed.push(...(await newPushStep(db)).failed);\n      failed.push(...(await lendTakeoverStep");
    expect(passSteps(text)).toContain("newPushStep");
    expect(SCHEDULER_PASS_PATHS.map((p) => p.step)).not.toContain("newPushStep");
  });

  test("every listed path names a real function in a real file; every card-effect path has a gate", () => {
    for (const p of SCHEDULER_PASS_PATHS) {
      const fn = p.fn.replace(/\(\)\..*$/, "").replace(/^.*\./, "");
      expect(source(p.file)).toMatch(new RegExp(`\\b${fn}\\b`));
      if (p.effects.length) expect(p.gates.filter((g) => g !== "none").length).toBeGreaterThan(0);
    }
  });

  test("hook-gated paths call the S2D2 gate in their own file; pace-gated loops ask skipTask", () => {
    const hooked = (p: SchedulerPassPath) => p.gates.includes("hook");
    for (const p of SCHEDULER_PASS_PATHS.filter(hooked)) {
      // lend-pr-takeover receives its hook from scheduler-v2-skip.ts (importing it there would cycle).
      expect(source(p.file)).toMatch(p.file === "lend-pr-takeover.ts" ? /takeoverSkip\?\.\(db, r\.taskId\)/ : /from "\.\/scheduler-v2-skip\.js"/);
    }
    expect(source("scheduler-v2-skip.ts")).toContain("configureTakeoverSkip(schedulerV2SkipTask)");
    expect(source("scheduler-pass.ts")).toContain("schedulerV2SkipManager(db, schedulerV2PassManager(");
    const paced = ["scheduler-yield.ts", "scheduler-service.ts", "scheduler-deploy-tick.ts", "scheduler-spec-resume.ts", "scheduler-autostart-resume.ts"];
    for (const f of paced) expect(source(f)).toContain("skipTask?.(");
  });

  test("peerPr is featureless: intake never binds a feature to the card it creates", () => {
    const peer = SCHEDULER_PASS_PATHS.find((p) => p.step === "opts.peerPr")!;
    expect(peer.gates).toContain("featureless");
    for (const f of libFiles().filter((f) => f.startsWith("peer-pr-"))) expect(source(f)).not.toMatch(/featureId|sharedFeatureId/);
    expect(readFileSync(join(import.meta.dir, "..", "src", "manager", "ledger-peer-pr-cmds.ts"), "utf8")).not.toMatch(/featureId|sharedFeatureId/);
  });

  test("every ledger subcommand the scheduler sends is registered with a target kind", () => {
    const { literal, dynamic } = ledgerCalls(libFiles().map((name) => ({ name, text: source(name) })));
    const missing = [...literal].filter((s) => !Object.hasOwn(SKIP_LEDGER_COMMANDS, s));
    expect(missing).toEqual([]);
    expect([...dynamic].sort()).toEqual(Object.keys(SKIP_LEDGER_DYNAMIC).sort());
    for (const subs of Object.values(SKIP_LEDGER_DYNAMIC)) for (const s of subs) expect(Object.hasOwn(SKIP_LEDGER_COMMANDS, s)).toBe(true);
    // a stale registration is caught too (only the dynamic-site commands may be absent from literal calls)
    const viaDynamic = new Set(Object.values(SKIP_LEDGER_DYNAMIC).flat());
    expect(Object.keys(SKIP_LEDGER_COMMANDS).filter((s) => !literal.has(s) && !viaDynamic.has(s))).toEqual([]);
  });

  test("an unregistered new subcommand or computed call site turns the scan red", () => {
    const fake = [{ name: "fake.ts", text: 'await deps.manager("ledger", "scheduler-brand-new", id); await manager("ledger", ...xs);' }];
    const { literal, dynamic } = ledgerCalls(fake);
    expect([...literal].filter((s) => !Object.hasOwn(SKIP_LEDGER_COMMANDS, s))).toEqual(["scheduler-brand-new"]);
    expect([...dynamic]).toEqual(["fake.ts"]);
    // path strings that only look alike are not commands
    expect(ledgerCalls([{ name: "p.ts", text: 'statePath("ledger", "docs"); join(dir, "ledger", "docs")' }]).literal.size).toBe(0);
  });

  test("dynamic call sites can only produce their registered commands", () => {
    expect(source("scheduler-auto-tick.ts")).toMatch(/\["scheduler-stage", intent\.id[^\]]*\] : \["scheduler-ui-ask", intent\.id\]/);
    const wiring = libFiles().filter((f) => f.startsWith("scheduler-model-wiring")).map(source).join("\n");
    const subs = new Set([...wiring.matchAll(/ledgerWrite\(card, \["([a-z-]+)"/g)].map((m) => m[1]!));
    expect([...subs].sort()).toEqual([...SKIP_LEDGER_DYNAMIC["scheduler-model-wiring.ts"]!].sort());
    const recovery = new Set(libFiles().flatMap((f) => [...source(f).matchAll(/\brecoveryWrite\([^,]+,\s*"([a-z-]+)"/g)].map((m) => m[1]!)));
    expect([...recovery].sort()).toEqual([...SKIP_LEDGER_DYNAMIC["scheduler-recovery-ports.ts"]!].sort());
  });
});

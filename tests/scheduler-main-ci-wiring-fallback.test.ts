/** Production fallback ports must obey the same claim-to-send gate as explicitly injected ports. */
import { expect, test } from "bun:test";
import { testChildEnv } from "./test-env.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function fallbackProbe(route: string, injected = false, revoke = true, failCancel = false, mode = "on", inFlight = false, extraPasses = 0) {
  const dir = mkdtempSync(join(tmpdir(), "mainci-fallback-"));
  const root = resolve(import.meta.dir, "..");
  const log = join(dir, "writes.jsonl");
  const timed = route === "timeout";
  const failedLog = ["##[group]tests/stale.test.ts:", ...(timed ? [] : ["error: expect(received).toBe(expected)"]),
    "(fail) stale [0.40ms]", ...(timed ? ["  ^ this test timed out after 5000ms."] : []), "##[endgroup]", " 1 fail"].join("\n");
  const gh = `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
const a = process.argv.slice(2), text = a.join(' ');
if (text.includes('update-branch') || text.startsWith('run rerun')) appendFileSync(${JSON.stringify(log)}, JSON.stringify(a)+'\\n');
let out = {};
if (text.includes('--json attempt,status,conclusion')) out = {attempt:1,status:'completed',conclusion:'failure'};
else if (text.includes('--log-failed')) out = ${JSON.stringify(failedLog)};
else if (text.includes('--json files')) out = {files:[{path:'src/own.ts'}]};
else if (text.includes('/compare/')) out = {base:'b'.repeat(40),commits:['f'.repeat(40)]};
else if (text.includes('/commits ')) out = ['f'.repeat(40)];
console.log(typeof out === 'string' ? out : JSON.stringify(out));`;
  writeFileSync(join(dir, "gh"), gh); chmodSync(join(dir, "gh"), 0o755);
  const script = `
import { mainCiWorld, writePolicy } from ${JSON.stringify(join(root, "tests/scheduler-main-ci-wiring-world.test.ts"))};
import { ciBehindGh } from ${JSON.stringify(join(root, "src/lib/scheduler-merge-ci-behind.ts"))};
import { ciRerunGh } from ${JSON.stringify(join(root, "src/lib/scheduler-merge-ci-rerun.ts"))};
import { createFeature, initDag } from ${JSON.stringify(join(root, "src/lib/ledger-feature-write.ts"))};
import { addKnownFlaky } from ${JSON.stringify(join(root, "src/lib/ci-known-flaky.ts"))};
const w = mainCiWorld();
try {
writePolicy({mainCiPause:${JSON.stringify(mode)},mergeUnsentCancel:'off',ciKnownFlaky:'on'});
if (${injected}) { w.ci.ports.ciBehind=ciBehindGh(); w.ci.ports.ciRerun=ciRerunGh(); }
const c = w.card('C'); w.ci.defaultCi='failure'; w.ci.prChecks.set('C','fail');
if (${JSON.stringify(route)} === 'flaky') {
 const owner={actor:'owner',now:Date.now()};
 const f=createFeature(w.db,owner,{project:'p',slug:'flaky',title:'fix'}).row.id;
 initDag(w.db,owner,{id:f,rev:1,nodes:[{key:'FIX',oneLine:'fix stale'}]});
 addKnownFlaky(w.db,owner,{project:'p',file:'tests/stale.test.ts',featureId:f,node:'FIX',reason:'timing'});
}
await w.ledger('agent-pm',['main-ci-repair','C','--head',c.head,'--main',w.hub.main,'--reason','修 main']);
const intent=await w.begin('C'); let revoked=false;
if (${inFlight}) await w.step(intent,'ready','updating');
w.ci.onReceipt=async(args)=>{
 if(!${revoke} || revoked || args[1]!=='scheduler-merge-step') return;
 const claim=w.taskEvents('C').some(e=>e.data.op==='merge_ci_rerun');
 if(w.phase('C')!=='updating' && !claim) return;
 revoked=true;
 const r=await w.ledger('agent-pm',['main-ci-repair','C','--revoke','--reason','换人修']);
 if(r.ok!==true) throw new Error(JSON.stringify(r));
};
let failedCancel=false;
w.ci.beforeWrite=async(args)=>{
 if (${failCancel} && !failedCancel && args[1]==='scheduler-merge-step' && args.includes('unknown')) {
  failedCancel=true; throw new Error('synthetic cancellation write unavailable');
 }
};
await w.pass(); const firstPhase=w.phase('C'); await w.pass();
for(let n=0;n<${extraPasses};n++) await w.pass();
console.log(JSON.stringify({revoked,failedCancel,firstPhase,stage:w.db.query("SELECT stage FROM tasks WHERE id=\'C\'").get().stage,phase:w.phase('C'),
status:w.db.query('SELECT status FROM scheduler_intents WHERE id=?').get(intent).status,
slot:!!w.db.query('SELECT 1 FROM scheduler_resources WHERE intentId=?').get(intent),frozen:w.frozen(),
bounces:w.taskEvents('C').filter(e=>e.data.op==='merge_conflict').length,
intents:w.db.query("SELECT status FROM scheduler_intents WHERE taskId='C' AND action='merge' ORDER BY eventSeq").all().map(i=>i.status),
workflow:w.db.query("SELECT mode FROM task_workflows WHERE taskId='C'").get().mode,
fallbacks:w.taskEvents('C').filter(e=>e.data.op==='fallback_manual').length}));
} finally {w.close();}`;
  try {
    const p = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
      cwd: dir, env: testChildEnv({ PATH: dir, HOME: dir, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: dir,
        // Production-only fallback creation requires a non-test child; fake HOME, dead bridge and fake-gh-only PATH keep it isolated.
        CLAUDESTRA_TEST: undefined, NODE_ENV: undefined }), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    return { result: JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      revoked: boolean; firstPhase: string; phase: string; status: string; slot: boolean; frozen: boolean; bounces: number; failedCancel: boolean; stage: string;
      intents: string[]; workflow: string; fallbacks: number;
    },
      writes: (() => { try { return readFileSync(log, "utf8").trim().split("\n"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      } })() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const route of ["behind", "timeout", "flaky"]) {
  for (const injected of [false, true]) {
    for (const revoke of [false, true]) {
      test(`[验收线 4] ${route}, injected=${injected}, revoke=${revoke}: claim-to-send binding`, async () => {
        const { result, writes } = await fallbackProbe(route, injected, revoke);
        expect(result.revoked).toBe(revoke);
        expect(writes.length).toBe(revoke ? 0 : 1);
        expect(result).toMatchObject({ status: revoke ? "cancelled" : "submitted", slot: !revoke, frozen: false, bounces: 0, stage: "merge" });
      });
    }
  }
}
for (const injected of [false, true]) {
  test(`[验收线 2] cancellation write fails once, injected=${injected}: never bounce an unsent revoked update`, async () => {
    const { result, writes } = await fallbackProbe("behind", injected, true, true);
    expect(result).toMatchObject({ revoked: true, failedCancel: true, frozen: false, bounces: 0, stage: "merge" });
    expect(writes).toEqual([]);
  });
}
for (const mode of ["observe", "off"]) {
  test(`[验收线 6] ${mode}: revoke does not change fallback sends`, async () => {
    const { result, writes } = await fallbackProbe("timeout", false, true, false, mode);
    expect(result.revoked).toBe(true);
    expect(writes.length).toBe(1);
    expect(result).toMatchObject({ status: "submitted", frozen: false, bounces: 0, stage: "merge" });
  });
}

for (const route of ["timeout", "flaky"]) {
  test(`[验收线 2] ${route}: revoked rerun cannot attest an earlier update was unsent`, async () => {
    const { result, writes } = await fallbackProbe(route, false, true, false, "on", true);
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ revoked: true, firstPhase: "updating", frozen: false, bounces: 0, stage: "merge" });
  });
}

for (const route of ["behind", "timeout", "flaky"]) {
  test(`[验收线 2] ${route}: main_ci_pause cancellation replans pending and retains auto workflow`, async () => {
    const { result, writes } = await fallbackProbe(route, false, true, false, "on", false, 4);
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ intents: ["cancelled", "pending"], workflow: "auto", fallbacks: 0, frozen: false, stage: "merge" });
  });
}

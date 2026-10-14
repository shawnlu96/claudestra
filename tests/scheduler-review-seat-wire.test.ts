import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A separate process isolates the real recovery reader and every state cache from the operator and other tests.
async function isolated<T>(script: string): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "seat-wire-"));
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(),
      env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err).toBe(0);
    return JSON.parse(out.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const imports = `
  import { writeFileSync } from 'node:fs';
  import { statePath } from './src/lib/paths.ts';
  import { autoFixture, H1, H2 } from './tests/scheduler-auto-helpers.ts';
  import { addSeat, reviewEffect, reviewEvent } from './tests/scheduler-review-seat-fixture.test.ts';
  import { autoSnapshot } from './src/lib/scheduler-auto-snapshot.ts';
  import { getTask } from './src/lib/ledger-store.ts';
  import { planScheduler } from './src/lib/scheduler-plan.ts';
  import { workingSeats, localAgentPool } from './src/lib/scheduler-agent-pool-ledger.ts';
  import { localReviewerCount } from './src/lib/scheduler-pool-facts.ts';
  const f = autoFixture();
  const mode = value => writeFileSync(statePath('recovery-policy.json'),JSON.stringify({projects:{p:{keys:{reviewSeatIdle:value}}}}));
  const workflow = id => f.db.query('INSERT INTO task_workflows SELECT ?,project,template,templateVersion,mode,authorFamily,' +
    "fallback,specRev,rev,createdAt,updatedAt FROM task_workflows WHERE taskId='T1'").run(id);
`;

test("[验收线 1] file-backed modes reach AgentPool, reviewer count and real bounded seven-review dispatch", async () => {
  const result = await isolated<{ modes: unknown[]; batch: unknown[] }>(imports + `
    try {
      f.db.query("UPDATE tasks SET stage='review',headSHA=?,pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(H2);
      for(let n=0;n<3;n++) addSeat(f.db,'author'+n,'author','build');
      for(let n=0;n<7;n++) {addSeat(f.db,'idle'+n); workflow('idle'+n); reviewEvent(f.db,'idle'+n,H1,1);}
      f.db.query("INSERT INTO scheduler_sessions VALUES ('T1','reviewer','agent-rv-t1','s-rv','codex','acp','active','created',null,null,null,0,0)").run();
      const remote = {agents:{claude:0,codex:8},mode:'balance',roles:[],poolTimeoutMin:15};
      const snap = id => autoSnapshot(f.reader.get(),getTask(f.db,id),{registry:[],maxWorkers:8,pool:{remote,borrow:[]}});
      const modes = [];
      for(const value of ['off','observe','on']) {
        mode(value);
        const s = snap('T1'), plan = planScheduler(s);
        modes.push({mode:value, running:s.pool.localPool.running.codex, reviewers:localReviewerCount(f.db,'p','T1'),
          seats:workingSeats(f.db,'p','T1').size, plan:{kind:plan.kind,action:plan.action,recipient:plan.recipient}});
      }
      const batch = [];
      for(let n=0;n<7;n++) {
        if(n===5) {
          const blocked = planScheduler(snap('idle'+n));
          batch.push({kind:blocked.kind,code:blocked.code});
          reviewEvent(f.db,'idle0'); reviewEvent(f.db,'idle1');
        }
        const plan = planScheduler(snap('idle'+n));
        reviewEffect(f.db,'idle'+n,'done');
        batch.push({kind:plan.kind,action:plan.action,recipient:plan.recipient,running:localAgentPool(f.db,'p',remote.agents).running.codex});
      }
      console.log(JSON.stringify({modes,batch}));
    } finally {f.close();}
  `);
  expect(result.modes).toEqual([
    { mode: "off", running: 10, reviewers: 7, seats: 10, plan: { kind: "wait" } },
    { mode: "observe", running: 10, reviewers: 7, seats: 10, plan: { kind: "wait" } },
    { mode: "on", running: 3, reviewers: 0, seats: 3, plan: { kind: "intent", action: "review", recipient: "agent-rv-t1" } },
  ]);
  const dispatched = (n: number, running: number) => ({kind:"intent",action:"review",recipient:`idle${n}`,running});
  expect(result.batch).toEqual([dispatched(0,4),dispatched(1,5),dispatched(2,6),dispatched(3,7),dispatched(4,8),
    {kind:"wait",code:"placement"},dispatched(5,7),dispatched(6,8)]);
});

test("[回归 finish-first-reserve-skip] on reserves idle bound reviewers before admitting new authors, pending stays queued", async () => {
  const result = await isolated<{ modes: unknown[]; pending: unknown; submitted: unknown; creating: unknown; ready: unknown[]; withPeer: unknown }>(imports + `
    import { poolStartFacts, poolStartGate } from './src/lib/scheduler-agent-pool-start.ts';
    import { recordHello } from './src/lib/ledger-lend-peers.ts';
    import { reserveFinishing } from './src/lib/scheduler-agent-pool-reserve.ts';
    try {
      f.db.query("UPDATE tasks SET stage='live' WHERE id='T1'").run();
      f.db.query("UPDATE task_workflows SET authorFamily='codex' WHERE taskId='T1'").run();
      for(let n=0;n<3;n++) addSeat(f.db,'author'+n,'author','build');
      for(let n=0;n<2;n++) {addSeat(f.db,'queued'+n); workflow('queued'+n);}
      f.db.query("UPDATE scheduler_sessions SET family='claude'").run();
      const remote = {agents:{claude:5,codex:0},mode:'balance',roles:[],poolTimeoutMin:15,repo:'o/r'};
      const read = (borrow = []) => {
        const facts = poolStartFacts(f.db,'p',remote,borrow,1000);
        return {running:facts.local.pool.running.claude, reserved:reserveFinishing(f.db,'p',facts).local.pool.running.claude,
          gate:poolStartGate(f.db,'p',remote,borrow,1000,null),reviewers:localReviewerCount(f.db,'p',null)};
      };
      const modes = [];
      for(const value of ['off','observe','on']) {mode(value); modes.push({mode:value,...read()});}
      recordHello(f.db,'mate',null,{v:1,proto:2,boot:'b',seq:1,paused:null,
        slots:{claude:{total:5,busy:0},codex:{total:0,busy:0}},
        grant:{until:10000,repos:['o/r'],roles:[],ordersPerDay:50,ordersLeftToday:50}},1000);
      const withPeer = read([{peer:'mate',projects:['p'],maxOpen:0,roles:[]}]);
      const ready = ['queued0','queued1'].map(id => {
        const plan = planScheduler(autoSnapshot(f.reader.get(),getTask(f.db,id),{registry:[],maxWorkers:5,pool:{remote,borrow:[]}}));
        return {kind:plan.kind,action:plan.action,recipient:plan.recipient};
      });
      reviewEffect(f.db,'queued0','pending');
      const pending = read();
      f.db.query("UPDATE scheduler_intents SET status='submitted' WHERE taskId='queued0'").run();
      const submitted = read();
      f.db.query("UPDATE scheduler_intents SET status='cancelled' WHERE taskId='queued0'").run();
      f.db.query("DELETE FROM scheduler_sessions WHERE taskId='queued1'").run();
      reviewEffect(f.db,'queued1','submitted');
      f.db.query("UPDATE scheduler_intents SET action='ensure_session',receipt='ensure reviewer claude' WHERE taskId='queued1'").run();
      const creating = read();
      console.log(JSON.stringify({modes,pending,submitted,creating,ready,withPeer}));
    } finally {f.close();}
  `);
  const full = "等 claude / codex 空位";
  expect(result.modes).toEqual([
    {mode:"off",running:5,reserved:5,gate:full,reviewers:2},
    {mode:"observe",running:5,reserved:5,gate:full,reviewers:2},
    {mode:"on",running:3,reserved:5,gate:"空位优先留给审查 / 复验 / 修复",reviewers:0},
  ]);
  expect(result.pending).toEqual({running:3,reserved:5,gate:"空位优先留给审查 / 复验 / 修复",reviewers:0});
  expect(result.submitted).toEqual({running:4,reserved:5,gate:"空位优先留给审查 / 复验 / 修复",reviewers:1});
  expect(result.creating).toEqual(result.submitted);
  expect(result.withPeer).toEqual(result.pending);
  expect(result.ready).toEqual([0,1].map(n => ({kind:"intent",action:"review",recipient:`queued${n}`})));
});

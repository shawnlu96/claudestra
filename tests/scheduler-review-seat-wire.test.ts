import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A separate process isolates the real recovery reader and every state cache from the operator and other tests.
test("[验收线 1] file-backed on reaches the canonical snapshot and plans a real local review; off/observe wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-wire-"));
  try {
    const script = `
      import { writeFileSync } from 'node:fs';
      import { statePath } from './src/lib/paths.ts';
      import { autoFixture, H2 } from './tests/scheduler-auto-helpers.ts';
      import { addSeat } from './tests/scheduler-review-seat-fixture.test.ts';
      import { autoSnapshot } from './src/lib/scheduler-auto-snapshot.ts';
      import { planScheduler } from './src/lib/scheduler-plan.ts';
      import { workingSeats } from './src/lib/scheduler-agent-pool-ledger.ts';
      const f = autoFixture();
      try {
        f.db.query("UPDATE tasks SET stage='review',headSHA=?,pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(H2);
        for(let n=0;n<3;n++) addSeat(f.db,'author'+n,'author','build');
        for(let n=0;n<7;n++) addSeat(f.db,'idle'+n);
        f.db.query("INSERT INTO scheduler_sessions VALUES ('T1','reviewer','agent-rv-t1','s-rv','codex','acp','active','created',null,null,null,0,0)").run();
        const result = [];
        for(const mode of ['off','observe','on']) {
          writeFileSync(statePath('recovery-policy.json'),JSON.stringify({projects:{p:{keys:{reviewSeatIdle:mode}}}}));
          const s = autoSnapshot(f.reader.get(),f.task(),{registry:[],maxWorkers:8,
            pool:{remote:{agents:{claude:0,codex:8},mode:'balance',roles:[],poolTimeoutMin:15},borrow:[]}});
          const plan = planScheduler(s);
          result.push({mode, seats:workingSeats(f.db,'p','T1').size, plan:{kind:plan.kind,action:plan.action,recipient:plan.recipient}});
        }
        console.log(JSON.stringify(result));
      } finally {f.close();}
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(),
      env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err).toBe(0);
    expect(JSON.parse(out.trim())).toEqual([
      { mode: "off", seats: 10, plan: { kind: "wait" } },
      { mode: "observe", seats: 10, plan: { kind: "wait" } },
      { mode: "on", seats: 3, plan: { kind: "intent", action: "review", recipient: "agent-rv-t1" } },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.js";

// A separate bridge process starts without the scheduler's pause cache. Only synthetic state is visible to this child.
const probe = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLendJournal, setMeta, getMeta } from "./src/lib/lend-journal.ts";
import { noteClaudeReadiness, cachedClaudeReadiness, claudeReadinessManual } from "./src/lib/lend-claude-worker-capacity.ts";
import { resetClaudePauseCache, syncClaudePause, claudePauseSlots } from "./src/lib/lend-claude-pause.ts";
import { helloBody } from "./src/lib/lend-hello.ts";
import { journalActualSlots, makeLendQuotaLinesApi } from "./src/bridge/local-api/lend-quota-lines.ts";
const now=Date.now(), dir=process.env.CLAUDESTRA_STATE_DIR, path=join(dir,"journal.sqlite");
const db=openLendJournal(path);
const entry={peer:"synthetic",fp:"aaaa-bbbb-cccc-dddd",families:{codex:3,claude:2},roles:["review"],repos:["o/r"],
  ordersPerDay:50,grantedAt:new Date(now-86400000).toISOString(),until:new Date(now+86400000).toISOString()};
const lendPath=join(dir,"lend.json");
writeFileSync(lendPath,JSON.stringify({version:2,enabled:true,lend:[entry],borrow:[]}));
const api=makeLendQuotaLinesApi({linesPath:join(dir,"lines.json"),lendPath,now:()=>now,facts:async()=>({}),
  context:async()=>({contacts:[{name:entry.peer,fp:entry.fp}],projects:[]}),actual:journalActualSlots(path),log:()=>{}});
const owner={id:"owner:self",role:"owner",agents:["*","master"],createdAt:new Date(now).toISOString(),terminal:true,manage:true};
const failure={at:now-500,key:"synthetic-failure",session:null,until:now+3600000};
const cases=[
  ["quota",{quota:failure},{ready:true,reason:null,at:now-1000},0],
  ["auth-blocked",{auth:{...failure,until:0}},{ready:true,reason:null,at:now-1000},0],
  ["auth-trial",{auth:{...failure,until:0}},{ready:true,reason:null,at:now-100},1],
  ["expired-quota",{quota:{...failure,until:now-1}},{ready:true,reason:null,at:now-1000},2],
  ["quota-over-trial",{auth:{...failure,until:0},quota:failure},{ready:true,reason:null,at:now-100},0],
  ["missing-readiness",{},null,0],
];
const results=[];
for(const [name,pause,ready,expected] of cases){
  setMeta(db,"pause:claude",JSON.stringify(pause)); setMeta(db,"claudeReady",JSON.stringify(ready));
  noteClaudeReadiness(null); // restore background=true too: the read endpoint must never start a probe
  resetClaudePauseCache();
  const before=getMeta(db,"pause:claude"), readyBefore=getMeta(db,"claudeReady");
  const res=await api(new Request("http://synthetic/lend/quota-lines"),"/lend/quota-lines",owner);
  const view=await res.json();
  await new Promise(r=>setTimeout(r,0));
  const cacheUntouched=cachedClaudeReadiness()===null && claudePauseSlots(2)===2;
  const journalUntouched=before===getMeta(db,"pause:claude") && readyBefore===getMeta(db,"claudeReady");
  noteClaudeReadiness(ready); claudeReadinessManual(); syncClaudePause(db);
  const hello=helloBody(db,entry,now);
  results.push({name,expected,status:res.status,available:view.families[1].available,slots:view.families[1].slots,
    hello:hello.slots.claude.total,codex:view.families[0].available,cacheUntouched,journalUntouched});
}
db.close(); console.log(JSON.stringify(results));
`;

test("independent bridge GET projects persisted Claude quota/auth/trial exactly like hello without probes or writes", () => {
  const root = mkdtempSync(join(tmpdir(), "qline-actual-"));
  try {
    for (const sub of ["home", "state", "run", "tmp"]) mkdirSync(join(root, sub));
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", probe], {
      cwd: join(import.meta.dir, ".."),
      env: testChildEnv({ PATH: "/nonexistent", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
        CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run") }),
      stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const results = JSON.parse(child.stdout.toString()) as {
      name: string; expected: number; status: number; hello: number; available: number; slots: number;
      codex: number; cacheUntouched: boolean; journalUntouched: boolean;
    }[];
    expect(results).toHaveLength(6);
    for (const r of results) {
      expect(r.status, r.name).toBe(200);
      expect(r.hello, r.name).toBe(r.expected);
      expect(r.available, r.name).toBe(r.expected);
      expect(r.slots, r.name).toBe(r.hello);
      expect(r.codex, r.name).toBe(3);
      expect(r.cacheUntouched, r.name).toBe(true);
      expect(r.journalUntouched, r.name).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

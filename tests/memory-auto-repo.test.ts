/** Real command registration and process argv/cwd, isolated from host repositories and credentials. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testChildEnv } from "./test-env.js";

let dir: string, repo: string, state: string, shim: string, log: string, gitBin: string, head: string, base: string, merge: string;
const actual = "src/foreign-actual.ts", named = "src/foreign-probe.ts", declared = "src/declared.ts";
function git(...args: string[]): string {
  const r = Bun.spawnSync([gitBin, ...args], { env: testChildEnv({ HOME: join(dir, "home") }), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-project-repo-"));
  repo = join(dir, "foreign-repo"); state = join(dir, "state"); shim = join(dir, "bin"); log = join(dir, "commands.jsonl");
  for (const p of [repo, state, shim, join(dir, "home"), join(dir, "tmp"), join(repo, "src")]) mkdirSync(p, { recursive: true });
  gitBin = Bun.which("git")!;
  git("init", "--bare", "--initial-branch=main", join(dir, "remote.git"));
  git("init", "--initial-branch=main", repo);
  for (const file of [named, declared]) writeFileSync(join(repo, file), "export const initial = true;\n");
  git("-C", repo, "add", ".");
  const commit = (message: string) => git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message);
  commit("base"); base = git("-C", repo, "rev-parse", "HEAD");
  git("-C", repo, "remote", "add", "origin", join(dir, "remote.git"));
  git("-C", repo, "checkout", "-b", "topic"); writeFileSync(join(repo, actual), "export const changed = true;\n");
  git("-C", repo, "add", "."); commit("PR change"); head = git("-C", repo, "rev-parse", "HEAD");
  git("-C", repo, "checkout", "main");
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "merge", "--no-ff", "topic", "-m", "merge PR");
  merge = git("-C", repo, "rev-parse", "HEAD"); git("-C", repo, "push", "origin", "main");
  const logCode = `import {appendFileSync} from 'node:fs'; const args=process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({bin:process.argv[1].split('/').at(-1),cwd:process.cwd(),args})+'\\n');`;
  const pr = JSON.stringify({ state: "MERGED", mergeCommit: { oid: merge }, mergedAt: "2026-01-01T00:00:00Z",
    headRefOid: head, headRefName: "topic", baseRefOid: base });
  writeFileSync(join(shim, "gh"), `#!${process.execPath}\n${logCode}
    const right=process.cwd()===${JSON.stringify(repo)} || args.some(a=>a.includes('demo/foreign/pull/12'));
    if(args[0]==='pr') console.log(${JSON.stringify(pr)});
    else if(process.env.FIXTURE_API_FAIL==='1') process.exit(1);
    else console.log(right?${JSON.stringify(actual)}:'src/wrong-primary.ts');\n`);
  writeFileSync(join(shim, "git"), `#!${process.execPath}\n${logCode}
    const at=args.includes('-C')?args[args.indexOf('-C')+1]:process.cwd();
    if(at!==${JSON.stringify(repo)}) process.exit(1);
    const r=Bun.spawnSync([${JSON.stringify(gitBin)},...args],{stdout:'pipe',stderr:'pipe'});
    process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.exitCode??1);\n`);
  for (const name of ["gh", "git"]) chmodSync(join(shim, name), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function invoke(pr: string, options: { apiFail?: boolean; repoDir?: string | null; primaryProbe?: boolean } = {}) {
  const repoDir = options.repoDir === undefined ? repo : options.repoDir;
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: false, projects: repoDir === null ? {} : {
    foreign: { repoDir, maxActiveWorkers: 1, requiredChecks: ["check"] },
  } }));
  const module = (name: string) => JSON.stringify(resolve(`src/${name}.ts`));
  const script = join(dir, "invoke.ts");
  writeFileSync(script, `
    import {openLedger,closeLedger,listEvents} from ${module("lib/ledger-store")};
    import {ledgerOrigin} from ${module("lib/ledger-origin")};
    import {createTask,deliver,recordReview} from ${module("lib/ledger-write")};
    import {assignStep} from ${module("lib/ledger-steps-write")};
    import {insertEvent} from ${module("lib/ledger-tx")};
    import {projectMemories} from ${module("lib/memory-auto-common")};
    import {runLedger} from ${module("manager/ledger")};
    const path=${JSON.stringify(join(state, "ledger.sqlite"))},db=openLedger(path); ledgerOrigin(db,()=> 'ab12');
    const owner={actor:'owner',now:1000};
    for(const id of ['S','R']) {
      createTask(db,owner,{id,project:'foreign',kind:'code',title:'Foreign '+id,extra:{fileGlobs:[${JSON.stringify(declared)}]}});
      db.query('UPDATE tasks SET pr=?,headSHA=? WHERE id=?').run(${JSON.stringify(pr)},${JSON.stringify(head)},id);
    }
    insertEvent(db,{...owner,now:1100},{project:'foreign',target:'S',kind:'stage',data:{to:'verified',specRev:1,round:1}},false);
    db.query("UPDATE tasks SET stage='build' WHERE id='R'").run();
    deliver(db,owner,{taskId:'R',headSHA:${JSON.stringify(head)},moveFrom:'build'});
    assignStep(db,owner,{taskId:'R',step:'review',executor:'agent-reviewer',executorKind:'agent'});
    recordReview(db,owner,{taskId:'R',reviewer:'agent-reviewer',verdict:'changes',p0:0,p1:1,p2:0,path:'fixture.md',
      head:${JSON.stringify(head)},reviewerSessionId:'fixture-review',reviewerFamily:'codex', findings:[{
        findingId:'tx',family:'foreign-tx',severity:'P1',probe:'Revision writes need a transaction. '+${JSON.stringify(options.primaryProbe ? "src/lib/registry.ts" : named)},
        basis:'acceptance:1',pitfall:true}]});
    let gitInTransaction=0; const spawnSync=Bun.spawnSync.bind(Bun);
    Bun.spawnSync=(argv,opts)=>{if(db.inTransaction && argv[0]==='git') gitInTransaction++; return spawnSync(argv,opts);};
    const result=await runLedger(['memory-auto','--project','foreign'],{db,actor:'scheduler',projectIds:['foreign'],
      assertLease:()=>{},now:()=>2000,loadRegistry:async()=>({socket:'',agents:{}}),saveRegistry:async()=>{}});
    const memories=projectMemories(db,'foreign'),events=listEvents(db,{project:'foreign'}); closeLedger(path);
    console.log(JSON.stringify({result,memories,events,gitInTransaction}));
  `);
  const env = testChildEnv({ HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), CLAUDESTRA_STATE_DIR: state,
    PATH: `${shim}:${process.env.PATH}`, FIXTURE_API_FAIL: options.apiFail ? "1" : "0" });
  const child = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", script],
    { cwd: dir, env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0);
  const data = JSON.parse(out) as { result: { ok: boolean }; gitInTransaction: number; memories: { kind: string; files: string[] }[];
    events: { data: { op?: string; files?: string[] } }[] };
  expect(data.result.ok).toBe(true);
  expect(data.gitInTransaction).toBe(0);
  const commands = (existsSync(log) ? readFileSync(log, "utf8") : "").trim().split("\n").filter(Boolean)
    .map((s) => JSON.parse(s) as { bin: string; cwd: string; args: string[] });
  return { ...data, commands, err };
}
function assertForeign(data: Awaited<ReturnType<typeof invoke>>) {
  expect(data.memories.find((m) => m.kind === "summary")!.files).toEqual([actual]);
  expect(data.memories.find((m) => m.kind === "pitfall")!.files).toEqual([named]);
  expect(data.events.filter((e) => e.data.op === "auto_observed" && e.data.files).map((e) => e.data.files)).toContainEqual([actual]);
  expect(data.commands.filter((c) => c.bin === "gh").every((c) => c.cwd === repo)).toBe(true);
  expect(data.commands.filter((c) => c.bin === "git").every((c) => c.args.includes("-C") ? c.args[c.args.indexOf("-C") + 1] === repo : c.cwd === repo)).toBe(true);
}

test("non-primary project + numeric PR uses its gh context, receipts, summary and explicit pitfall paths", async () => {
  assertForeign(await invoke("12"));
}, 60000);
test("URL PR API failure uses project-local git fetch/merge/diff fallback and project path recognition", async () => {
  const data = await invoke("https://github.com/demo/foreign/pull/12", { apiFail: true }); assertForeign(data);
  expect(data.commands.some((c) => c.bin === "git" && c.args.includes("diff"))).toBe(true);
}, 60000);
test("missing or invalid project repo falls back to declared scope and never recognizes primary-repo paths", async () => {
  const data = await invoke("#12", { repoDir: null, primaryProbe: true });
  expect(data.memories.map((m) => m.files)).toEqual([[declared], [declared]]);
  expect(data.commands.filter((c) => c.bin === "gh")).toEqual([]);
}, 60000);

for (const mode of ["absent-directory", "not-a-repository"] as const) {
  test(`${mode}: configured unusable clone explicitly preserves declared scope`, async () => {
    const candidate = join(dir, mode);
    if (mode === "not-a-repository") mkdirSync(candidate);
    const data = await invoke("12", { repoDir: candidate, primaryProbe: true });
    expect(data.memories.map((m) => m.files)).toEqual([[declared], [declared]]);
    expect(data.commands.filter((c) => c.bin === "gh")).toEqual([]);
    expect(data.err).toContain("project repository unavailable; using declared scope");
  }, 60000);
}

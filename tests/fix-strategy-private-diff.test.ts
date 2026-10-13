/**
 * CONVREPO1 · the repair diff summary of a fresh-session swap reads the card's own repo. Real ledger CLI subprocesses (the
 * sizeFixture way of fix-strategy-remote-size.test.ts) with a fake git on PATH that logs every argv: the public repoDir has
 * none of the private heads (exit 128), the private clone answers, and any other subcommand — fetch included — exits 71.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { peerAuthor, remoteProbe } from "./fix-strategy-remote-helpers.js";
import { testChildEnv } from "./test-env.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { driveConvergence } from "../src/lib/fix-strategy-tick.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { diffSummarizer, privateDiffDir, type DiffDirIO } from "../src/lib/fix-strategy-diff-dir.js";
import { DISPUTE_RULE, FIX_STRATEGY_RULE } from "../src/lib/fix-strategy.js";
import { sendNotice } from "../src/lib/scheduler-auto-tick.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { encodeLease, SCHEDULER_LEASE_ENV } from "../src/lib/scheduler-lease-env.js";

const ROOT = join(import.meta.dir, ".."), MANAGER = join(ROOT, "src", "manager.ts");
type PrivateGit = "ok" | "bad" | "sleep";

/** The fake git: `-C <dir>` picks the answer; the log holds one argv per line. */
function fakeGit(bin: string, log: string, pub: string, priv: string, mode: PrivateGit) {
  const privDiff = mode === "ok" ? 'echo "private diff: 1 file"' : mode === "bad" ? 'echo "fatal: bad object $5" >&2; exit 128' : "sleep 20";
  const git = join(bin, "git");
  writeFileSync(git, `#!/bin/sh
echo "$*" >> "${log}"
dir=""; if [ "$1" = "-C" ]; then dir="$2"; fi
case " $* " in
  *" remote get-url origin "*) case "$dir" in "${pub}") echo "https://github.com/o/r.git";; "${priv}") echo "https://github.com/o/private.git";; *) exit 2;; esac;;
  *" diff --stat "*) case "$dir" in "${priv}") ${privDiff};; "${pub}") echo "fatal: bad object $5" >&2; exit 128;; *) exit 3;; esac;;
  *) exit 71;;
esac
`);
  chmodSync(git, 0o755);
}

/** Two rounds of the same P1 on a peer-written card; `repo` makes it private, `clone` puts that repo's clone in the project dirs. */
async function cliFixture(opts: { repo?: string; clone?: boolean; git?: PrivateGit; publicGit?: "ok" | "bad" } = {}) {
  const f = autoFixture(), reports = ["round one evidence with a concrete assertion\n", "round two evidence with a concrete assertion\n"];
  const paths = [join(f.dir, "round1.md"), join(f.dir, "round2.md")];
  paths.forEach((p, i) => writeFileSync(p, reports[i]));
  await toBuild(f); await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick(); await f.tick();
  expect(await f.review("changes", H1, [P1], ["--path", paths[0]])).toMatchObject({ ok: true });
  await f.tick(); await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
  await f.tick();
  expect(await f.review("changes", H2, [P1], ["--path", paths[1]])).toMatchObject({ ok: true });
  await f.tick();
  const p = remoteProbe(f, ["Peer"], opts.repo); peerAuthor(f, "codex", opts.repo); const intent = p.plan();
  for (const dir of ["home", "tmp", "run", "bin", ".git", "priv", "priv/.git"]) mkdirSync(join(f.dir, dir));
  const priv = join(f.dir, "priv"), log = join(f.dir, "git.log");
  writeFileSync(log, "");
  const spec = join(f.dir, "spec.md"); writeFileSync(spec, "Specification and acceptance criteria.\n");
  f.db.query("UPDATE tasks SET spec = ? WHERE id = 'T1'").run(spec);
  writeFileSync(join(f.dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: opts.clone === false ? [f.dir] : [f.dir, priv], createdAt: "" }] }));
  writeFileSync(join(f.dir, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true, projects: { p: {
    maxActiveWorkers: 0, repoDir: f.dir, requiredChecks: ["check"], remote: { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15 },
  } } }));
  writeFileSync(join(f.dir, "lend.json"), JSON.stringify({ version: 2, enabled: false, lend: [], borrow: p.context.borrow }));
  writeFileSync(join(f.dir, "peers.json"), JSON.stringify({ httpPeers: [{ name: "Peer", addedAt: "" }], pendingInvites: [] }));
  recordHello(f.db, "Peer", "abcd-bbbb-cccc-dddd", { v: 1, proto: 3, boot: "private-diff", seq: 1,
    grant: { until: Date.now() + 600000, roles: ["write", "review"], repos: ["o/r", "o/private"], ordersPerDay: 100, ordersLeftToday: 100 },
    slots: { codex: { total: 3, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null }, Date.now());
  fakeGit(join(f.dir, "bin"), log, f.dir, priv, opts.git ?? "ok");
  if (opts.publicGit === "ok") {
    writeFileSync(join(f.dir, "bin", "git"), `#!/bin/sh\necho "$*" >> "${log}"\ncase " $* " in *" diff --stat "*) echo "public diff: 2 files";; *) exit 71;; esac\n`);
  }
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const env = testChildEnv({ HOME: join(f.dir, "home"), TMPDIR: join(f.dir, "tmp"), PATH: `${join(f.dir, "bin")}:/usr/bin:/bin`,
    CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_RUNTIME_DIR: join(f.dir, "run"), CLAUDESTRA_SCHEDULER_SERVICE: "1",
    [SCHEDULER_LEASE_ENV]: encodeLease({ singleton: { path: singletonPath, token: singleton.token }, maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    try { return JSON.parse(out.trim().split("\n").at(-1)!); } catch { throw new Error(`CLI produced no JSON: ${out}\n${err}`); }
  };
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite")), notices: string[] = [];
  const card = { db: reader.get()!, task: f.task(), opts: { registry: [], maxWorkers: 0 }, deps: { ...f.tickDeps, manager,
    borrow: async () => [...p.context.borrow], notifyPm: async (_task: unknown, text: string) => { notices.push(text); } } };
  const tick = () => driveConvergence(card, getIntent(card.db, intent.id)!, sendNotice);
  const gitLog = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const material = () => {
    const ev = listEvents(card.db, { project: "p", target: "T1" }).find((e) => e.dedupKey === `scheduler:${intent.id}:materials`);
    return ev ? readFileSync(String(ev.data.material), "utf8") : null;
  };
  const wire = () => remoteOrder(card.db, intent.id)?.wire.inputs.join("\n") ?? "";
  const close = () => { reader.close(); singleton.release(); maintenance.release(); f.close(); };
  return { f, intent, db: card.db, priv, paths, reports, notices, manager, tick, gitLog, material, wire, close };
}

/** The repair-diff section of every history round, so headers (which name the reviewed heads) stay out of the SHA check. */
const diffSections = (text: string): string[] => [...text.matchAll(/修复 diff 摘要：\n([\s\S]*?)\n\n复现 probe：/g)].map((m) => m[1]);

test("[验收线 1] a private card reads its diff in its own clone, pools to the peer, and never fetches or diffs the public repo", async () => {
  const p = await cliFixture({ repo: "o/private" });
  try {
    const before = listEvents(p.db, { project: "p", target: "T1" }).length;
    expect(await p.tick()).toMatchObject({ step: "pooled" });
    expect(remoteOrder(p.db, p.intent.id)?.peer).toBe("Peer");
    expect(listEvents(p.db, { project: "p", target: "T1" }).length).toBeGreaterThan(before);
    expect(p.material()).toContain("private diff: 1 file");
    expect(p.wire()).toContain("private diff: 1 file");
    expect(getIntent(p.db, p.intent.id)?.status).toBe("submitted");
    const log = p.gitLog();
    expect(log).toContain(`-C ${p.priv} diff --stat ${H1} ${H2}`);
    expect(log.some((l) => / fetch( |$)/.test(` ${l}`))).toBe(false);
    expect(log.some((l) => l.startsWith(`-C ${p.f.dir} diff`))).toBe(false);
  } finally { p.close(); }
}, 30_000);

for (const [name, opts, why] of [
  ["(a) no clone in the project dirs", { clone: false }, "diff 摘要不可用：项目 dirs 里没有 o/private 的 clone"],
  ["(b) the clone lacks the commits (exit 128)", { git: "bad" }, "diff 摘要不可用：本机 o/private clone 读不到这两个提交（git 退出码 128）"],
  ["(c) the clone's diff times out", { git: "sleep" }, "diff 摘要不可用：本机 o/private clone 读不到这两个提交（超时）"],
] as const) {
  test(`[验收线 2] ${name}: the order still pools with an unavailable line and no git stderr`, async () => {
    const p = await cliFixture({ repo: "o/private", ...opts });
    try {
      expect(await p.tick()).toMatchObject({ step: "pooled" });
      const material = p.material()!;
      expect(material).toContain(why);
      expect(p.wire()).toContain(why.normalize("NFKC")); // the outbound wire folds full-width punctuation
      for (const text of [material, p.wire()]) expect(text).not.toContain("fatal");
      for (const section of diffSections(material)) expect(section).not.toMatch(/[0-9a-f]{40}/);
      expect(p.gitLog().some((l) => / fetch( |$)/.test(` ${l}`))).toBe(false);
      expect(getIntent(p.db, p.intent.id)?.status).toBe("submitted");
    } finally { p.close(); }
  }, 60_000);
}

test("[验收线 4] a public card keeps the exact argv, material bytes, and the invalid failure", async () => {
  const ok = await cliFixture({ publicGit: "ok" });
  try {
    expect(await ok.tick()).toMatchObject({ step: "pooled" });
    expect(ok.gitLog().filter((l) => l.includes(" diff "))).toEqual([`-C ${ok.f.dir} diff --stat ${H1} ${H2}`]);
    expect(ok.gitLog().some((l) => l.includes("remote get-url"))).toBe(false);
    const expected = [FIX_STRATEGY_RULE, DISPUTE_RULE,
      `## 第 1 轮 · ${H1}\n\n报告原文（${ok.paths[0]}）：\n${ok.reports[0]}\n\n修复 diff 摘要：\n首轮审查前没有上一轮修复区间\n\n复现 probe：\n${P1.probe}`,
      `## 第 2 轮 · ${H2}\n\n报告原文（${ok.paths[1]}）：\n${ok.reports[1]}\n\n修复 diff 摘要：\npublic diff: 2 files\n\n\n复现 probe：\n${P1.probe}`].join("\n\n");
    expect(ok.material()).toBe(expected);
  } finally { ok.close(); }
  const bad = await cliFixture({});
  try {
    const r = await bad.manager("ledger", "scheduler-convergence", bad.intent.id, "--max-workers", "0");
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(String(r.error).startsWith("修复 diff 摘要读取失败")).toBe(true);
    expect(bad.material()).toBeNull();
  } finally { bad.close(); }
}, 60_000);

test("[验收线 3] a local private author keeps reading its own worktree with the main argv", async () => {
  const g = await repeatedFix(), old = process.env.PATH;
  try {
    g.db.run("UPDATE tasks SET pr = 'https://github.com/o/private/pull/7', extra = json_set(extra, '$.fileGlobs', json('[\"repo:o/private/src/lib/x.ts\"]')) WHERE id = 'T1'");
    const probe = convergenceProbe(g), intent = probe.plan();
    delete probe.deps.diffSummary;
    const bin = join(g.dir, "bin"), log = join(g.dir, "git.log");
    mkdirSync(bin); writeFileSync(log, "");
    fakeGit(bin, log, join(g.dir, "public-elsewhere"), g.dir, "ok");
    process.env.PATH = `${bin}:${old}`;
    await fixSwapStep(g.db, g.at("scheduler"), intent.id, probe.deps);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes(" diff "))).toEqual([`-C ${g.dir} diff --stat ${H1} ${H2}`]);
    const ev = listEvents(g.db, { project: "p", target: "T1" }).find((e) => e.dedupKey === `scheduler:${intent.id}:materials`)!;
    expect(readFileSync(String(ev.data.material), "utf8")).toContain("private diff: 1 file");
  } finally { process.env.PATH = old; g.close(); }
}, 30_000);

const card = (repo: string | null) => ({ project: "p", pr: repo ? `https://github.com/${repo}/pull/7` : null,
  extra: { fileGlobs: [repo ? `repo:${repo}/src/x.ts` : "src/x.ts"] } });
const io = (origins: Record<string, string>, clone: string | null): DiffDirIO => ({ origin: (d) => origins[d] ?? null, dirFor: () => clone });
const never = async () => { throw new Error("git must not run"); };

test("[验收线 2] a private card's injected diff reader that throws degrades; one that is never given a clone is not called", async () => {
  let called: string[] = [];
  const injected = async (dir: string) => { called.push(dir); throw new Error(`fatal: bad object ${"a".repeat(40)} in /secret/path`); };
  const read = diffSummarizer(card("o/private"), "/pub", never, injected, io({ "/pub": "o/r" }, "/clone"));
  expect(await read(H1, H2)).toBe("diff 摘要不可用：本机 o/private clone 读不到这两个提交（摘要读取出错）");
  expect(called).toEqual(["/clone"]);
  called = [];
  const none = diffSummarizer(card("o/private"), "/pub", never, injected, io({ "/pub": "o/r" }, null));
  expect(await none(H1, H2)).toBe("diff 摘要不可用：项目 dirs 里没有 o/private 的 clone");
  expect(called).toEqual([]);
});

test("directory choice: public cards are untouched, a source already on the card's repo wins (any case), else the project clone", () => {
  expect(privateDiffDir(card(null), "/pub", io({}, "/clone"))).toBeNull();
  expect(privateDiffDir(card("o/private"), "/wt", io({ "/wt": "O/Private" }, "/clone"))).toEqual({ repo: "o/private", dir: "/wt" });
  expect(privateDiffDir(card("o/private"), "/pub", io({ "/pub": "o/r" }, "/clone"))).toEqual({ repo: "o/private", dir: "/clone" });
  const prOnly = { ...card("o/private"), pr: "https://github.com/o/fork/pull/9" };
  expect(privateDiffDir(prOnly, "/pub", io({}, null))).toEqual({ repo: "o/fork", dir: null });
});

test("a private card's first round keeps the first-round line, and only the stdout of a clean diff is kept", async () => {
  const runs: string[][] = [];
  const run = async (dir: string, from: string, to: string) => { runs.push([dir, from, to]); return { code: 0, stdout: "x | 1 +\n", stderr: "", timedOut: false }; };
  const read = diffSummarizer(card("o/private"), "/pub", run, undefined, io({}, "/clone"));
  expect(await read(null, H1)).toBe("首轮审查前没有上一轮修复区间");
  expect(await read(H1, H2)).toBe("x | 1 +\n");
  expect(runs).toEqual([["/clone", H1, H2]]);
});

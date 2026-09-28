/**
 * `ledger verify`（src/manager/ledger-verify.ts）+ 事实采集（src/lib/ledger-verify-facts.ts）+ recordVerify：
 * 外部命令全换成假的（gh / git / lsof / launchctl / ps），核对：全过同事务推 verified、没过只记事件不推、daemon 代码目录与重启时刻、
 * extra 只加不减、豁免、dry-run 不写库、角色、code 任务必须挂 PR、非本仓库项目只核证据、stage 直推 verified 被堵。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, getTask, listEvents, LedgerError, openLedger } from "../src/lib/ledger-store.js";
import type { FactsDeps } from "../src/lib/ledger-verify-facts.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { createTask, moveStage, recordVerify, setMeta } from "../src/lib/ledger-write.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM = "agent-claudestra";
const EXE = "agent-task-t8g";
const MERGED = Date.parse("2026-09-28T12:00:00Z");
const PULLED = MERGED + 120_000;
const DAEMON_CWD = "/srv/claudestra";

const REPO_FILES: Record<string, string> = {
  "src/bridge.ts": `import "./bridge/x.js";\nimport "./lib/shared.js";`,
  "src/bridge/x.ts": "",
  "src/cron.ts": `import "./lib/shared.js";`,
  "src/launcher.ts": "",
  "src/lib/shared.ts": "",
};

let db: Database;
let calls: string[];
let sc: {
  files: string[] | null;
  state: string;
  branch: string;
  ghFails: boolean;
  mergeInMain: boolean;
  localWeb: string | null;
  relay: { enabled: boolean; base?: string } | null;
  relayWeb: string | null;
  bridgeStart: number;
  codeHasMerge: boolean;
  cwdIsRepo: boolean;
  worktreeClean: boolean;
  origin: string | null;
  mainRepoOk: boolean;
  mergeParents: number;
  mainRepo: string;
  /** 项目里别的目录的 origin（一个项目登记多个仓库）；missing = 不存在的目录 */
  origins: Record<string, string>;
  missing: string[];
  projects: ProjectDef[];
  sizes: Record<string, number>;
};

const proj = (id: string, dirs: string[]): ProjectDef => ({ id, name: id, dirs, createdAt: "" });
const out = (code: number, stdout = "", stderr = "") => Promise.resolve({ code, stdout, stderr });
const lstart = (ms: number) => new Date(ms).toString(); // 与 LC_ALL=C 的 lstart 一样能被 Date.parse 读（本地时区）

/** 假的外部命令：期望的网页提交 w1；w2 是 w1 的后代；old 更早。daemon 的代码目录 reflog：pull 那一条含合并提交，之前那条不含 */
function fakeRun(argv: string[]) {
  const cmd = argv.join(" ");
  calls.push(cmd);
  const at = (repo: string, rest: string) => cmd === `git -C ${repo} ${rest}`;
  if (cmd.startsWith("gh pr view")) {
    if (sc.ghFails) return out(1, "", "gh: not logged in\n");
    return out(0, JSON.stringify({ state: sc.state, mergeCommit: { oid: "m1" }, mergedAt: new Date(MERGED).toISOString(), headRefOid: "h1", headRefName: sc.branch }));
  }
  if (cmd.startsWith("gh api --paginate repos/x/y/pulls/150/files")) return sc.files ? out(0, sc.files.join("\n") + "\n") : out(1, "", "HTTP 502");
  if (at("/repo", "fetch --quiet origin main")) return out(0);
  if (at("/repo", "merge-base --is-ancestor m1 origin/main")) return out(sc.mergeInMain ? 0 : 1);
  if (cmd.startsWith("git -C /repo log -1 --format=%H m1 -- web")) return out(0, "w1\n");
  if (cmd.startsWith("git -C /repo cat-file -e")) return out(["w1^{commit}", "w2^{commit}", "old^{commit}"].includes(argv.at(-1)!) ? 0 : 128);
  if (cmd.startsWith("git -C /repo merge-base --is-ancestor w1 ")) return out(["w1", "w2"].includes(argv.at(-1)!) ? 0 : 1);
  if (at("/repo", "rev-parse --path-format=absolute --git-common-dir")) return sc.mainRepoOk ? out(0, `${sc.mainRepo}/.git\n`) : out(128, "", "fatal");
  if (at("/repo", "remote get-url origin")) return sc.origin ? out(0, `${sc.origin}\n`) : out(2, "", "no such remote");
  const other = cmd.match(/^git -C (\S+) remote get-url origin$/)?.[1];
  if (other) return sc.origins[other] ? out(0, `${sc.origins[other]}\n`) : out(2, "", "no such remote");
  if (at("/repo", "rev-list --parents -n 1 m1")) return out(0, ["m1", "p0", "p9"].slice(0, sc.mergeParents + 1).join(" ") + "\n");
  if (at("/repo", "diff --name-only m1^1 m1")) return out(0, "src/bridge/x.ts\nweb/a.tsx\n");
  if (at(DAEMON_CWD, "rev-parse --git-dir")) return sc.cwdIsRepo ? out(0, ".git\n") : out(128, "", "fatal: not a git repository");
  if (cmd.startsWith(`git -C ${DAEMON_CWD} diff --quiet HEAD --`)) return out(sc.worktreeClean ? 0 : 1);
  if (at(DAEMON_CWD, "cat-file -e m1^{commit}")) return out(sc.codeHasMerge ? 0 : 128);
  if (at(DAEMON_CWD, "merge-base --is-ancestor m1 HEAD")) return out(sc.codeHasMerge ? 0 : 1);
  if (cmd.startsWith(`git -C ${DAEMON_CWD} reflog`)) return out(0, `aaaa002 HEAD@{${PULLED / 1000}}\naaaa001 HEAD@{${(MERGED - 60_000) / 1000}}\n`);
  if (at(DAEMON_CWD, "merge-base --is-ancestor m1 aaaa002")) return out(0);
  if (at(DAEMON_CWD, "merge-base --is-ancestor m1 aaaa001")) return out(1);
  if (cmd.startsWith("lsof -nP -t")) return out(0, "4242\n");
  if (cmd.startsWith("lsof -a -d cwd -p")) return out(0, `p${argv[4]}\nfcwd\nn${DAEMON_CWD}\n`);
  if (cmd === "launchctl list") return out(0, "PID\tStatus\tLabel\n555\t0\tcom.claudestra.cron\n");
  if (cmd === "ps -o lstart= -p 4242") return out(0, `${lstart(sc.bridgeStart)}\n`);
  if (cmd === "ps -o lstart= -p 555") return out(0, `${lstart(PULLED + 3600_000)}\n`);
  return out(127, "", `unexpected ${cmd}`);
}

const fakeDeps = (over: Partial<FactsDeps> = {}): FactsDeps => ({
  repoRoot: "/repo",
  run: fakeRun,
  localWebCommit: () => sc.localWeb,
  relayStatus: async () => sc.relay,
  relayWebCommit: async () => sc.relayWeb,
  bridgePort: () => 3847,
  fileSize: (p) => sc.sizes[p] ?? null,
  isDir: (p) => !sc.missing.includes(p),
  readRepoFile: (rel) => REPO_FILES[rel] ?? null,
  ...over,
});

async function run(actor: string, args: string[], facts: Partial<FactsDeps> = {}) {
  const reg = { socket: "", agents: { [PM]: { status: "active", projectId: P }, [EXE]: { status: "active", projectId: P } } } as unknown as Registry;
  return runLedger(args, {
    db, actor, actorProject: P, projectIds: [P], loadRegistry: async () => reg, saveRegistry: async () => {}, now: () => 5_000,
    factsDeps: () => fakeDeps(facts), projects: () => sc.projects,
  }) as Promise<Record<string, any>>;
}
const pm = (...args: string[]) => run(PM, args);

function liveTask(id = "T9", over: Record<string, unknown> = {}) {
  createTask(db, { actor: "owner" }, {
    project: P, id, title: "t", kind: "code", agent: EXE, pm: PM, pr: "https://github.com/x/y/pull/150", branch: "task/t9", stage: "live", round: 1, ...over,
  });
}

beforeEach(() => {
  calls = [];
  sc = { files: ["web/a.tsx", "src/bridge/x.ts"], state: "MERGED", branch: "task/t9", ghFails: false, mergeInMain: true, localWeb: "w1",
    relay: { enabled: true, base: "relay.example" }, relayWeb: "w2", bridgeStart: PULLED + 60_000, codeHasMerge: true,
    cwdIsRepo: true, worktreeClean: true, origin: "git@github.com:x/y.git", mainRepoOk: true, mergeParents: 2, mainRepo: "/repo", origins: {}, missing: [], projects: [proj(P, ["/repo"])], sizes: {} };
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] });
  liveTask();
});
afterEach(() => closeLedger(":memory:"));

const stages = (id = "T9") => listEvents(db, { project: P, target: id }).filter((e) => e.kind === "stage").map((e) => `${e.data.from}>${e.data.to}`);
const ids = (r: Record<string, any>) => r.checks.map((c: any) => `${c.id}:${c.status}`);

describe("ledger verify：全过与没过", () => {
  test("全过：记 verify 事件（每项带模板与证据）并同事务推 live → verified", async () => {
    const r = await pm("verify", "T9");
    expect(r).toMatchObject({ ok: true, moved: true, result: "pass", checklistSource: "files", task: { stage: "verified" } });
    expect(ids(r)).toEqual(["pr-merged:pass", "web-local:pass", "web-relay:pass", "daemon-bridge:pass"]);
    expect(r.event.data.checks[3]).toMatchObject({ tpl: expect.stringContaining("{daemon}"), evidence: { cwd: DAEMON_CWD, codeHasMerge: true, headSince: PULLED } });
    expect(stages()).toEqual(["live>verified"]);
  });
  test("bridge 在合并后、代码目录 ff 之前重启：fail，只记事件、留在 live、ok:false", async () => {
    sc.bridgeStart = MERGED + 30_000;
    const r = await pm("verify", "T9");
    expect(r).toMatchObject({ ok: false, code: "unverified", moved: false, result: "fail", task: { stage: "live" } });
    expect(r.error).toContain("daemon-bridge（fail）");
    expect(stages()).toEqual([]);
  });
  test("代码目录 HEAD 含合并提交但工作区还是旧文件 → fail；工作目录不是 git 仓库 → unknown 写明原因", async () => {
    sc.worktreeClean = false;
    expect((await pm("verify", "T9", "--dry-run")).blocking).toContain("和 HEAD 不一致");
    expect(calls).toContain(`git -C ${DAEMON_CWD} diff --quiet HEAD -- :(top)src/bridge/x.ts`); // 路径相对仓库根，不随 daemon 的 cwd 变
    sc.worktreeClean = true;
    sc.cwdIsRepo = false;
    calls = [];
    const r = await pm("verify", "T9", "--dry-run");
    expect(r).toMatchObject({ result: "unknown", blocking: expect.stringContaining("不是 git 仓库") });
    expect(calls.some((c) => c.includes(`${DAEMON_CWD} cat-file`))).toBe(false);
  });
  test("bridge 的代码目录还没更新到合并提交：fail（哪怕进程启动晚于合并）", async () => {
    sc.codeHasMerge = false;
    expect((await pm("verify", "T9")).blocking).toContain("先把那里更新到 main");
  });
  test("PR 来自别的分支 → fail；合并提交不在 origin/main → fail", async () => {
    sc.branch = "task/other";
    expect((await pm("verify", "T9", "--dry-run")).blocking).toContain("不是任务的分支");
    sc.branch = "task/t9";
    sc.mergeInMain = false;
    expect((await pm("verify", "T9", "--dry-run")).blocking).toContain("不在 origin/main");
  });
});

describe("检查单：extra 只加不减、推断不全、改动的文件决定 daemon", () => {
  test("extra.checks 空数组报错；写了 cron 就在推断之上加一项（web / bridge 仍在）", async () => {
    liveTask("T12", { extra: { checks: [] } });
    expect(await pm("verify", "T12")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("非空数组") });
    liveTask("T13", { extra: { checks: ["cron"] } });
    const r = await pm("verify", "T13", "--dry-run");
    expect(r.checklistSource).toBe("files+extra");
    expect(r.checks.map((c: any) => c.id)).toEqual(["pr-merged", "web-local", "web-relay", "daemon-bridge", "daemon-cron"]);
  });
  test("改的是 cron 与 bridge 共用的 lib：两个 daemon 都要核；没 web 改动就不问中继", async () => {
    sc.files = ["src/lib/shared.ts"];
    let relayAsked = false;
    const r = await run(PM, ["verify", "T9", "--dry-run"], { relayStatus: async () => ((relayAsked = true), null) });
    expect(r.checks.map((c: any) => c.id)).toEqual(["pr-merged", "daemon-bridge", "daemon-cron"]);
    expect(relayAsked).toBe(false);
  });
  test("gh 拿不到文件列表：真正的 merge commit 从本地 diff 推；推不出（squash / rebase 又拿不到 PR head）→ incomplete → unknown", async () => {
    sc.files = null;
    const r = await pm("verify", "T9", "--dry-run");
    expect(r).toMatchObject({ result: "pass", checklistSource: "files" });
    expect(r.checks.map((c: any) => c.id)).toEqual(["pr-merged", "web-local", "web-relay", "daemon-bridge"]);
    sc.mergeParents = 1;
    expect(await pm("verify", "T9", "--dry-run")).toMatchObject({ result: "unknown", blocking: expect.stringContaining("推断不出检查单") });
    sc.files = [];
    expect((await pm("verify", "T9", "--dry-run")).result).toBe("unknown");
  });
  test("task-new / task-set 写 extra.checks 时就校验（空数组、未知组名当场报错）", async () => {
    const rev = getTask(db, "T9")!.rev;
    expect(await pm("task-set", "T9", "--rev", String(rev), "--extra", '{"checks":[]}')).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("非空数组") });
    expect(await pm("task-set", "T9", "--rev", String(rev), "--extra", '{"checks":["webb"]}')).toMatchObject({ ok: false, code: "invalid" });
    expect(await pm("task-set", "T9", "--rev", String(rev), "--extra", '{"checks":["cron"],"goal":"g"}')).toMatchObject({ ok: true });
    expect(await pm("task-new", "T18", "--title", "t", "--kind", "code", "--extra", '{"checks":"web"}')).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("豁免与角色", () => {
  test("中继查不到 → unknown，PM 带理由豁免后推进；没理由报错；pr-merged 不能豁免", async () => {
    sc.relayWeb = null;
    expect(await pm("verify", "T9")).toMatchObject({ ok: false, result: "unknown" });
    expect(await pm("verify", "T9", "--waive", "web-relay")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("--text") });
    sc.state = "OPEN";
    expect(await pm("verify", "T9", "--waive", "pr-merged", "--text", "x")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("不能豁免") });
    sc.state = "MERGED";
    const r = await pm("verify", "T9", "--waive", "web-relay", "--text", "中继维护中");
    expect(r).toMatchObject({ ok: true, moved: true, result: "pass" });
    expect(r.event.data.checks.find((c: any) => c.id === "web-relay")).toMatchObject({ status: "unknown", waived: "中继维护中" });
  });
  test("--dry-run：执行者也能跑、不写库；正式跑只有 PM / master / owner；不在 live 不能正式跑", async () => {
    sc.localWeb = "old";
    const before = listEvents(db, { project: P, target: "T9" }).length;
    expect(await run(EXE, ["verify", "T9", "--dry-run"])).toMatchObject({ ok: true, dryRun: true, result: "fail" });
    expect(listEvents(db, { project: P, target: "T9" }).length).toBe(before);
    expect(await run(EXE, ["verify", "T9"])).toMatchObject({ ok: false, code: "forbidden" });
    createTask(db, { actor: "owner" }, { project: P, id: "T10", title: "t", kind: "code", agent: EXE, pr: "#1", stage: "merge", round: 1 });
    expect(await pm("verify", "T10")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("--dry-run") });
  });
  test("合并之后执行者不能再改 PR / 分支 / head，PM 可以", async () => {
    const rev = getTask(db, "T9")!.rev;
    expect(await run(EXE, ["task-set", "T9", "--rev", String(rev), "--pr", "https://github.com/x/y/pull/999"])).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(EXE, ["task-set", "T9", "--rev", String(rev), "--model", "m"])).toMatchObject({ ok: true });
    expect(await pm("task-set", "T9", "--rev", String(rev + 1), "--branch", "task/t9b")).toMatchObject({ ok: true });
  });
});

describe("没 PR 与别的项目", () => {
  test("属于本仓库的 code 任务没挂 PR → 直接报错；ops 任务没 PR 只核证据文件，不跑 gh / git", async () => {
    liveTask("T11", { pr: null });
    expect(await pm("verify", "T11")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("没挂 PR") });
    liveTask("T14", { pr: null, kind: "ops" });
    calls = [];
    expect(await pm("verify", "T14")).toMatchObject({ ok: false, result: "fail", checklistSource: "evidence" });
    sc.sizes["docs/T14.report.md"] = 800;
    expect(await pm("verify", "T14", "--evidence", "docs/T14.report.md")).toMatchObject({ ok: true, moved: true });
    expect(calls.filter((c) => !c.includes("rev-parse"))).toEqual([]);
  });
  test("明确不属于本仓库：项目目录不含本仓库（PR 链接也指向别的仓库）→ 只核证据文件，带可翻译的说明", async () => {
    sc.origin = "https://github.com/other/repo.git";
    sc.projects = [proj(P, ["/somewhere/else"])];
    const r = await pm("verify", "T9", "--dry-run");
    expect(r).toMatchObject({ checklistSource: "evidence", noteTpl: expect.stringContaining("{prRepo}"), noteParams: { prRepo: "x/y", origin: "other/repo" } });
    expect(r.checks.map((c: any) => c.id)).toEqual(["manual-evidence"]);
    liveTask("T15", { pr: null, kind: "ops" });
    expect(await pm("verify", "T15", "--dry-run")).toMatchObject({ checklistSource: "evidence", note: expect.stringContaining("项目 claude-orchestrator") });
  });
  test("按目录明确不属于本仓库的 code 任务不强制挂 PR，只核证据", async () => {
    sc.projects = [proj(P, ["/somewhere/else"])];
    liveTask("T11", { pr: null });
    sc.sizes["docs/T11.report.md"] = 800;
    expect(await pm("verify", "T11", "--evidence", "docs/T11.report.md")).toMatchObject({ ok: true, moved: true, checklistSource: "evidence" });
    liveTask("T23", { pr: null });
    sc.projects = [proj(P, [])]; // 判断不了归属：照样要挂 PR
    expect(await pm("verify", "T23")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("没挂 PR") });
  });
  // 7 / 7b / 7c：PR 链接指向别的仓库，但项目目录没说不属于 → 判断不了，证据文件也放不过去
  const mismatch = async (id: string) => {
    sc.sizes["/etc/hosts"] = 100;
    const r = await pm("verify", id, "--evidence", "/etc/hosts");
    expect(r).toMatchObject({ ok: false, result: "unknown", noteTpl: expect.stringContaining("PR 链接和项目对不上"), task: { stage: "live" } });
    expect(r.error).toContain("PR 链接和项目对不上");
    expect(r.event.data).toMatchObject({ incomplete: true, incompleteReason: "ownership" });
  };
  test("7：项目目录就是本仓库，PR 填成别的仓库 → unknown", async () => {
    liveTask("T20", { pr: "https://github.com/someone/other/pull/9" });
    await mismatch("T20");
  });
  test("7b：项目没登记目录（或 projects.json 里没有这个项目），PR 填成别的仓库 → unknown", async () => {
    liveTask("T21", { pr: "https://github.com/someone/other/pull/9" });
    sc.projects = [proj(P, [])];
    await mismatch("T21");
    sc.projects = [];
    await mismatch("T21");
  });
  test("7c：PR 的 owner 打错一个字 → unknown", async () => {
    sc.origin = "git@github.com:shawnlu96/claudestra.git";
    liveTask("T22", { pr: "https://github.com/shawnlu69/claudestra/pull/150" });
    await mismatch("T22");
  });
  test("判断不了归属（origin 读不到 / git 读不到本仓库）→ 推断不全、不放行，证据文件也救不了", async () => {
    sc.origin = null;
    sc.sizes["/etc/hosts"] = 100;
    const r = await pm("verify", "T9", "--evidence", "/etc/hosts");
    expect(r).toMatchObject({ ok: false, result: "unknown", blocking: expect.stringContaining("判断不了任务所属项目"), task: { stage: "live" } });
    expect(r.event.data).toMatchObject({ incomplete: true, incompleteReason: "ownership" });
    liveTask("T16", { pr: null, kind: "ops" });
    sc.mainRepoOk = false;
    expect(await pm("verify", "T16", "--evidence", "/etc/hosts")).toMatchObject({ ok: false, result: "unknown" });
  });
  test("挂 PR（#N 短引用，只能按目录判）的 code 任务：项目目录是本仓库的上级目录 → 按全套核", async () => {
    sc.mainRepo = "/w/claudestra";
    sc.projects = [proj(P, ["/w"])];
    liveTask("T17", { pr: "#150" });
    const r = await pm("verify", "T17", "--dry-run");
    expect(r).toMatchObject({ checklistSource: "files" });
    expect(r.checks.map((c: any) => c.id)).toEqual(["pr-merged", "web-local", "web-relay", "daemon-bridge"]);
    expect(r.note).toBeUndefined();
  });
  test("伞形根只精确匹配、按最具体的目录命中：项目目录是「/」或本仓库归了别的项目 → 不属于，只核证据", async () => {
    sc.mainRepo = "/w/claudestra";
    liveTask("T19", { pr: "#150" });
    sc.projects = [proj(P, ["/"])];
    expect(await pm("verify", "T19", "--dry-run")).toMatchObject({ checklistSource: "evidence", note: expect.stringContaining("目录里没有本仓库") });
    sc.projects = [proj(P, ["/w"]), proj("other", ["/w/claudestra"])];
    expect(await pm("verify", "T19", "--dry-run")).toMatchObject({ checklistSource: "evidence" });
  });
  test("一个项目登记了多个仓库：claudestra-relay 的 PR → 属于该项目的另一个仓库，只核证据；本仓库的 PR 照旧按全套核", async () => {
    sc.projects = [proj(P, ["/repo", "/relay"])];
    sc.origins["/relay"] = "git@github.com:shawnlu96/claudestra-relay.git";
    liveTask("T30", { pr: "https://github.com/shawnlu96/claudestra-relay/pull/3" });
    const dry = await pm("verify", "T30", "--dry-run");
    expect(dry).toMatchObject({ checklistSource: "evidence", noteTpl: expect.stringContaining("另一个仓库"), noteParams: { prRepo: "shawnlu96/claudestra-relay", dir: "/relay" } });
    sc.sizes["docs/T30.report.md"] = 500;
    expect(await pm("verify", "T30", "--evidence", "docs/T30.report.md")).toMatchObject({ ok: true, moved: true });
    expect((await pm("verify", "T9", "--dry-run")).checks.map((c: any) => c.id)).toEqual(["pr-merged", "web-local", "web-relay", "daemon-bridge"]);
    sc.missing = ["/relay"]; // 那个目录不在了：认不出是它的仓库 → 回到「对不上」
    liveTask("T31", { pr: "https://github.com/shawnlu96/claudestra-relay/pull/3" });
    expect(await pm("verify", "T31", "--dry-run")).toMatchObject({ result: "unknown", noteTpl: expect.stringContaining("对不上") });
  });
  test("登记的目录不存在 / 是相对路径 / 就是本仓库却被别的项目占了 → 判断不了，不判「不属于」", async () => {
    liveTask("T32", { pr: "https://github.com/someone/other/pull/9" });
    liveTask("T33", { pr: null, kind: "ops" });
    const cases: [ProjectDef[], string[]][] = [
      [[proj(P, ["/gone"])], ["/gone"]],
      [[proj(P, ["rel/dir"])], []],
      [[proj("other", ["/repo"]), proj(P, ["/repo"])], []],
    ];
    for (const [projects, missing] of cases) {
      sc.projects = projects;
      sc.missing = missing;
      expect(await pm("verify", "T32", "--dry-run")).toMatchObject({ result: "unknown" });
      expect(await pm("verify", "T33", "--dry-run")).toMatchObject({ result: "unknown" });
    }
    sc.missing = [];
    sc.projects = [proj(P, ["/gone"])]; // 目录在、只是不含本仓库：照旧判不属于
    expect(await pm("verify", "T33", "--dry-run")).toMatchObject({ checklistSource: "evidence" });
  });
  test("没配中继 → web-relay 不适用算过；本机网页是后代版本也算过", async () => {
    sc.relay = { enabled: false };
    sc.localWeb = "w2";
    expect(await pm("verify", "T9")).toMatchObject({ ok: true, moved: true });
  });
  test("dedup：成功推进 verified 之后同一个键重试 → duplicate，而不是报「不在 live」；键用在别处 → dedup_mismatch", async () => {
    expect(await pm("verify", "T9", "--dedup", "ok1")).toMatchObject({ ok: true, moved: true });
    expect(await pm("verify", "T9", "--dedup", "ok1")).toMatchObject({ ok: true, duplicate: true });
    await pm("note", "T9", "随手记", "--dedup", "n1");
    expect(await pm("verify", "T9", "--dedup", "n1")).toMatchObject({ ok: false, code: "dedup_mismatch" });
  });
  test("dedup 重放：结论以当时记下的为准", async () => {
    sc.bridgeStart = MERGED - 1000;
    expect(await pm("verify", "T9", "--dedup", "v1")).toMatchObject({ ok: false });
    sc.bridgeStart = PULLED + 60_000;
    expect(await pm("verify", "T9", "--dedup", "v1")).toMatchObject({ ok: false, duplicate: true });
  });
});

describe("进 verified 只有一条路", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as LedgerError).code;
    }
    return null;
  };
  const clear = [{ id: "pr-merged", status: "pass" }];
  test("stage 直推 verified 被拒并提示改用 ledger verify；从 blocked 回到 verified 不受影响", async () => {
    expect(await pm("stage", "T9", "--from", "live", "--to", "verified")).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("ledger verify") });
    recordVerify(db, { actor: PM }, { taskId: "T9", result: "pass", data: { checks: clear } });
    moveStage(db, { actor: PM }, { taskId: "T9", from: "verified", to: "blocked" });
    expect(moveStage(db, { actor: PM }, { taskId: "T9", from: "blocked", to: "verified" }).row.stage).toBe("verified");
  });
  test("recordVerify：pass 但检查单推断不全 → invalid", () => {
    expect(code(() => recordVerify(db, { actor: PM }, { taskId: "T9", result: "pass", data: { checks: clear, incomplete: true } }))).toBe("invalid");
  });
  test("recordVerify：pass 但 checks 空 / 有没过没豁免 → invalid；执行者 → forbidden；不在 live → conflict", () => {
    expect(code(() => recordVerify(db, { actor: PM }, { taskId: "T9", result: "pass", data: {} }))).toBe("invalid");
    expect(code(() => recordVerify(db, { actor: PM }, { taskId: "T9", result: "pass", data: { checks: [{ id: "web-local", status: "fail" }] } }))).toBe("invalid");
    expect(code(() => recordVerify(db, { actor: EXE }, { taskId: "T9", result: "pass", data: { checks: clear } }))).toBe("forbidden");
    moveStage(db, { actor: PM }, { taskId: "T9", from: "live", to: "fix" });
    expect(code(() => recordVerify(db, { actor: PM }, { taskId: "T9", result: "pass", data: { checks: clear } }))).toBe("conflict");
  });
});

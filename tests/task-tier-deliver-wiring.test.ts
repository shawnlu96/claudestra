/**
 * 交付门控接线（src/lib/task-tier-deliver-wiring.ts）：经真实交付入口 ledger-write.ts deliver（`ledger deliver` 与出借交付共用），
 * 不直接调门控辅助函数。临时 git 仓库给实际 diff：docs 卡 fileGlobs 与实际 diff 双重校验，越界 / 重命名越界 / 删除越界 / 规格改版 / 读不到 diff 都拒、
 * 交付一笔不写；off 下 docs 卡暂停、不挂模板不记事件，非 docs 卡交付与旧路径一致；重新 on 后可重新校验。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeLedger, getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { WorkflowTemplate } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { gitDiffFiles, resetDocsTemplate, useDeliveredFilesPort } from "../src/lib/task-tier-docs-template.js";
import { useTaskTierPort } from "../src/lib/task-tier-models.js";
import { tierLaunchable } from "../src/lib/task-tier-spec.js";

const P = "d1-project", PM = { actor: "agent-d1-pm" };
const GLOBS = ["docs/**", "README.md"];
let db: Database, repo: string, dir: string, diffReads = 0;
const mode = (m: "on" | "observe" | "off") => useTaskTierPort({ policy: () => ({ mode: m, manualAfterMs: null, source: "config" }) });

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const put = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
/** 从 main 切一个分支，做 change，提交，回 main；返回交付 head */
function branch(name: string, change: () => void): string {
  git("checkout", "-q", "-b", name, "main");
  change();
  git("add", "-A");
  git("commit", "-q", "-m", name);
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  return head;
}

/**
 * 一张到了 build 的卡。code 卡经正式 setWorkflow 写流程；docs 卡的 task_workflows 行要等台账 CHECK 放开 docs（表迁移待 owner 拍板，
 * ask_mvbt05km826d6fbe86），这里只为测交付门控本身临时放开约束插一行——不证明 docs 能正式开卡落库。
 */
function card(id: string, template: string, globs = GLOBS): string {
  const agent = `agent-${id.toLowerCase()}`;
  createTask(db, PM, { project: P, id, title: id, kind: "code", agent, pm: PM.actor, extra: { fileGlobs: globs } });
  if (template === "docs") {
    db.run("PRAGMA ignore_check_constraints = ON");
    db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES (?, ?, 'docs', 3, 'auto', 'claude', 'manual', 1, 0, 0)`).run(id, P);
    db.run("PRAGMA ignore_check_constraints = OFF");
  } else {
    setWorkflow(db, PM, { taskId: id, taskRev: getTask(db, id)!.rev, template: template as WorkflowTemplate, templateVersion: 3, mode: "auto",
      authorFamily: "claude", fallback: "退 PM 人工" });
  }
  writeFileSync(join(dir, "tasks", `${id}.md`), `# ${id}\n模板：${template}\n\n## 背景\n`);
  moveStage(db, { actor: agent }, { taskId: id, from: "spec", to: "restate" });
  moveStage(db, PM, { taskId: id, from: "restate", to: "build" });
  return agent;
}
const send = (id: string, head: string) => deliver(db, { actor: `agent-${id.toLowerCase()}` }, { taskId: id, headSHA: head, moveFrom: "build" });
function refusal(fn: () => unknown): LedgerError {
  try { fn(); } catch (e) { if (e instanceof LedgerError) return e; throw e; }
  throw new Error("expected LedgerError");
}
const delivered = (id: string) => listEvents(db, { project: P, target: id }).filter((e) => e.kind === "deliver");
const checks = (id: string) => listEvents(db, { project: P, target: id }).filter((e) => e.data.op === "task_tier_check");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tier3e-wire-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  mkdirSync(join(dir, "tasks"));
  git("init", "-q", "-b", "main");
  put("README.md", "r\n"); put("docs/a.md", "a\n"); put("src/a.ts", "export {};\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM.actor] });
  setMeta(db, { actor: "owner" }, { project: P, key: "docsDir", value: dir });
  diffReads = 0;
  resetDocsTemplate(); // 同进程先跑的开卡测试可能已按缺省 on 挂上 docs（进程级）
  useDeliveredFilesPort((_db, _task, head) => (diffReads++, gitDiffFiles(repo, head)));
  mode("on");
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
  useDeliveredFilesPort(); useTaskTierPort(); resetDocsTemplate();
});

describe("[验收线 4] 真实交付入口：glob 与实际 diff 双重校验", () => {
  test("docs 卡：docs 下增改、README 改动 → 交付入账、推到 review，不记校验事件", () => {
    card("D1", "docs");
    const head = branch("d1", () => { put("docs/a.md", "a2\n"); put("docs/new/b.md", "b\n"); put("README.md", "r2\n"); });
    expect(send("D1", head).row).toMatchObject({ stage: "review", headSHA: head });
    expect(diffReads).toBe(1);
    expect(delivered("D1")).toHaveLength(1);
    expect(checks("D1")).toEqual([]);
    expect(tierLaunchable("docs")).toBe(true);
  });

  test.each([
    ["新增越界", () => put("src/b.ts", "x\n"), "src/b.ts 不在本卡 fileGlobs"],
    ["删除越界", () => unlinkSync(join(repo, "src/a.ts")), "src/a.ts 不在本卡 fileGlobs"],
    ["重命名越界（docs/a.md → src/a.md）", () => git("mv", "docs/a.md", "src/a.md"), "src/a.md 不在本卡 fileGlobs"],
    ["宽泛授权（diff 只动了文档也拒）", () => put("docs/x.md", "x\n"), null],
  ] as const)("docs 卡%s：拒绝、交付一笔不写、留一条校验事件", (_, change, why) => {
    const globs = why === null ? ["docs/**", "src/**"] : GLOBS;
    card("D2", "docs", globs);
    const head = branch("d2", change);
    const e = refusal(() => send("D2", head));
    expect(e.code).toBe("invalid");
    expect(e.message).toContain(why ?? "「src/**」超出 docs 范围");
    expect(delivered("D2")).toEqual([]);
    expect(getTask(db, "D2")).toMatchObject({ stage: "build", headSHA: null });
    expect(checks("D2").map((x) => [x.data.phase, x.data.tier, x.data.mode])).toEqual([["delivery", "docs", "on"]]);
  });

  test("规格改版 / 卡首声明换类型 / 读不到 diff：停止按 docs 交付，诊断要求纠正", () => {
    card("D3", "docs");
    const head = branch("d3", () => put("docs/a.md", "a3\n"));
    db.run("UPDATE tasks SET specRev = 2 WHERE id = 'D3'");
    expect(refusal(() => send("D3", head)).message).toContain("第 1 版改到第 2 版");
    db.run("UPDATE tasks SET specRev = 1 WHERE id = 'D3'");
    writeFileSync(join(dir, "tasks", "D3.md"), "# D3\n模板：code\n");
    expect(refusal(() => send("D3", head)).message).toContain("冲突");
    writeFileSync(join(dir, "tasks", "D3.md"), "# D3\n模板：docs\n");
    expect(refusal(() => send("D3", "f".repeat(40))).message).toContain("读不到交付的实际 diff");
    expect(delivered("D3")).toEqual([]);
    expect(send("D3", head).row.stage).toBe("review");
  });

  test("非 docs 卡：on 下照常交付，不读 diff、不记事件、不挂 docs", () => {
    card("C1", "code", ["src/**"]);
    const head = branch("c1", () => put("src/b.ts", "x\n"));
    expect(send("C1", head).row.stage).toBe("review");
    expect([diffReads, checks("C1").length, tierLaunchable("docs")]).toEqual([0, 0, false]);
  });

  test("observe：docs 越界只记会拒、照常交付", () => {
    mode("observe");
    card("D4", "docs");
    const head = branch("d4", () => put("src/b.ts", "x\n"));
    expect(send("D4", head).row.stage).toBe("review");
    expect(checks("D4").map((x) => x.data.mode)).toEqual(["observe"]);
  });
});

describe("[验收线 3] off：docs 卡暂停，原有模板不变；重新 on 后重新校验", () => {
  test("off：docs 交付拒（要求恢复开关或纠正规格），不读 diff、不挂模板、不记事件；code 卡交付与旧路径一致", () => {
    card("D5", "docs");
    card("C2", "code", ["src/**"]);
    const docsHead = branch("d5", () => put("docs/a.md", "a5\n"));
    const codeHead = branch("c2", () => put("src/b.ts", "x\n"));
    mode("on");
    expect(refusal(() => send("D5", "f".repeat(40))).code).toBe("invalid"); // on 下挂过一次
    expect(tierLaunchable("docs")).toBe(true);
    mode("off");
    const reads = diffReads, events = listEvents(db, { project: P }).length;
    const e = refusal(() => send("D5", docsHead));
    expect(e.message).toContain("taskTierModels 是 off");
    expect(e.message).toContain("纠正规格");
    expect(e.message).not.toContain("类型校验");
    expect(tierLaunchable("docs")).toBe(false);
    expect(diffReads).toBe(reads);
    expect(listEvents(db, { project: P }).length).toBe(events);
    const r = send("C2", codeHead);
    expect(r.row).toMatchObject({ stage: "review", headSHA: codeHead });
    expect(r.event).toMatchObject({ kind: "deliver", data: { round: 1, headSHA: codeHead, evidence: null } });
    expect(checks("C2")).toEqual([]);
    mode("on");
    expect(send("D5", docsHead).row.stage).toBe("review");
    expect(tierLaunchable("docs")).toBe(true);
  });
});

describe("[验收线 1、2、3] 冷启动的生产交付进程：只 import 台账模块、不手动注册，交付门控照样生效", () => {
  /** 独立 bun 子进程只加载 ledger-store / ledger-write（与 `ledger deliver`、MCP deliver 同一入口），开关与仓库目录走真实状态文件 */
  type Cold = { ok: boolean; stage?: string; code?: string; message?: string; launchable: boolean };
  /** entry = 只 import 台账写入口（旁路进程）还是连同开卡入口一起（manager / bridge / scheduler 都静态加载 dag-tools-start.ts） */
  function coldDeliver(id: string, head: string, policy: "on" | "off", entry: "ledger" | "start" = "start"): Cold {
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "recovery-policy.json"), JSON.stringify({ projects: { [P]: { keys: { taskTierModels: policy } } } }));
    writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: false, projects: { [P]: { maxActiveWorkers: 0, repoDir: repo, requiredChecks: ["check"] } } }));
    const lib = join(import.meta.dir, "..", "src", "lib");
    const script = join(dir, "cold.ts");
    writeFileSync(script, `
import { openLedger, LedgerError } from ${JSON.stringify(join(lib, "ledger-store.ts"))};
import { deliver } from ${JSON.stringify(join(lib, "ledger-write.ts"))};
import { tierLaunchable } from ${JSON.stringify(join(lib, "task-tier-spec.ts"))};
${entry === "start" ? `import ${JSON.stringify(join(lib, "dag-tools-start.ts"))};` : ""}
const db = openLedger(${JSON.stringify(join(dir, "ledger.sqlite"))});
let out;
const input = { taskId: ${JSON.stringify(id)}, headSHA: ${JSON.stringify(head)}, moveFrom: "build" };
try { out = { ok: true, stage: deliver(db, { actor: ${JSON.stringify(`agent-${id.toLowerCase()}`)} }, input).row.stage }; }
catch (e) { if (!(e instanceof LedgerError)) throw e; out = { ok: false, code: e.code, message: e.message }; }
console.log(JSON.stringify({ ...out, launchable: tierLaunchable("docs") }));
`);
    closeLedger(join(dir, "ledger.sqlite"));
    const r = Bun.spawnSync([process.execPath, script], { cwd: dir, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "rt") } });
    db = openLedger(join(dir, "ledger.sqlite"));
    if (!r.success) throw new Error(`cold deliver crashed: ${r.stderr.toString()}`);
    return JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
  }

  test("on：docs 越界在冷进程里被拒（真实 git diff），合规交付推到 review；off：docs 暂停，code 卡照旧；不经开卡入口的旁路进程 docs 交付按无法证明拒", () => {
    card("D8", "docs");
    card("C8", "code", ["src/**"]);
    const bad = branch("d8-bad", () => put("src/b.ts", "x\n"));
    const good = branch("d8-good", () => put("docs/a.md", "a8\n"));
    const codeHead = branch("c8", () => put("src/c.ts", "x\n"));
    const refused = coldDeliver("D8", bad, "on");
    expect(refused).toMatchObject({ ok: false, code: "invalid", launchable: true });
    expect(refused.message).toContain("src/b.ts 不在本卡 fileGlobs");
    expect(delivered("D8")).toEqual([]);
    expect(coldDeliver("D8", good, "off")).toMatchObject({ ok: false, code: "invalid", message: expect.stringContaining("taskTierModels 是 off"), launchable: false });
    expect(coldDeliver("C8", codeHead, "off")).toMatchObject({ ok: true, stage: "review" });
    const side = coldDeliver("D8", good, "on", "ledger");
    expect(side).toMatchObject({ ok: false, code: "invalid", message: expect.stringContaining("交付门控没装上"), launchable: false });
    expect(coldDeliver("D8", good, "on")).toMatchObject({ ok: true, stage: "review", launchable: true });
    expect(delivered("D8")).toHaveLength(1);
  });
});

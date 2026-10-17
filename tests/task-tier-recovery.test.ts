/**
 * TIER3 恢复键 taskTierModels：登记且缺省 on（不要求旧 roleModel 键 on）；observe 只记 would-use、argv 不变；off 在新增逻辑之前完整委托旧角色路径——
 * 旧键 on / observe / off、显式覆盖、Codex 启动参数、purpose（派单材料）逐字一致，不读表、不记事件 / 启动事实、不调扩展点。
 * 回退命令按规格原文跑真实 CLI（子进程、独立状态目录）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCardRole, cardRoleCreate } from "../src/lib/card-role-definitions.js";
import type { StartPlan } from "../src/lib/dag-tools-start.js";
import type { StepIO } from "../src/lib/dag-tools-steps.js";
import { runLocalStart } from "../src/lib/scheduler-local-runtime-start.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS, recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { useRoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { taskTierLaunchHistory } from "../src/lib/task-tier-launch-events.js";
import { resetDocsTemplate } from "../src/lib/task-tier-docs-template.js";
import { registerAuthorTierOverride, taskTierMode, tierCheckGate, useTaskTierPort, type TierLaunchCtx } from "../src/lib/task-tier-models.js";
import { registerTierChecks } from "../src/lib/task-tier-spec.js";
import { testChildEnv } from "./test-env.js";

const ROLLBACK = `ledger scheduler-recovery claude-orchestrator off --key taskTierModels --reason "回退类型模型选择"`;
const cleanups: (() => void)[] = [];
afterEach(() => { useTaskTierPort(); useRoleModelPort(); registerAuthorTierOverride(null); for (const c of cleanups.splice(0)) c(); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

/** 角色表与 TIER1 默认不同，看得出谁读了它 */
const TABLE: RoleModelRead = (() => { const t = defaultRoleModels(); t.rev = 2; t.roles.author = { claude: "claude-sonnet-5-5", codex: "xhigh" };
  t.roles.reviewer = { claude: "claude-haiku-5-5", codex: "low" }; return { status: "ok", table: t }; })();
const policy = (mode: RecoveryMode) => () => ({ mode, manualAfterMs: null, source: "config" as const });
function ports(tier: RecoveryMode, role: RecoveryMode) {
  const n = { tierReads: 0, roleSeen: 0 };
  useTaskTierPort({ policy: policy(tier), read: () => (n.tierReads++, TABLE) });
  useRoleModelPort({ policy: policy(role), read: () => TABLE, observe: () => void n.roleSeen++ });
  return n;
}
function ledger() {
  const path = join(tmp("tier3-rec-"), "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => closeLedger(path));
  createTask(db, { actor: "owner" }, { id: "T1", project: "p1", title: "demo", kind: "code" });
  return db;
}
const author = (...extra: string[]) => ["create", "a1", "/w", "--purpose", "T1 作者。先读 /x/T1-exec-prompt.md", "--task", "T1", "--card", "T1", "--card-role", "author",
  "--effort", "high", "--project", "p1", ...extra];
const reviewer = (...extra: string[]) => ["create", "r1", "/w", "--purpose", "T1 审查", "--project", "p1", "--card", "T1", "--card-role", "reviewer", ...extra];
const CODEX = ["--runtime", "codex", "--transport", "acp"];
const CASES: [string, string[]][] = [
  ["Claude 作者", author()], ["Claude 审查员", reviewer()], ["显式 --model", author("--model", "claude-haiku-5-5")],
  ["Codex 作者", [...author(), ...CODEX]], ["Codex 审查员", [...reviewer(), ...CODEX]], ["Codex 显式 --effort", [...reviewer("--effort", "max"), ...CODEX]],
];

describe("[验收线 3] 键登记与缺省", () => {
  test("taskTierModels 已登记（字母序）；没有任何配置时缺省 on", () => {
    expect(RECOVERY_KEYS).toContain("taskTierModels");
    expect([...RECOVERY_KEYS]).toEqual([...RECOVERY_KEYS].sort());
    const path = join(tmp("tier3-pol-"), "recovery-policy.json");
    expect(recoveryPolicy("p1", "taskTierModels", path).mode).toBe("on");
    useTaskTierPort({ policy: (p, k) => recoveryPolicy(p, k, path) });
    expect(taskTierMode("p1")).toEqual({ mode: "on" });
  });

  test("on 独立生效：旧 roleModel 键 off 时类型选择照样换模型（ui 作者 Sonnet、code 审查员继承角色格 Haiku）", () => {
    ports("on", "off");
    const ctx: TierLaunchCtx = { project: "p1", card: "T1", tier: "ui" };
    const a = applyCardRole(author(), { tier: ctx });
    expect("args" in a && a.args[a.args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    const r = applyCardRole(reviewer(), { tier: { ...ctx, tier: "code" } });
    expect("args" in r && r.args[r.args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
  });
});

describe("[验收线 3] off：完整委托旧角色路径", () => {
  test.each(CASES)("%s：旧键 on / observe / off 三种下 argv（含 purpose / 派单材料）与不经类型选择逐字一致，不读表、不记、不调扩展点", (_, args) => {
    const db = ledger();
    let asked = 0, checked = 0;
    registerAuthorTierOverride(() => (asked++, "claude-haiku-5-5"));
    cleanups.push(registerTierChecks({ dispatch: () => (checked++, "拒"), delivery: () => (checked++, "拒") }));
    for (const role of ["on", "observe", "off"] as const) {
      const legacy = ports("off", role);
      const want = applyCardRole([...args]);
      const n = ports("off", role);
      expect(applyCardRole([...args], { tier: { db, project: "p1", card: "T1", tier: "security", baseEffort: "high" } })).toEqual(want);
      expect(n).toEqual({ tierReads: 0, roleSeen: legacy.roleSeen });
    }
    expect(tierCheckGate(db, "dispatch", { project: "p1", taskId: "T1", tier: "code", fileGlobs: [] })).toBeNull();
    expect(tierCheckGate(db, "delivery", { project: "p1", taskId: "T1", tier: "code", fileGlobs: [], files: ["x"] })).toBeNull();
    expect([asked, checked]).toEqual([0, 0]);
    expect(listEvents(db, { project: "p1" }).filter((e) => e.kind === "note")).toEqual([]);
    expect(taskTierLaunchHistory(db, "p1", "T1")).toEqual([]);
  });

  test("off 下真 create 包装发出的 argv 与旧路径一致，不留启动事实", async () => {
    const db = ledger();
    const sent: string[][] = [];
    ports("off", "observe");
    await cardRoleCreate(async (...a: string[]) => (sent.push(a), { ok: true }))(...author());
    await cardRoleCreate(async (...a: string[]) => (sent.push(a), { ok: true }), { tier: { db, project: "p1", card: "T1", tier: "ui" } })(...author());
    expect(sent[1]).toEqual(sent[0]);
    expect(taskTierLaunchHistory(db, "p1", "T1")).toEqual([]);
  });
});

describe("[验收线 3] off：start_node 不建上下文、不读、不绑", () => {
  /** runLocalStart 的最小替身：Claude 本机、无槽位限制；registry 由测试写（有 session id 才会去绑） */
  function startRig(db: ReturnType<typeof ledger>) {
    const dir = tmp("tier3-start-"), configPath = join(dir, "scheduler.json"), registryPath = join(dir, "registry.json");
    writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true, projects: { p1: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: dir,
      localAuthorRuntime: "claude" } } }));
    writeFileSync(registryPath, JSON.stringify({ agents: {} }));
    const plan = { project: "p1", taskId: "T1", peer: null, agent: "agent-task-t1", agentName: "task-t1", specPath: join(dir, "spec.md"), specText: "# 卡\n",
      workflow: { template: "code", version: 3 } } as unknown as StartPlan;
    const seen = { db: 0, read: 0 };
    const io = { db: () => (seen.db++, db), read: () => (seen.read++, null), manager: async () => ({ ok: true }) } as unknown as StepIO;
    const run = async (x: StepIO) => { await x.manager(author().map((a) => (a === "a1" ? "task-t1" : a))); return { ok: true } as never; };
    const register = () => writeFileSync(registryPath, JSON.stringify({ agents: { "agent-task-t1": { cwd: dir, projectId: "p1", sessionId: "s-1", status: "active",
      runtime: "claude-code", transport: "tmux" } } }));
    return { go: () => runLocalStart(io, plan, run, { configPath, registryPath }), register, seen };
  }

  test("on 下留了一条未绑尝试；切 off 后会话出现在 registry，再跑启动也不绑、不多事件，台账与规格都不碰", async () => {
    const db = ledger();
    const rig = startRig(db);
    ports("on", "observe");
    await rig.go();
    expect(taskTierLaunchHistory(db, "p1", "T1").map((f) => f.status)).toEqual(["attempted"]);
    const before = listEvents(db, { project: "p1" }).length;
    ports("off", "observe");
    rig.register();
    rig.seen.db = rig.seen.read = 0;
    await rig.go();
    expect(rig.seen).toEqual({ db: 0, read: 0 });
    expect(taskTierLaunchHistory(db, "p1", "T1").map((f) => f.status)).toEqual(["attempted"]); // 历史照读，不翻成 bound
    expect(listEvents(db, { project: "p1" }).length).toBe(before);
    ports("on", "observe");
    await rig.go(); // 回到 on：新尝试照常记、照常绑（最近一条未绑的）
    expect(taskTierLaunchHistory(db, "p1", "T1").map((f) => f.status)).toEqual(["attempted", "bound"]);
  });
});

describe("[验收线 3] observe：只记 would-use", () => {
  test("argv 与旧路径一致；卡上一条 would-use（同值重复只一条），无启动事实", () => {
    const db = ledger();
    ports("observe", "observe");
    const want = applyCardRole(author());
    const ctx: TierLaunchCtx = { db, project: "p1", card: "T1", tier: "ui" };
    expect(applyCardRole(author(), { tier: ctx })).toEqual(want);
    expect(applyCardRole(author(), { tier: ctx })).toEqual(want);
    const notes = listEvents(db, { project: "p1", target: "T1" }).filter((e) => e.data.mechanism === "taskTierModels");
    expect(notes).toEqual([expect.objectContaining({ kind: "note", data: expect.objectContaining({ op: "recovery_observe", tier: "ui", role: "author", wouldUse: "claude-sonnet-5-5" }) })]);
    expect(taskTierLaunchHistory(db, "p1", "T1")).toEqual([]);
  });

  test("扩展点 2 的交付钩子：observe 记会拒、放行；on 拒绝并记事件", () => {
    resetDocsTemplate(); // 同进程先跑的开卡测试可能已按缺省 on 挂上 docs 范围钩子（进程级）；本条只测自己挂的钩子
    const db = ledger();
    cleanups.push(registerTierChecks({ delivery: (c) => (c.files?.includes("docs/x.md") ? null : "交付改了 docs 之外的文件") }));
    const at = { project: "p1", taskId: "T1", tier: "docs" as const, fileGlobs: ["docs/**"], files: ["src/a.ts"] };
    ports("observe", "observe");
    expect(tierCheckGate(db, "delivery", at)).toBeNull();
    ports("on", "observe");
    expect(tierCheckGate(db, "delivery", at)).toBe("交付改了 docs 之外的文件");
    expect(tierCheckGate(db, "delivery", { ...at, files: ["docs/x.md"] })).toBeNull();
    const evs = listEvents(db, { project: "p1", target: "T1" }).filter((e) => e.data.op === "task_tier_check");
    expect(evs.map((e) => [e.data.phase, e.data.mode])).toEqual([["delivery", "observe"], ["delivery", "on"]]);
  });
});

describe("[验收线 3] 回退命令逐字", () => {
  test(`${ROLLBACK}：真实 CLI 把这个键改 off，读出来 off`, async () => {
    const state = tmp("tier3-cli-");
    mkdirSync(join(state, "run"), { recursive: true });
    writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "claude-orchestrator", name: "CO", dirs: [state] }] }));
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "s", agents: {} }));
    const argv = ["ledger", "scheduler-recovery", "claude-orchestrator", "off", "--key", "taskTierModels", "--reason", "回退类型模型选择"];
    expect(`${argv.slice(0, -1).join(" ")} "${argv.at(-1)}"`).toBe(ROLLBACK);
    const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), ...argv],
      { env: testChildEnv({ CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") }), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.parse(out.trim().split("\n").at(-1) ?? "{}")).toMatchObject({ ok: true, changed: true });
    const path = join(state, "recovery-policy.json");
    expect(recoveryPolicy("claude-orchestrator", "taskTierModels", path).mode).toBe("off");
    expect(readFileSync(path, "utf8")).toContain("taskTierModels");
    useTaskTierPort({ policy: (p, k) => recoveryPolicy(p, k, path) });
    expect(taskTierMode("claude-orchestrator").mode).toBe("off");
  }, 30_000);
});

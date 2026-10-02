import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSharedLedgerImport } from "../scripts/shared-ledger-import.js";
import { settleDagStart, type StartSettleEnv } from "../src/lib/dag-start-settle.js";
import { closeLedger, getEventByDedup, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { ledgerUsage } from "../src/manager/ledger.js";

const card = "c601-card", attempt = "a1b2c3d4";
const key = (step: string) => `dag-start:${card}:${attempt}:${step}`;

/** 本机：一个只选中已完成 feature 的导入，加一张开卡中途失败的卡（只有 task-new，没有 bind） */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dag-start-settle-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const id = "c601-plan", project = "project-a", repo = join(dir, "repo"), worktreeRoot = join(dir, "worktrees");
  mkdirSync(repo);
  db.prepare("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) "
    + "VALUES (?,?, 'Team plan', 'Shared description', 'active', 1, 1, 'owner', 1, 1)").run(id, project);
  db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,1,'initial','Plan','owner',1,?)")
    .run(id, JSON.stringify([{ key: "next", taskId: null, oneLine: "Next", deps: [], fileGlobs: ["src/sample.ts"], estimate: "1h" }]));
  createTask(db, { actor: "owner", now: 1, dedupKey: key("task-new") }, { project, id: card, title: "Card", kind: "code", agent: "agent-task-c601-card" });
  const options = { stateDir: dir, localProject: project, projectId: "shared-project", sourceInstanceId: "peer-a", featureIds: [id],
    batchId: "batch-a", summaries: {}, scrub: { identity: { username: "private-person", hostname: "private-machine" } } };
  const state = { agents: [] as { name: string; status?: string; cwd?: string }[], dirs: new Set<string>(), listed: [] as string[] };
  const env: StartSettleEnv = {
    worktreeRoot, agents: async () => state.agents, exists: (p) => state.dirs.has(p),
    projectDirs: (p) => (p === project ? [repo] : []), worktrees: async (d) => (d === repo ? [repo, ...state.listed] : null),
  };
  const cancel = () => moveStage(db, { actor: "owner", now: 2, dedupKey: key("undo-task") }, { taskId: card, from: "spec", to: "cancelled", text: "start_node 中途失败，回滚" });
  const settle = (actor = "owner") => settleDagStart(db, { actor, now: 3 }, env, { taskId: card, attempt, reason: "N9 回滚后清理完毕" });
  return { dir, db, options, state, env, cancel, settle, worktree: join(worktreeRoot, card), close() { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

test("task-new without bind blocks prepare; a verified start-settle records settled once and prepare passes", async () => {
  const f = fixture();
  try {
    await expect(prepareSharedLedgerImport(f.db, f.options)).rejects.toThrow("migration blocked: unfinished manual start");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dir).sharedPlanning).toBe(false);
    f.cancel();
    f.state.agents = [{ name: "agent-task-c601-card", status: "stopped", cwd: f.worktree }];
    const first = await f.settle();
    expect(first.duplicate).toBe(false);
    expect(first.checks).toMatchObject({ rolledBack: { ok: true }, session: { ok: true }, worktree: { ok: true } });
    const event = getEventByDedup(f.db, key("settled"))!;
    expect(event.data).toMatchObject({ op: "dag_start_settle", taskId: card, attempt, operator: "owner", reason: "N9 回滚后清理完毕" });
    expect(event.actor).toBe("owner");
    const again = await f.settle();
    expect(again.duplicate).toBe(true);
    expect(listEvents(f.db, {}).filter((e) => e.dedupKey === key("settled"))).toHaveLength(1);
    const prepared = await prepareSharedLedgerImport(f.db, f.options);
    expect(prepared.payload.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally { f.close(); }
});

test("an undo-task event alone counts as rolled back", async () => {
  const f = fixture();
  try {
    // 回滚事件在库里，卡后来被别人改回了别的阶段也不影响「这次 attempt 已回滚」
    f.cancel();
    f.db.prepare("UPDATE tasks SET stage = 'build' WHERE id = ?").run(card);
    expect((await f.settle()).checks?.rolledBack).toEqual({ ok: true, detail: "这次 attempt 有 undo-task 回滚事件" });
  } finally { f.close(); }
});

const cases: { name: string; label: string; arrange(f: ReturnType<typeof fixture>): void }[] = [
  { name: "card still live and not rolled back", label: "卡没回滚", arrange: () => {} },
  { name: "executor session still running", label: "会话仍在运行", arrange: (f) => { f.cancel(); f.state.agents = [{ name: "agent-task-c601-card", status: "active" }]; } },
  { name: "session found by worktree cwd", label: "会话仍在运行", arrange: (f) => { f.cancel(); f.state.agents = [{ name: "agent-renamed", status: "idle", cwd: f.worktree }]; } },
  { name: "worktree directory still present", label: "worktree 还在", arrange: (f) => { f.cancel(); f.state.dirs.add(f.worktree); } },
  { name: "worktree still registered in git", label: "worktree 还在", arrange: (f) => { f.cancel(); f.state.listed.push(f.worktree); } },
  { name: "git worktree list unreadable", label: "worktree 还在", arrange: (f) => { f.cancel(); f.env.worktrees = async () => null; } },
];
for (const c of cases) {
  test(`start-settle refuses when ${c.name}, names the failed check and writes nothing`, async () => {
    const f = fixture();
    try {
      c.arrange(f);
      const before = listEvents(f.db, {}).length;
      await expect(f.settle()).rejects.toThrow(`核实没过，不结清：${c.label}`);
      expect(getEventByDedup(f.db, key("settled"))).toBeNull();
      expect(listEvents(f.db, {}).length).toBe(before);
      await expect(prepareSharedLedgerImport(f.db, f.options)).rejects.toThrow("migration blocked");
    } finally { f.close(); }
  });
}

test("only project managers settle, only a recorded unbound attempt can be settled", async () => {
  const f = fixture();
  try {
    f.cancel();
    await expect(f.settle("agent-task-c601-card")).rejects.toThrow("PM / master / owner");
    await expect(settleDagStart(f.db, { actor: "owner" }, f.env, { taskId: card, attempt: "other", reason: "x" })).rejects.toThrow("没有 attempt other");
    await expect(settleDagStart(f.db, { actor: "owner" }, f.env, { taskId: card, attempt: "bad:attempt", reason: "x" })).rejects.toThrow("--attempt");
    await expect(settleDagStart(f.db, { actor: "owner" }, f.env, { taskId: card, attempt, reason: " " })).rejects.toThrow("--reason");
    expect(getEventByDedup(f.db, key("settled"))).toBeNull();
    expect(ledgerUsage()).toContain("start-settle <卡号> --attempt <attemptId> --reason <原因>");
  } finally { f.close(); }
});

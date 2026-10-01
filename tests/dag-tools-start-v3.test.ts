/**
 * i28-N3：start_node 开的 auto 卡走 code v3（复述记录即放行，PM 要拦用 restate-hold），其余 workflow 字段不变；
 * 后面的步骤失败时回滚切 manual，版本号沿用卡当前的 3。直接跑 runStart：台账是临时库里的进程内 runLedger，git / create 是假的。
 * 完整的 bridge 管道（权限、各步失败、重放）在 tests/dag-tools-bridge.test.ts；v3 闸本身在 tests/scheduler-restate-v3.test.ts。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartPlan } from "../src/lib/dag-tools-start.js";
import { runStart, type StepIO } from "../src/lib/dag-tools-steps.js";
import type { Feature } from "../src/lib/ledger-feature.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { nodeAt, templateFor } from "../src/lib/scheduler-template.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const ID = "i28-n";
const AGENT = "agent-task-i28-n";

let dir: string, db: Database, now: number;
let agents: Record<string, { channelId: string; projectId: string }>;
/** manager 子命令（ledger 的取第二段）命中就返回失败 */
let failSub: string | null;

/** 以 PM 身份跑 manager：ledger 进临时库；dag-bind 只看成败（本文件不建 feature，绑定由 bridge 测试覆盖）；create / kill 记在 agents */
async function manager(args: string[]): Promise<any> {
  const sub = args[0] === "ledger" ? args[1] : args[0];
  if (sub === failSub) return { ok: false, error: `注入失败：${sub}` };
  if (sub === "dag-bind") return { ok: true };
  if (sub === "create") agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
  if (sub === "kill") delete agents[args[1]];
  if (args[0] !== "ledger") return { ok: true };
  return runLedger(args.slice(1), {
    db, actor: "agent-pm", projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never, saveRegistry: async () => {},
    now: () => now++, autoDispatch: () => true, autoProjects: () => [P],
  });
}

const io = (): StepIO => ({
  db: () => db, manager, attempt: "t1",
  git: async (_cwd, args) => ({ ok: true, out: args[0] === "rev-parse" && args[3].endsWith("^{commit}") ? "base0" : "" }),
  exists: existsSync, read: () => null, write: () => {}, remove: () => {}, symlink: () => {},
  agentExists: (a) => !!agents[a],
});

const plan = (): StartPlan => ({
  feature: { id: "ab12-i28" } as Feature, key: "n", taskId: ID, title: "节点 n", project: P, item: null, pm: "agent-pm",
  base: "main", branch: `feat/${ID}`, repo: join(dir, "repo"), worktree: join(dir, "wt", ID), agentName: `task-${ID}`, agent: AGENT,
  fileGlobs: ["src/lib/n.ts"], specRel: `docs/tasks/${ID}.md`, specPath: join(dir, "spec.md"), specText: null,
  promptPath: join(dir, "prompt.md"), promptText: "说明", purpose: "执行者",
});

beforeEach(() => {
  now = 1_000;
  failSub = null;
  agents = { "agent-pm": { channelId: "ch-pm", projectId: P } };
  dir = mkdtempSync(join(tmpdir(), "i28-n3-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("start_node 开 auto 卡用 code v3", () => {
  test("新卡 workflow = code v3 / auto / claude / 原 fallback；复述闸是 restate_recorded", async () => {
    expect(await runStart(io(), plan())).toMatchObject({ ok: true, taskId: ID });
    const w = getWorkflow(db, ID)!;
    expect(w).toMatchObject({
      template: "code", templateVersion: 3, mode: "auto", authorFamily: "claude", fallback: "PM 接管，按手动流程推进（派审 + 合并队列）",
    });
    expect(nodeAt(templateFor(w.template, w.templateVersion)!, "restate")?.gate).toBe("restate_recorded");
  });

  test("workflow 之后的 bind 失败：切回 manual，版本号沿用 3，其余字段不变，卡取消", async () => {
    failSub = "dag-bind";
    expect(await runStart(io(), plan())).toMatchObject({ ok: false, failedStep: "bind", leftovers: [] });
    expect(getWorkflow(db, ID)).toMatchObject({
      template: "code", templateVersion: 3, mode: "manual", authorFamily: "claude", fallback: "PM 接管，按手动流程推进（派审 + 合并队列）",
    });
    expect(getTask(db, ID)?.stage).toBe("cancelled");
    expect(agents[AGENT]).toBeUndefined();
  });

  test("workflow-set 自己失败：没有落 auto，回滚不写 workflow", async () => {
    failSub = "workflow-set";
    expect(await runStart(io(), plan())).toMatchObject({ ok: false, failedStep: "workflow", leftovers: [] });
    expect(getWorkflow(db, ID)?.mode ?? "manual").toBe("manual");
    expect(getTask(db, ID)?.stage).toBe("cancelled");
  });
});

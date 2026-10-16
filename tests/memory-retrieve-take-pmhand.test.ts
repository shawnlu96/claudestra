/**
 * PMHAND1 9补：作者领单门与 order-take 的 bindingAllows 同口径——retired 的作者绑定视同无绑定，PM 手派的本机作者能领单
 * （并记一条 retired_binding 样本）；active 绑定且 agent / session 不同照旧拒。
 * 每例一个子进程：最小 env、私有 HOME / TMPDIR / 状态 / 运行目录，身份全是合成的（同 tests/memory-retrieve-manual-review.test.ts）。
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

const HEAD = "a".repeat(40);
const NEW = { agent: "author-new", sessionId: "sid-new", family: "claude", verified: true };
const OLD = { agent: "author-old", sessionId: "sid-old", family: "claude", verified: true };

async function probe(c: string): Promise<void> {
  const root = process.env.CLAUDESTRA_STATE_DIR!;
  const { openLedger, listEvents } = await import("../src/lib/ledger-store.js");
  const { createTask } = await import("../src/lib/ledger-write.js");
  const { assignStep } = await import("../src/lib/ledger-steps-write.js");
  const { takeOrderWithMemory } = await import("../src/lib/memory-retrieve-take.js");
  const db = openLedger(join(root, "ledger.sqlite"));
  const owner = { actor: "owner" };
  writeFileSync(join(root, "registry.json"), JSON.stringify({ agents: {
    [NEW.agent]: { channelId: "c-new", sessionId: NEW.sessionId, cwd: root },
    [OLD.agent]: { channelId: "c-old", sessionId: OLD.sessionId, cwd: root } } }));
  db.exec("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  createTask(db, owner, { project: "demo", id: "T1", title: "PM 手派作者", kind: "code" });
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T1', 'demo', 'code', 3, 'manual', 'claude', 'manual', 1, 1, 1)`).run();
  // PM 接手后把写步骤手派给本机新作者；调度器当初绑的旧作者会话还在台账里（retired 或 active）
  assignStep(db, owner, { taskId: "T1", step: "write", executor: NEW.agent, executorKind: "agent", round: 1 });
  db.query("UPDATE tasks SET stage = 'build', headSHA = ? WHERE id = 'T1'").run(HEAD);
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('intent-a1', 'T1', 'demo', 'write', 'ensure_session', ?, 0, 1, 1, 1, ?, 3, 'done', 'r', 1, 1)`).run(OLD.agent, HEAD);
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('T1', 'author', ?, ?, 'claude', 'tmux', ?, 'intent-a1', 1, 1)`).run(OLD.agent, OLD.sessionId, c === "retired" ? "retired" : "active");
  const deps = { headFiles: [] as string[], embedder: { model: "fake", remote: false, embed: async (texts: string[]) => texts.map(() => [1, 0]) } };
  const samples = () => listEvents(db, { project: "demo", target: "T1" }).filter((e) => e.data.op === "pm_handback");
  const r: any = await takeOrderWithMemory(db, { ...NEW, channelId: "c-new" } as any, deps);
  if (c === "retired") {
    expect(r).toMatchObject({ ok: true, order: { orderId: "T1:write:r0", step: "write" } });
    expect(samples().map((e) => [e.data.type, e.data.head, e.actor])).toEqual([["retired_binding", HEAD, "scheduler"]]);
    await takeOrderWithMemory(db, { ...NEW, channelId: "c-new" } as any, deps);
    expect(samples()).toHaveLength(1); // card + head + type dedup
  } else {
    // active 绑定的核对不放宽：别人的会话照旧不给单（scanOrders 先拦下），也不记样本
    expect(r.ok === false || r.order === null).toBe(true);
    expect(samples()).toEqual([]);
  }
  db.close();
}

if (process.argv.includes("--probe")) {
  await probe(process.argv.at(-1)!);
} else {
  for (const c of ["retired", "active"]) {
    test(`[验收线 1] 作者绑定 ${c}：PM 手派执行者领单`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pmhand1-"));
      try {
        for (const d of ["home", "tmp", "tmp/state", "tmp/run"]) mkdirSync(join(dir, d));
        const p = Bun.spawn([process.execPath, import.meta.path, "--probe", c], {
          env: testChildEnv({ HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), CLAUDESTRA_STATE_DIR: join(dir, "tmp", "state"),
            CLAUDESTRA_RUNTIME_DIR: join(dir, "tmp", "run") }),
          cwd: join(dir, "tmp"), stdout: "pipe", stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        expect({ code, output: code ? out + err : "" }).toEqual({ code: 0, output: "" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 10000);
  }
}

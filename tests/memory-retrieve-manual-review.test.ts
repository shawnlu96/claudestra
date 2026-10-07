/**
 * MRVM1：手动卡新审查会话的记忆领单只认 reviewSlotsFor 的正式审查槽（currentReview 本步执行者），
 * 不被旧轮次遗留的自动审查绑定挡住；自动卡绑定、作者领单门、异步检索前后的重核一字不放宽。
 * 每例一个子进程：最小 env、私有 HOME / TMPDIR / 状态 / 运行目录，身份全是合成的，不碰真实凭据或 bridge。
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

const HEAD = "a".repeat(40);
const NEW = { agent: "rev-new", sessionId: "sid-new", family: "codex", verified: true };
const OLD = { agent: "rev-old", sessionId: "sid-old", family: "codex", verified: true };
const WAIT = ["head", "round", "step", "spec", "registry", "cred", "binding", "workflow"];

async function probe(c: string): Promise<void> {
  const root = process.env.CLAUDESTRA_STATE_DIR!;
  const { openLedger, listEvents } = await import("../src/lib/ledger-store.js");
  const { createTask } = await import("../src/lib/ledger-write.js");
  const { assignStep } = await import("../src/lib/ledger-steps-write.js");
  const { recordMemory } = await import("../src/lib/ledger-memory.js");
  const { takeReviewWithMemory, takeOrderWithMemory } = await import("../src/lib/memory-retrieve-take.js");
  const { reviewToolHandlers } = await import("../src/bridge/review-tools.js");
  const { issueCallerCred } = await import("../src/lib/caller-cred.js");
  const db = openLedger(join(root, "ledger.sqlite"));
  const owner = { actor: "owner" };
  const registry = (sid = NEW.sessionId) => writeFileSync(join(root, "registry.json"), JSON.stringify({ agents: {
    [NEW.agent]: { channelId: "c-new", sessionId: sid, cwd: root, runtime: "codex" },
    [OLD.agent]: { channelId: "c-old", sessionId: OLD.sessionId, cwd: root, runtime: "codex" } } }));
  registry();
  db.exec("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  createTask(db, owner, { project: "demo", id: "T1", title: "审查领单", kind: "code" });
  const auto = c.startsWith("auto"), author = c.startsWith("author");
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T1', 'demo', 'code', 3, ?, 'claude', 'manual', 1, 1, 1)`).run(auto ? "auto" : "manual");
  // r1 由调度器派给旧审查员，绑定至今仍 active（真实来源：PR847 r1）
  assignStep(db, owner, { taskId: "T1", step: author ? "write" : "review", executor: OLD.agent, executorKind: "agent", round: 1 });
  if (c !== "manual-no-new-step") assignStep(db, owner, { taskId: "T1", step: c === "manual-wrong-step" ? "write" : author ? "write" : "review",
    executor: NEW.agent, executorKind: "agent", round: 2 });
  db.query("UPDATE tasks SET stage = ?, round = 2, headSHA = ? WHERE id = 'T1'").run(author ? "build" : "review", HEAD);
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('intent-r1', 'T1', 'demo', 'review', 'review', ?, 0, 9999, 1, 1, ?, 3, 'done', 'r', 1, 1)`).run(OLD.agent, HEAD);
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('T1', ?, ?, ?, 'codex', 'acp', ?, 'intent-r1', 1, 1)`).run(author ? "author" : "reviewer", OLD.agent, OLD.sessionId, c === "auto-retired" ? "retired" : "active");
  recordMemory(db, owner, { project: "demo", kind: "pitfall", title: "审查坑", symptom: "s", rule: "r", files: [], fixable: false,
    via: "tool", authorRole: "reviewer", head: HEAD, specRev: 1 });
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const deps = { headFiles: [] as string[], embedder: { model: "fake", remote: false, embed: async (texts: string[]) => {
    entered.resolve();
    if (WAIT.includes(c)) await gate.promise;
    return texts.map(() => [1, 0]);
  } } };
  const delivered = () => listEvents(db, { project: "demo" }).filter((e) => e.data.op === "memory_retrieve");
  const ids = (r: any) => r.ok ? r.orders.map((o: any) => o.orderId) : r.error;

  if (c === "manual-ok") {
    const r: any = await takeReviewWithMemory(db, NEW, join(root, "reviews"), deps);
    expect(ids(r)).toEqual(["T1:review:r2"]);
    expect(r.orders[0].head).toBe(HEAD);
    expect(r.orders[0].round).toBe(2);
    expect(delivered()).toHaveLength(1);
  } else if (c === "manual-handler") {
    // 真实 MCP handler 接法：身份只取 bridge 验证过的 call，参数里塞旗标无效
    const h = reviewToolHandlers((() => { throw new Error("不该写台账"); }) as any, { get: () => db });
    const call = { ...NEW, channelId: "c-new" } as any;
    const ok: any = await h.take_review!(call, { manual: true, agent: OLD.agent });
    expect(ok.orders.map((o: any) => o.orderId)).toEqual(["T1:review:r2"]);
    const other: any = await h.take_review!({ ...OLD, channelId: "c-old" } as any, { manual: true, orderId: "T1:review:r2" });
    expect(other.orders).toEqual([]);
    const bad: any = await h.take_review!({ ...NEW, sessionId: "sid-forged", channelId: "c-new" } as any, {});
    expect(bad.ok).toBe(false);
  } else if (c === "manual-wrong-sid") {
    expect(ids(await takeReviewWithMemory(db, { ...NEW, sessionId: "sid-forged" }, undefined, deps))).toBe("no_order");
  } else if (c === "manual-unverified") {
    expect(ids(await takeReviewWithMemory(db, { ...NEW, verified: false }, undefined, deps))).toBe("identity_unverified");
  } else if (["manual-old", "manual-other", "manual-no-new-step", "manual-wrong-step"].includes(c)) {
    const who = c === "manual-old" ? OLD : c === "manual-other" ? { ...NEW, agent: "someone" } : NEW;
    if (c === "manual-other") writeFileSync(join(root, "registry.json"), JSON.stringify({ agents: { someone: { sessionId: NEW.sessionId, runtime: "codex" } } }));
    expect(ids(await takeReviewWithMemory(db, who, undefined, deps))).toEqual([]);
    expect(delivered()).toEqual([]);
  } else if (c === "auto-new") {
    // 自动卡：只认调度器绑定，新会话哪怕被派了 r2 手动步骤也不能领
    expect(ids(await takeReviewWithMemory(db, NEW, undefined, deps))).toEqual([]);
  } else if (c === "auto-bound") {
    expect(ids(await takeReviewWithMemory(db, OLD, join(root, "reviews"), deps))).toEqual(["intent-r1"]);
  } else if (c === "auto-wrong-sid") {
    expect(ids(await takeReviewWithMemory(db, { ...OLD, sessionId: "sid-forged" }, undefined, deps))).toBe("no_order");
  } else if (c === "auto-retired") {
    expect(ids(await takeReviewWithMemory(db, OLD, undefined, deps))).toEqual([]);
  } else if (c === "author-new" || c === "author-old") {
    // 作者门不受本卡影响：旧作者绑定 active 时新会话照旧没单；旧轮作者不是当前执行者也没单
    const r: any = await takeOrderWithMemory(db, { ...(c === "author-new" ? NEW : OLD), channelId: "c" } as any, deps);
    expect(r.order ?? null).toBeNull();
    expect(delivered()).toEqual([]);
  } else {
    const pending = takeReviewWithMemory(db, NEW, join(root, "reviews"), deps);
    const timer = setTimeout(() => entered.reject(new Error("没进检索：领单前就被拒了")), 1500);
    try { await entered.promise; } finally { clearTimeout(timer); }
    if (c === "head") db.query("UPDATE tasks SET headSHA = ?").run("b".repeat(40));
    if (c === "round") db.query("UPDATE tasks SET round = 3").run();
    if (c === "step") assignStep(db, owner, { taskId: "T1", step: "review", executor: "rev-third", executorKind: "agent", round: 2 });
    if (c === "spec") db.query("UPDATE tasks SET specRev = 2").run();
    if (c === "registry") registry("sid-restarted");
    if (c === "cred") await issueCallerCred({ agent: NEW.agent, sessionId: NEW.sessionId, family: "codex" });
    if (c === "binding") db.query("UPDATE scheduler_sessions SET sessionId = 'sid-moved'").run();
    if (c === "workflow") db.query("UPDATE task_workflows SET mode = 'auto'").run();
    gate.resolve();
    const r: any = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toBe("order_changed");
    expect(delivered()).toEqual([]);
  }
  db.close();
}

if (process.argv.includes("--probe")) {
  await probe(process.argv.at(-1)!);
} else {
  const cases = ["manual-ok", "manual-handler", "manual-wrong-sid", "manual-unverified", "manual-old", "manual-other", "manual-no-new-step",
    "manual-wrong-step", "auto-new", "auto-bound", "auto-wrong-sid", "auto-retired", "author-new", "author-old", ...WAIT];
  for (const c of cases) {
    test(`手动审查记忆领单边界：${c}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "mrvm1-"));
      try {
        for (const d of ["home", "tmp", "state", "run"]) mkdirSync(join(dir, d));
        const p = Bun.spawn([process.execPath, import.meta.path, "--probe", c], {
          env: testChildEnv({ HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), CLAUDESTRA_STATE_DIR: join(dir, "state"),
            CLAUDESTRA_RUNTIME_DIR: join(dir, "run") }),
          cwd: join(dir, "tmp"), stdout: "pipe", stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        expect({ code, output: code ? out + err : "" }).toEqual({ code: 0, output: "" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 10000);
  }
}

/** 独立子进程隔离 bridge 边界的 mock；实际 answerOrderTool → take_* → 检索 → 拼单全链运行。 */
import { expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function fixtureHead(root: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  mkdirSync(join(root, "src/lib"), { recursive: true });
  for (const f of ["widget-store.ts", "widget-schema.ts"]) writeFileSync(join(root, "src/lib", f), "export {};\n");
  git("add", "src");
  git("commit", "-qm", "fixture");
  const head = git("rev-parse", "HEAD");
  // 当前 checkout 删除文件，检索必须仍按订单给出的旧 head 展开。
  git("rm", "-q", "src/lib/widget-schema.ts");
  git("commit", "-qm", "new tree");
  return head;
}

async function probe(kind: string, mode: string): Promise<void> {
  const root = process.env.CLAUDESTRA_STATE_DIR!;
  const head = fixtureHead(root);
  const { openLedger, getTask, listEvents } = await import("../src/lib/ledger-store.js");
  const { createTask } = await import("../src/lib/ledger-write.js");
  const { assignStep } = await import("../src/lib/ledger-steps-write.js");
  const { recordMemory, markMemory } = await import("../src/lib/ledger-memory.js");
  const db = openLedger(join(root, "ledger.sqlite"));
  db.exec("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  createTask(db, { actor: "owner" }, { project: "demo", id: "T1", title: "批量写", kind: "code" });
  assignStep(db, { actor: "owner" }, { taskId: "T1", step: kind === "write" ? "write" : "review", executor: "agent-x", executorKind: "agent" });
  db.query("UPDATE tasks SET stage = ?, headSHA = ?, agent = 'agent-x', extra = ? WHERE id = 'T1'")
    .run(kind === "write" ? "build" : "review", head, JSON.stringify({ fileGlobs: ["src/lib/widget-store*.ts"] }));
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('test', 'T1', 'demo', 'write', 'ensure_session', 0, 9999, 1, 1, 1, 'submitted', 'r', 1, 1)`).run();
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('T1', ?, 'agent-x', 's1', 'codex', 'acp', 'active', 'test', 1, 1)`).run(kind === "write" ? "author" : "reviewer");
  writeFileSync(join(root, "registry.json"), JSON.stringify({ agents: { "agent-x": { channelId: "test", sessionId: "s1", cwd: root, runtime: "codex" } } }));
  const add = (title: string, files: string[] = [], taskId?: string) => recordMemory(db, { actor: "owner" }, {
    project: "demo", kind: "pitfall", title, symptom: "事务陷阱", rule: "不要 await", files, taskId, fixable: false,
    via: "tool", authorRole: "reviewer", head, specRev: 1,
  });
  if (mode !== "empty") {
    add("语义旧坑");
    add("语义新坑");
    add("无交集坑", ["src/lib/*-schema.ts"]);
    add("文件消失坑", ["src/lib/gone.ts"], "T1");
    add("图文件坑", ["src/lib/widget-store.ts"], "T1");
  }
  const identity = { agent: mode === "unauthorized" ? "agent-other" : "agent-x", sessionId: "s1", family: "codex", verified: true };
  mock.module("../src/bridge/caller-identity.js", () => ({ callerOf: () => ({ identity, channelId: "test" }) }));
  mock.module("../src/bridge/ledger-feed.js", () => ({ ledgerDb: () => db }));
  const read = await import("../src/lib/ledger-read.js");
  mock.module("../src/lib/ledger-read.js", () => ({ ...read, LedgerReader: class { get() { return db; } } }));
  const embed = await import("../src/lib/memory-embed.js");
  let calls = 0;
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  mock.module("../src/lib/memory-embed.js", () => ({ ...embed, pickEmbedder: async () => mode === "no-model" ? null : ({
    model: "fake:axes", remote: false, embed: async (texts: string[]) => {
      calls++;
      if (db.inTransaction) throw new Error("检索持有事务");
      entered.resolve();
      if (["concurrent", "session", "head", "claim", "dispute", "registered", "lease"].includes(mode)) await gate.promise;
      if (mode === "timeout") await new Promise(() => {});
      if (mode === "failure") throw new Error("model unavailable");
      return texts.map((t) => t.startsWith("语义") || t === "批量写" ? [1, 0, 0] : t.startsWith("图文件") ? [0, 1, 0] : [0, 0, 1]);
    },
  }) }));
  const { answerOrderTool } = await import("../src/bridge/order-tools.js");
  const invoke = async () => {
    let result: any;
    await answerOrderTool({ send: (s: string) => { result = JSON.parse(s).result; } } as any,
      { tool: kind === "write" ? "take_order" : "take_review", args: {}, requestId: "test" });
    return result;
  };
  const deliveryEvents = () => listEvents(db, { project: "demo" }).filter((e) => e.data.op === "memory_retrieve");
  if (mode === "fallback") {
    const { takeOrderResult } = await import("../src/lib/order-take.js");
    const { takeReview } = await import("../src/lib/review-order.js");
    if (kind === "write") takeOrderResult(db, { ...identity, channelId: "test" });
    else takeReview(db, identity);
  }
  const pending = invoke();
  if (["concurrent", "session", "head", "claim", "dispute", "registered", "lease"].includes(mode)) {
    const timer = setTimeout(() => entered.reject(new Error("tool never called embedder")), 1500);
    try { await entered.promise; } finally { clearTimeout(timer); }
    if (mode === "session") db.query("UPDATE scheduler_sessions SET sessionId = 's2'").run();
    if (mode === "head") db.query("UPDATE tasks SET headSHA = ?").run("b".repeat(40));
    if (mode === "claim") db.query("UPDATE scheduler_sessions SET state = 'retiring'").run();
    if (mode === "dispute") markMemory(db, { actor: "owner" }, { memoryId: "ab12-m2", mark: "dispute", reason: "规则已变" });
    if (mode === "registered") writeFileSync(join(root, "registry.json"), JSON.stringify({ agents: { "agent-x": { sessionId: "s2" } } }));
    if (mode === "lease") db.query(`INSERT INTO lend_orders
      (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs, leaseUntil, createdBy, createdAt, updatedAt)
      VALUES ('lease', 'T1', 'demo', 'peer', 'codex', 'write', 1, 0, ?, 'a/b', '{}', '', '', 'claimed', 10000, ?, 'owner', 1, 1)`)
      .run(head, Date.now() + 10000);
    const other = mode === "concurrent" ? invoke() : null;
    gate.resolve();
    if (other) expect(await other).toEqual(await pending);
  }
  const result = await pending;
  await checkResult(kind, mode, result, deliveryEvents(), calls, db, head);
  db.close();
}

if (process.argv.includes("--probe")) {
  await probe(process.argv.at(-2)!, process.argv.at(-1)!);
} else {
  const modes = ["first", "concurrent", "session", "head", "claim", "dispute", "unauthorized", "empty", "no-model", "failure", "timeout", "fallback", "registered"];
  for (const kind of ["write", "review"]) for (const mode of [...modes, ...(kind === "write" ? ["lease"] : [])]) {
    test(`真实工具 ${kind}: ${mode}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "memory-tool-"));
      try {
        const p = Bun.spawn([process.execPath, import.meta.path, "--probe", kind, mode], {
          env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        expect({ code, output: code ? out + err : "" }).toEqual({ code: 0, output: "" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 10000);
  }
}

async function checkResult(kind: string, mode: string, result: any, events: any[], calls: number,
  db: import("bun:sqlite").Database, head: string): Promise<void> {
  const { getTask } = await import("../src/lib/ledger-store.js");
  const order = kind === "write" ? result.order : result.orders?.[0];
  if (["session", "head", "claim", "registered", "lease"].includes(mode)) {
    expect(result.ok).toBe(false);
    expect(events).toEqual([]);
  } else if (mode === "unauthorized" || mode === "empty") {
    expect(calls).toBe(0);
    expect(events).toEqual([]);
    if (mode === "empty") {
      const { orderWireFor } = await import("../src/lib/order-take.js");
      const { reviewOrderOf } = await import("../src/lib/review-order.js");
      const t = getTask(db, "T1")!;
      const bare = kind === "write" ? orderWireFor(db, { task: t, stage: "build", step: "write", orderId: order.orderId, intent: null })
        : reviewOrderOf(db, { task: t, orderId: order.orderId, node: "review", head, auto: false });
      expect(bare.ok && JSON.stringify(bare.order)).toBe(JSON.stringify(order));
    }
  } else {
    expect(result.ok).toBe(true);
    const section = order.inputs.at(-1) as string;
    expect(section).toContain("项目记忆");
    expect(section).not.toContain("ab12-m3"); // 旧 head 上 glob 展开有文件，但与本卡范围无交集
    expect(section).not.toContain("ab12-m4"); // 图命中但文件已消失，×0.3 后低于下限
    if (["no-model", "failure", "timeout", "dispute"].includes(mode)) expect(section).not.toContain("ab12-m2");
    else {
      expect(section).toContain("ab12-m2");
      expect(section).not.toContain("ab12-m1"); // 两条语义坑余弦 1，留新的
      expect(calls).toBe(2); // 一次批量嵌入、一次查询；并发领单也只准备一次
    }
    const ids = [...section.matchAll(/\[坑 (ab12-m\d+)/g)].map((m) => m[1]);
    expect(events.at(-1)!.data.memoryIds).toEqual(ids);
    expect(Buffer.byteLength(JSON.stringify(order))).toBeLessThanOrEqual(32768);
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(kind === "write" ? 1600 : 1000);
  }
}

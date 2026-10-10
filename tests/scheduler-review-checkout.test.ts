/**
 * dispatch-recovery-RVWT1 · the reviewer checkout rule (scheduler-review-checkout.ts) on synthetic ledger rows: which directory a
 * binding gets is decided by the binding, the ensure_session that created it and the latest reviewer_swap — never by the
 * agent's name or which directories exist. The end-to-end refusal / legacy paths are in scheduler-review-checkout-prod.test.ts
 * and scheduler-review-swap-source-prod.test.ts.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { getTask } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { boundReviewCheckout, replacementTag, reviewCheckoutDir } from "../src/lib/scheduler-review-checkout.js";
import { openReviewWorktree } from "../src/lib/scheduler-review-worktree.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const sh = (dir: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

function world() {
  const f = autoFixture();
  const head = "a".repeat(40);
  f.db.run("UPDATE tasks SET headSHA = ?, stage = 'review' WHERE id = 'T1'", [head]);
  const task = (): LedgerTask => getTask(f.db, "T1")!;
  let n = 0;
  const event = (data: Record<string, unknown>) => insertEvent(f.db, { actor: "scheduler", now: 5000 + n++ }, { project: "p", target: "T1", kind: "scheduler", text: "合成", data }, false);
  const intent = (action: string, eventSeq: number, node = "adversarial_review") => {
    const id = `i-${n++}`, t = task();
    f.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status,
      attempts, receipt, reason, createdAt, updatedAt) VALUES (?, 'T1', 'p', ?, ?, NULL, ?, ?, ?, ?, ?, 2, 'done', 0, NULL, '合成', 1, 1)`,
    [id, node, action, eventSeq, eventSeq, t.rev, t.specRev, t.headSHA]);
    return id;
  };
  /** the card's reviewer binding (one row per task + role, as the session writer keeps it) */
  const bind = (agent: string, sessionId: string, createIntentId: string, state = "active", family = "codex") => {
    f.db.run("DELETE FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'reviewer'");
    f.db.run(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES ('T1', 'reviewer', ?, ?, ?, 'acp', ?, ?, 1, 1)`, [agent, sessionId, family, state, createIntentId]);
    return { taskId: "T1", role: "reviewer", agent, sessionId, family, transport: "acp" } as SessionRef;
  };
  const swap = (extra: Record<string, unknown>) => {
    const t = task();
    return event({ op: "reviewer_swap", intentId: "i-old", sessionId: "s-rv", head: t.headSHA, specRev: t.specRev, round: t.round, toFamily: "codex", ...extra });
  };
  const seq = () => (f.db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  return { f, task, intent, bind, swap, seq, root: f.dir, at: (rel: string) => join(f.dir, rel) };
}

test("RVWT1 目录规则：无绑定 / 普通绑定 → rv-<task>；普通家族替代 → rv-<task>；旧单退休替代 → -re；当前拒审 epoch 替代 → -ex", () => {
  const w = world();
  try {
    const ord = { dir: w.at("rv-t1") };
    expect(reviewCheckoutDir(w.root, "T1")).toBe(ord.dir);
    expect(boundReviewCheckout(w.f.db, w.task(), { taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp" }, w.root)).toEqual(ord);
    expect(boundReviewCheckout(w.f.db, w.task(), w.bind("agent-rv-t1", "s-rv", w.intent("ensure_session", w.seq())), w.root)).toEqual(ord);
    const cases = [[{}, ""], [{ legacy: true }, "-re"], [{ refusal: { planSeq: 1, approvalId: "a" } }, "-ex"]] as const;
    for (const [extra, tag] of cases) {
      const e = w.swap(extra);
      expect(replacementTag(e)).toBe(tag);
      const ref = w.bind(`agent-task-rv-t1-r1${tag}`, `s-new${tag}`, w.intent("ensure_session", e.seq + 1));
      expect(boundReviewCheckout(w.f.db, w.task(), ref, w.root)).toEqual({ dir: w.at(`rv-t1${tag}`) });
    }
  } finally { w.f.close(); }
});

test("RVWT1 反例：名字带 -ex 但无替代来源、绑定早于 swap、非 ensure_session 建的、拒审 epoch 已不是当前窗口、ref 不是当前正式绑定", () => {
  const w = world();
  try {
    const ord = { dir: w.at("rv-t1") };
    // no swap at all: a -ex name is the ordinary rule
    expect(boundReviewCheckout(w.f.db, w.task(), w.bind("agent-task-rv-t1-r1-ex", "s-ex", w.intent("ensure_session", w.seq())), w.root)).toEqual(ord);
    const early = w.intent("ensure_session", w.seq());
    const e = w.swap({ refusal: { planSeq: 1, approvalId: "a" } });
    expect(boundReviewCheckout(w.f.db, w.task(), w.bind("agent-task-rv-t1-r1-ex", "s-ex", early), w.root)).toEqual(ord);
    expect(boundReviewCheckout(w.f.db, w.task(), w.bind("agent-task-rv-t1-r1-ex", "s-ex", w.intent("fix_swap", e.seq + 1)), w.root)).toEqual(ord);
    expect(boundReviewCheckout(w.f.db, w.task(), w.bind("agent-task-rv-t1-r1-ex", "s-ex", w.intent("ensure_session", e.seq + 1, "build")), w.root)).toEqual(ord);
    const ref = w.bind("agent-task-rv-t1-r1-ex", "s-ex", w.intent("ensure_session", e.seq + 1));
    expect(boundReviewCheckout(w.f.db, w.task(), ref, w.root)).toEqual({ dir: w.at("rv-t1-ex") });
    for (const moved of [{ headSHA: "b".repeat(40) }, { round: w.task().round + 1 }, { specRev: w.task().specRev + 1 }]) {
      expect(boundReviewCheckout(w.f.db, { ...w.task(), ...moved }, ref, w.root)).toEqual({ manual: expect.stringContaining("拒审替代来源已不是") });
    }
    for (const other of [{ sessionId: "s-other" }, { agent: "agent-rv-t1" }, { family: "claude" as const }, { taskId: "T2" }, { role: "author" as const }]) {
      expect(boundReviewCheckout(w.f.db, w.task(), { ...ref, ...other }, w.root)).toEqual({ manual: expect.stringContaining("不是本卡当前正式审查绑定") });
    }
    // a retired binding gives no replacement path
    w.bind("agent-task-rv-t1-r1-ex", "s-ex", w.intent("ensure_session", e.seq + 1), "retired");
    expect(boundReviewCheckout(w.f.db, w.task(), ref, w.root)).toEqual(ord);
  } finally { w.f.close(); }
});

test("RVWT1 普通家族替代：autoTickDeps.pinReview 把住在 rv-<task> 的替代会话固定到 head；住在 -ex 目录则照旧拒派", async () => {
  const w = world();
  try {
    const author = w.at("author");
    mkdirSync(author);
    sh(author, "init", "-q", "-b", "main");
    writeFileSync(join(author, "a.txt"), "one\n");
    sh(author, "add", "a.txt");
    sh(author, "commit", "-q", "-m", "one");
    const base = sh(author, "rev-parse", "HEAD");
    writeFileSync(join(author, "a.txt"), "two\n");
    sh(author, "commit", "-q", "-am", "two");
    const head = sh(author, "rev-parse", "HEAD");
    w.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [head]);
    for (const d of ["rv-t1", "rv-t1-ex"]) expect(await openReviewWorktree(author, w.at(d), base)).toEqual({ dir: w.at(d) });
    const e = w.swap({});
    const ref = w.bind("agent-task-rv-t1-r1", "s-new", w.intent("ensure_session", e.seq + 1));
    const reg = JSON.parse(readFileSync(w.f.registryPath, "utf8"));
    reg.agents["agent-task-rv-t1-r1"] = { runtime: "codex", transport: "acp", sessionId: "s-new", cwd: w.at("rv-t1") };
    writeFileSync(w.f.registryPath, JSON.stringify(reg));
    const d = autoTickDeps(w.f.db, { registryPath: w.f.registryPath, worktreeRoot: w.root });
    expect(await d.pinReview(w.task(), ref, head)).toEqual({ dir: w.at("rv-t1") });
    expect(sh(w.at("rv-t1"), "rev-parse", "HEAD")).toBe(head);
    reg.agents["agent-task-rv-t1-r1"].cwd = w.at("rv-t1-ex");
    writeFileSync(w.f.registryPath, JSON.stringify(reg));
    expect(await d.pinReview(w.task(), ref, head)).toEqual({ manual: expect.stringContaining("不是它独立的审查 worktree") });
    expect(sh(w.at("rv-t1-ex"), "rev-parse", "HEAD")).toBe(base);
  } finally { w.f.close(); }
});

test("RVWT1 r1 legacy-window：旧单退休替代（-re）的来源窗口已不是本卡当前 head/轮次/规格 → 不给目录；普通家族替代没有窗口照旧 rv-<task>", () => {
  const w = world();
  try {
    const e = w.swap({ legacy: true });
    const ref = w.bind("agent-task-rv-t1-r1-re", "s-re", w.intent("ensure_session", e.seq + 1));
    expect(boundReviewCheckout(w.f.db, w.task(), ref, w.root)).toEqual({ dir: w.at("rv-t1-re") });
    for (const moved of [{ headSHA: "b".repeat(40) }, { round: w.task().round + 1 }, { specRev: w.task().specRev + 1 }]) {
      // 旧代码：-re 不核来源窗口，照样给 rv-t1-re，向旧替代会话派新 head 的审查单
      expect(boundReviewCheckout(w.f.db, { ...w.task(), ...moved }, ref, w.root)).toEqual({ manual: expect.stringContaining("旧单退休替代来源已不是") });
    }
    const plain = w.swap({});
    const swapped = w.bind("agent-task-rv-t1-r1", "s-new", w.intent("ensure_session", plain.seq + 1));
    expect(boundReviewCheckout(w.f.db, { ...w.task(), headSHA: "b".repeat(40) }, swapped, w.root)).toEqual({ dir: w.at("rv-t1") });
  } finally { w.f.close(); }
});

test("RVWT1 r1 cwd-drift：生产 worker 发审查单前再核 registry 目录——移到作者树 / 同前缀邻居即拒发（不碰 bridge），回到本目录才往下走", async () => {
  const w = world();
  try {
    const ref = w.bind("agent-rv-t1", "s-rv", w.intent("ensure_session", w.seq()));
    const setCwd = (cwd: string) => {
      const reg = JSON.parse(readFileSync(w.f.registryPath, "utf8"));
      reg.agents["agent-rv-t1"].cwd = cwd;
      writeFileSync(w.f.registryPath, JSON.stringify(reg));
    };
    const t = w.task();
    const order = { taskId: "T1", specRev: t.specRev, head: t.headSHA, round: t.round, node: "adversarial_review", step: "review" as const,
      dedupKey: "i-rv", inputs: [], outputs: [], acceptance: [], writeBack: "", delivery: { mode: "text" as const, reason: "测试" } };
    const ws = autoTickDeps(w.f.db, { registryPath: w.f.registryPath, worktreeRoot: w.root }).worker(ref);
    if ("manual" in ws) throw new Error(ws.manual);
    for (const cwd of [w.at("author"), w.at("rv-t12")]) {
      setCwd(cwd);
      // 旧代码：worker 只核 session，照样投递
      expect(await ws.submit(ref, "i-rv", order)).toMatchObject({ status: "rejected", reason: expect.stringContaining("发送前复核审查目录") });
    }
    setCwd(w.at("rv-t1"));
    const ok = await ws.submit(ref, "i-rv", order); // 测试 preload 把 bridge 指向无人监听的端口：这里只证明没被目录复核拦下
    expect("reason" in ok ? ok.reason : "").not.toContain("发送前复核审查目录");
    w.bind("agent-rv-t1", "s-rv", w.intent("ensure_session", w.seq()), "retired");
    w.bind("agent-other", "s-other", w.intent("ensure_session", w.seq()));
    expect(await ws.submit(ref, "i-rv", order)).toMatchObject({ status: "rejected", reason: expect.stringContaining("不是本卡当前正式审查绑定") });
  } finally { w.f.close(); }
}, 60_000);

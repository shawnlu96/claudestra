/**
 * agents-PMJOB1 测试共用的世界：真实台账（pmFixture）+ 真实 openOrderAsk + 真实 deliverPmLocal / pmDigest / pmJob 接线；
 * 只有模型（run）、额度、远端发送是可控桩，状态全在临时目录。提问经真实的台账通知信封（bridge「ledger」，ledger-ask:<askId>）进 PM 投递口。
 */
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { pmDigest } from "../src/bridge/pm-digest.js";
import { pmJob, type PmJobBridgeDeps } from "../src/bridge/pm-job.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import type { CodexResult, CodexRunOpts } from "../src/lib/codex.js";
import { getAsk, openAskFull, patchAsk, type Ask } from "../src/lib/ledger-asks.js";
import { getTask } from "../src/lib/ledger-store.js";
import { setMeta, setTask } from "../src/lib/ledger-write.js";
import { openOrderAsk, type OpenedOrderAsk } from "../src/lib/order-ask.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { PmJobStore } from "../src/lib/pm-job-store.js";
import type { PmJobMode } from "../src/lib/pm-job-types.js";
import { runPmJobWorker, type PmJobWorkerDeps } from "../src/lib/pm-job-worker.js";
import { A, B, P, pmFixture } from "./pm-role-fixture.test.js";

export { A, B, P };
export const ASKER = "agent-worker-1", REMOTE = "worker-9@remote", ORDER = "order-T1-1";
export const SPEC = ["# T1 · 合成规格", "", "## 验收线", "1. 新文件不超过 800 行", "2. 只改 src/lib/thing.ts", "", "## 范围", "- src/lib/thing.ts"].join("\n");
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const defaults = { digest: { ...pmDigest.deps }, job: { ...pmJob.deps } };

export type Sent = { to: string | undefined; content: string; id: string };
export type JobWorld = Awaited<ReturnType<typeof jobWorld>>;

/** 模型桩：按白名单类型答，依据是规格第 4 行和仓库里的文件 */
export const goodAnswer = (job: { specPath: string }, over: Record<string, unknown> = {}): string => JSON.stringify({
  type: "acceptance", answer: "验收线 1 说的是新文件不超过 800 行。", evidence: [{ file: job.specPath, line: 4 }, { file: "src/lib/thing.ts", line: 2 }],
  confident: true, reason: "", pending: [], ...over,
});

/** 出借台账里的一单（审查单当场回规则、结清的单不再收答复） */
export function lendOrder(db: Database, orderId: string, step: "review" | "write", status: string): void {
  db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, worker, leaseMs,
    createdBy, createdAt, updatedAt) VALUES (?, 'T1', ?, 'remote', 'claude', ?, 1, 0, 'head', 'repo', '{}', '', 'sha', ?, 'worker-9', 60000, 'test', 1, 1)`)
    .run(orderId, P, step, status);
}

export async function jobWorld(mode: PmJobMode | null = "on") {
  const f = pmFixture(), repo = join(f.dir, "repo"), docs = join(f.dir, "docs"), specPath = join(docs, "tasks", "T1.md");
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  mkdirSync(join(docs, "tasks"), { recursive: true });
  writeFileSync(join(repo, "src", "lib", "thing.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(repo, "src", "lib", "outside.ts"), "export const c = 3;\n");
  writeFileSync(specPath, SPEC);
  setMeta(f.db, { actor: "owner" }, { project: P, key: "docsDir", value: docs });
  setTask(f.db, { actor: "owner" }, { id: "T1", rev: getTask(f.db, "T1")!.rev, patch: { extra: { fileGlobs: ["src/lib/thing.ts"] } } });
  const digest = new PmDigestStore(join(f.dir, "pm-digest.json"), join(f.dir, "pm-digest-mode.json"));
  const store = new PmJobStore(join(f.dir, "pm-job"), digest.modePath);
  writeFileSync(digest.modePath, JSON.stringify({ projects: { [P]: "on" }, routeProjects: { [P]: "observe" } }));
  if (mode) store.setMode(P, mode);
  const state = await f.deps.read(), clients = new Map([["channel-a", { ws }], ["channel-b", { ws }], ["channel-d", { ws }]]);
  let clock = 1_000_000;
  const now = () => clock;
  Object.assign(pmDigest.deps, { store: digest, db: () => f.db, now, agents: () => state.agents, heldCarriers: () => new Set() });
  const pm: Sent[] = [], asker: Sent[] = [], remote: { to: string; text: string }[] = [];
  const send = async (e: Envelope, to: LocalEndpoint): Promise<Delivery> => {
    pm.push({ to: to.agentName, content: e.content, id: e.meta.messageId });
    return { envelope: e, outcome: { kind: "sent" } };
  };
  const book = new AgentCallBook(null), receipts = new Map();
  /** 台账通知的真实信封形状（bridge/team-router.ts envelopeOf）；PM 走真实 deliverPmLocal，执行者直接记下 */
  const envelope = (to: string, content: string, messageId: string, from: Envelope["from"] = { kind: "bridge", label: "ledger" }): Envelope => ({
    from, to: { kind: "local", agentName: to, channelId: to === A ? "channel-a" : to === B ? "channel-b" : "channel-d", ws }, intent: "notification", content,
    meta: { messageId, triggerKind: "bridge_synth", ts: "2026-10-12T00:00:00Z", threadId: "t", waitForIdle: true } });
  const deliver = (env: Envelope) => deliverPmLocal(env, env.to as LocalEndpoint, clients, book, receipts, send, { db: f.db, agents: state.agents });
  const notify: PmJobBridgeDeps["notify"] = async (to, text, messageId) => {
    if (to !== A && to !== B) return asker.push({ to, content: text, id: messageId }), { handed: true, note: "已送达" };
    const d = await deliver(envelope(to, text, messageId));
    return { handed: d.outcome.kind === "sent", note: d.outcome.kind };
  };
  const jobDeps: PmJobBridgeDeps = { store, digest, now, db: () => f.db, askDb: async () => f.db, notify, repoDir: () => repo,
    tell: async (a, text) => (remote.push({ to: String(a.fromAgent), text }), true), readSpec: pmJob.deps.readSpec };
  Object.assign(pmJob.deps, jobDeps);
  /** 执行者经 ask 工具提问（真实 openOrderAsk）：开 ask、把通知交给 PM 投递口 */
  const ask = async (question: string, o: { from?: string; class?: "blocker" | "design" | "scope"; default?: string; orderId?: string } = {}) => {
    const r = await openOrderAsk(f.db, {
      open: (input, beforeWrite) => openAskFull(f.db, input, now(), { beforeWrite }), notify,
      markHanded: (id) => patchAsk(f.db, id, { extra: { notice: "handed", handedAt: now() } }), record: () => {},
    }, { task: { id: "T1", project: P, pm: A }, orderId: o.orderId ?? ORDER, from: o.from ?? ASKER, keyPrefix: "mcp-ask" },
    { question, options: [], class: o.class ?? "blocker", ...(o.default ? { default: o.default } : {}) });
    if (!("askId" in r)) throw new Error(`ask 没开出来：${JSON.stringify(r)}`);
    return r as OpenedOrderAsk;
  };
  const runs: CodexRunOpts[] = [];
  /** 可控的一次性 worker：模型输出由 reply 决定 */
  const work = (reply: (opts: CodexRunOpts) => Promise<CodexResult> | CodexResult = () => ({ ok: true, message: goodAnswer({ specPath }), sessionId: null, elapsedMs: 5 }),
    over: Partial<PmJobWorkerDeps> = {}) => runPmJobWorker({ store, now, pid: process.pid, quota: async () => ({ ok: true, line: 70, usedPct: 10 }),
    slot: async () => ({ id: "slot", release: async () => {} }), timeoutMs: 1000, leaseMs: 60_000,
    run: async (opts) => (runs.push(opts), reply(opts)), ...over });
  return { f, repo, specPath, store, digest, pm, asker, remote, runs, ask, work, notify, now, jobDeps, deliver, envelope,
    advance: (ms: number) => { clock += ms; }, askOf: (id: string) => getAsk(f.db, id) as Ask,
    close: () => { pmJob.stop(); pmDigest.stop(); Object.assign(pmDigest.deps, defaults.digest); Object.assign(pmJob.deps, defaults.job); f.close(); } };
}

test("world: an executor's blocker ask reaches the PM entry as the ledger notice", async () => {
  const w = await jobWorld("off");
  try {
    const r = await w.ask("验收线 1 的行数上限是多少？");
    expect(w.pm).toEqual([{ to: A, id: `ledger-ask:${r.askId}`, content: expect.stringContaining("【执行者提问】T1") }]);
    expect(w.askOf(r.askId)).toMatchObject({ state: "open", extra: { class: "blocker", notice: "handed" } });
  } finally { w.close(); }
});

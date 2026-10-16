/**
 * The ledger side of peer PR auto review (i28-A2): intake a PR as an auto card, hand a new stable head to the card, record one
 * push / notice row. Only the scheduler service (or a real PM by hand) runs them; peer-prs.json is re-read here and the PR's
 * facts are read from GitHub here, never trusted from the caller; every check is repeated inside the write
 * (lib/peer-pr-ledger.ts). tests/peer-pr-ledger.test.ts.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getWorkflow } from "../lib/ledger-scheduler.js";
import { getTask, LedgerError } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { readPeerPrConfig, type PeerPrConfig } from "../lib/peer-pr-config.js";
import { peerPrGithub, type PeerPrGithub } from "../lib/peer-pr-github.js";
import { verifiedIntake } from "../lib/peer-pr-intake.js";
import { headLineage } from "../lib/peer-pr-head-review-git.js";
import { headReviewMode, type Lineage } from "../lib/peer-pr-head-review.js";
import { headWrite, intakeWrite, observeWrite, peerTaskId, PUSH_RESULTS, recordPeerPrNote, REDELIVER_PREFIX, type PushResult } from "../lib/peer-pr-ledger.js";
import { claimRedelivery, requestRedelivery } from "../lib/peer-pr-retry.js";
import { peerPrSpec } from "../lib/peer-pr-spec.js";
import { readReviewReport } from "../lib/peer-pr-tick.js";
import { intFlag, jsonObjectFlag } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function allow(c: LedgerCli, project: string, what: string): void {
  if (c.deps.actor !== "scheduler") c.requireRealPm(project, what);
}

function configFor(project: string): PeerPrConfig {
  const read = readPeerPrConfig();
  if (read.kind !== "on") throw new LedgerError("forbidden", read.kind === "error" ? `peer-prs.json 读不成：${read.error}` : "peer-prs.json 没开");
  if (read.config.project !== project) throw new LedgerError("forbidden", `peer-prs.json 不收项目 ${project} 的 PR`);
  return read.config;
}

/** GitHub reads of the intake command; tests swap `make` (there the ledger CLI runs in-process). */
export const intakeGithub = { make: (repoDir: string): PeerPrGithub => peerPrGithub(repoDir) };

/** PEERHEAD1: how the new head relates to the card's, read from the peer repository (never from args); unreadable = missing. */
async function lineageOf(repoDir: string, oldHead: string | null, newHead: string): Promise<Lineage> {
  if (!oldHead) return "missing";
  try { return await headLineage.read(repoDir, oldHead, newHead); } catch { return "missing"; }
}

/** The spec card is written once, before the card exists (mode 0600); a duplicate intake keeps the first one. */
function writeSpec(n: number, text: string): string {
  const path = statePath("ledger", "peer-prs", `${peerTaskId(n)}.md`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

export const PEER_PR_CMDS: Record<string, CommandSpec> = {
  "peer-pr-intake": {
    valued: ["project", "number", "head"], bools: [],
    usage: "peer-pr-intake --project <id> --number <n> --head <sha>（调度器收 peer PR 成自动卡；PR 的事实现读 GitHub）",
    async run(c) {
      const project = c.project();
      allow(c, project, "收 peer PR ");
      const cfg = configFor(project);
      const number = intFlag(c.p, "number");
      if (number === undefined) throw new LedgerError("invalid", "缺 --number");
      const facts = await verifiedIntake(intakeGithub.make(cfg.repoDir), cfg, number, c.need("head"));
      const known = statePath("ledger", "peer-prs", `${peerTaskId(number)}.md`);
      const spec = getTask(c.db, peerTaskId(number)) && existsSync(known) ? known : writeSpec(number, peerPrSpec(facts));
      c.deps.assertLease?.();
      const r = intakeWrite(c.db, c.ctx(), { ...facts, project, spec }, cfg);
      return { ok: true, task: { id: r.task.id, stage: r.task.stage, round: r.task.round }, duplicate: r.duplicate, surface: facts.surface };
    },
  },
  "peer-pr-observe": {
    valued: ["head"], bools: [],
    usage: "peer-pr-observe <task> --head <sha>（peer PR 的新 head 稳定后交给卡：fix 直接复验，review 有结论时先转 fix；" +
      "manual 卡在审查通过后作者新推：登记新 head 进 review，peerPrHeadReview）",
    async run(c) {
      const task = c.task(c.p.pos[1]);
      allow(c, task.project, "记 peer PR 新 head ");
      const cfg = configFor(task.project), head = c.need("head");
      const mode = headReviewMode(task.project);
      // PEERHEAD1: a manual card only ever meets the author-push registration (headWrite); handing it back is peerPrHeadResume's
      if (mode !== "off" && getWorkflow(c.db, task.id)?.mode === "manual") {
        const lineage = await lineageOf(cfg.repoDir, task.headSHA, head);
        c.deps.assertLease?.();
        const r = headWrite(c.db, c.ctx(), { taskId: task.id, head, lineage });
        return { ok: true, moved: r.moved, reason: r.reason, lineage, task: { id: r.task.id, stage: r.task.stage, round: r.task.round } };
      }
      // off: no repository read and no registration, the observe as it was
      const lineage = mode === "off" ? undefined : await lineageOf(cfg.repoDir, task.headSHA, head);
      c.deps.assertLease?.();
      const r = observeWrite(c.db, c.ctx(), { taskId: task.id, head, ...(lineage ? { lineage } : {}) });
      return { ok: true, moved: r.moved, reason: r.reason, task: { id: r.task.id, stage: r.task.stage, round: r.task.round } };
    },
  },
  "peer-pr-retry": {
    valued: ["review", "refused"], bools: [],
    usage: "peer-pr-retry <task> --review <审查事件 seq> --refused <拒收记录 seq>（PM 对一次已拒收的审查报告申请一次投递补发；照走原推送通道和全部门禁）",
    run(c) {
      const task = c.task(c.p.pos[1]);
      c.requireRealPm(task.project, "申请补发 peer 审查报告");
      const cfg = configFor(task.project);
      const review = intFlag(c.p, "review"), refused = intFlag(c.p, "refused");
      if (review === undefined || refused === undefined) throw new LedgerError("invalid", "缺 --review / --refused");
      c.deps.assertLease?.();
      const r = requestRedelivery(c.db, { actor: c.deps.actor, now: c.deps.now() }, { taskId: task.id, review, refused }, cfg, (path) => readReviewReport(path));
      return { ok: true, key: r.key, event: { seq: r.event.seq }, duplicate: r.duplicate, note: "已排队：下一轮调度按原通道发一次，结果看这个 key 的推送记录" };
    },
  },
  "peer-pr-push-record": {
    valued: ["project", "key", "result", "text", "data"], bools: [],
    usage: `peer-pr-push-record <task|-> [--project <id>] --key <k> --result ${PUSH_RESULTS.join("|")} --text <t> [--data <json>]（peer PR 推送 / 通知记一行 note）`,
    run(c) {
      const t = c.target(c.p.pos[1]);
      allow(c, t.project, "记 peer PR 推送 ");
      const result = c.need("result") as PushResult;
      c.deps.assertLease?.();
      const input = { project: t.project, target: t.task?.id ?? "", key: c.need("key"), result, text: c.need("text"), data: jsonObjectFlag(c.p, "data") };
      // A redelivery's claim re-checks the request (head, spec, round, peer, requester, original evidence) in the same transaction.
      const r = result === "claimed" && input.key.startsWith(REDELIVER_PREFIX) ? claimRedelivery(c.db, c.ctx(), configFor(t.project), input)
        : recordPeerPrNote(c.db, c.ctx(), input);
      return { ok: true, event: { seq: r.event.seq, text: r.event.text }, duplicate: r.duplicate };
    },
  },
};

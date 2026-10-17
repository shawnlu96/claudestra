/**
 * `ledger scheduler-remote-review <task> --inbox <file>`: book one repository-owner review push the bridge stashed (RRL-1).
 * Nothing in the file is trusted: it is re-read from the inbox only, the sender must still be the project's handoffPeer, the text
 * must still parse strictly and still match exactly this one card; then lib/remote-review-ledger.ts records it in one transaction.
 * `--apply <seq>` acts on a booking that did not match then and does now; `--notified <seq>` marks that PM got that event's notice.
 * Scheduler service (or a real PM by hand) only.
 * tests/remote-review-intake-ledger.test.ts.
 */
import { LedgerError } from "../lib/ledger-store.js";
import { readInbox, REMOTE_INBOX_DIR } from "../lib/remote-review-inbox.js";
import { applyLateRemote, markRemoteNotified, recordRemoteReview } from "../lib/remote-review-ledger.js";
import { handoffProjects, matchRemoteCard } from "../lib/remote-review-read.js";
import { parseRemoteReview } from "../lib/remote-review-parse.js";
import { readSchedulerConfig, type SchedulerConfig } from "../lib/scheduler-config.js";
import { intFlag } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const REMOTE_REVIEW_SERVICE = new Set(["scheduler-remote-review"]);

function book(c: LedgerCli, taskId: string, file: string, readConfig: () => SchedulerConfig, dir: string, reportDir?: string) {
  let entry;
  try { entry = readInbox(file, dir); } catch (e) { throw new LedgerError("invalid", `收件读不成：${(e as Error).message}`); }
  if (entry.taskId !== taskId) throw new LedgerError("conflict", `收件记的是 ${entry.taskId}，不是 ${taskId}`);
  const task = c.task(taskId), projects = handoffProjects(readConfig(), entry.peer);
  if (!projects.includes(task.project)) throw new LedgerError("forbidden", `${entry.peer} 不是项目 ${task.project} 的 handoffPeer`);
  const review = parseRemoteReview(entry.text);
  if (!review) throw new LedgerError("invalid", "收件正文不是仓库方审查推送的格式");
  if (matchRemoteCard(c.db, projects, review)?.id !== task.id) throw new LedgerError("conflict", `${review.repo} PR #${review.number} 现在对不上唯一的 ${task.id}`);
  c.deps.assertLease?.();
  return recordRemoteReview(c.db, c.ctx(), { taskId: task.id, review, peer: entry.peer, reportDir });
}

/** readConfig / dir / reportDir are for tests (the real ones: scheduler.json, the state-dir inbox, ledger/reviews). */
export function remoteReviewCmds(readConfig: () => SchedulerConfig = readSchedulerConfig, dir = REMOTE_INBOX_DIR, reportDir?: string): Record<string, CommandSpec> {
  return {
    "scheduler-remote-review": {
      valued: ["inbox", "apply", "notified"], bools: [],
      usage: "scheduler-remote-review <task> --inbox <收件文件> | --apply <seq> | --notified <seq>" +
        "（仓库方审查结论入账 / 到 head 后生效 / 通知已送达；调度服务或项目 PM）",
      run(c) {
        const task = c.task(c.p.pos[1]);
        if (c.deps.actor !== "scheduler") c.requireRealPm(task.project, "仓库方审查结论入账");
        const notified = intFlag(c.p, "notified"), apply = intFlag(c.p, "apply"), inbox = c.p.flags.inbox;
        if ([notified, apply, inbox].filter((x) => x !== undefined).length !== 1) throw new LedgerError("invalid", "--inbox / --apply / --notified 三选一");
        c.deps.assertLease?.();
        if (notified !== undefined) return { ok: true, ...markRemoteNotified(c.db, c.ctx(), { taskId: task.id, seq: notified }) };
        if (apply !== undefined) return { ok: true, ...applyLateRemote(c.db, c.ctx(), { taskId: task.id, seq: apply }) };
        const r = book(c, task.id, inbox!, readConfig, dir, reportDir);
        return { ok: true, duplicate: r.duplicate, event: r.event, notice: r.notice };
      },
    },
  };
}

export const REMOTE_REVIEW_CMDS = remoteReviewCmds();

/**
 * The ledger side of peer PR auto review (i28-A2): intake a PR as an auto card, hand a new stable head to the card, record one
 * push / notice row. Only the scheduler service (or a real PM by hand) runs them; peer-prs.json is re-read here and the PR's
 * facts are read from GitHub here, never trusted from the caller; every check is repeated inside the write
 * (lib/peer-pr-ledger.ts). tests/peer-pr-ledger.test.ts.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getTask, LedgerError } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { readPeerPrConfig, type PeerPrConfig } from "../lib/peer-pr-config.js";
import { peerPrGithub, type PeerPrGithub } from "../lib/peer-pr-github.js";
import { verifiedIntake } from "../lib/peer-pr-intake.js";
import { intakeWrite, observeWrite, peerTaskId, PUSH_RESULTS, recordPeerPrNote, type PushResult } from "../lib/peer-pr-ledger.js";
import { peerPrSpec } from "../lib/peer-pr-spec.js";
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
    usage: "peer-pr-observe <task> --head <sha>（peer PR 的新 head 稳定后交给卡：fix 直接复验，review 有结论时先转 fix）",
    run(c) {
      const task = c.task(c.p.pos[1]);
      allow(c, task.project, "记 peer PR 新 head ");
      configFor(task.project);
      c.deps.assertLease?.();
      const r = observeWrite(c.db, c.ctx(), { taskId: task.id, head: c.need("head") });
      return { ok: true, moved: r.moved, reason: r.reason, task: { id: r.task.id, stage: r.task.stage, round: r.task.round } };
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
      const r = recordPeerPrNote(c.db, c.ctx(), { project: t.project, target: t.task?.id ?? "", key: c.need("key"), result, text: c.need("text"),
        data: jsonObjectFlag(c.p, "data") });
      return { ok: true, event: { seq: r.event.seq, text: r.event.text }, duplicate: r.duplicate };
    },
  },
};

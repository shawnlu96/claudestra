/** S2C chain harness: one local ledger card (`T1`) whose center twin lives in a fake center, so the real stage-two client
 * functions (S2Q claim, X8 gate, S2J merge) send their own commands to S2C. The lease and the intent are made with real
 * lease.acquire / intent.create commands; nothing here writes a receipt or an intent status by hand.
 */
import { join } from "node:path";
import { getIntent, getWorkflow } from "../../src/lib/ledger-scheduler.js";
import { authorizationAction, parseSchedulerCentralContext, type SchedulerCentralRuntime } from "../../src/lib/scheduler-central-context.js";
import { SchedulerCentralJournal } from "../../src/lib/scheduler-central-journal.js";
import { withSchedulerV2LedgerCmds, type SchedulerV2LedgerPort } from "../../src/lib/scheduler-v2-ledger-cmds.js";
import { V2ContractError, v2ObjectDigest, type V2Actor, type V2CommandName, type V2ErrorCode } from "../../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../../src/lib/shared-ledger-contract-v2-fixtures.js";
import { V2_ROUTES } from "../../src/lib/shared-ledger-contract-v2-routes.js";
import { autoFixture } from "../scheduler-auto-helpers.js";
import { FakeCenter } from "./shared-ledger-v2-fake-center.js";
import { ACTORS, approvedAsk, featureRows, harness, HOME_SCHEDULER, ROLES, START } from "./shared-ledger-v2-fake-center-kit.js";

export type ChainAction = "dispatch" | "review" | "merge";
const FEATURE = "feature-chain", TASK = "T1", ASK = "ask-chain";
const NODES: Record<ChainAction, string> = { dispatch: "write", review: "adversarial_review", merge: "merge_deploy" };

/** What a signed transport would hand the client: the receipt body, or the center's error code thrown. */
function centerClient(center: FakeCenter, actor: V2Actor) {
  return { command: async (command: unknown): Promise<any> => {
    const res = center.handle({ method: "POST", url: V2_ROUTES.commands.path(V2_FIXTURE_SCOPE), body: command, actor });
    if (res.status !== 200) throw new V2ContractError((res.body as { code: V2ErrorCode }).code);
    return res.body;
  } };
}

export function claimChain(action: ChainAction) {
  const f = autoFixture(), db = f.db;
  db.query("UPDATE tasks SET extra=? WHERE id=?").run(JSON.stringify({ ...f.task().extra, sharedFeatureId: FEATURE }), TASK);
  const local = f.task(), workflowRev = getWorkflow(db, TASK)!.rev;
  const center = new FakeCenter({ roles: ROLES, now: START, homeSchedulerServiceId: HOME_SCHEDULER });
  const rows = featureRows(FEATURE, TASK, "execution"), task: Record<string, any> = rows.task;
  const versions = { taskRev: local.rev, specRev: local.specRev, workflowRev };
  const ask = approvedAsk(ASK, FEATURE, TASK, { ...versions, actions: [authorizationAction(action)] });
  center.seed({ features: [rows.feature], tasks: [{ ...task, rev: local.rev, specRev: local.specRev }],
    workflows: [{ ...rows.workflow, rev: workflowRev, specRev: local.specRev }], asks: [ask] });
  const k = harness(center), owner = ACTORS.owner, head: string = task.head, id = `op-${action}`;
  const expected = { taskId: TASK, expectedRev: local.rev, expectedSpecRev: local.specRev, expectedWorkflowRev: workflowRev };
  const ok = (type: V2CommandName, payload: Record<string, unknown>) => {
    const res = k.post(owner, k.command(type, payload));
    if (res.status !== 200) throw new Error(`${type} refused: ${JSON.stringify(res.body)}`);
  };
  ok("lease.acquire", { ...expected, homeInstanceId: owner.instanceId });
  ok("intent.create", { ...expected, action, node: NODES[action], operationId: id, head, round: task.round, dependencyDigest: "d".repeat(64),
    authorizationAskId: ASK, authorizationDigest: v2ObjectDigest(ask.bind),
    resources: [{ ...V2_FIXTURE_SCOPE, repository: task.repository, kind: "file", path: "src/example.ts" }] });

  /** The center projection a sync would write: intent rows, plus the authorization the intent was frozen with. */
  const sync = async () => {
    for (const i of center.rows().intents.values()) {
      db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,recipient,causalSeq,eventSeq,taskRev,specRev,head,
        templateVersion,status,attempts,receipt,reason,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,updatedAt=excluded.updatedAt`)
        .run(i.id, i.taskId, local.project, i.node, i.action, i.action === "dispatch" ? local.agent : null, i.causalSeq, i.eventSeq,
          i.taskRev, i.specRev, i.head, i.templateVersion, i.status, i.attempts, null, i.reason || `${i.action} plan`, i.createdAt, i.updatedAt);
      db.query("INSERT OR IGNORE INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (?,'center-projection',?,?,'scheduler','',?,?)")
        .run(i.createdAt, local.project, i.taskId, JSON.stringify({ authorizationAskId: i.authorizationAskId,
          authorizationDigest: i.authorizationDigest }), `scheduler:${i.id}`);
    }
  };
  const client = centerClient(center, owner);
  const port: SchedulerV2LedgerPort = {
    route: () => "central", db: () => db, fence: () => ({ ...V2_FIXTURE_FENCE }), registryPath: f.registryPath, clientFor: () => client, sync,
    context: () => ({ ...V2_FIXTURE_SCOPE, serviceGeneration: V2_FIXTURE_FENCE.serviceGeneration, bootId: V2_FIXTURE_FENCE.bootId,
      homeInstanceId: owner.instanceId, fence: { ...V2_FIXTURE_FENCE } }),
  };
  const manager = withSchedulerV2LedgerCmds(f.tickDeps.manager, port);
  const centerIntent = () => center.rows().intents.get(id)!;
  /** The X8 / S2J context of this intent, read from the center rows the client would have projected. */
  const context = () => {
    const i = centerIntent();
    return parseSchedulerCentralContext({ ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, homeInstanceId: i.homeInstanceId, taskId: i.taskId,
      intentId: i.id, operationId: i.operationId, taskRev: i.taskRev, specRev: i.specRev, workflowRev: i.workflowRev, head: i.head,
      action, authorizationAskId: i.authorizationAskId, authorizationDigest: i.authorizationDigest, authorizationBind: ask.bind });
  };
  const runtime: SchedulerCentralRuntime = { instanceId: owner.instanceId, client, lock: { held: () => true } };
  return {
    f, center, id, head, context, runtime, centerIntent,
    journal: new SchedulerCentralJournal(join(f.dir, "central-journal")),
    /** S2Q: the projection arrives, then the scheduler's own claim goes through the wrapped manager. */
    claim: async () => { await sync(); return manager("ledger", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed"); },
    localIntent: () => getIntent(db, id),
    /** Commands of `type` the center has answered so far, by status. */
    served: (type: V2CommandName) => center.log.filter(e => e.command === type).map(e => e.status),
    close: f.close,
  };
}

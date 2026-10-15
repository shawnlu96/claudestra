/**
 * 验收线 1（agents-NOTICETYPE1）：PM 通知入口的级别参数必填，不标编译不过。下面每个 @ts-expect-error 都压着一处「少了级别」的调用：
 * 哪天哪个入口的级别又变成可选，这一行不再报错，`tsc --noEmit`（CI typecheck）就会因多余的 @ts-expect-error 失败。函数从不执行，只给编译器看。
 */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { notifyProjectPm } from "../src/lib/pm-notify.js";
import { sendLedgerNotice } from "../src/bridge/team-router.js";
import { notifyTaskPm } from "../src/bridge/ask-expire.js";
import { sendToPm, type SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";
import type { AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import type { PoolTickDeps } from "../src/lib/scheduler-pool-tick.js";
import type { TrainTickDeps } from "../src/lib/scheduler-merge-train-tick.js";
import type { RetireDeps } from "../src/lib/scheduler-retire.js";
import type { ManualResumeDeps } from "../src/lib/manual-resume.js";
import type { CardReapHost } from "../src/lib/card-proc-reap.js";
import type { FollowUpNoticeDeps } from "../src/lib/review-converge-notice.js";
import type { P2NoticeDeps } from "../src/lib/p2-backlog-notice.js";
import type { HumanNodeDeps } from "../src/bridge/human-node.js";
import type { IdentityNotify } from "../src/lib/scheduler-identity-notice.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import type { centerDeployTick } from "../src/lib/center-deploy-tick.js";

declare const db: Database, task: LedgerTask, env: SpecWaitEnv;
declare const auto: AutoTickDeps, pool: PoolTickDeps, train: TrainTickDeps, retire: RetireDeps, resume: ManualResumeDeps;
declare const center: NonNullable<Parameters<typeof centerDeployTick>[2]["notifyPm"]>;
declare const reap: CardReapHost, converge: FollowUpNoticeDeps, p2: P2NoticeDeps, human: HumanNodeDeps, identity: IdentityNotify;

export function missingLevelDoesNotCompile(): void {
  // @ts-expect-error notifyProjectPm 的 opts.level 必填
  void notifyProjectPm(db, "p", "x", { fromName: "scheduler" });
  // @ts-expect-error sendLedgerNotice 的 pmLevel 必填
  void sendLedgerNotice({ to: "agent-pm", text: "x", messageId: "m" });
  // @ts-expect-error notifyTaskPm 的 level 必填
  void notifyTaskPm(task, "p", "x", "ask_1", "ask-expire");
  // @ts-expect-error sendToPm 的 level 必填
  void sendToPm(env, "p", "agent-pm", "x");
  // @ts-expect-error SpecWaitEnv.notifyPm 端口的 level 必填
  void env.notifyPm("p", "x");
  // @ts-expect-error AutoTickDeps.notifyPm
  void auto.notifyPm(task, "x");
  // @ts-expect-error PoolTickDeps.notifyPm
  void pool.notifyPm(task, "x");
  // @ts-expect-error TrainTickDeps.notifyPm
  void train.notifyPm(task, "x");
  // @ts-expect-error RetireDeps.notifyPm
  void retire.notifyPm(task, "x");
  // @ts-expect-error ManualResumeDeps.notifyPm
  void resume.notifyPm(task, "x");
  // @ts-expect-error CardReapHost.notifyPm
  void reap.notifyPm(task, "x");
  // @ts-expect-error FollowUpNoticeDeps.notifyPm
  void converge.notifyPm(task, "x");
  // @ts-expect-error P2NoticeDeps.notifyPm
  void p2.notifyPm(task, "x");
  // @ts-expect-error HumanNodeDeps.notifyPm
  void human.notifyPm(task, "x", "ask_1");
  // @ts-expect-error IdentityNotify
  void identity(task, "x");
  // @ts-expect-error centerDeployTick 的 notifyPm 端口
  void center("p", "x");
}

export function levelGivenCompiles(): void {
  void notifyProjectPm(db, "p", "x", { fromName: "scheduler", level: "action" });
  void sendLedgerNotice({ to: "agent-pm", text: "x", messageId: "m", pmLevel: "info" });
  void sendToPm(env, "p", "agent-pm", "x", "info");
  void auto.notifyPm(task, "x", "action");
  void center("p", "x", "action");
}

test("the level checks above are compile-time only (tsc --noEmit covers tests/)", () => {
  expect(typeof missingLevelDoesNotCompile).toBe("function");
});

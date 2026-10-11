/** S2C kit: a fake center seeded from the X0 synthetic fixtures (本机 = local home, peer A member, peer B executor),
 * command builders and route callers. Two features: `feature-plan` (planning) and `feature-exec` (execution, epoch 1).
 */
import { parseCommand, type V2Actor, type V2Command, type V2Fence } from "../../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../../src/lib/shared-ledger-contract-v2-fixtures.js";
import { V2_ROUTES, type V2RouteName } from "../../src/lib/shared-ledger-contract-v2-routes.js";
import { FakeCenter, type FakeCenterOptions, type FakeResponse } from "./shared-ledger-v2-fake-center.js";

type Obj = Record<string, any>;
const dto = (k: keyof typeof V2_DTO_FIXTURES): Obj => structuredClone(V2_DTO_FIXTURES[k].valid) as Obj;
const person = (personId: string, instanceId: string): V2Actor => ({ kind: "person", personId, instanceId, serviceId: null,
  representedPersonId: null, orderId: null, projects: [V2_FIXTURE_SCOPE.projectId], actions: [] });
export const ACTORS = { owner: person("person", "local"), member: person("member", "peer-a"), executor: person("executor", "peer-b") };
/** A non-owner person signed in on the home instance. */
export const HOME_MEMBER = person("member", "local");
export const HOME_SCHEDULER = "home-scheduler";
export const ROLES = { person: "owner", member: "member", executor: "member" } as const;
/** A service on the home instance acting for the owner; with an orderId it is a lend-order service, not the scheduler. */
export const service = (serviceId: string, orderId: string | null = null): V2Actor => ({ kind: "service", personId: "person",
  instanceId: "local", serviceId, representedPersonId: "person", orderId, projects: [V2_FIXTURE_SCOPE.projectId], actions: ["intent.cancel"] });
const FENCE: V2Fence = V2_FIXTURE_FENCE;
/** Central clock start: inside the X0 fixtures' ask / bind expiry (100000). */
export const START = 10_000;

/** Feature + task + workflow rows for one feature id, copied from the X0 fixtures. */
export function featureRows(featureId: string, taskId: string, authorityMode: "planning" | "execution") {
  const feature = { ...dto("feature"), id: featureId, authorityMode, currentVersion: 0 };
  const task = { ...dto("task"), id: taskId, featureId, itemId: null };
  return { feature, task, workflow: { ...dto("workflow"), taskId } };
}
/** An owner-approved authorize ask on `featureId` (answered before START, expiring at the fixtures' 100000). */
export function approvedAsk(id: string, featureId: string, taskId: string | null, bind: Obj = {}): Obj {
  const ask = dto("ask");
  return { ...ask, id, featureId, taskId, bind: { ...ask.bind, featureId, taskId, ...bind }, state: "answered", rev: 2,
    answeredBy: "person", answeredAt: 2000, answer: { kind: "option", optionId: "approve" }, decision: "approved" };
}

/** Command builder and route callers over one center. */
export function harness(center: FakeCenter) {
  let n = 0;
  /** A contract-valid command; requestId is fresh unless given. */
  const command = <K extends V2Command["type"]>(type: K, payload: Obj, extra: Partial<V2Fence & { requestId: string }> = {}) =>
    parseCommand({ ...V2_FIXTURE_SCOPE, ...FENCE, requestId: `request-${++n}`, ...extra, type, payload }) as Extract<V2Command, { type: K }>;
  const post = (actor: V2Actor, body: unknown): FakeResponse =>
    center.handle({ method: "POST", url: V2_ROUTES.commands.path(V2_FIXTURE_SCOPE), body, actor });
  const call = (actor: V2Actor | null, name: V2RouteName, params: Obj = {}, body?: unknown): FakeResponse => {
    const route = V2_ROUTES[name] as { method: "GET" | "POST"; path(p: Obj): string };
    return center.handle({ method: route.method, url: route.path({ ...V2_FIXTURE_SCOPE, ...params }), body, actor });
  };
  return { center, command, post, call };
}
export function kit(options: Partial<FakeCenterOptions> = {}) {
  const center = new FakeCenter({ roles: ROLES, now: START, homeSchedulerServiceId: HOME_SCHEDULER, ...options });
  const plan = featureRows("feature-plan", "task-plan", "planning"), exec = featureRows("feature-exec", "task-exec", "execution");
  center.seed({ features: [plan.feature, exec.feature], tasks: [plan.task, exec.task], workflows: [exec.workflow],
    asks: [approvedAsk("ask-exec", "feature-exec", "task-exec")] });
  return harness(center);
}
/** Execution task version fields for `task-exec` as seeded (rev 1, spec 1, workflow 1). */
export const EXEC_TASK = { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, expectedWorkflowRev: 1 };
export const code = (r: FakeResponse) => (r.body as { code?: string }).code;

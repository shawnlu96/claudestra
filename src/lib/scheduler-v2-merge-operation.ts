import { assertLocalOwner, type SchedulerCentralContext, type SchedulerCentralRuntime } from "./scheduler-central-context.js";
import { checkSchedulerCentral, reportSchedulerCentral, schedulerCentralResult } from "./scheduler-central-gate.js";
import { type SchedulerCentralJournal } from "./scheduler-central-journal.js";
import { parseOperationResult, v2ObjectDigest, type V2OperationResult } from "./shared-ledger-contract-v2.js";
import { mergeReason, SchedulerV2MergeWait, type SchedulerV2MergePort } from "./scheduler-v2-merge-context.js";
import type { MergeExternal } from "./scheduler-merge-driver.js";

const SHA = /^[a-f0-9]{40}$/i;
/** The frozen result contract carries this evidence in one dedicated line until a separate field exists. */
export function parseSchedulerV2MergeSha(summary: string): string | null {
  const lines = summary.split("\n").filter(line => line.startsWith("mergeSha:"));
  return lines.length === 1 && /^mergeSha:[a-f0-9]{40}$/.test(lines[0]!) ? lines[0]!.slice(9) : null;
}

/** Reconciliation reads authoritative operation state first. An unknown claim never becomes permission to resend. */
async function replayMerge(port: SchedulerV2MergePort, context: SchedulerCentralContext,
  journal: SchedulerCentralJournal, external: MergeExternal, pr: string): Promise<string | null> {
  const entry = journal.read(context);
  if (!entry) return null;
  if (!port.reconcile) throw new SchedulerV2MergeWait("unknown_operation：缺少在线对账端口");
  const raw = await port.reconcile(context, entry);
  if (!raw) throw new SchedulerV2MergeWait("unknown_operation：中心尚未确认");
  const result = parseOperationResult(raw);
  if (v2ObjectDigest(result) !== v2ObjectDigest(schedulerCentralResult(context, result, result.observedAt))) {
    throw new SchedulerV2MergeWait("authorization_mismatch：对账结果与原意图不符");
  }
  if (result.state !== "succeeded") throw new SchedulerV2MergeWait(`${result.state}_operation：等待 owner 对账`);
  const sha = parseSchedulerV2MergeSha(result.summary), snapshot = await external.inspect(pr);
  if (!sha || !SHA.test(sha) || snapshot.state !== "MERGED" || snapshot.base !== "main"
    || snapshot.head !== context.head || snapshot.mergeSha !== sha) throw new SchedulerV2MergeWait("unknown_operation：合并提交无法核实");
  entry.result = result; entry.state = "confirmed"; journal.write(entry);
  return sha;
}

/** The durable claim precedes the bounded effect; even a late success cannot clear a timed-out operation locally. */
async function boundedEffect<T>(effect: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([effect(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("merge effect timeout")), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function runMergeOperation(input: {
  port: SchedulerV2MergePort; context: SchedulerCentralContext; runtime: SchedulerCentralRuntime;
  journal: SchedulerCentralJournal; external: MergeExternal; pr: string; action: "merge" | "updateBranch";
  assertRoute(): void;
}): Promise<string | void> {
  const { port, context: c, runtime, journal, external, pr, action, assertRoute } = input;
  const previous = journal.read(c);
  if (previous) {
    if (action === "merge") return (await replayMerge(port, c, journal, external, pr))!;
    throw new SchedulerV2MergeWait("unknown_operation：分支更新已发出，须对账后建立新 head 意图");
  }
  await checkSchedulerCentral(c, runtime);
  assertRoute();
  const entry = journal.begin(c);
  if (!entry) throw new SchedulerV2MergeWait("unknown_operation");
  entry.steps.push({ operationId: `step-${v2ObjectDigest([c.operationId, action])}`, state: "started" });
  journal.write(entry);
  let sha: string | undefined;
  try {
    assertRoute(); assertLocalOwner(c, runtime);
    const returned = await boundedEffect<string | void>(() => action === "merge" ? external.merge(pr, c.head!) : external.updateBranch(pr), 120_000);
    if (action === "merge") {
      if (typeof returned !== "string" || !SHA.test(returned)) throw new Error("merge API 未确认完整合并 SHA");
      sha = returned.toLowerCase();
    }
    assertRoute(); assertLocalOwner(c, runtime);
    entry.steps[0]!.state = "succeeded";
    // Updating the branch changes the authorized head. It cannot settle the encompassing merge intent as succeeded.
    if (action === "updateBranch") { journal.write(entry); return; }
    entry.result = schedulerCentralResult(c, { state: "succeeded", head: c.head, summary: `mergeSha:${sha}`, artifactIds: [] }, Date.now());
  } catch (error) {
    entry.steps[0]!.state = "unknown";
    entry.result = schedulerCentralResult(c, { state: "unknown", head: c.head,
      summary: `合并副作用未确认：${mergeReason(error).slice(0, 1000)}`, artifactIds: [] }, Date.now());
  }
  entry.state = "unknown";
  journal.write(entry);
  try { await reportSchedulerCentral(c, runtime, entry.result!); }
  catch (error) { throw new SchedulerV2MergeWait(`unknown_operation：结果回执未确认（${mergeReason(error)}）`); }
  entry.state = "confirmed"; journal.write(entry);
  if (entry.result!.state !== "succeeded") throw new SchedulerV2MergeWait("unknown_operation：禁止重试，下一轮先在线对账");
  return sha;
}

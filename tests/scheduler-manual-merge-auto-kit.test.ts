/**
 * MANAUTOQ1 共享夹具（本身没有用例；按 *.test.ts 命名以留在本卡文件范围内）。复用 RVWAKE1 的 S2W 形状（scheduler-review-pm-kit.test.ts：
 * 调度器经出借池派审 → B 端真实 take_review / submit_verdict → A 入账、调度结清），PM 经正规 `workflow-set --mode manual` 以非 sticky 理由码
 * 把卡留在人工，卡仍停在 review；恢复策略文件写 manualMergeQueue / manualMergeAuto。只合成形状，不读生产钥匙、截图、凭据或真实库。
 */
import { rmSync, writeFileSync } from "node:fs";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { listRequests } from "../src/lib/manual-merge-queue-facts.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { MANUAL_MERGE_AUTO_OP } from "../src/lib/scheduler-manual-merge-ledger.js";
import { ok, PM, pooledManual, type Verdict } from "./scheduler-review-pm-kit.test.js";

export type AutoWorld = Awaited<ReturnType<typeof pooledManual>>;

/** 恢复策略：缺省 manualMergeQueue on、manualMergeAuto on；传 undefined 的键不写（走缺省） */
export function policy(keys: Record<string, string | undefined> = {}) {
  const all = { manualMergeQueue: "on", manualMergeAuto: "on", manualCaseOwnership: "off", ...keys };
  const set = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: set } } }));
}
export const clearPolicy = () => rmSync(RECOVERY_POLICY_PATH, { force: true });

/** PM 经正规 workflow-set 留人工；code 缺省 runtime_unavailable（非 sticky），作者家族缺省 claude（池审查员是 codex） */
export async function manualAs(w: AutoWorld, code = "runtime_unavailable", family = "claude", reason = "执行环境不可用，本机 Codex 接手") {
  const wf = getWorkflow(w.db, "T1")!;
  await ok(w.as(PM, "workflow-set", "T1", "--rev", String(w.f.task().rev), "--workflow-rev", String(wf.rev), "--template", wf.template, "--version", "2",
    "--mode", "manual", "--author-family", family, "--fallback", "只报错不修", "--reason-code", code, "--reason", reason));
}

/** 跨族 pass 的 manual 卡，停在 review，manualMergeQueue / manualMergeAuto 都是 on */
export async function readyWorld(o: { verdict?: Verdict; code?: string; family?: string; keys?: Record<string, string | undefined> } = {}): Promise<AutoWorld> {
  const w = await pooledManual({ manual: false, verdict: o.verdict });
  await manualAs(w, o.code, o.family);
  policy(o.keys);
  return w;
}

export const requests = (w: AutoWorld) => listRequests(w.db, "p", "T1");
export const autoNotes = (w: AutoWorld) => listEvents(w.db, { target: "T1" }).filter((e) => e.data.op === MANUAL_MERGE_AUTO_OP);
export const samples = (w: AutoWorld) => listEvents(w.db, { target: "T1" })
  .filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "manualMergeAuto");

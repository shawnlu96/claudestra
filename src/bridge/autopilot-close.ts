/**
 * Autopilot run 的收尾（调度在 bridge/mission.ts）：等证据到齐 → 归类 → 落盘 lastRun 并排下一次 → 写一行日志。
 * 证据要等：Stop 先发 done，watcher 在那之后才把最后几行 jsonl 读完（撞额度、API 报错常在最后），立刻取证会漏。
 * tests/bridge-mission.test.ts。
 */
import { classifyRun, type RunEvidence } from "../lib/autopilot-run.js";
import { finishRun, type ActiveRun } from "../lib/autopilot-wake.js";
import { appendRunLog, runLogLine } from "../lib/autopilot-log.js";
import { missionOnClaudeCode, updateMissions, type Mission } from "../lib/missions.js";
import { lastEvidenceAt, peekTracked, takeEvidence, takeOrphan } from "./autopilot-evidence.js";
import { quotaWall } from "./quota-wall-wiring.js";

/** done 之后至少等这么久、且最后一条事件之后安静这么久才取证；最多等 EVIDENCE_MAX_MS（watcher 另有 2s 轮询兜底） */
let EVIDENCE = { minMs: 2_000, quietMs: 1_000, maxMs: 10_000 };
/** 单测缩短等待；生产不调 */
export function setEvidenceWaitForTest(w: typeof EVIDENCE): void {
  EVIDENCE = w;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

/** 正在收尾的 run：同一个 run 的第二个 done（打断之后又来 Stop）不重复收 */
const closing = new Set<string>();
/**
 * 收尾时写锁超时：证据留在这里，mission.ts closeAndNext 原样重试，不丢日志、也不让这个 run 被当成没投递放回去重投。
 * 记账元信息一起留：证据取走时记账已经撤了，重试前换了一代就只能靠它给旧一代补那行日志。
 */
const pendingClose = new Map<string, { ev: RunEvidence; meta: { run: ActiveRun; missionId: string } | null }>();
export const pendingCloseOf = (runId: string): RunEvidence | undefined => pendingClose.get(runId)?.ev;

async function settle(agent: string, doneAt: number): Promise<void> {
  const end = doneAt + EVIDENCE.maxMs;
  for (;;) {
    const now = Date.now();
    const quietFor = now - (lastEvidenceAt(agent) ?? 0);
    if (now >= end || (now - doneAt >= EVIDENCE.minMs && quietFor >= EVIDENCE.quietMs)) return;
    await sleep(100);
  }
}

export interface CloseCtx {
  path: string;
  graceMs: number;
  /** 写锁最多等多久；不给 = lib/missions.ts 的默认 */
  lockMs?: number;
}

/**
 * 收一个 run：只认 runId 对得上的那一个（重复 done、旧一代都不收）；mission 已不在进行中就不再排下一次。
 * ev 为空 = 从证据模块取（afterDone 为真时先等证据到齐）；bridge 判的失败 / 证据丢失由调用方传进来。
 * 等证据期间换了一代（stop 后立刻 start）→ 给旧一代补一行日志；写锁超时 → 证据进 pendingClose，返回 null 等下次重试。
 */
export async function closeRun(
  agent: string, runId: string, ctx: CloseCtx, opts: { afterDone?: number; ev?: RunEvidence } = {},
): Promise<Mission | null> {
  if (closing.has(runId)) return null;
  closing.add(runId);
  try {
    if (opts.afterDone !== undefined) await settle(agent, opts.afterDone);
    const pending = pendingClose.get(runId);
    const meta = peekTracked(agent, runId) ?? pending?.meta ?? null;
    const ev = opts.ev ?? pending?.ev ?? takeEvidence(agent, runId);
    // CC 撞墙：下次唤醒按闸的重置时刻排（出闸时 mission.ts 另行放行）。每次尝试都按当下重算：写锁超时重试时闸可能已经开了。
    // 闸在这一轮撞额度之后已经提前开了（用卡 / clear / 探测）：按出闸时刻排，别退回原文的重置时刻白押（T24 adv2 P2-5）
    const wall = missionOnClaudeCode(agent) ? quotaWall() : null;
    const wallUntil = wall?.until();
    const exitAt = wall?.snapshot().wall?.exit?.at;
    if (wallUntil) ev.wallUntil = wallUntil;
    else if (ev.rateLimitText && exitAt !== undefined && exitAt >= (ev.rateLimitAt ?? 0)) ev.wallUntil = exitAt;
    else delete ev.wallUntil;
    const now = Date.now();
    const cls = classifyRun(ev);
    const out = await updateMissions((all) => {
      const cur = all[agent];
      if (!cur || cur.run?.runId !== runId) return null;
      const run: ActiveRun = cur.run;
      // 只有已经递出去的 run 才会走到这里；「已投递」没来得及落盘（写锁超时）时计数在这里补上
      if (!run.deliveredAt) Object.assign(cur, { nudges: cur.nudges + 1, lastNudgeAt: run.claimedAt });
      const f = finishRun(cur, runId, cls.outcome, ev, now, ctx.graceMs)!;
      if (cur.status !== "active") delete cur.wake;
      if (f.next.hold && cur.status === "active") cur.resumeAt = iso(f.nextAt); // 网页「等到 …」
      else delete cur.resumeAt;
      return { m: { ...cur }, run, f };
    }, ctx.path, ctx.lockMs).catch((e) => {
      pendingClose.set(runId, { ev, meta });
      console.error(`⏱ Autopilot ${agent}: run ${runId} 收尾写入失败，下次到点重试:`, (e as Error).message);
      return undefined;
    });
    if (out === undefined) return null;
    pendingClose.delete(runId);
    if (!out) {
      if (meta) logLine(agent, meta, ev, "（mission 已停止或换了一代）");
      return null;
    }
    const active = out.m.status === "active";
    // 先落盘再追加日志：写锁超时重试时不会重复记一行。两次写之间有几毫秒，读的一方要等日志本身（tests/bridge-mission.test.ts）
    appendRunLog(runLogLine({
      missionId: out.m.id ?? "unknown", agent, run: out.run, outcome: cls.outcome, reason: cls.reason, evidence: ev, now,
      ...(active ? { next: { at: out.f.nextAt, why: out.f.next.why } } : {}),
    }));
    console.log(`⏱ Autopilot ${agent}: run ${runId} → ${cls.outcome}（${cls.reason}）${active ? `，下次 ${out.f.next.why}` : ""}`);
    return out.m;
  } finally {
    closing.delete(runId);
  }
}

/**
 * 本进程还在给旧 run 记账，但 missions.json 里已经换了一代（stop 后立刻 start）或整条删了：给旧一代补一行日志，不排下一次。
 * 新一代领 run 之前、以及回合结束时都查一次，免得旧 run 的记账被新 run 覆盖、悄悄丢掉。
 */
export function logOrphanRun(agent: string, currentRunId: string | undefined): void {
  const o = takeOrphan(agent, currentRunId);
  if (o) logLine(agent, o, o.ev, "（mission 已停止或换了一代）");
}

function logLine(agent: string, o: { run: ActiveRun; missionId: string }, ev: RunEvidence, note: string): void {
  const cls = classifyRun(ev);
  appendRunLog(runLogLine({ missionId: o.missionId, agent, run: o.run, outcome: cls.outcome, reason: `${cls.reason}${note}`, evidence: ev, now: Date.now() }));
  console.log(`⏱ Autopilot ${agent}: 旧一代的 run ${o.run.runId} 补记 ${cls.outcome}`);
}

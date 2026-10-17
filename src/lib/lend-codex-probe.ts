/**
 * Codex 额度暂停期间的定时探测（CODEXPROBE1）：Codex 读数只来自本机最近一次 rollout 的 rate_limits，暂停期间不跑 Codex 就没有新读数，
 * 额度被提前重置时 refreshPause 看不到，只能等原截止（周额度可能好几天）。所以暂停中、离截止还有 ≥ PROBE_EVERY_MS 时，每 PROBE_EVERY_MS
 * 跑一次最小的 Codex 调用（只读沙箱、空临时目录、固定短提示、不加载全局 MCP），只为让它写出一条新 rollout；解除照旧由下一轮 refreshPause 判。
 * - 后台跑、不等：journal 在 lendTick 返回后就关，所以这里只在同步段写 meta（本次探测时刻），完成后只读额度、打日志，不碰 db。
 * - 同一进程同一时刻最多一个；探测撞额度 / 超时 / 失败 / 没写出新读数都按「未知」，不改暂停，下一个间隔再试。
 * - 失败的探测也可能先写出读数（先收到 rate_limits 再出错 / 超时）：probeDistrust 给 refreshPause 一个截至时刻，
 *   在它之前的读数不拿来解除暂停（跑着的、失败的、结果丢了的探测都截到当轮），只认成功探测或之后的读数。
 * - 恢复键 codexPauseProbe（缺省 on）：off 与改前一致；observe 只记「本会探测」。生产调用在 lend-codex-probe-run.ts（调度器不可达）。
 * tests/lend-codex-probe.test.ts。
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { getMeta, setMeta } from "./lend-journal.js";
import { PROJECTS_PATH, resolveProjectForRealDir, type ProjectDef } from "./projects.js";
import { recoveryPolicy, RECOVERY_POLICY_PATH, type ObservedAction, type RecoveryKey, type RecoveryMode } from "./recovery-policy.js";
import { REPO_ROOT } from "./repo-root.js";

const CODEX_PROBE_KEY: RecoveryKey = "codexPauseProbe";
export const PROBE_EVERY_MS = 30 * 60_000;
const PROBE_KEY = "probe:codex";

type ProbeOutcome = "not_full" | "full" | "unknown";
const LABEL: Record<ProbeOutcome, string> = { not_full: "不满（下一轮解除暂停）", full: "仍满（暂停保持）", unknown: "未知（暂停不变）" };

/** 读数只要 refreshPause 用得上的几样（同 lend-health QuotaView，不反向 import 免成环） */
interface Reading { observedAt: number | null; full: boolean | null }
export interface CodexPauseProbe {
  /** 档位与本机仓库所属项目（observe 样本记在它名下；解析不出 = null） */
  mode: () => { mode: RecoveryMode; project: string | null };
  /** 跑一次最小 Codex 调用；ok=false（含超时、撞额度）按未知 */
  call: () => Promise<{ ok: boolean; message: string }>;
  /** observe 档的样本口（生产写 ledger recordObserved）；不给只打日志 */
  observe?: (a: ObservedAction) => void;
}

interface Pause { at: number; until: number }
/** settled：这次探测的结果已记进 distrustThrough（或确认可信）；distrustThrough：本次暂停里不拿来解除的读数截至时刻 */
interface Last { pauseAt: number; at: number; settled?: boolean; distrustThrough?: number }

let inflight: Promise<void> | null = null;
/** 跑完的探测（按 pauseAt + at 认是哪次）：trusted = 调用成功，它写的读数可用 */
let finished: { pauseAt: number; at: number; trusted: boolean } | null = null;
/** 测试等后台探测跑完；没有在跑的 = null */
export const pendingCodexProbe = (): Promise<void> | null => inflight;

function read<T>(db: Database, key: string): T | null {
  try { return JSON.parse(getMeta(db, key) || "null") as T | null; } catch { return null; /* 坏值按没有：最坏提前一个间隔多探一次 */ }
}

/** 本次暂停的上次探测时刻；换了一次暂停就从暂停开始算，所以第一次探测在暂停后第 PROBE_EVERY_MS */
function lastProbeAt(db: Database, p: Pause): number {
  const last = read<Last>(db, PROBE_KEY);
  return last && last.pauseAt === p.at ? last.at : p.at;
}

/**
 * refreshQuotaPause 收尾时调（暂停状态已按本轮读数更新过）：该探就起后台探测，不等它。
 * 返回本轮做了什么，测试用；off / 不该探 = "skip"。
 */
export function maybeProbeCodex(db: Database, pause: Pause | null, probe: CodexPauseProbe, quota: () => Promise<Reading | null>,
  now: number, log: (m: string) => void): "skip" | "observe" | "started" {
  if (!pause || now >= pause.until || pause.until - now < PROBE_EVERY_MS) return "skip";
  if (inflight || now - lastProbeAt(db, pause) < PROBE_EVERY_MS) return "skip";
  const { mode, project } = probe.mode();
  if (mode === "off") return "skip";
  const prev = read<Last>(db, PROBE_KEY);
  const keep = prev && prev.pauseAt === pause.at && prev.distrustThrough !== undefined ? { distrustThrough: prev.distrustThrough } : {};
  setMeta(db, PROBE_KEY, JSON.stringify({ pauseAt: pause.at, at: now, settled: mode === "observe", ...keep } satisfies Last));
  const next = new Date(now + PROBE_EVERY_MS).toISOString();
  if (mode === "observe") {
    log(`Codex 额度暂停中：本会探测一次额度（${CODEX_PROBE_KEY} observe，没跑），下次 ${next}`);
    if (project && probe.observe) {
      try {
        probe.observe({ project, mechanism: CODEX_PROBE_KEY, target: "codex", actionKey: `probe:${pause.at}:${now}`,
          action: `跑一次最小 Codex 调用刷新额度读数（暂停截止 ${new Date(pause.until).toISOString()}）` });
      } catch (e) { log(`${CODEX_PROBE_KEY} 观察样本没记上：${String(e)}`); }
    }
    return "observe";
  }
  finished = null;
  inflight = probeOnce(probe, quota, now).then((r) => {
    finished = { pauseAt: pause.at, at: now, trusted: r.called };
    log(`Codex 额度暂停中探测一次：${LABEL[r.outcome]}${r.why ? `，${r.why}` : ""}；下次 ${next}`);
  }).finally(() => { inflight = null; });
  return "started";
}

/**
 * refreshPause 之前调：本次暂停里不能拿来解除暂停的读数截至时刻（observedAt ≤ 它的不算），没有 = null。
 * 探测还在跑：截到 now（它可能已写出半截读数）；跑完失败或结果没了（进程重启）：截到这一轮的 now，记进 meta；成功：不加截。
 */
export function probeDistrust(db: Database, pause: Pause | null, now: number): number | null {
  const last = pause ? read<Last>(db, PROBE_KEY) : null;
  if (!pause || !last || last.pauseAt !== pause.at) return null;
  const prev = last.distrustThrough ?? null;
  if (last.settled) return prev;
  if (inflight) return Math.max(prev ?? now, now);
  const f = finished && finished.pauseAt === last.pauseAt && finished.at === last.at ? finished : null;
  finished = null;
  const through = f?.trusted ? prev : Math.max(prev ?? 0, now); // 暂停中只有探测跑 Codex：到这一轮为止的读数都出自这次失败的探测
  setMeta(db, PROBE_KEY, JSON.stringify({ ...last, settled: true, ...(through === null ? {} : { distrustThrough: through }) } satisfies Last));
  return through;
}

/** called：调用本身成功（它写出的读数可信）；失败 / 超时 / 抛错 = false，期间写出的读数不拿来解除 */
async function probeOnce(probe: CodexPauseProbe, quota: () => Promise<Reading | null>, startedAt: number): Promise<{ outcome: ProbeOutcome; called: boolean; why?: string }> {
  const r = await probe.call().catch((e) => ({ ok: false, message: String(e) }));
  if (!r.ok) return { outcome: "unknown", called: false, why: `调用没成：${r.message.slice(0, 200)}` };
  const q = await quota().catch(() => null); // 读不到 = 未知，下一轮 refreshPause 自己会再读
  if (!q || q.observedAt === null || q.observedAt < startedAt) return { outcome: "unknown", called: true, why: "没读到这次探测后的新读数" };
  return { outcome: q.full === false ? "not_full" : q.full === true ? "full" : "unknown", called: true };
}

/**
 * 档位：本机 claudestra 仓库所属项目按统一恢复策略取（recoveryPolicy：keys.codexPauseProbe → 项目 mode → 缺省 on；文件坏 = off）。
 * 项目解析不出 = 缺省 on（探测只读、只花一次极短调用，保守 off 就回到额度提前重置也看不见的老问题）。
 */
export function codexProbeMode(o: { policyPath?: string; projectsPath?: string; repoRoot?: string } = {}): { mode: RecoveryMode; project: string | null } {
  let project: string | null = null;
  try {
    const projects = (JSON.parse(readFileSync(o.projectsPath ?? PROJECTS_PATH, "utf8")) as { projects?: ProjectDef[] }).projects;
    project = Array.isArray(projects) ? resolveProjectForRealDir(projects, o.repoRoot ?? REPO_ROOT)?.id ?? null : null;
  } catch { /* 项目表读不了：同解析不出 */ }
  return { mode: project ? recoveryPolicy(project, CODEX_PROBE_KEY, o.policyPath ?? RECOVERY_POLICY_PATH).mode : "on", project };
}

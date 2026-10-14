/**
 * GET /api/v1/team/roster?project=<id>（team-roster-ROSTER1）：读 scheduler.json、台账、peers.json、在线探测、借入视图与本机额度，
 * 交给 lib/team-roster.ts 拼名册。门在 team.ts（canReadLedger + 只许 GET），这里不另开。
 * 台账打不开 → 503；单个 peer 的在线 / 额度读不到只是那一格 null，整包照回；每处 catch 都留一句日志。tests/team-roster-route.test.ts。
 */
import type { Database } from "bun:sqlite";
import { instanceIdSync } from "../../lib/instance-id.js";
import { readPeers, type HttpPeer } from "../../lib/peers.js";
import type { PeerPresence } from "../../lib/peer-presence.js";
import { peerQuota, readWeekQuota, type QuotaReport } from "../../lib/quota-week.js";
import type { AgentLimits } from "../../lib/scheduler-agent-pool-config.js";
import { quotaPoolTotals } from "../../lib/scheduler-agent-pool-quota.js";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH } from "../../lib/scheduler-config.js";
import { teamRoster, type PeerPresenceFacts } from "../../lib/team-roster.js";
import { apiJson } from "../api-respond.js";
import { ledgerDb } from "../ledger-feed.js";
import { peerPresence } from "../peer-presence.js";
import { borrowPeerViews } from "./lend-peers-view.js";
import { ledgerProjectExists } from "./ledger.js";

export interface TeamRosterDeps {
  projectExists(project: string): Promise<boolean>;
  db(): Database | null;
  /** scheduler.json 里本项目的 agents 池；没有池 = null，读不了就抛 */
  agents(project: string): AgentLimits | null;
  poolTotals(db: Database, project: string, totals: AgentLimits, now: number): AgentLimits;
  /** 有效借入条目里含本项目的 peer 名 */
  borrowPeers(project: string, now: number): Promise<string[]>;
  peers(): Promise<HttpPeer[]>;
  presence(name: string, peer?: HttpPeer): PeerPresence;
  localQuota(now: number): Promise<QuotaReport>;
  peerQuota(peer: string, now: number): QuotaReport | null;
  instanceId(): string;
  now(): number;
}

const DEFAULT_DEPS: TeamRosterDeps = {
  projectExists: ledgerProjectExists,
  db: () => ledgerDb(),
  agents: (project) => readSchedulerConfig(SCHEDULER_CONFIG_PATH).projects[project]?.agents ?? null,
  poolTotals: quotaPoolTotals,
  borrowPeers: async (project, now) => (await borrowPeerViews(now)).peers.filter((p) => p.projects.includes(project)).map((p) => p.peer),
  peers: async () => (await readPeers()).httpPeers ?? [],
  presence: peerPresence,
  localQuota: readWeekQuota,
  peerQuota,
  instanceId: instanceIdSync,
  now: () => Date.now(),
};
let deps: TeamRosterDeps = DEFAULT_DEPS;

/** 单测：换掉全部读口；不传 = 还原 */
export function setTeamRosterDepsForTest(over?: Partial<TeamRosterDeps>): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

/** 读失败只让这一格变 null，原因进日志 */
function soft<T>(what: string, read: () => T): T | null {
  try { return read(); }
  catch (e) {
    console.warn(`[team-roster] ${what} 读不了，按未知给：${(e as Error).message}`);
    return null;
  }
}

async function softAsync<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try { return await read(); }
  catch (e) {
    console.warn(`[team-roster] ${what} 读不了，按未知给：${(e as Error).message}`);
    return null;
  }
}

const isoMs = (iso: string | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

export async function teamRosterApi(req: Request): Promise<Response> {
  const project = new URL(req.url).searchParams.get("project");
  if (!project) return apiJson(400, { error: "project required" });
  if (!(await deps.projectExists(project))) return apiJson(404, { error: "project not found" });
  let db: Database | null;
  try { db = deps.db(); }
  catch (e) {
    console.warn("[team-roster] ledger unavailable:", e);
    return apiJson(503, { error: "ledger unavailable" });
  }
  if (!db) return apiJson(503, { error: "ledger unavailable" });
  const now = deps.now();
  const [borrow, httpPeers, localQuota] = await Promise.all([
    softAsync("借入视图", () => deps.borrowPeers(project, now)), softAsync("peers.json", deps.peers),
    softAsync("本机额度", () => deps.localQuota(now))]);
  const byName = new Map((httpPeers ?? []).map((p) => [p.name, p]));
  const agents = soft("scheduler.json", () => deps.agents(project));
  const self = soft("本机实例 id", deps.instanceId) || null;
  try {
    return apiJson(200, teamRoster({
      db, project, now, selfInstanceId: self, agents, localQuota,
      poolTotals: (totals) => soft("额度调整", () => deps.poolTotals(db, project, totals, now)),
      borrowPeers: borrow ?? [],
      peerInstanceId: (peer) => byName.get(peer)?.instanceId ?? null,
      peerPresence: (peer): PeerPresenceFacts | null => {
        const p = soft(`${peer} 在线状态`, () => deps.presence(peer, byName.get(peer)));
        return p ? { online: p.online, checkedAt: isoMs(p.checkedAt), latencyMs: p.latencyMs ?? null } : null;
      },
      peerQuota: (peer) => soft(`${peer} 额度`, () => deps.peerQuota(peer, now)),
    }));
  } catch (e) {
    console.warn("[team-roster] ledger unavailable:", e);
    return apiJson(503, { error: "ledger unavailable" });
  }
}

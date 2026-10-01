/**
 * 判死、判卡住都要两次观察（i28-S1，规则沿用出借 worker 的 R5a，lib/lend-health.ts noteLiveness）：一次否定只记下，隔 ≥ MISS_GAP_MS 的
 * 下一轮、同一身份（agent / session / 在途的那件活）仍否定才算数；running / unknown、身份变了、卡住的证据变了（中间又来过 update）都清零。
 * 一次读失败曾让正在干活的 worker 被判死杀掉（ledger/reviews/i28-R5a-rootcause.md），所以单次否定绝不处置。
 * 记录只在调度服务内存里：服务重启后从第一次重新数，最坏晚一轮处置，不会误判。tests/agent-supervisor-judge.test.ts。
 */
import { MISS_GAP_MS } from "./lend-health.js";
import type { WorkerLiveness } from "./worker-liveness.js";

export type Down = "no_window" | "no_host" | "stuck";

export interface Identity {
  agent: string;
  sessionId: string;
  workKey: string;
}

/** 这一轮看到的：liveness 是四态；stuckSince = 回合在跑、最近一次 update 的时刻（够久没动静才给，否则 null） */
export interface Look {
  liveness: WorkerLiveness;
  stuckSince: number | null;
}

interface Miss extends Identity {
  at: number;
  kind: Down;
  /** 卡住时的最近 update 时刻：第二次看到的必须还是它 */
  evidence: number | null;
}

const same = (a: Identity, b: Identity): boolean => a.agent === b.agent && a.sessionId === b.sessionId && a.workKey === b.workKey;

/** 这一轮的否定种类：窗口 / 宿主没了优先；活着且回合够久没动静 = 卡住；读不到 = 不知道（不算否定） */
function downOf(look: Look): { kind: Down; evidence: number | null } | null {
  if (look.liveness === "no_window" || look.liveness === "no_host") return { kind: look.liveness, evidence: null };
  if (look.liveness === "running" && look.stuckSince !== null) return { kind: "stuck", evidence: look.stuckSince };
  return null;
}

export class TwoStrikes {
  private readonly misses = new Map<string, Miss>();

  constructor(private readonly log: (m: string) => void = () => {}) {}

  /** 记一次观察；返回确认的否定（同一身份、同一种类、同一证据连续第二次），否则 null。确认后清零，下次从头数 */
  note(id: Identity, look: Look, now: number): Down | null {
    const down = downOf(look);
    const prev = this.misses.get(id.agent);
    if (!down) {
      if (prev) this.misses.delete(id.agent), this.log(`${id.agent} 恢复（${look.liveness}），清掉上次的否定`);
      return null;
    }
    const match = prev && same(prev, id) && prev.kind === down.kind && prev.evidence === down.evidence ? prev : null;
    if (!match) {
      this.misses.set(id.agent, { ...id, at: now, kind: down.kind, evidence: down.evidence });
      this.log(`${id.agent} 否定 1/2：${down.kind}，下一轮再看（session ${id.sessionId}，${id.workKey}）`);
      return null;
    }
    if (now - match.at < MISS_GAP_MS) return null; // 同一轮连着看两次不算两次
    this.misses.delete(id.agent);
    this.log(`${id.agent} 否定 2/2：${down.kind}，确认（session ${id.sessionId}，${id.workKey}）`);
    return down.kind;
  }

  /** 不再监护（活交了、换了会话、开关关了）：丢掉它的记录 */
  forget(agent: string): void {
    this.misses.delete(agent);
  }

  /** 这一轮不在监护名单里的都丢掉，免得很久以后同名同会话再出现时拿旧的否定凑成第二次 */
  keepOnly(agents: ReadonlySet<string>): void {
    for (const a of [...this.misses.keys()]) if (!agents.has(a)) this.misses.delete(a);
  }
}

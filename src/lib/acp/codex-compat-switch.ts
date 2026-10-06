/**
 * Codex 适配器的选择开关：上游 codex-acp（upstream）还是仓库里的自研适配器（self）。
 * - 存在 <STATE_DIR>/codex-adapter.json：{ default, agents: { <agent>: upstream|self } }；全局一处，单个 agent 覆盖。
 *   没有文件 = 全体 upstream；文件坏了读者按 upstream（只报一次），写者拒写（state-file.ts），不会把坏文件覆盖成「全体上游」以外的东西。
 * - 只有 manager `codex-adapter` 命令写它（manager/acp-adapter.ts）；生效靠重启：宿主只在启动时读一次（acp-host.ts）。
 * - CLAUDESTRA_ACP_AGENT 手工覆盖仍最优先、沙箱永远是 stub、出借 worker 永远上游（adapter-proc.ts acpAgentCommand）。
 * tests/codex-adapter-switch.test.ts。
 */
import { acquireLock } from "../file-lock.js";
import { statePath } from "../paths.js";
import { readJsonStateSync, reportCorrupt, StateCorruptError, writeJsonAtomicSync } from "../state-file.js";

export type CodexAdapterId = "upstream" | "self";
export interface AdapterChoice {
  default: CodexAdapterId;
  agents: Record<string, CodexAdapterId>;
}

export const ADAPTER_IDS: readonly CodexAdapterId[] = ["upstream", "self"];
const isId = (v: unknown): v is CodexAdapterId => v === "upstream" || v === "self";
export const choiceFile = () => statePath("codex-adapter.json");
const EMPTY: AdapterChoice = { default: "upstream", agents: {} };

function valid(d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  const o = d as { default?: unknown; agents?: unknown };
  if (o.default !== undefined && !isId(o.default)) return false;
  if (o.agents === undefined) return true;
  return !!o.agents && typeof o.agents === "object" && !Array.isArray(o.agents) && Object.values(o.agents).every(isId);
}

const normalize = (d: { default?: CodexAdapterId; agents?: Record<string, CodexAdapterId> }): AdapterChoice => ({ default: d.default ?? "upstream", agents: { ...d.agents } });

/** 读者：坏文件按全体上游（上游是一直在用的那个，回到它最安全），报一次 */
export function readAdapterChoice(file = choiceFile()): AdapterChoice {
  const r = readJsonStateSync(file, valid);
  if (r.status === "ok") return normalize(r.data as AdapterChoice);
  if (r.status === "corrupt") reportCorrupt(file, r.error, "codex-adapter");
  return EMPTY;
}

/** registry 里的名字有带 agent- 前缀和不带两种：覆盖按两种都认，带前缀的优先 */
const keysOf = (agent: string) => [`agent-${agent.replace(/^agent-/, "")}`, agent.replace(/^agent-/, "")];

export function adapterFor(choice: AdapterChoice, agent?: string): CodexAdapterId {
  if (agent) for (const k of keysOf(agent)) if (choice.agents[k]) return choice.agents[k]!;
  return choice.default;
}

/** 写者：锁住改一处，坏文件拒写（抛 StateCorruptError）。change 返回新值，不改入参 */
export async function updateAdapterChoice(change: (c: AdapterChoice) => AdapterChoice, file = choiceFile()): Promise<AdapterChoice> {
  const lock = await acquireLock(`${file}.lock`);
  if (!lock) throw new Error(`拿不到 ${file} 的写锁（20s），别的进程在改；稍后重试`);
  try {
    const r = readJsonStateSync(file, valid);
    if (r.status === "corrupt") throw new StateCorruptError(file, r.error);
    const next = change(r.status === "ok" ? normalize(r.data as AdapterChoice) : EMPTY);
    writeJsonAtomicSync(file, next);
    return next;
  } finally {
    lock.release();
  }
}

/** 覆盖改成 to；to 为 null = 删掉覆盖（跟随全局）。两种拼写的旧键都清掉，只留带前缀的那个 */
export function withAgent(c: AdapterChoice, agent: string, to: CodexAdapterId | null): AdapterChoice {
  const agents = Object.fromEntries(Object.entries(c.agents).filter(([k]) => !keysOf(agent).includes(k)));
  return { ...c, agents: to ? { ...agents, [keysOf(agent)[0]!]: to } : agents };
}

/** 一条命令切回：全局 upstream、清掉所有覆盖 */
export const ROLLBACK: AdapterChoice = EMPTY;

/**
 * 宿主里的「当前用哪个适配器」：起自研失败（接不上线程）时换成上游再起，只换一次、不换回。
 * 自研是没验证够的那一边，起不来就回到一直在用的上游；auth（没登录）两边一样起不来，不换。
 */
export class AdapterPick {
  private fellBack = false;
  constructor(
    public adapter: CodexAdapterId,
    public cmd: string[],
    private readonly upstream: string[] | null,
    private readonly log: (m: string) => void,
  ) {}

  /** 自研用不了（协议判不过 / 接不上线程）：能换就换并返回新命令（宿主据此清掉「不再重起」、按新命令重起），否则 null */
  fallback(why: string, kind?: string): string[] | null {
    if (this.adapter !== "self" || this.fellBack || kind === "auth") return null;
    if (!this.upstream) {
      this.log(`⚠️ 自研 Codex 适配器用不了（${why}），也没装上游 codex-acp 可退：照旧用自研（manager acp-install 装上就能退）`);
      return null;
    }
    this.fellBack = true;
    this.adapter = "upstream";
    this.cmd = this.upstream;
    this.log(`⚠️ 自研 Codex 适配器用不了（${why}），本宿主改用上游 codex-acp；选择开关没动，下次重启还会先试自研（manager codex-adapter 改开关）`);
    return this.cmd;
  }
}

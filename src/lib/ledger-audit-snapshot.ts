/**
 * 台账巡检的取数（规则在 ledger-audit.ts）：全部从文件和 tmux 取，不读 bridge 内存——CLI 手动跑和 bridge 定时跑结果一样，
 * bridge 重启（事件态、bg-activity 清空）也不影响。每个来源单独兜错：取不到的记 null，依赖它的规则这一轮不跑。
 * 来源：台账库、registry、tmux 窗口与画面、会话文件写入时间、PM 名单里各人的 subagents、押后队列文件、docsDir 旁的 ledger.json。
 */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditAgent, AuditHeld, AuditInboxEntry, AuditSnapshot, MainTurn } from "./ledger-audit.js";
import { getMeta, listEvents, listTasks } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { subagentsDir } from "./jsonl-cost.js";
import { HELD_MESSAGES_PATH } from "./paths.js";
import { readRegistryAgents, type RegistryAgent } from "./registry.js";
import { sessionFileMtime } from "./session-source.js";
import { readJsonStateSync } from "./state-file.js";
import { EMPTY_PROGRESS, nextProgress, readSubagentMeta, subagentEndStatus } from "./subagent-progress.js";
import { listWindows, tmuxRawStrict, windowTarget } from "./tmux-helper.js";
import { turnState } from "./turn-state.js";

/** 调度助理派审查员的 description 约定（ledger/docs/07c-dispatch.md）：`Review <T> r<N>` / `Adversarial review <T> r<N>` */
const REVIEWER_RE = /^(?:adversarial\s+)?review\s+(\S+)\s+r(\d+)\b/i;
/** 与 bg-activity-watcher 的 SUBAGENT_SILENT_LIMIT_MS 同口径：30 分钟一行不写的 subagent 当已结束 */
const SUBAGENT_SILENT_MS = 30 * 60_000;

export interface SnapshotSources {
  registry(): Promise<RegistryAgent[]>;
  /** master 会话里的窗口名；tmux 出错 = null */
  windows(): Promise<string[] | null>;
  turn(agent: RegistryAgent): Promise<MainTurn>;
  lastWrite(agent: RegistryAgent): Promise<number | null>;
  reviewers(agent: RegistryAgent, now: number): { taskId: string; round: number | null }[];
  heldPath: string;
}

/** 某个 PM 的 subagents 里还在跑的审查员 */
export function runningReviewers(agent: RegistryAgent, now: number): { taskId: string; round: number | null }[] {
  if (!agent.cwd || !agent.sessionId) return [];
  const dir = subagentsDir(agent.cwd, agent.sessionId);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return []; // 还没派过 subagent（目录不存在）：没有审查员在跑
  }
  const out: { taskId: string; round: number | null }[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const meta = readSubagentMeta(path);
    const m = meta.description?.match(REVIEWER_RE);
    if (!m) continue;
    let mtime: number;
    let text: string;
    try {
      mtime = statSync(path).mtimeMs;
      if (now - mtime > SUBAGENT_SILENT_MS) continue;
      text = readFileSync(path, "utf-8");
    } catch {
      continue; // 刚被清理 / 读到一半被挪走：当它不在跑，最坏多报一条「没有审查员」
    }
    let p = EMPTY_PROGRESS;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        p = nextProgress(p, JSON.parse(line));
      } catch {
        // 末行写到一半：跳过这一行，按已读到的判
      }
    }
    if (subagentEndStatus(p, meta, now - mtime, SUBAGENT_SILENT_MS) === null) out.push({ taskId: m[1], round: Number(m[2]) });
  }
  return out;
}

const realSources: SnapshotSources = {
  registry: () => readRegistryAgents(),
  windows: async () => {
    const w = await listWindows();
    return w.length ? w : null; // 生产的 master 会话至少有窗口 0：一个都没有 = tmux 没列出来
  },
  turn: async (a) => {
    let pane: string | null;
    try {
      pane = await tmuxRawStrict(["capture-pane", "-t", windowTarget(a.name), "-p"]);
    } catch {
      pane = null; // 抓屏失败 = 画面未知，turnState 报 unknown
    }
    return turnState({ pane, runtime: a.runtime }).main;
  },
  lastWrite: (a) => (a.cwd && a.sessionId ? sessionFileMtime(a.cwd, a.sessionId, a.runtime) : Promise.resolve(null)),
  reviewers: runningReviewers,
  heldPath: HELD_MESSAGES_PATH,
};

type HeldRaw = { env?: { from?: Record<string, unknown>; meta?: { messageId?: string } }; heldAt?: number; lease?: { at?: number } };

function senderOf(from: Record<string, unknown> | undefined): string | null {
  const kind = from?.kind;
  if (kind === "bridge" || !kind) return null; // 巡检自己的通知也押在这里，不算「PM 漏了消息」
  const name = from?.agentName ?? from?.username ?? from?.name;
  return typeof name === "string" && name ? name : String(kind);
}

/** 取不到时 value = null，reason 写进 CLI 输出的 skipped */
type Got<T> = { value: T | null; reason?: string };

function readHeld(path: string, byChannel: ReadonlyMap<string, string>): Got<AuditHeld[]> {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return { value: [] };
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return { value: null, reason: `押后队列文件读不了：${path}` };
  const out: AuditHeld[] = [];
  for (const [ch, q] of Object.entries(r.data as Record<string, unknown>)) {
    const to = byChannel.get(ch);
    if (!to || !Array.isArray(q)) continue;
    for (const i of q as HeldRaw[]) {
      const from = senderOf(i?.env?.from);
      if (!from || typeof i.heldAt !== "number") continue;
      out.push({ to, from, messageId: i.env?.meta?.messageId ?? String(i.heldAt), heldAt: i.heldAt, leaseAt: typeof i.lease?.at === "number" ? i.lease.at : null });
    }
  }
  return { value: out };
}

/** ownerInbox 在 docsDir 上一级的 ledger.json（PM 手写的老台账）：没有 docsDir / 没有这个文件 / 坏了都不跑，写明原因 */
function readOwnerInbox(docsDir: string | null): Got<AuditInboxEntry[]> {
  if (!docsDir) return { value: null, reason: "项目没有 meta.docsDir，找不到 ownerInbox" };
  const file = join(dirname(docsDir), "ledger.json");
  const r = readJsonStateSync(file);
  if (r.status === "missing") return { value: null, reason: `${file} 不存在` };
  if (r.status !== "ok") return { value: null, reason: `${file} 读不了` };
  const list = (r.data as { ownerInbox?: unknown } | null)?.ownerInbox;
  if (!Array.isArray(list)) return { value: null, reason: `${file} 里没有 ownerInbox` };
  return { value: list.map((m: Record<string, unknown>) => {
    const ts = typeof m.ts === "string" ? Date.parse(m.ts) : Number.NaN;
    return { ts: Number.isFinite(ts) ? ts : null, text: String(m.text ?? ""), status: String(m.status ?? ""), to: String(m.to ?? "") };
  }) };
}

/** 有 PM 名单的项目（没有名单的项目没人收推送，也就不巡检） */
export function auditedProjects(db: Database): string[] {
  const rows = db.query("SELECT DISTINCT project FROM meta WHERE key = 'pms' ORDER BY project").all() as { project: string }[];
  return rows.map((r) => r.project).filter((p) => getMeta(db, p).pms.length > 0);
}

async function readAgents(src: SnapshotSources, want: ReadonlySet<string>): Promise<{ list: RegistryAgent[]; agents: AuditAgent[] } | string> {
  let list: RegistryAgent[];
  try {
    list = await src.registry();
  } catch (e) {
    return `registry 读不了：${(e as Error).message}`; // 依赖它的规则这一轮不跑，原因进 skipped
  }
  const windows = await src.windows().catch(() => null); // tmux 出错：windowAlive 全为 null，只有回收规则不跑
  const agents = await Promise.all(list.map(async (a): Promise<AuditAgent> => ({
    name: a.name,
    projectId: a.projectId,
    windowAlive: windows ? windows.includes(a.name) : null,
    turn: want.has(a.name) ? await src.turn(a) : "unknown",
    lastWriteAt: want.has(a.name) ? await src.lastWrite(a) : null,
  })));
  return { list, agents };
}

export async function collectAuditSnapshots(db: Database, projects: readonly string[], now: number, src: SnapshotSources = realSources): Promise<AuditSnapshot[]> {
  const perProject = projects.map((project) => {
    const byTarget = new Map<string, LedgerEvent[]>();
    for (const e of listEvents(db, { project })) byTarget.set(e.target, [...(byTarget.get(e.target) ?? []), e]);
    const tasks = listTasks(db, project).map((task) => ({ task, events: byTarget.get(task.id) ?? [] }));
    return { project, meta: getMeta(db, project), tasks };
  });
  // 只给用得上的人抓屏 / 看会话文件：build / fix 的执行者（空闲规则）和各项目 PM 名单（押后规则）
  const want = new Set<string>();
  for (const p of perProject) {
    p.meta.pms.forEach((x) => want.add(x));
    for (const { task } of p.tasks) if (task.agent && (task.stage === "build" || task.stage === "fix")) want.add(task.agent);
  }
  const got = await readAgents(src, want);
  const reg = typeof got === "string" ? null : got;
  const byChannel = new Map((reg?.list ?? []).filter((a) => a.channelId).map((a) => [a.channelId as string, a.name]));
  const held: Got<AuditHeld[]> = reg ? readHeld(src.heldPath, byChannel) : { value: null };
  return perProject.map(({ project, meta, tasks }) => {
    const pmAgents = (reg?.list ?? []).filter((a) => meta.pms.includes(a.name));
    const inbox = readOwnerInbox(meta.docsDir);
    const unavailable: AuditSnapshot["unavailable"] = {
      ...(typeof got === "string" ? { agents: got } : {}),
      ...(reg?.agents.some((a) => a.windowAlive === null) ? { windows: "tmux 没列出窗口" } : {}),
      ...(held.reason ? { held: held.reason } : {}),
      ...(inbox.reason ? { ownerInbox: inbox.reason } : {}),
    };
    return {
      project,
      pms: meta.pms,
      tasks,
      agents: reg?.agents ?? null,
      reviewers: reg ? pmAgents.flatMap((a) => src.reviewers(a, now)) : null,
      held: held.value,
      ownerInbox: inbox.value,
      unavailable,
    };
  });
}

/**
 * PM 摘要的落盘状态（agents-PMDIG1）：statePath("pm-digest.json") 存摘要队列与最近 24 小时的归类记录，只有 bridge 写；
 * statePath("pm-digest-mode.json") 存各项目开关（缺省 observe），只有 manager 的 `ledger pm-digest-mode` 写。重启读回队列照常送出。
 */
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt, StateCorruptError, writeJsonAtomicSync, type StateRead } from "./state-file.js";
import type { DigestEntry, DigestKind, DigestMode } from "./pm-digest.js";

/** 归类记录只留这么久（只读统计看最近 24 小时） */
export const PM_DIGEST_LOG_MS = 24 * 3600_000;

export interface DigestRecord {
  at: number;
  project: string;
  send: "now" | "digest";
  reason: string;
  source: string;
  kind?: DigestKind;
  /** 记录时的开关：observe 下 digest = 本来会合并 */
  mode: DigestMode;
}
interface DigestState { queue: DigestEntry[]; log: DigestRecord[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validState = (v: unknown): boolean => isObj(v) && Array.isArray(v.queue) && Array.isArray(v.log);
const validModes = (v: unknown): boolean => isObj(v) && (v.projects === undefined || isObj(v.projects));

/** 写者读：损坏（含结构不对）就拒写，不把「空 + 这次改动」覆盖回去（lib/state-file.ts 的约定） */
function forWrite(path: string, r: StateRead): unknown {
  if (r.status === "corrupt") throw new StateCorruptError(path, r.error);
  return r.status === "ok" ? r.data : undefined;
}

export class PmDigestStore {
  constructor(readonly path = statePath("pm-digest.json"), readonly modePath = statePath("pm-digest-mode.json")) {}

  /** 读者读：损坏报一次、按空看（只读统计 / 窗口判断）；写都走 load，损坏时抛 StateCorruptError */
  read(): DigestState {
    try {
      return this.load();
    } catch (e) {
      if (!(e instanceof StateCorruptError)) throw e;
      reportCorrupt(this.path, e.detail, "pm-digest");
      return { queue: [], log: [] };
    }
  }

  private load(): DigestState {
    const v = forWrite(this.path, readJsonStateSync(this.path, validState)) as DigestState | undefined;
    return { queue: v?.queue ?? [], log: v?.log ?? [] };
  }

  private write(s: DigestState, now: number): void {
    writeJsonAtomicSync(this.path, { queue: s.queue, log: s.log.filter((x) => now - x.at < PM_DIGEST_LOG_MS) });
  }

  /** 开关文件损坏按缺省 observe（照常逐条投，不压任何消息） */
  mode(project: string): DigestMode {
    const r = readJsonStateSync(this.modePath, validModes);
    if (r.status === "corrupt") reportCorrupt(this.modePath, r.error, "pm-digest");
    const m = r.status === "ok" ? (r.data as { projects?: Record<string, unknown> }).projects?.[project] : undefined;
    return m === "on" || m === "off" ? m : "observe";
  }

  setMode(project: string, mode: DigestMode): void {
    const v = forWrite(this.modePath, readJsonStateSync(this.modePath, validModes)) as { projects?: Record<string, DigestMode> } | undefined;
    writeJsonAtomicSync(this.modePath, { projects: { ...v?.projects, [project]: mode } });
  }

  /** 记一条归类；enqueue 给了就同时入队（同 id 不重复入队） */
  record(rec: DigestRecord, enqueue?: DigestEntry): void {
    const s = this.load();
    s.log.push(rec);
    if (enqueue && !s.queue.some((e) => e.id === enqueue.id)) s.queue.push(enqueue);
    this.write(s, rec.at);
  }

  queued(project: string): DigestEntry[] {
    return this.read().queue.filter((e) => e.project === project);
  }

  /** 已经随某次投递送到的条目出队 */
  remove(ids: ReadonlySet<string>, now: number): void {
    const s = this.load();
    if (!s.queue.some((e) => ids.has(e.id))) return;
    this.write({ ...s, queue: s.queue.filter((e) => !ids.has(e.id)) }, now);
  }
}

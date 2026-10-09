/**
 * PM 摘要的落盘状态（agents-PMDIG1）：statePath("pm-digest.json") 存摘要队列与最近 24 小时的归类记录，只有 bridge 写；
 * statePath("pm-digest-mode.json") 存各项目开关（缺省 observe），只有 manager 的 `ledger pm-digest-mode` 写。重启读回队列照常送出。
 */
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
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

export class PmDigestStore {
  constructor(readonly path = statePath("pm-digest.json"), readonly modePath = statePath("pm-digest-mode.json")) {}

  read(): DigestState {
    const r = readJsonStateSync(this.path);
    const v = r.status === "ok" ? (r.data as Partial<DigestState>) : {};
    return { queue: Array.isArray(v.queue) ? v.queue : [], log: Array.isArray(v.log) ? v.log : [] };
  }

  private write(s: DigestState, now: number): void {
    writeJsonAtomicSync(this.path, { queue: s.queue, log: s.log.filter((x) => now - x.at < PM_DIGEST_LOG_MS) });
  }

  mode(project: string): DigestMode {
    const r = readJsonStateSync(this.modePath);
    const m = r.status === "ok" ? (r.data as { projects?: Record<string, unknown> }).projects?.[project] : undefined;
    return m === "on" || m === "off" ? m : "observe";
  }

  setMode(project: string, mode: DigestMode): void {
    const r = readJsonStateSync(this.modePath);
    const projects = { ...(r.status === "ok" ? (r.data as { projects?: Record<string, DigestMode> }).projects : undefined), [project]: mode };
    writeJsonAtomicSync(this.modePath, { projects });
  }

  /** 记一条归类；enqueue 给了就同时入队（同 id 不重复入队） */
  record(rec: DigestRecord, enqueue?: DigestEntry): void {
    const s = this.read();
    s.log.push(rec);
    if (enqueue && !s.queue.some((e) => e.id === enqueue.id)) s.queue.push(enqueue);
    this.write(s, rec.at);
  }

  queued(project: string): DigestEntry[] {
    return this.read().queue.filter((e) => e.project === project);
  }

  /** 已经随某次投递送到的条目出队 */
  remove(ids: ReadonlySet<string>, now: number): void {
    const s = this.read();
    if (!s.queue.some((e) => ids.has(e.id))) return;
    this.write({ ...s, queue: s.queue.filter((e) => !ids.has(e.id)) }, now);
  }
}

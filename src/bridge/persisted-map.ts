/**
 * 同步落盘的 Map：set / delete 之后整张表 tmp+rename 写进 state 目录，bridge 重启时读回来。
 * 给 bridge 里「丢了就有人收不到消息」的内存簿记用（押后队列 held-queue.ts、agent 回程路由簿 agent-calls.ts）。
 * ws 这类进程内对象落盘时剥掉（stripKeys），读回来是 undefined，用的时候按 channelId 取最新连接。
 * 文件坏了不抛：挪成 <path>.corrupt-<时间> 留作排查 / 手工恢复，这次启动从空表开始（这类簿记不能让 bridge 起不来）。
 */
import { existsSync, renameSync } from "node:fs";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";

export class PersistedMap<V> extends Map<string, V> {
  constructor(
    private readonly path: string | null,
    private readonly label: string,
    isValue: (v: unknown) => boolean,
    private readonly stripKeys: readonly string[] = ["ws"],
  ) {
    super();
    if (!path || !existsSync(path)) return;
    const isFile = (d: unknown) => !!d && typeof d === "object" && !Array.isArray(d) && Object.values(d as object).every(isValue);
    const r = readJsonStateSync(path, isFile);
    if (r.status !== "ok") {
      const base = `${path}.corrupt-${Date.now()}`;
      let keep = base;
      for (let i = 1; existsSync(keep); i++) keep = `${base}-${i}`; // 同一毫秒坏两次也不互相覆盖
      try {
        renameSync(path, keep);
      } catch (e) {
        console.error(`🚨 ${label}坏文件挪不走，下一次落盘会覆盖它:`, (e as Error).message);
      }
      console.error(`🚨 ${label}文件读不了（${r.status === "corrupt" ? r.error : r.status}），这次启动不恢复，原文件留在:`, keep);
      return;
    }
    for (const [k, v] of Object.entries(r.data as Record<string, V>)) super.set(k, v);
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    this.persist();
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.persist();
    return had;
  }

  /** 不落盘的原始写入：批量改完由调用方 persist() 一次 */
  protected setQuiet(key: string, value: V): void {
    super.set(key, value);
  }

  protected deleteQuiet(key: string): void {
    super.delete(key);
  }

  persist(): void {
    if (!this.path) return;
    const strip = (k: string, v: unknown) => (this.stripKeys.includes(k) ? undefined : v);
    try {
      writeJsonAtomicSync(this.path, JSON.parse(JSON.stringify(Object.fromEntries(this), strip)));
    } catch (e) {
      console.error(`🚨 ${this.label}落盘失败（内存里还在，bridge 重启前不丢）:`, (e as Error).message);
    }
  }
}

/**
 * 已结束 bg shell 的结果（lib/bg-shell-results.ts）按「名字 × 会话」记、并落盘；结束的 shell 已不在活动 map 里，
 * 改挂活动救不到它。这里记住每个「频道 × 会话」上次认的名字，可信登记换了名就把结果搬到新名下（新名落盘），
 * 旧名的视图清空——不留幽灵结果。纯靠 ShellResults 的公开接口，不 import 任何 watcher。
 */
import type { ShellResults } from "../lib/bg-shell-results.js";
import type { OwnerRef } from "./watcher-ownership-gen.js";

export class ShellResultOwners {
  /** 频道 \0 会话 → 上次认的名字（bg tick 的登记与 bridge rescan 都喂） */
  private names = new Map<string, string>();
  constructor(private readonly results: ShellResults) {}

  /** 同频道同会话换了名：搬结果。先记新名再 await，并发的另一路不重搬。返回搬了几条 */
  async sync(owners: readonly OwnerRef[]): Promise<number> {
    let n = 0;
    for (const o of owners) {
      const key = `${o.channelId}\0${o.sessionId}`;
      const prev = this.names.get(key);
      this.names.set(key, o.name);
      if (prev && prev !== o.name) n += await this.move(prev, o.name, o.sessionId);
    }
    return n;
  }

  private async move(from: string, to: string, sessionId: string): Promise<number> {
    const r = this.results;
    await r.select(from, sessionId);
    const rows = r.snapshots(from);
    // 旧名指向一个不存在的作用域（会话 id 不会是空串）：快照即空；旧名之后真被再登记，tick 的 select 会照常重载
    await r.load(from, "");
    if (!rows.length) return 0;
    await r.select(to, sessionId);
    const have = new Set(r.snapshots(to).map((s) => s.id)); // 改名后新名下已记过的更新，不拿旧的盖
    let n = 0;
    for (const s of rows) {
      if (have.has(s.id)) continue;
      await r.remember({ agentName: to, sessionId, id: s.id, startedAt: s.startedAt, lastGrowth: s.progress.lastTs, exitCode: s.end.exitCode },
        s.end.durationMs, s.end.status);
      n++;
    }
    if (n) console.log(`🐚 bg shell 结果随改名迁移: ${from} → ${to} (${n} 条)`);
    return n;
  }
}

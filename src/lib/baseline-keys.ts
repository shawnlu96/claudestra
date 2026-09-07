/**
 * bg-activity-watcher 的「重启防重放」baseline 作用域(纯逻辑,单测在 tests/baseline-keys.test.ts)。
 *
 * 2026-09-07 peer HedeMacBook-Pro-3 报 109 张幽灵 subagent 卡:原实现是进程级单标志
 * `baselined`,只在 bridge 启动后第一轮 tick 把存量文件标 seen。但扫描目录按
 * `<cwd>/<sessionId>/subagents/` 走,baseline 的真正作用域是 **agent × session**——
 * 首轮 tick 时不在 watchableAgents() 里的 agent(registry 还没写回 sessionId、正在
 * restart / 刚 create),或之后 restart / resume 换了 session 的 agent,其存量文件
 * 会一个不漏地开成「运行中」活动(SSE 无上限,web 端 running 卡不修剪)。
 *
 * 这里按 `${agent}:${sessionId}` 记「见过」:首次进入监视的 agent-session 只记存量
 * 不重播,之后新出现的文件才开活动。
 */
export class BaselineKeys {
  private readonly keys = new Set<string>();

  /** 该 agent-session 是否首次进入监视——true 表示本轮只做 baseline(存量标 seen 不开流)。 */
  first(agentName: string, sessionId: string): boolean {
    const k = `${agentName}:${sessionId}`;
    if (this.keys.has(k)) return false;
    this.keys.add(k);
    return true;
  }

  /** 瘦身:registry 里已不存在的 agent 的 key 全部丢掉。同一 agent 轮转过的旧
   *  session key 留着(一天几条,无害);按 agent 名而不是 agent-session 过滤,是为了
   *  避开「agent 正在 restart、sessionId 暂时为空」的窗口——那时它不在 watchable
   *  列表里,若按 session 删掉,回来后会被重新 baseline,窗口期新文件被吞。返回删除数。 */
  prune(liveAgentNames: Iterable<string>): number {
    const live = new Set(liveAgentNames);
    let n = 0;
    for (const k of this.keys) {
      const name = k.slice(0, k.lastIndexOf(":"));
      if (!live.has(name)) {
        this.keys.delete(k);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.keys.size;
  }
}

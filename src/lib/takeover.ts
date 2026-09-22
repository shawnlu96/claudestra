/**
 * 把「跑在 Claudestra 之外的 Claude Code」接管进我们的 tmux（v2.24+）。纯逻辑，单测覆盖。
 *
 * owner 2026-09-22：「你应该自动的有这么一个办法去把进程重启到 tmux 里啊。」
 *
 * ## 能做到什么，做不到什么
 *
 * **搬不了**：一个进程的控制终端在 fork/exec 那一刻就定死，没有任何办法把别人 iTerm
 * 窗口里那个 Claude Code 挪进我们的 tmux session。
 *
 * **能做的是「退出再重开」**：Claude Code 的会话状态全在 `~/.claude/projects` 的
 * jsonl 里，进程只是它的一个读写者。所以先让原进程干净退出（SIGTERM，等它落盘），
 * 再在我们的 tmux 里 `resume` 同一个 sessionId —— 对用户来说就是「同一个会话换了个
 * 地方继续」，上下文一条不丢。这就是 takeover。
 *
 * ## 判据：怎么确定它「在我们外面」
 *
 * `~/.claude/sessions/<pid>.json` 里的 `tmux` 字段形如 `master:@994.%994`
 * （session:window.pane）。pane id 是**每个 tmux server 独立**的，所以拿它跟**我们
 * 自己 socket 上**的 pane 列表比对就是精确判断——不靠 session 名去猜（用户自己的
 * tmux 也可能叫 master）。
 *
 * ⚠ 但 pane id 在不同 server 之间**会撞号**（各自从 %0 递增）。撞号会让我们把一个
 * 外面的会话误判成「已经在里面」⇒ 少接管一个，方向是安全的；反过来永远不会发生。
 * registry 里已登记的 sessionId 是更硬的证据，两者取并集。
 */

export interface RunningCc {
  pid: number;
  sessionId: string;
  cwd: string;
  /** "master:@994.%994"；不在 tmux 里跑就没有这个字段 */
  tmux?: string;
  /** Claude Code 自报：idle / busy / shell */
  status?: string;
}

export type TakeoverVerdict =
  /** 已经在我们的 tmux 里（或已登记）——没什么要做的 */
  | "inside"
  /** 可以接管：退出原进程 + 在我们这边 resume 同一个 session */
  | "ready"
  /** 正在跑一个回合——接管会打断它，要显式 --force */
  | "busy";

/** `master:@994.%994` → `%994`；取不出来返回 null */
export function paneIdOf(tmuxField?: string): string | null {
  const m = /(%\d+)\s*$/.exec(tmuxField ?? "");
  return m ? m[1] : null;
}

export function classifyRunning(
  e: RunningCc,
  ourPanes: Set<string>,
  managedSessionIds: Set<string>,
): TakeoverVerdict {
  if (managedSessionIds.has(e.sessionId)) return "inside";
  const pane = paneIdOf(e.tmux);
  if (pane && ourPanes.has(pane)) return "inside";
  return e.status === "busy" ? "busy" : "ready";
}

export interface TakeoverCandidate extends RunningCc {
  verdict: Exclude<TakeoverVerdict, "inside">;
}

/**
 * 外面那些会话，按能不能直接接管分好类。
 * `inside` 的直接剔除——它们本来就归我们管，列出来只会让人以为要做点什么。
 */
export function takeoverCandidates(
  entries: RunningCc[],
  ourPanes: Set<string>,
  managedSessionIds: Set<string>,
): TakeoverCandidate[] {
  const out: TakeoverCandidate[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.sessionId || !e.pid || !e.cwd) continue;
    if (seen.has(e.sessionId)) continue; // 同一个 session 多条登记（旧 pid 残留）只算一次
    const v = classifyRunning(e, ourPanes, managedSessionIds);
    if (v === "inside") continue;
    seen.add(e.sessionId);
    out.push({ ...e, verdict: v });
  }
  return out;
}

/** 允不允许对它动手：busy 的必须显式 force */
export function mayTakeOver(c: TakeoverCandidate, force: boolean): { ok: boolean; reason?: string } {
  if (c.verdict === "busy" && !force) {
    return { ok: false, reason: "它正在跑一个回合，接管会打断；确认要打断就加 --force" };
  }
  return { ok: true };
}

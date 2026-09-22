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
  /** 只有 interactive（用户开的 TUI）才是接管对象；bg job / sdk 进程不是 */
  kind?: string;
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
    // 缺 kind 的（老版本 CC）也不收：判断不了是不是用户开的 TUI，就不去 SIGTERM 它
    if (e.kind !== "interactive") continue;
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

export interface TakeoverPreflight {
  /** 用户级 settings 里记录过 bypass 同意（否则 resume 起来会停在确认框上） */
  bypassAccepted: boolean;
  /** master tmux session 在（resume 要在里面 new-window） */
  masterSession: boolean;
  /** bridge /stats 答话（resume 要经它建频道） */
  bridgeReachable: boolean;
}

/**
 * SIGTERM 之前必须全部成立的前置条件（纯函数）。任何一项不满足就一个进程都不动：
 * 先关掉用户的会话、再发现这边起不来，是最坏的结果。
 */
export function preflightProblems(p: TakeoverPreflight): string[] {
  const out: string[] = [];
  if (!p.bypassAccepted) {
    out.push("还没接受 Claude Code 的 bypass 模式——重跑 bun run setup，或在终端里执行一次 claude --dangerously-skip-permissions 并选 Yes, I accept");
  }
  if (!p.masterSession) out.push("Claudestra 的 master tmux session 不在（launcher 没起来？先跑 claudestra doctor）");
  if (!p.bridgeReachable) out.push("bridge 连不上（/stats 无响应）——收编要经 bridge 建频道");
  return out;
}

/**
 * 原进程已经被 SIGTERM、我们这边又没起来时，用户手动把会话接回去的命令。
 * cwd 单引号转义：目录名里有空格 / 引号也能原样粘贴。
 */
export function recoverCommand(cwd: string, sessionId: string): string {
  return `cd '${cwd.replace(/'/g, `'\\''`)}' && claude --resume ${sessionId}`;
}

/**
 * 从 cmdResume 打到 stdout 的行里判成败（纯函数）。
 * cmdResume 自己 output 一份 JSON（成功 ok:true，失败 ok:false + error）；takeover 截下
 * 这些行、只输出自己的一份汇总。没有任何 JSON 结论 = 没跑完，按失败算——
 * 这时原进程已经被关掉了，绝不能报成功。ready:false 同样算失败（会话没真正起来）。
 */
export function resumeOutcome(lines: string[]): { ok: boolean; error?: string; agent?: string } {
  let last: Record<string, unknown> | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (j && typeof j === "object" && "ok" in j) last = j;
    } catch { /* 不是 JSON 行 */ }
  }
  if (!last) return { ok: false, error: "resume 没有给出结果" };
  if (last.ok !== true) return { ok: false, error: String(last.error ?? "resume 失败") };
  if (last.ready === false) return { ok: false, error: "resume 后 Claude Code 没有就绪" };
  return { ok: true, ...(typeof last.agent === "string" ? { agent: last.agent } : {}) };
}

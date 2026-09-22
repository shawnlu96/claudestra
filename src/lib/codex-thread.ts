/**
 * Codex 线程的查活与入站投递（channel-server 的 Codex 模式用）。
 *
 * 为什么要查活：`codex queue` 对**没被任何 TUI 加载**的线程也返回成功（exit 0），
 * 消息存进 ~/.codex/queue_1.sqlite，等下次有人 resume 这个线程时才自动投递——对发消息
 * 的人来说就是「显示送达、其实石沉大海，几天后突然冒出来」。所以投递前先确认线程确实
 * 在本 TUI 里：Codex TUI 加载线程后由原生进程持有 `~/.codex/thread-writer-locks/<sid>.lock`，
 * 而本进程（channel-server，Codex 起的 MCP 子进程）的 ppid 正是那个原生进程。
 *
 * 锁文件与 queue 都是 Codex 未公开的内部机制（0.153 实测），升级后可能漂移——解析部分
 * 做成纯函数，漂移时改这里一处。
 */

/** 重启 / 收编后职责前言的标记（codex-launch.codexContextPreamble 生成；codex-session 的历史翻译据此剥掉前言） */
export const CONTEXT_PREAMBLE_MARKER = "[claudestra:context]";

/** 前言经环境变量带给 channel-server：base64 免得换行 / 引号进 tmux 键入的启动命令 */
export function encodePreambleEnv(preamble: string): string {
  return Buffer.from(preamble, "utf8").toString("base64");
}

/** 解不出来 / 不是我们的前言 → undefined（宁可不附，也不把乱码塞给模型） */
export function decodePreambleEnv(v: string | undefined): string | undefined {
  if (!v || !v.trim()) return undefined;
  try {
    const s = Buffer.from(v.trim(), "base64").toString("utf8");
    return s.startsWith(CONTEXT_PREAMBLE_MARKER) ? s : undefined;
  } catch {
    return undefined;
  }
}

export interface CmdResult {
  ok: boolean;
  out: string;
  err: string;
}
export type Runner = (cmd: string[], timeoutMs?: number) => Promise<CmdResult>;

const LOCK_RE = /\/\.codex\/thread-writer-locks\/([^/]+)\.lock$/;

/** `lsof -p <pid> -Fn` 的输出 → 该进程持有的线程 id（去重、保序） */
export function parseHeldThreadLocks(lsofOutput: string): string[] {
  const out: string[] = [];
  for (const raw of lsofOutput.split("\n")) {
    // -F 输出每行首字母是字段类型：n = 文件名
    if (!raw.startsWith("n")) continue;
    const m = LOCK_RE.exec(raw.slice(1).trim());
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 默认执行器：Bun.spawn，带超时 */
export const defaultRunner: Runner = async (cmd, timeoutMs = 10_000) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: code === 0, out, err };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error)?.message || String(e) };
  }
};

/** macOS 的 lsof 在 /usr/sbin，launchd 的精简 PATH 里不一定有 */
const LSOF = "/usr/sbin/lsof";

/** pid 持有的 Codex 线程锁。lsof 查无结果时 exit 1，此时照样按输出解析（为空即无锁） */
export async function heldThreadIds(pid: number, run: Runner = defaultRunner): Promise<string[]> {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  const r = await run([LSOF, "-p", String(pid), "-Fn"], 5_000);
  return parseHeldThreadLocks(r.out);
}

export async function isThreadLive(sid: string, pid: number, run: Runner = defaultRunner): Promise<boolean> {
  return !!sid && (await heldThreadIds(pid, run)).includes(sid);
}

export type DeliveryDecision =
  | { action: "queue"; sid: string }
  /** TUI 里 /new 之类换了线程：切过去并重报 register */
  | { action: "switch"; sid: string }
  /** 一个锁都没有：线程不在线，**不入队**（否则离线积压、下次 resume 重放） */
  | { action: "offline" }
  /** 持有多个锁且都不是已知的那个：猜错会把消息送进别的线程，宁可不投 */
  | { action: "ambiguous"; held: string[] };

/** 线程 id 的形状。锁文件名来自文件系统：不像线程 id 的不能切过去（会被当 sessionId 报给 bridge） */
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decideDelivery(knownSid: string | undefined, held: string[]): DeliveryDecision {
  if (knownSid && held.includes(knownSid)) return { action: "queue", sid: knownSid };
  if (held.length === 0) return { action: "offline" };
  const valid = held.filter((s) => THREAD_ID_RE.test(s));
  if (valid.length === 1) return { action: "switch", sid: valid[0] };
  return { action: "ambiguous", held };
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 回复路径提示（`reply_via` 属性）。Codex 的 developer_instructions 只在建线程那一轮生效
 * （0.153.4 实测 TUI `resume` / `fork` 带新的 -c developer_instructions 都不写进上下文），
 * 所以接管的外来会话、改过职责后重启的会话都看不到频道回复规则；每条入站自带这一句，
 * 模型至少知道该调哪个工具。
 */
export function codexReplyHint(source: string): string {
  return `mcp__${source}__reply(chat_id)；纯文本输出不会送达`;
}

/**
 * 包成与 Claude Code channel 通知同款的 `<channel …>` 标签：回复规则（「用 <channel> 里的
 * chat_id 调 reply」）逐字适用，历史面板的 unwrapChannelMessage 也能照常解包。
 */
export function wrapChannelContent(
  content: string,
  meta: Record<string, string> | undefined,
  source: string,
  replyVia?: string,
): string {
  const attrs = [`source="${escapeAttr(source)}"`];
  for (const [k, v] of Object.entries(meta || {})) {
    if (!/^[A-Za-z_][\w-]*$/.test(k) || k === "source" || k === "reply_via" || v === undefined || v === null) continue;
    attrs.push(`${k}="${escapeAttr(String(v))}"`);
  }
  if (replyVia) attrs.push(`reply_via="${escapeAttr(replyVia)}"`);
  return `<channel ${attrs.join(" ")}>\n${content}\n</channel>`;
}

/**
 * Codex 父进程是否已经没了。强杀 Codex（tmux kill-window 的 SIGHUP）不会带走它的 MCP
 * 子进程（实测 /quit 会带走），孤儿 channel-server 收不到 stdio 关闭通知，会一直重连
 * bridge、跟重启后的新实例抢同一个频道。父进程没了 = MCP 客户端没了，与 mcp.onclose 同义。
 */
export function codexParentGone(initialPpid: number, currentPpid: number, alive: (pid: number) => boolean): boolean {
  if (!Number.isInteger(initialPpid) || initialPpid <= 1) return false; // 起来时就没有可盯的父进程
  return currentPpid !== initialPpid || !alive(initialPpid);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM"; // 活着但不归我们管
  }
}

/** 与设计里的 InboundSink 同形（合并后可换成 runtimes/types.ts 的定义） */
export interface InboundSink {
  deliver(content: string, meta: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CodexQueueSinkDeps {
  source: string;
  getSessionId(): string | undefined;
  /** 查活：本 TUI 进程持有的线程锁 */
  heldThreadIds(): Promise<string[]>;
  /** 线程换了（/new 等）：更新 sid 并重报 register */
  onSwitch(sid: string): void;
  /** `codex queue --thread <sid> --message <text>` */
  queue(sid: string, text: string): Promise<CmdResult>;
  /** 投不进去时告诉发消息的人（never silent） */
  notify(chatId: string | undefined, text: string): Promise<void>;
  log?(line: string): void;
  /**
   * 重启 / 收编后第一条成功投递前附的前言（codex-launch.codexContextPreamble）。只附一次，
   * 投递失败不算用掉——下一条再附。
   */
  preamble?: string;
}

export const OFFLINE_NOTICE = "⚠️ Codex 会话不在线，消息未投递";
/** 同一 Codex 进程持有多个线程锁、且都不是已知那个（刚 /new 过、或子 agent 在跑）：认不准，宁可不投 */
export const AMBIGUOUS_NOTICE = "⚠️ Codex 进程同时开着多个会话（刚 /new 过或有子 agent 在跑），认不准该投哪个，消息未投递——请先在终端里发一条消息，再从这里重发";
/** /new 之后新线程还没有 rollout，queue 报 `no rollout found` */
export const ROTATED_NOTICE = "⚠️ Codex 会话刚轮转、还没有第一轮，消息未投递——请先在终端里发一条消息，再从这里重发";

/** queue 失败时给发消息的人看的话：已知原因给指引，其余带上 stderr 末行 */
export function queueFailureNotice(detail: string): string {
  if (/no rollout found/i.test(detail)) return ROTATED_NOTICE;
  return `⚠️ 消息投递到 Codex 失败：${detail}`;
}

/** 构造 queue 命令（纯函数，便于钉住参数形状） */
export function codexQueueArgs(codexBin: string, sid: string, text: string): string[] {
  return [codexBin, "queue", "--thread", sid, "--message", text];
}

/**
 * 串行投递：promise 链保证 queue 顺序与到达顺序一致（并发 spawn 的完成顺序不定）。
 * 每条消息投递前都查活，不缓存结果——线程可能随时被 /new 换掉或 TUI 退出。
 */
export class CodexQueueSink implements InboundSink {
  private chain: Promise<unknown> = Promise.resolve();
  private preamblePending: string | undefined;
  constructor(private deps: CodexQueueSinkDeps) {
    this.preamblePending = deps.preamble?.trim() ? deps.preamble : undefined;
  }

  deliver(content: string, meta: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
    const run = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const d = this.deps;
      const chatId = meta?.chat_id;
      let held: string[];
      try { held = await d.heldThreadIds(); } catch { held = []; }
      const decision = decideDelivery(d.getSessionId(), held);
      if (decision.action === "offline" || decision.action === "ambiguous") {
        const offline = decision.action === "offline";
        const why = offline ? "offline" : `ambiguous locks: ${decision.held.join(",")}`;
        d.log?.(`⚠️ Codex 入站未投递（${why}）`);
        await d.notify(chatId, offline ? OFFLINE_NOTICE : AMBIGUOUS_NOTICE).catch(() => {});
        return { ok: false, error: why };
      }
      if (decision.action === "switch") {
        d.log?.(`🔀 Codex 线程已切换 ${d.getSessionId() ?? "?"} → ${decision.sid}`);
        d.onSwitch(decision.sid);
      }
      const wrapped = wrapChannelContent(content, meta, d.source, codexReplyHint(d.source));
      const preamble = this.preamblePending;
      const r = await d.queue(decision.sid, preamble ? `${preamble}\n\n${wrapped}` : wrapped);
      if (r.ok && preamble) this.preamblePending = undefined;
      if (!r.ok) {
        const detail = (r.err || r.out || "unknown").trim().split("\n").slice(-1)[0].slice(0, 300);
        d.log?.(`❌ codex queue 失败: ${detail}`);
        await d.notify(chatId, queueFailureNotice(detail)).catch(() => {});
        return { ok: false, error: detail };
      }
      return { ok: true };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}

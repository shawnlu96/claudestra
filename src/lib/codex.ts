/**
 * Codex 调用层(v2.20+):agent 经 `ask_codex` MCP 工具让本机 Codex 跑一轮。
 *
 * 形态决策(owner 2026-08-26「选最优雅的」):**bridge 统一 per-call spawn
 * `codex exec`**,不给每个 agent 挂常驻 `codex mcp-server`(N 个 agent = N 份
 * ~百 MB 常驻进程),也不用朋友 BRIDGE.md 那套 outbox+watcher(那是给「无法注入
 * 对方上下文」的环境设计的;Claudestra 的回程天然走 MCP 通道)。集中过 bridge
 * 的好处:零常驻、调用在 jsonl-watcher 流里全程可审计、限频/日志一处管。
 *
 * 认证:复用 ChatGPT.app 的登录态(~/.codex/auth.json, auth_mode=chatgpt),
 * 走订阅额度,无 API key。二进制随 ChatGPT.app 发行(alpha 契约,路径/参数可能
 * 漂移,findCodexBin 支持 CODEX_BIN 覆盖)。
 *
 * 线程连续性:`thread` 参数是**命名会话**——首次调用创建 codex session 并把
 * name→sessionId 记进 ~/.claude-orchestrator/codex-threads.json,后续同名调用
 * `codex exec resume <id>` 续聊。不同 agent 用同名 thread 就是共享同一个
 * Codex 上下文(特性,不是 bug:多 agent 问同一个「PM」)。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "fs";
import { spawn } from "child_process";
import { homedir, tmpdir } from "os";
import { join } from "path";

/** 沙箱白名单:read-only 缺省(纯问答/审阅);workspace-write 让它真改 cwd 里的
 *  文件。danger-full-access 故意不暴露——agent 自己已经是无沙箱 shell,没必要
 *  再造一个不受 --disallowedTools 约束的全权分身。 */
export const CODEX_SANDBOXES = ["read-only", "workspace-write"] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

const DEFAULT_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
export const CODEX_TIMEOUT_MS = 12 * 60 * 1000; // 单轮上限;channel-server 侧给 15min

export function findCodexBin(): string | null {
  const env = process.env.CODEX_BIN;
  if (env && existsSync(env)) return env;
  if (existsSync(DEFAULT_BIN)) return DEFAULT_BIN;
  return null;
}

/* ── 命名线程注册表 ─────────────────────────────────────────────── */

const THREADS_PATH = join(homedir(), ".claude-orchestrator", "codex-threads.json");

export interface CodexThreadEntry {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  cwd?: string;
}

export function readThreads(path = THREADS_PATH): Record<string, CodexThreadEntry> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** 原子写(临时文件 + rename,同仓库其它状态文件的惯例)。 */
export function writeThreads(threads: Record<string, CodexThreadEntry>, path = THREADS_PATH): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(threads, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/* ── 参数构建(纯函数,单测) ─────────────────────────────────────── */

export interface CodexRunOpts {
  prompt: string;
  /** 命名会话:同名续聊(经注册表映射到 codex sessionId)。 */
  thread?: string;
  /** 工作目录(codex 读/写代码的根)。缺省不传 -C。 */
  cwd?: string;
  sandbox?: CodexSandbox;
  model?: string;
  timeoutMs?: number;
}

/** 组 codex exec 的 argv(不含 prompt 本体——prompt 走 stdin,免 shell 转义面)。
 *  ⚠ resume 子命令的 flag 面更窄(0.149 实测):不吃 -s/-C/--color——沙箱与
 *  工作目录在**建线程那次**定死,续聊继承原会话策略(与 BRIDGE.md §1 的观察一致)。 */
export function buildCodexArgs(
  opts: CodexRunOpts,
  resumeSessionId: string | null,
  lastMsgFile: string
): string[] {
  const args = ["exec"];
  if (resumeSessionId) {
    args.push("resume", resumeSessionId, "--json", "-o", lastMsgFile, "--skip-git-repo-check");
  } else {
    const sandbox: string =
      opts.sandbox && CODEX_SANDBOXES.includes(opts.sandbox) ? opts.sandbox : "read-only";
    args.push("--json", "-o", lastMsgFile, "-s", sandbox, "--skip-git-repo-check", "--color", "never");
    if (opts.cwd) args.push("-C", opts.cwd);
  }
  if (opts.model) args.push("-m", opts.model);
  args.push("-"); // prompt 从 stdin 读
  return args;
}

/** 从 --json 事件流里抠 session/thread id(alpha CLI 事件形态不稳,多形态兼容;
 *  抠不到只影响「续聊」,本轮回复不受损)。 */
export function extractSessionId(jsonlText: string): string | null {
  for (const line of jsonlText.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    const cand =
      obj.thread_id ??
      obj.session_id ??
      obj.sessionId ??
      obj.thread?.id ??
      obj.msg?.session_id ??
      obj.msg?.thread_id ??
      (obj.type === "thread.started" ? obj.id : undefined);
    if (typeof cand === "string" && cand.length >= 8) return cand;
  }
  return null;
}

/* ── 执行 ───────────────────────────────────────────────────────── */

export interface CodexResult {
  ok: boolean;
  /** 最终回复正文(ok=false 时是错误说明)。 */
  message: string;
  /** 本轮的 codex sessionId(续聊句柄;拿不到为 null)。 */
  sessionId: string | null;
  /** thread 名(传了才有)。 */
  thread?: string;
  elapsedMs: number;
}

/**
 * 跑一轮 codex exec。prompt 走 stdin;最终回复优先取 -o 落盘文件(契约最稳),
 * 兜底取 stdout JSONL 的尾部文本。超时 SIGKILL。
 */
export async function runCodex(opts: CodexRunOpts): Promise<CodexResult> {
  const t0 = Date.now();
  const bin = findCodexBin();
  if (!bin) {
    return {
      ok: false,
      message: "Codex CLI 不存在:装 ChatGPT.app 或设 CODEX_BIN 指向 codex 二进制。",
      sessionId: null,
      elapsedMs: 0,
    };
  }
  // thread 名解析 → 续聊 id
  let resumeId: string | null = null;
  const threads = opts.thread ? readThreads() : {};
  if (opts.thread && threads[opts.thread]) resumeId = threads[opts.thread].sessionId;

  const lastMsgFile = join(tmpdir(), `codex-last-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const args = buildCodexArgs(opts, resumeId, lastMsgFile);
  const timeoutMs = opts.timeoutMs ?? CODEX_TIMEOUT_MS;

  const { out, err, code, timedOut } = await new Promise<{
    out: string;
    err: string;
    code: number | null;
    timedOut: boolean;
  }>((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, err, code, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ out, err: String(e), code: -1, timedOut: false });
    });
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });

  const sessionId = extractSessionId(out);
  // 注册表回写:新会话绑定 thread 名;续聊刷新 lastUsedAt
  if (opts.thread && sessionId) {
    const now = new Date().toISOString();
    const all = readThreads();
    const prev = all[opts.thread];
    all[opts.thread] = {
      sessionId,
      createdAt: prev?.createdAt ?? now,
      lastUsedAt: now,
      ...(opts.cwd ? { cwd: opts.cwd } : prev?.cwd ? { cwd: prev.cwd } : {}),
    };
    writeThreads(all);
  }

  let message = "";
  try {
    message = readFileSync(lastMsgFile, "utf8").trim();
  } catch {
    /* -o 没写出来,走兜底 */
  }
  try {
    rmSync(lastMsgFile, { force: true });
  } catch { /* 清理尽力 */ }

  const elapsedMs = Date.now() - t0;
  if (timedOut) {
    return { ok: false, message: `Codex 超时(${Math.round(timeoutMs / 1000)}s)被终止。`, sessionId, thread: opts.thread, elapsedMs };
  }
  if (code !== 0 && !message) {
    const hint = /login|auth/i.test(err) ? "(登录态可能过期:到 ChatGPT.app 里重新登录)" : "";
    return { ok: false, message: `Codex 退出码 ${code}${hint}:${err.trim().slice(0, 500) || "无 stderr"}`, sessionId, thread: opts.thread, elapsedMs };
  }
  return { ok: true, message: message || "(Codex 无文本输出)", sessionId, thread: opts.thread, elapsedMs };
}

/**
 * Web 远程终端 —— 把 agent 的 tmux window（或网页开的宿主 shell，web-shell.ts）以真 PTY 实时流到 Web 前端。
 * 本文件只做路由 + agent 鉴权；viewer / PTY / IO 在 term-viewer.ts，tmux 尺寸适配在 term-fit.ts。
 *
 * 架构（设计文档 project-nexus reference/web-terminal-design.md，PoC 2026-07-11 全链路验证）：
 *
 *   xterm.js ⇄ 本文件 3 端点 ⇄ Bun.Terminal(PTY) ⇄ tmux attach ⇄ master:agent-X
 *
 * - 每个 viewer 一条 PTY：**独立 session + link-window**——`new-session -d -s
 *   webterm-<id>` 后 `link-window master:<win> → viewer:9`（同一 window 实体，
 *   内容/输入实时同步）→ `Bun.Terminal` + `Bun.spawn(tmux attach)`。
 *   ⚠ 不能用 grouped session（new-session -t master）：master 上挂着 iTerm2 的
 *   tmux -CC control client，它会同步整个 session group 的 current window，把
 *   viewer 的当前窗口漂到最大索引（「跳到最后一个 tab」bug，2026-07-12 实验钉死）。
 * - 输出：PTY 字节流 → SSE `{"t":"o","d":<base64>}`（连接即发首包 + 5s ping，
 *   Bun.serve idleTimeout≈10s 坑，同 handleEventsRequest 的 修复）。
 * - 输入：POST base64 原始字节（xterm onData 的转义序列原样）→ term.write —— tmux
 *   自己解析方向键/Ctrl/粘贴，零翻译。
 * - resize：term.resize 后**必须手动 proc.kill("SIGWINCH")** —— Bun.Terminal spawn
 *   的子进程没有 controlling tty，TIOCSWINSZ 生效但内核不会替我们发信号（PoC 实证）。
 * - 生命周期：SSE 断开（cancel / enqueue 失败 / PTY 退出）→ kill attach 进程 +
 *   kill viewer session。Bridge 启动时 sweepStaleTerminalSessions() 清残留。
 *
 * 鉴权（B2）：终端把原始按键注入 agent 的 tmux，可 Ctrl-C 逃出 CC TUI 落到宿主
 * shell、绕过 `--disallowedTools`——能力等级 == **宿主 shell 访问**，严格强于
 * messaging。因此在 Bearer 之上要求 `terminalAllowed`（token 需显式 terminal 授予，
 * 不复用裸 messaging scope；见 principals.ts）。input/resize 额外校验 termId 属主。
 * 不走 SlidingWindowLimiter（逐键输入秒超 30 req/min），但有 MAX_TERM_SESSIONS
 * 并发上限（含在途占坑，防并发绕过）+ TTL 回收兜底。服务默认只绑 127.0.0.1。
 */

import { MASTER_SESSION, windowTarget } from "../lib/tmux-helper.js";
import { terminalAllowedFor } from "./terminal-auth.js";
import { tmuxRun } from "./term-fit.js";
import { authNoLimit, handleTermIo, json, openTerminal } from "./term-viewer.js";
import { handleShellApi } from "./web-shell.js";

export { sweepStaleTerminalSessions } from "./term-viewer.js";

/**
 * agent 名 → master session 里的 window 引用。
 * master → 索引 0（grouped session 的 window 索引与原 session 一致，已实测）；
 * 其余按窗口名匹配（registry 名 "x" ↔ 窗口名 "agent-x" 双向兼容）。
 * 返回 null = 找不到活的 tmux window。
 */
async function resolveWindowRef(agentParam: string): Promise<string | null> {
  if (agentParam === "master") return "0";
  const { code, out } = await tmuxRun(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"]);
  if (code !== 0) return null;
  const names = new Set(out.split("\n"));
  for (const cand of [agentParam, `agent-${agentParam}`]) {
    if (names.has(cand)) return cand;
  }
  return null;
}

/**
 * 路由入口。匹配不到终端路径时返回 null（调用方 fallthrough 到 handleApiRequest）。
 *   GET  /api/v1/agents/:name/terminal?cols=&rows=   → SSE 输出流（创建 PTY）
 *   POST /api/v1/terminal/:termId/input  {d: base64} → 写 PTY
 *   POST /api/v1/terminal/:termId/resize {cols,rows} → resize + SIGWINCH
 *   /api/v1/shells…                                 → 宿主 shell（web-shell.ts）
 */
export async function handleTerminalApi(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.slice("/api/v1".length);

  const openMatch = path.match(/^\/agents\/([^/]+)\/terminal$/);
  if (openMatch && req.method === "GET") {
    return openAgentTerminal(req, url, decodeURIComponent(openMatch[1]));
  }

  const ioMatch = path.match(/^\/terminal\/([^/]+)\/(input|resize)$/);
  if (ioMatch && req.method === "POST") return handleTermIo(req, ioMatch[1], ioMatch[2] as "input" | "resize");

  if (path === "/shells" || path.startsWith("/shells/")) return handleShellApi(req, url, path);
  return null;
}

/** GET /api/v1/agents/:name/terminal —— agent 的 tmux window */
async function openAgentTerminal(req: Request, url: URL, agentParam: string): Promise<Response> {
  const auth = await authNoLimit(req);
  if (auth instanceof Response) return auth;
  // B2：终端 = 宿主 shell 级访问，须显式 terminal 授予（不复用裸 messaging scope）
  if (!terminalAllowedFor(auth, agentParam)) {
    return json(403, {
      ok: false,
      error: `terminal access not granted for agent "${agentParam}" (needs a token with terminal scope: token-add --terminal)`,
    });
  }
  return openTerminal(auth, url, {
    authAgent: agentParam,
    label: `agent "${agentParam}"`,
    resolve: async () => {
      const ref = await resolveWindowRef(agentParam);
      return ref === null ? null : windowTarget(ref);
    },
  });
}

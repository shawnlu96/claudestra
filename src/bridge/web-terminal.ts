/**
 * Web 远程终端 —— 把 agent 的 tmux window 以真 PTY 实时流到 Web 前端。
 *
 * 架构（设计文档 project-nexus reference/web-terminal-design.md，PoC 2026-07-11 全链路验证）：
 *
 *   xterm.js ⇄ Next.js BFF ⇄ 本文件 3 端点 ⇄ Bun.Terminal(PTY) ⇄ tmux attach ⇄ master:agent-X
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

import { randomBytes } from "node:crypto";
import { TMUX_SOCK, MASTER_SESSION } from "../lib/tmux-helper.js";
import {
  readPrincipals,
  findByBearer,
  terminalAllowed,
  tokenIdOf,
  type Principal,
} from "../lib/principals.js";

// ---------- tmux 小工具（独立于 tmux-helper 的 tmuxRaw：这里需要 exitCode） ----------

function tmuxArgs(args: string[]): string[] {
  return ["tmux", "-f", "/dev/null", "-S", TMUX_SOCK, ...args];
}

async function tmuxRun(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(tmuxArgs(args), { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

// ---------- 会话表 ----------

/** iTerm -CC 钳制解除记录：断开时按原尺寸改写回去，桌面端恢复原状。 */
interface ClampLift {
  windowId: string;
  /** 被改写申报尺寸的控制客户端（iTerm -CC） */
  clients: string[];
  origCols: number;
  origRows: number;
}

interface TermSession {
  id: string;
  tokenId: string;
  agent: string;
  viewerSession: string;
  /** master 侧被 link 的窗口引用（断开时恢复 window-size latest 用） */
  windowRef: string;
  /** 本 viewer 解除过 iTerm 钳制 → 断开时改写回原尺寸 */
  lift?: ClampLift;
  /** 最近一次请求的视口（settle 重申用） */
  want: { cols: number; rows: number };
  /** 当前 PTY 尺寸（settle 校正比对用） */
  effCols: number;
  effRows: number;
  /** 往 SSE 流推帧（settle 校正推送 resize 事件用；stream start 时赋值） */
  push?: (payload: string) => void;
  settleTimer?: ReturnType<typeof setTimeout>;
  term: InstanceType<typeof Bun.Terminal>;
  proc: ReturnType<typeof Bun.spawn>;
  createdAt: number;
  destroy: () => void;
}

const termSessions = new Map<string, TermSession>();
/**
 * 已通过容量检查、但 tmux/PTY 尚未建好登记进 termSessions 的"在途"名额数（M1）。
 * openTerminal 的容量检查在 3 个 tmux await 之前、set 在 await 之后——并发请求
 * 若只看 termSessions.size 会全部读到"未满"而各自建 PTY，绕过上限。占坑计入此数，
 * 使容量检查同步生效；登记成真 session 或走失败路径时释放。
 */
let pendingReservations = 0;
/** 并发 viewer 上限（防泄漏兜底；正常一人用 1-2 个） */
const MAX_TERM_SESSIONS = 8;
const VIEWER_PREFIX = "webterm-";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Bearer 鉴权（同 authApi 但不限流——终端输入逐键回传，30 req/min 秒超）。 */
async function authNoLimit(req: Request): Promise<Principal | Response> {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json(401, { ok: false, error: "missing Authorization: Bearer <secret>" });
  const file = await readPrincipals();
  const p = findByBearer(file, m[1].trim());
  if (!p) return json(401, { ok: false, error: "invalid or revoked token" });
  return p;
}

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

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v === null ? NaN : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 解除 iTerm2 -CC 的 per-tab 尺寸钳制。
 *
 * 控制客户端会为每个窗口申报自己 tab 的尺寸,tmux 把 window 钳到 ≤ 该申报值——
 * resize-window / window-size manual 都顶不动（2026-07-13 实验:exit=0、manual
 * 已置,尺寸纹丝不动）。唯一有效的杠杆是 refresh-client -C <windowId>:WxH 改写
 * 控制客户端的申报值（同实验:改写后立即生效且不回弹,iTerm 只在自己 tab 几何
 * 变化时才重新申报）。返回原尺寸供断开时改写回去;无控制客户端时返回 null
 * （没有钳制来源,不需要解除）。
 */
async function liftControlClamp(
  windowRef: string,
  cols: number,
  rows: number,
  origCols: number,
  origRows: number,
): Promise<ClampLift | null> {
  const idRes = await tmuxRun([
    "display-message", "-p", "-t", `${MASTER_SESSION}:${windowRef}`, "#{window_id}",
  ]);
  const wid = idRes.out.trim();
  if (idRes.code !== 0 || !/^@\d+$/.test(wid)) return null;
  const clientsRes = await tmuxRun(["list-clients", "-F", "#{client_name}\t#{client_control_mode}"]);
  if (clientsRes.code !== 0) return null;
  const clients = clientsRes.out
    .split("\n")
    .filter((l) => l.endsWith("\t1"))
    .map((l) => l.split("\t")[0])
    .filter(Boolean);
  if (!clients.length) return null;
  for (const c of clients) {
    await tmuxRun(["refresh-client", "-t", c, "-C", `${wid}:${cols}x${rows}`]).catch(() => {});
  }
  return { windowId: wid, clients, origCols, origRows };
}

/** 把控制客户端的申报尺寸改写回解除前的值（断开 / 失败清理路径共用）。 */
function restoreControlClamp(lift: ClampLift | undefined | null): void {
  if (!lift) return;
  for (const c of lift.clients) {
    tmuxRun(["refresh-client", "-t", c, "-C", `${lift.windowId}:${lift.origCols}x${lift.origRows}`]).catch(() => {});
  }
}

/**
 * 把 window 拉到 viewer 视口尺寸：先普通 resize-window;window 仍比请求小
 * = 有控制客户端钳制 → liftControlClamp 改写申报值后再拉一次。返回实际
 * eff/win 尺寸与 lift 记录（open 和 resize 端点共用）。
 */
async function fitWindow(
  viewerTarget: string,
  windowRef: string,
  cols: number,
  rows: number,
  existingLift?: ClampLift,
): Promise<{ effCols: number; effRows: number; winCols: number; winRows: number; lift?: ClampLift }> {
  const read = async () => {
    const r = await tmuxRun(["display-message", "-p", "-t", viewerTarget, "#{window_width}x#{window_height}"]);
    const m = /^(\d+)x(\d+)$/.exec(r.out.trim());
    return r.code === 0 && m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
  };
  // 原始尺寸必须在任何 resize 之前捕获——resize 可能已经动了宽度，事后读到的
  // 不再是 iTerm tab 的真实原值，断开还原就还错了
  const before = await read();
  await tmuxRun(["resize-window", "-t", viewerTarget, "-x", String(cols), "-y", String(rows)]).catch(() => {});
  let win = await read();
  let lift = existingLift;
  if (win && (win.w < cols || win.h < rows)) {
    if (lift) {
      // 已解除过（同一 viewer 再次 resize）→ 直接改写到新尺寸，orig 保持首捕值
      for (const c of lift.clients) {
        await tmuxRun(["refresh-client", "-t", c, "-C", `${lift.windowId}:${cols}x${rows}`]).catch(() => {});
      }
    } else {
      const orig = before ?? win;
      lift = (await liftControlClamp(windowRef, cols, rows, orig.w, orig.h)) ?? undefined;
    }
    if (lift) {
      await tmuxRun(["resize-window", "-t", viewerTarget, "-x", String(cols), "-y", String(rows)]).catch(() => {});
      win = (await read()) ?? win;
    }
  }
  const winCols = win?.w ?? cols;
  const winRows = win?.h ?? rows;
  return { effCols: Math.min(cols, winCols), effRows: Math.min(rows, winRows), winCols, winRows, lift };
}

/**
 * lift 后的一次性稳定器。iTerm 跟随宽度变化重排原生窗口后会**重新申报**该窗口
 * 尺寸，晚于 fitWindow 的读数落地 → 窗口被打回（实验：宽度变化必触发重申报;
 * 高度超原生窗口物理上限时原生不动、不再申报）。等它落地后再改写一次即钉住。
 * 若 3 轮后仍被钳（无控制客户端可改写等），把 PTY 校正到实际尺寸并推送前端。
 */
function scheduleSettle(sess: TermSession, attempt = 0): void {
  if (sess.settleTimer) clearTimeout(sess.settleTimer);
  sess.settleTimer = setTimeout(async () => {
    sess.settleTimer = undefined;
    if (!termSessions.has(sess.id)) return;
    const { cols, rows } = sess.want;
    const f = await fitWindow(`${sess.viewerSession}:9`, sess.windowRef, cols, rows, sess.lift);
    if (f.lift) sess.lift = f.lift;
    if (!termSessions.has(sess.id)) return;
    if ((f.winCols < cols || f.winRows < rows) && attempt < 2) {
      scheduleSettle(sess, attempt + 1);
      return;
    }
    if (f.effCols !== sess.effCols || f.effRows !== sess.effRows) {
      sess.effCols = f.effCols;
      sess.effRows = f.effRows;
      try {
        sess.term.resize(f.effCols, f.effRows);
        sess.proc.kill("SIGWINCH");
      } catch { /* PTY 已关 */ }
      sess.push?.(`data: {"t":"resize","cols":${f.effCols},"rows":${f.effRows},"wcols":${f.winCols},"wrows":${f.winRows}}\n\n`);
    }
  }, 1200);
}

// ---------- 端点 ----------

/**
 * 路由入口。匹配不到终端路径时返回 null（调用方 fallthrough 到 handleApiRequest）。
 *   GET  /api/v1/agents/:name/terminal?cols=&rows=   → SSE 输出流（创建 PTY）
 *   POST /api/v1/terminal/:termId/input  {d: base64} → 写 PTY
 *   POST /api/v1/terminal/:termId/resize {cols,rows} → resize + SIGWINCH
 */
export async function handleTerminalApi(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.slice("/api/v1".length);

  const openMatch = path.match(/^\/agents\/([^/]+)\/terminal$/);
  if (openMatch && req.method === "GET") {
    return openTerminal(req, url, decodeURIComponent(openMatch[1]));
  }

  const ioMatch = path.match(/^\/terminal\/([^/]+)\/(input|resize)$/);
  if (ioMatch && req.method === "POST") {
    const auth = await authNoLimit(req);
    if (auth instanceof Response) return auth;
    const sess = termSessions.get(ioMatch[1]);
    if (!sess) return json(404, { ok: false, error: "terminal session not found (expired?)" });
    if (sess.tokenId !== tokenIdOf(auth)) {
      return json(403, { ok: false, error: "terminal session belongs to another token" });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (ioMatch[2] === "input") {
      const d = typeof body.d === "string" ? body.d : "";
      if (!d) return json(400, { ok: false, error: "missing d (base64 bytes)" });
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(Buffer.from(d, "base64"));
      } catch {
        return json(400, { ok: false, error: "invalid base64" });
      }
      try {
        sess.term.write(bytes);
      } catch (e) {
        return json(500, { ok: false, error: `pty write failed: ${(e as Error).message}` });
      }
      return json(200, { ok: true });
    }
    // resize：fitWindow 把 window 拉到新视口（iTerm -CC 钳制时先解除），
    // 再按 window 实际尺寸 clamp PTY;实际值回传给前端 xterm 同步。
    const cols = clampInt(String(body.cols ?? ""), 0, 20, 500);
    const rows = clampInt(String(body.rows ?? ""), 0, 5, 200);
    if (!cols || !rows) return json(400, { ok: false, error: "missing/invalid cols,rows" });
    const fitted = await fitWindow(`${sess.viewerSession}:9`, sess.windowRef, cols, rows, sess.lift);
    if (fitted.lift) sess.lift = fitted.lift;
    const { effCols, effRows, winCols, winRows } = fitted;
    try {
      sess.term.resize(effCols, effRows);
      // 无 controlling tty → 内核不发 SIGWINCH，必须手动补（PoC 实证，勿删）
      sess.proc.kill("SIGWINCH");
    } catch (e) {
      return json(500, { ok: false, error: `resize failed: ${(e as Error).message}` });
    }
    sess.want = { cols, rows };
    sess.effCols = effCols;
    sess.effRows = effRows;
    if (fitted.lift) scheduleSettle(sess); // iTerm 迟到的重申报会打回尺寸，落定后再钉一次
    // wcols/wrows = window 实际尺寸——移动端用它做「完整镜像」目标（PTY 提到
    // window 尺寸,字号再按屏宽自适应,不然 window 比手机视口宽时内容被裁）
    return json(200, { ok: true, cols: effCols, rows: effRows, wcols: winCols, wrows: winRows });
  }

  return null;
}

/** GET /api/v1/agents/:name/terminal —— 建 PTY + SSE 输出流 */
async function openTerminal(req: Request, url: URL, agentParam: string): Promise<Response> {
  const auth = await authNoLimit(req);
  if (auth instanceof Response) return auth;
  const principal = auth;
  // B2：终端 = 宿主 shell 级访问，须显式 terminal 授予（不复用裸 messaging scope）
  if (!terminalAllowed(principal, agentParam) && !terminalAllowed(principal, `agent-${agentParam}`)) {
    return json(403, {
      ok: false,
      error: `terminal access not granted for agent "${agentParam}" (needs a token with terminal scope: token-add --terminal)`,
    });
  }

  // M1：容量检查计入在途占坑，且检查+占坑在任何 await 之前**同步**完成，
  // 并发请求无法各自读到"未满"。此后每条 return / start() 都要 release()。
  if (termSessions.size + pendingReservations >= MAX_TERM_SESSIONS) {
    return json(429, { ok: false, error: `too many terminal sessions (max ${MAX_TERM_SESSIONS})` });
  }
  pendingReservations++;
  let reserved = true;
  const release = () => { if (reserved) { reserved = false; pendingReservations--; } };

  const windowRef = await resolveWindowRef(agentParam);
  if (windowRef === null) {
    release();
    return json(404, { ok: false, error: `no live tmux window for agent "${agentParam}"` });
  }

  const cols = clampInt(url.searchParams.get("cols"), 100, 20, 500);
  const rows = clampInt(url.searchParams.get("rows"), 30, 5, 200);
  const termId = randomBytes(12).toString("hex");
  const viewerSession = `${VIEWER_PREFIX}${termId}`;

  // 独立 session + link-window（不是 grouped session！）：
  // grouped（new-session -t master）共享 master 的 window 集，而 master 上挂着
  // iTerm2 的 tmux -CC control-mode client——它会主动同步/管理整个 session group
  // 的 current window，把 viewer 的当前窗口「漂」到窗口列表最大索引（用户点 A 的
  // 终端,过一会儿跳到最后一个 tab）。受控实验钉死：同一 control client 环境下
  // grouped 必漂、link-window 零漂（2026-07-12,25 次实测）。
  // 做法：独立 session（不入 group,control client 摸不到）+ link-window 把目标
  // 窗口链接进来（同一 window 实体,内容/输入实时同步）+ 干掉默认窗口。
  const created = await tmuxRun([
    "new-session", "-d", "-s", viewerSession,
    "-x", String(cols), "-y", String(rows),
  ]);
  if (created.code !== 0) {
    release();
    return json(500, { ok: false, error: `tmux new-session failed: ${created.err}` });
  }
  const linked = await tmuxRun([
    "link-window", "-s", `${MASTER_SESSION}:${windowRef}`, "-t", `${viewerSession}:9`,
  ]);
  if (linked.code !== 0) {
    await tmuxRun(["kill-session", "-t", viewerSession]);
    release();
    return json(500, { ok: false, error: `tmux link-window failed: ${linked.err}` });
  }
  await tmuxRun(["select-window", "-t", `${viewerSession}:9`]);
  await tmuxRun(["kill-window", "-t", `${viewerSession}:0`]);
  // 尺寸三段式（2026-07-13 定稿）：
  // ① resize-window 尝试把 window 拉到 viewer 视口;
  // ② 拉不动 = iTerm -CC 控制客户端按 tab 申报尺寸在钳制 → fitWindow 里
  //    refresh-client -C 改写申报值解除钳制再拉（实验实证:manual/resize 都
  //    顶不动,改写申报值立即生效不回弹）,断开时改写回原值还原桌面端;
  // ③ 仍失败（无控制客户端等）才反向 clamp:PTY 用 min(视口, window),
  //    视口=window 就没有「window 外」区域,tmux 无处画填充点。
  const fitted = await fitWindow(`${viewerSession}:9`, windowRef, cols, rows);
  const { effCols, effRows, winCols, winRows } = fitted;
  // 滚动支持：CC TUI 在 alternate screen（无滚动缓冲），滚轮要靠 tmux 的
  // copy-mode——viewer session 开 mouse（session 级选项，master/本地 attach
  // 不受影响），tmux 会向 PTY 请求鼠标上报，xterm.js 自动转发滚轮 → tmux
  // 进 copy-mode 翻 pane 历史（Esc/q 或滚到底退出，与 iTerm 体验一致）。
  await tmuxRun(["set-option", "-t", viewerSession, "mouse", "on"]);

  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const destroy = () => {
        if (closed) return;
        closed = true;
        if (ping) { clearInterval(ping); ping = null; }
        if (sess.settleTimer) { clearTimeout(sess.settleTimer); sess.settleTimer = undefined; }
        termSessions.delete(termId);
        try { sess.proc.kill(); } catch { /* 已退出 */ }
        try { sess.term.close(); } catch { /* 已关闭 */ }
        // fire-and-forget：viewer session 清理失败由启动 sweep 兜底
        tmuxRun(["kill-session", "-t", viewerSession]).catch(() => {});
        // 解除过 iTerm 钳制 → 申报尺寸改写回原值，桌面端恢复原状
        restoreControlClamp(sess.lift);
        // 把 window 尺寸决定权还回去（resize-window 置了 manual;不恢复的话
        // master/iTerm 里这个窗口会一直钉在手机尺寸）
        tmuxRun(["set-option", "-w", "-t", `${MASTER_SESSION}:${windowRef}`, "window-size", "latest"]).catch(() => {});
        try { controller.close(); } catch { /* 已关闭 */ }
        console.log(`🖥️ [term] closed id=${termId.slice(0, 8)} agent=${agentParam}`);
      };
      const send = (payload: string) => {
        try {
          controller.enqueue(enc.encode(payload));
        } catch {
          destroy(); // controller 已关（客户端断开）
        }
      };

      // L8：term/proc 构造若抛错，viewerSession 已建但未登记（destroy 拿不到），
      // 会泄漏到下次启动 sweep——就地清理 tmux session + 释放占坑 + 报错收流。
      let term: InstanceType<typeof Bun.Terminal>;
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        term = new Bun.Terminal({
          cols: effCols,
          rows: effRows,
          data(_t: unknown, bytes: Uint8Array) {
            send(`data: {"t":"o","d":"${Buffer.from(bytes).toString("base64")}"}\n\n`);
          },
        });
        proc = Bun.spawn(tmuxArgs(["attach", "-t", viewerSession]), {
          terminal: term,
          env: { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG || "en_US.UTF-8" },
        });
      } catch (e) {
        release();
        tmuxRun(["kill-session", "-t", viewerSession]).catch(() => {});
        restoreControlClamp(fitted.lift); // 已解除钳制但 session 没建成 → 就地还原
        try { controller.error(e); } catch { /* 已关闭 */ }
        console.error(`🖥️ [term] spawn failed id=${termId.slice(0, 8)} agent=${agentParam}:`, e);
        return;
      }
      const sess: TermSession = {
        id: termId,
        tokenId: tokenIdOf(principal),
        agent: agentParam,
        viewerSession,
        windowRef,
        lift: fitted.lift,
        want: { cols, rows },
        effCols,
        effRows,
        push: send,
        term,
        proc,
        createdAt: Date.now(),
        destroy,
      };
      termSessions.set(termId, sess);
      release(); // 占坑转为实际登记（size 已计入），释放在途名额

      // 首包立即 flush（Bun idleTimeout 坑）+ 告知前端 termId（input/resize 用）
      send(`: connected\n\n`);
      // wcols/wrows = window 实际尺寸——移动端据此把 PTY 提到 window 大小做完整镜像
      send(`data: {"t":"open","id":"${termId}","cols":${effCols},"rows":${effRows},"wcols":${winCols},"wrows":${winRows}}\n\n`);
      ping = setInterval(() => send(`: ping\n\n`), 5_000);
      if (fitted.lift) scheduleSettle(sess); // iTerm 迟到的重申报会打回尺寸，落定后再钉一次

      // PTY 进程退出（window 被 kill / tmux server 重启）→ 通知前端并收尾
      proc.exited.then(() => {
        if (closed) return;
        send(`data: {"t":"exit"}\n\n`);
        destroy();
      });

      console.log(`🖥️ [term] open id=${termId.slice(0, 8)} agent=${agentParam} ${cols}x${rows} (token=${sess.tokenId})`);
    },
    cancel() {
      release(); // stream 从未 start 就被取消时兜底释放占坑（幂等）
      termSessions.get(termId)?.destroy();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/** 单条 PTY 会话的最长存活（TTL 兜底）。正常关闭走 SSE 断开；这里防的是
 *  取消传导失败的僵尸（实测过一例：dev 双 effect + BFF 透传 body 漏 abort）。 */
const MAX_TERM_AGE_MS = 12 * 60 * 60 * 1000;

function reapExpiredTerminalSessions(): void {
  const now = Date.now();
  for (const sess of [...termSessions.values()]) {
    if (now - sess.createdAt > MAX_TERM_AGE_MS) {
      console.log(`🖥️ [term] TTL reap id=${sess.id.slice(0, 8)} agent=${sess.agent}（存活超 ${MAX_TERM_AGE_MS / 3600_000}h）`);
      sess.destroy();
    }
  }
}

/**
 * Bridge 启动时清扫残留 viewer session（上次进程被 kill -9 / 崩溃时的孤儿），
 * 并拉起 TTL 兜底回收（每 10 分钟）。孤儿判定：tmux 里 webterm-* 但不在本进程
 * termSessions 表里的（同进程活跃 viewer 不能误杀——本函数只在启动时调，表必空）。
 * grouped session 只是 window 集的视图，kill 不伤 master 本体。
 */
export async function sweepStaleTerminalSessions(): Promise<void> {
  const { code, out } = await tmuxRun(["list-sessions", "-F", "#{session_name}"]);
  if (code === 0 && out) {
    for (const name of out.split("\n")) {
      if (name.startsWith(VIEWER_PREFIX)) {
        await tmuxRun(["kill-session", "-t", name]);
        console.log(`🖥️ [term] swept stale viewer session ${name}`);
      }
    }
  }
  setInterval(reapExpiredTerminalSessions, 10 * 60 * 1000);
}

/**
 * 独立维护页:只监听 127.0.0.1,随执行器之外的 serve 进程存活(bridge 停了照常可用)。
 * 访问:URL 带一次性访问码,首次打开换成 HttpOnly 会话 cookie(短期),码随即作废;Host 头只认本机,防 DNS 重绑定。
 * 只有三个固定动作:看状态、恢复(按原请求与 journal 续)、取消(还没动根时);没有参数、不碰任意文件,不是 shell。
 * tests/state-maintenance-page.test.ts。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { FILE_MODE } from "./paths.js";
import { loadState, runPaths, takenRequest, type RunState } from "./run-store.js";

const CODE_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 2 * 3600_000;
/** 取消只在还没动状态根时有效 */
const CANCELLABLE = new Set<RunState["phase"]>(["starting", "ready", "stopping", "probing", "pre-inventory"]);
/** 这些停留态才给恢复按钮:执行器中断、回滚失败保持屏障、恢复写者失败、指针没落库 */
const RECOVERABLE = new Set<RunState["phase"]>(["stopping", "probing", "pre-inventory", "migrating", "verifying", "rolling-back", "recording", "restoring", "failed-holding", "restore-failed"]);

export interface PageDeps {
  maintRoot: string;
  runId: string;
  /** 执行器是否还活着(活着就不另起恢复) */
  executorAlive: () => boolean;
  /** 起一个恢复执行器(独立进程) */
  spawnRecover: () => void;
  now: () => number;
}

export interface PageHandle { port: number; code: string; stop: () => void }

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const eq = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function render(s: RunState | null, csrf: string, msg: string): string {
  const rows = (s?.comparisons ?? []).map((c) => `<li>${esc(c.stage)}:${c.executed ? "已执行" : "未执行"}${c.note ? ` — ${esc(c.note)}` : ""}`
    + `${c.identityDiff?.length ? `;身份差异 ${c.identityDiff.length}` : ""}${c.treeDiff?.length ? `;数据差异 ${c.treeDiff.length}` : ""}</li>`).join("");
  const form = (path: string, label: string) => `<form method="post" action="${path}"><input type="hidden" name="csrf" value="${csrf}"><button>${label}</button></form>`;
  const phase = s?.phase ?? "unknown";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>状态根维护</title>
<body style="font-family:system-ui;max-width:640px;margin:16px auto;padding:0 16px">
<h1>状态根维护 ${esc(s?.runId ?? "")}</h1>${msg ? `<p><b>${esc(msg)}</b></p>` : ""}
<p>阶段:${esc(phase)};结论:${esc(s?.outcome ?? "进行中")}</p>${s?.error ? `<p>原因:${esc(s.error)}</p>` : ""}
${s?.restore ? `<p>恢复写者:${s.restore.ok ? "完成" : esc(s.restore.problems.join(";"))}</p>` : ""}
${s?.note ? `<p>ledger 指针:${s.note.ok ? "已记" : `留存未完成(${esc(s.note.error ?? "")})`}</p>` : ""}
<ul>${rows}</ul>${RECOVERABLE.has(phase as RunState["phase"]) || (s?.note && !s.note.ok) ? form("/recover", "恢复") : ""}
${CANCELLABLE.has(phase as RunState["phase"]) ? form("/cancel", "取消") : ""}<p><a href="/">刷新</a></p></body>`;
}

/** 维护页的请求处理(与监听分开,单测直接调) */
export function pageHandler(d: PageDeps, port: () => number): { code: string; fetch: (req: Request) => Promise<Response> } {
  const code = randomBytes(24).toString("base64url");
  const codeExpires = d.now() + CODE_TTL_MS;
  let codeUsed = false;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const session = (req: Request) => {
    const sid = /(?:^|;\s*)smaint=([A-Za-z0-9_-]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    const s = sid ? sessions.get(sid) : undefined;
    return s && s.expires > d.now() ? s : null;
  };
  const page = (s: { csrf: string }, msg = "", status = 200) =>
    new Response(render(loadState(d.maintRoot, d.runId), s.csrf, msg), { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (![`127.0.0.1:${port()}`, `localhost:${port()}`].includes(req.headers.get("host") ?? "")) return new Response("forbidden", { status: 403 });
    if (req.method === "GET" && url.searchParams.has("code")) {
      if (codeUsed || d.now() > codeExpires || !eq(url.searchParams.get("code")!, code)) return new Response("访问码无效或已用过", { status: 403 });
      codeUsed = true;
      const sid = randomBytes(24).toString("base64url");
      sessions.set(sid, { csrf: randomBytes(16).toString("hex"), expires: d.now() + SESSION_TTL_MS });
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `smaint=${sid}; HttpOnly; SameSite=Strict; Path=/` } });
    }
    const s = session(req);
    if (!s) return new Response("需要维护页访问码", { status: 401 });
    if (req.method === "GET" && url.pathname === "/") return page(s);
    if (req.method !== "POST" || !["/recover", "/cancel"].includes(url.pathname)) return new Response("not found", { status: 404 });
    const form = await req.formData().catch(() => null); // 表单读不出来按 CSRF 不符处理
    if (!form || !eq(String(form.get("csrf") ?? ""), s.csrf)) return page(s, "表单校验不符,什么都没做", 403);
    const st = loadState(d.maintRoot, d.runId);
    if (url.pathname === "/cancel") {
      if (!st || !CANCELLABLE.has(st.phase)) return page(s, "已经开始动状态根,不能取消;等结果或用恢复", 409);
      writeFileSync(runPaths(d.maintRoot, d.runId).cancel, String(d.now()), { mode: FILE_MODE });
      return page(s, "已请求取消,执行器在下一步之前停下并恢复写者");
    }
    if (!st || !takenRequest(d.maintRoot, d.runId)) return page(s, "没有这次运行的已领取请求,无从恢复", 409);
    if (!RECOVERABLE.has(st.phase) && !(st.note && !st.note.ok)) return page(s, `阶段 ${st.phase} 不需要恢复`, 409);
    if (d.executorAlive()) return page(s, "执行器还在运行,等它结束", 409);
    d.spawnRecover();
    return page(s, "已起恢复执行器,按原请求与 journal 续");
  };
  return { code, fetch };
}

export function startPage(d: PageDeps): PageHandle {
  let port = 0;
  const h = pageHandler(d, () => port);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.fetch });
  port = server.port ?? 0;
  return { port, code: h.code, stop: () => server.stop(true) };
}

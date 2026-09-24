import { isNativeShell } from "./native";
import { postClientLog } from "./client-log";

/** 原生壳「记住登录」的客户端半边（服务端见 lib/services/resume-token.ts）。只在壳里生效：浏览器 / PWA 的 cookie 不丢，不需要 */
const KEY = "cstra.resumeToken";

function read(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return ""; // 读不到本地存储 = 没法记住登录，退回每次手动登录
  }
}

function write(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* 写不进本地存储：同上，只是记不住，不影响这次登录 */
  }
}

export function hasShellResumeToken(): boolean {
  return isNativeShell() && !!read();
}

/** 壳里已登录且手上没有凭证 → 领一枚（启动时调；登录后回到首页也会走到这里） */
export async function ensureShellResumeToken(): Promise<void> {
  if (!isNativeShell() || read()) return;
  const r = await fetch("/api/auth/resume-token", { method: "POST" });
  if (r.ok) write(((await r.json()) as { token?: string }).token ?? null);
}

/** 登录页挂载时调：壳里有凭证就拿它换会话。true = 已恢复登录，调用方直接进应用 */
export async function tryShellResume(): Promise<boolean> {
  const token = isNativeShell() ? read() : "";
  if (!token) return false;
  try {
    const r = await fetch("/api/auth/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string }; // 回包坏了当没拿到新凭证，下次重登
    write(r.ok ? (j.token ?? null) : null);
    postClientLog(`[shell] 记住登录: ${r.ok ? "已恢复" : `失败 ${r.status}`}`);
    return r.ok;
  } catch {
    return false; // 网络不通：凭证留着下次再试，这次先显示登录表单
  }
}

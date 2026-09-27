/**
 * Claude Code 能不能用：版本够不够（Channels 要 2.1.80+，README 同一个数）、有没有登录。
 * 没登录时 master 起不来，而向导照样会报「安装完成」，所以 setup（装完依赖后）和 doctor 都查这两项。
 * 判定是纯函数，tests/claude-account.test.ts。
 */
import type { Check } from "./doctor.js";
import { isNewerVersion } from "./update-hints.js";

export const MIN_CLAUDE_VERSION = "2.1.80";

/** `claude --version` 的输出 → x.y.z；认不出返回 null */
export function parseClaudeVersion(out: string): string | null {
  return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

/** 版本认不出时不算太旧：拿不准就不拦人 */
export function claudeTooOld(version: string | null): boolean {
  return !!version && isNewerVersion(MIN_CLAUDE_VERSION, version);
}

export interface ClaudeAuth {
  loggedIn: boolean;
  method: string | null;
}

/** `claude auth status --json` 的输出；解析不了（旧版没有这个子命令、输出不是 JSON）→ null = 不知道 */
export function parseAuthStatus(out: string): ClaudeAuth | null {
  try {
    const j = JSON.parse(out) as { loggedIn?: unknown; authMethod?: unknown };
    if (typeof j.loggedIn !== "boolean") return null;
    return { loggedIn: j.loggedIn, method: typeof j.authMethod === "string" ? j.authMethod : null };
  } catch {
    return null; // 不是 JSON：按「不知道」处理，调用方不拦人
  }
}

type Run = (cmd: string[]) => Promise<{ ok: boolean; out: string }>;

/** 跑两条只读命令拿版本与登录状态（claude 不在 PATH 时两项都是 null） */
export async function probeClaude(run: Run): Promise<{ version: string | null; auth: ClaudeAuth | null }> {
  const v = await run(["claude", "--version"]);
  if (!v.ok) return { version: null, auth: null };
  const a = await run(["claude", "auth", "status", "--json"]);
  // 没登录时 auth status 可能以非零退出但仍打印 JSON：只看输出
  return { version: parseClaudeVersion(v.out), auth: parseAuthStatus(a.out) };
}

/** doctor「运行时」组里的两行；claude 不在 PATH 由 checkRuntime 自己报，这里不重复 */
export function claudeAccountChecks(p: { version: string | null; auth: ClaudeAuth | null }, group: string): Check[] {
  if (!p.version) return [];
  const out: Check[] = [];
  if (claudeTooOld(p.version)) {
    out.push({ group, name: "claude 版本", status: "fail", detail: `${p.version} 低于 ${MIN_CLAUDE_VERSION}（Channels 需要）`,
      fix: "npm i -g @anthropic-ai/claude-code@latest，然后 bun src/manager.ts restart --include-master" });
  }
  if (p.auth && !p.auth.loggedIn) {
    out.push({ group, name: "claude 登录", status: "fail", detail: "Claude Code 没登录，大总管和所有 agent 都起不来",
      fix: "在终端跑 claude auth login（或直接 claude 按提示登录），然后 bun src/manager.ts restart --include-master" });
  } else if (p.auth) {
    out.push({ group, name: "claude 登录", status: "ok", detail: `已登录${p.auth.method ? `（${p.auth.method}）` : ""}` });
  }
  return out;
}

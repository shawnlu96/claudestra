/**
 * 按**登录 shell 的 PATH** 定位一个 CLI（与 tmux 里的 agent 同一口径）。
 *
 * 为什么不直接信当前进程的 PATH：manager / launcher 常跑在 launchd 的精简 PATH 下，
 * 裸名解析到的可能是另一份安装（claude-binary.ts 头注释里的四次升级事故），或者
 * npm 壳找不到 node。claude 与 codex 共用这一份。
 */
export interface LoginBinary {
  /** 登录 shell 里 `command -v <name>` 的结果（常是 symlink） */
  link: string;
  /** 解析 symlink 后的真实文件 */
  real: string;
}

export interface CmdResult {
  ok: boolean;
  out: string;
  err: string;
}
export type Runner = (cmd: string[], timeoutMs?: number) => Promise<CmdResult>;

/** name 会被拼进 `sh -lc` 的脚本里，只收安全字符，杜绝注入 */
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

/** 登录 shell 的命令行（导出给单测钉住：claude 的探测命令必须逐字不变） */
export function loginResolveCommand(name: string): string[] {
  if (!SAFE_NAME.test(name)) throw new Error(`非法的可执行名: ${name}`);
  return ["/bin/sh", "-lc", `p="$(command -v ${name})" && printf "%s\\n%s\\n" "$p" "$(realpath "$p")"`];
}

export async function resolveLoginBinary(run: Runner, name: string): Promise<LoginBinary | null> {
  const r = await run(loginResolveCommand(name), 15_000);
  if (!r.ok) return null;
  const [link, real] = r.out.trim().split("\n");
  if (!link || !real) return null;
  return { link, real };
}

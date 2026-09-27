/**
 * `claudestra` 启动器装在 ~/.local/bin（cli-install.ts writeCliWrapper），但 macOS 默认 zsh 的 PATH 不含它，Homebrew 装的 bun
 * 也不会往 rc 里加 ~/.bun/bin——新开终端敲 claudestra 就是 command not found。agent / daemon 找得到它只是因为继承了 launchd
 * plist 的 PATH，所以这事一直没暴露（2026-09-28 mac mini 实测）。判定一律用「空环境起用户的登录交互 shell」实测，不猜 PATH。
 * install-cli 写完启动器调 ensureCliOnPath（找不到就往登录 profile 追加一行带守卫的 PATH），doctor 调 checkCliOnPath。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { Check } from "./doctor.js";

/** 追加进登录 profile 的那一行：已在 PATH 里就什么都不做（重复 source 不会越拼越长） */
export const CLI_PATH_LINE = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
const CLI_PATH_COMMENT = "# Claudestra：claudestra 启动器装在 ~/.local/bin，系统默认 PATH 不含它";

/** 登录 shell 读哪个 profile：zsh → ~/.zprofile，bash → ~/.bash_profile；别的 shell 不替用户改，只给提示 */
export function loginProfileFor(shell: string, home: string): string | null {
  const name = basename(shell || "");
  if (name === "zsh") return `${home}/.zprofile`;
  if (name === "bash") return `${home}/.bash_profile`;
  return null;
}

type Runner = (cmd: string, args: string[], opts: { env: Record<string, string>; timeout: number; encoding: "utf8" }) => {
  status: number | null;
  stdout: string;
};

/** 空环境起登录交互 shell 问 `command -v <cmd>`：true 找得到、false 找不到、null 这个 shell 起不来（判不了） */
export function loginShellFinds(cmd: string, shell: string, home: string, run: Runner = spawnSync as unknown as Runner): boolean | null {
  const env = { HOME: home, USER: process.env.USER ?? "", TERM: "dumb", SHELL: shell };
  const r = run("/usr/bin/env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), shell, "-l", "-i", "-c", `command -v ${cmd}`], {
    env,
    timeout: 10_000,
    encoding: "utf8",
  });
  if (r.status === null) return null; // 超时 / 起不来
  return r.status === 0 && r.stdout.trim().length > 0;
}

export interface CliPathResult {
  status: "ok" | "added" | "hint";
  profile?: string;
  hint?: string;
}

const manualHint = (profile: string) => `把 ~/.local/bin 加进 PATH：echo '${CLI_PATH_LINE}' >> ${profile}，然后新开一个终端`;

/** 找不到就往登录 profile 追加带守卫的一行（先备份 <profile>.bak-claudestra，只备一次）；追加后再实测一次 */
export function ensureCliOnPath(opts: { shell?: string; home?: string; finds?: () => boolean | null } = {}): CliPathResult {
  const home = opts.home ?? homedir();
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  const finds = opts.finds ?? (() => loginShellFinds("claudestra", shell, home));
  if (finds() !== false) return { status: "ok" }; // null = 判不了：不动用户的文件
  const profile = loginProfileFor(shell, home);
  if (!profile) return { status: "hint", hint: `你的登录 shell 是 ${shell}：请自己把 $HOME/.local/bin 加进 PATH` };
  const text = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  if (text.includes(CLI_PATH_LINE)) return { status: "hint", profile, hint: `${profile} 里已有这一行但仍找不到 claudestra：检查后面是否有覆盖 PATH 的语句` };
  if (text && !existsSync(`${profile}.bak-claudestra`)) copyFileSync(profile, `${profile}.bak-claudestra`);
  appendFileSync(profile, `${text && !text.endsWith("\n") ? "\n" : ""}\n${CLI_PATH_COMMENT}\n${CLI_PATH_LINE}\n`);
  return finds() === false ? { status: "hint", profile, hint: manualHint(profile) } : { status: "added", profile };
}

/** install-cli 的 warnings：ok 不出声；补了 profile 说一句在哪、新开终端生效；补不了给手动办法。出错也只是提示，不挡安装 */
export function cliPathNotes(ensure: () => CliPathResult = () => ensureCliOnPath()): string[] {
  try {
    const r = ensure();
    if (r.status === "added") return [`已把 ~/.local/bin 加进 ${r.profile}（新开终端后 claudestra 可直接用）`];
    return r.status === "hint" && r.hint ? [`claudestra 命令：${r.hint}`] : [];
  } catch (e) {
    return [`claudestra 命令：检查 PATH 失败（${(e as Error).message}），新开终端找不到时把 ~/.local/bin 加进 PATH`];
  }
}

/** doctor：用户新开的终端里能不能直接敲 claudestra */
export function checkCliOnPath(home: string = homedir(), shell: string = process.env.SHELL ?? "/bin/zsh"): Check[] {
  const g = "运行环境";
  const found = loginShellFinds("claudestra", shell, home);
  if (found === true) return [{ group: g, name: "claudestra 命令", status: "ok", detail: "新开终端可直接使用" }];
  if (found === null) return [{ group: g, name: "claudestra 命令", status: "warn", detail: `${shell} 登录 shell 起不来，无法确认` }];
  const profile = loginProfileFor(shell, home);
  return [{
    group: g, name: "claudestra 命令", status: "warn", detail: "新开终端里找不到 claudestra（~/.local/bin 不在 PATH 里）",
    fix: profile ? `bun src/manager.ts install-cli 会自动补；或手动：${manualHint(profile)}` : "把 $HOME/.local/bin 加进你的登录 shell 的 PATH",
  }];
}

/**
 * 网页「新终端」（宿主 shell，bridge/web-shell.ts）的纯规则：tmux 命名、数量上限、起始目录白名单。
 * tests/web-shell-policy.test.ts。
 */
import { basename } from "node:path";
import type { ProjectDef } from "./projects.js";

/** 独立 session：不进 master——iTerm2 -CC 只挂 master，这里的窗口不会冒成桌面标签，也不和 agent 窗口名撞 */
export const SHELL_SESSION = "webshell";
/** 同时开着的 shell 上限（shell 持久，忘关的会一直占着；满了要先关一个） */
export const MAX_SHELLS = 8;

const ID_RE = /^[0-9a-f]{6}$/;
const NAME_PREFIX = "sh-";

export const isShellId = (id: string): boolean => ID_RE.test(id);
export const shellWindowName = (id: string): string => `${NAME_PREFIX}${id}`;

/** 窗口名 → shell id；不是我们起的名字（被改过名等）返回 null，不给寻址 */
export function parseShellWindow(name: string): string | null {
  const id = name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : "";
  return isShellId(id) ? id : null;
}

/** 两段都用 = 精确匹配：tmux 默认按前缀找 session / 窗口，不精确就可能落到别人的窗口上 */
export const shellTarget = (id: string): string => `=${SHELL_SESSION}:=${shellWindowName(id)}`;

/** 取一个没被占用的 id；rand 坏掉（总给非法值 / 撞车）时抛错而不是死循环 */
export function newShellId(taken: ReadonlySet<string>, rand: () => string): string {
  for (let i = 0; i < 20; i++) {
    const id = rand();
    if (isShellId(id) && !taken.has(id)) return id;
  }
  throw new Error("could not allocate a shell id");
}

export interface ShellDir {
  label: string;
  dir: string;
}

/** 可选起始目录：家目录 + projects.json 登记过的目录，都要过 usable（存在、沙箱闸）；同一目录只列一次，第一项是缺省 */
export function shellDirChoices(home: string, projects: ProjectDef[], usable: (d: string) => boolean): ShellDir[] {
  const out: ShellDir[] = usable(home) ? [{ label: "~", dir: home }] : [];
  for (const p of projects) {
    for (const dir of p.dirs) {
      if (out.some((c) => c.dir === dir) || !usable(dir)) continue;
      out.push({ label: p.dirs.length > 1 ? `${p.name} · ${basename(dir)}` : p.name, dir });
    }
  }
  return out;
}

/** 请求里的目录 → 白名单里逐字相同的那一项；没给 = 第一项（家目录）；其它一律 null（拒绝，不做任何路径归一） */
export function resolveShellDir(requested: unknown, choices: ShellDir[]): string | null {
  if (requested === undefined || requested === null || requested === "") return choices[0]?.dir ?? null;
  return typeof requested === "string" && choices.some((c) => c.dir === requested) ? requested : null;
}

/**
 * 「本机能用什么程序打开一个目录」的纯逻辑（无 import，tests/ 直测）：候选表 + 探测 + 拼命令。
 * 探测只做文件存在 / PATH 查找，两个谓词由调用方注入（lib/host/host-info.ts 用真文件系统，测试用假的）。
 * 加新软件只改 TABLE。客户端只拿到 id / label / kind，打开时也只回传 id——命令永远在这里拼。
 */
export type OpenerKind = "files" | "terminal" | "ide";
export type Platform = "darwin" | "linux" | "win32";

export interface Opener {
  id: string;
  label: string;
  kind: OpenerKind;
}

interface Candidate extends Opener {
  /** macOS：/Applications、~/Applications、/System/Applications(/Utilities) 下的 .app 名 */
  app?: string;
  /** Linux / Windows：PATH 里的命令名 */
  cmd?: string;
  /** 命令行参数模板，`{dir}` 占位；缺省 = 直接把目录当参数 */
  args?: string[];
  platforms: Platform[];
}

const TABLE: Candidate[] = [
  { id: "finder", label: "Finder", kind: "files", platforms: ["darwin"] },
  { id: "xdg", label: "文件管理器", kind: "files", cmd: "xdg-open", platforms: ["linux"] },
  { id: "explorer", label: "资源管理器", kind: "files", cmd: "explorer", platforms: ["win32"] },
  // ── 终端 ──
  { id: "terminal", label: "Terminal", kind: "terminal", app: "Terminal.app", platforms: ["darwin"] },
  { id: "iterm", label: "iTerm2", kind: "terminal", app: "iTerm.app", platforms: ["darwin"] },
  { id: "warp", label: "Warp", kind: "terminal", app: "Warp.app", platforms: ["darwin"] },
  { id: "ghostty", label: "Ghostty", kind: "terminal", app: "Ghostty.app", cmd: "ghostty", args: ["--working-directory={dir}"], platforms: ["darwin", "linux"] },
  { id: "kitty", label: "kitty", kind: "terminal", app: "kitty.app", cmd: "kitty", args: ["--directory", "{dir}"], platforms: ["darwin", "linux"] },
  { id: "alacritty", label: "Alacritty", kind: "terminal", app: "Alacritty.app", cmd: "alacritty", args: ["--working-directory", "{dir}"], platforms: ["darwin", "linux"] },
  { id: "wezterm", label: "WezTerm", kind: "terminal", app: "WezTerm.app", cmd: "wezterm", args: ["start", "--cwd", "{dir}"], platforms: ["darwin", "linux"] },
  { id: "gnome-terminal", label: "GNOME Terminal", kind: "terminal", cmd: "gnome-terminal", args: ["--working-directory={dir}"], platforms: ["linux"] },
  { id: "konsole", label: "Konsole", kind: "terminal", cmd: "konsole", args: ["--workdir", "{dir}"], platforms: ["linux"] },
  { id: "wt", label: "Windows Terminal", kind: "terminal", cmd: "wt", args: ["-d", "{dir}"], platforms: ["win32"] },
  // ── IDE / 编辑器 ──
  { id: "vscode", label: "VS Code", kind: "ide", app: "Visual Studio Code.app", cmd: "code", platforms: ["darwin", "linux", "win32"] },
  { id: "cursor", label: "Cursor", kind: "ide", app: "Cursor.app", cmd: "cursor", platforms: ["darwin", "linux", "win32"] },
  { id: "windsurf", label: "Windsurf", kind: "ide", app: "Windsurf.app", cmd: "windsurf", platforms: ["darwin", "linux", "win32"] },
  { id: "zed", label: "Zed", kind: "ide", app: "Zed.app", cmd: "zed", platforms: ["darwin", "linux"] },
  { id: "sublime", label: "Sublime Text", kind: "ide", app: "Sublime Text.app", cmd: "subl", platforms: ["darwin", "linux", "win32"] },
  { id: "webstorm", label: "WebStorm", kind: "ide", app: "WebStorm.app", cmd: "webstorm", platforms: ["darwin", "linux", "win32"] },
  { id: "idea", label: "IntelliJ IDEA", kind: "ide", app: "IntelliJ IDEA.app", cmd: "idea", platforms: ["darwin", "linux", "win32"] },
  { id: "xcode", label: "Xcode", kind: "ide", app: "Xcode.app", platforms: ["darwin"] },
  { id: "nova", label: "Nova", kind: "ide", app: "Nova.app", platforms: ["darwin"] },
];

export const MAC_APP_DIRS = ["/Applications", "~/Applications", "/System/Applications", "/System/Applications/Utilities"];

export interface Probe {
  /** 路径存在（`~` 已由调用方展开） */
  exists: (path: string) => boolean;
  /** PATH 里找得到命令 */
  which: (cmd: string) => boolean;
}

function macAppPath(app: string, probe: Probe): string | null {
  for (const d of MAC_APP_DIRS) {
    const p = `${d}/${app}`;
    if (probe.exists(p)) return p;
  }
  return null;
}

function available(c: Candidate, platform: Platform, probe: Probe): boolean {
  if (!c.platforms.includes(platform)) return false;
  if (c.id === "finder" || c.id === "explorer") return true; // 系统自带
  if (platform === "darwin" && c.app) return macAppPath(c.app, probe) !== null;
  return c.cmd ? probe.which(c.cmd) : false;
}

/** 按 TABLE 顺序返回本机可用的打开方式（每种 kind 内顺序即菜单顺序）。 */
export function detectOpeners(platform: Platform, probe: Probe): Opener[] {
  return TABLE.filter((c) => available(c, platform, probe)).map(({ id, label, kind }) => ({ id, label, kind }));
}

/** 打开 dir 的 argv；id 不在表里或不适用于该平台 → null（客户端传来的 id 只在这里被认） */
export function openArgv(id: string, dir: string, platform: Platform, probe: Probe): string[] | null {
  const c = TABLE.find((x) => x.id === id);
  if (!c || !available(c, platform, probe)) return null;
  const args = (c.args ?? ["{dir}"]).map((a) => a.replace("{dir}", dir));
  if (platform === "darwin") {
    if (c.kind === "files") return ["open", dir];
    // 用 .app 打开：不依赖命令行工具是否装进 PATH。带自定义参数的终端（kitty 等）走 --args
    if (c.app && (!c.args || c.args.length === 1)) return ["open", "-a", c.app.replace(/\.app$/, ""), dir];
    if (c.app) return ["open", "-a", c.app.replace(/\.app$/, ""), "--args", ...args];
  }
  if (platform === "win32" && c.id === "explorer") return ["explorer", dir];
  return c.cmd ? [c.cmd, ...args] : null;
}

/**
 * 「本机能用什么程序打开一个目录」的纯逻辑（bridge/local-api/host.ts 用，tests/local-api-host.test.ts 直测）：
 * 候选表 + 探测 + 拼 argv。探测只做「文件存在 / PATH 里找得到」两个谓词，由调用方注入（lib/host-open.ts 用真文件系统）。
 * 客户端只拿到 id / label / kind，打开时也只回传 id——命令永远在这里拼，路径与命令都不接受外部输入。加新软件只改 TABLE。
 */
type OpenerKind = "files" | "terminal" | "ide";
export type Platform = "darwin" | "linux" | "win32";
export interface Opener { id: string; label: string; kind: OpenerKind }
/** app = macOS 的 .app 名（MAC_APP_DIRS 下找）；cmd = Linux / Windows 的 PATH 命令名；args 模板里 `{dir}` 占位，缺省 = 直接把目录当参数 */
interface Candidate extends Opener { platforms: Platform[]; app?: string; cmd?: string; args?: string[] }

const ALL: Platform[] = ["darwin", "linux", "win32"];
const MAC: Platform[] = ["darwin"];
const NIX: Platform[] = ["darwin", "linux"];
const LINUX: Platform[] = ["linux"];
const WIN: Platform[] = ["win32"];
type Extra = Pick<Candidate, "app" | "cmd" | "args">;
const row = (id: string, label: string, kind: OpenerKind, platforms: Platform[], extra: Extra = {}): Candidate => ({ id, label, kind, platforms, ...extra });

const TABLE: Candidate[] = [
  row("finder", "Finder", "files", MAC),
  row("xdg", "文件管理器", "files", LINUX, { cmd: "xdg-open" }),
  row("explorer", "资源管理器", "files", WIN, { cmd: "explorer" }),
  row("terminal", "Terminal", "terminal", MAC, { app: "Terminal.app" }),
  row("iterm", "iTerm2", "terminal", MAC, { app: "iTerm.app" }),
  row("warp", "Warp", "terminal", MAC, { app: "Warp.app" }),
  row("ghostty", "Ghostty", "terminal", NIX, { app: "Ghostty.app", cmd: "ghostty", args: ["--working-directory={dir}"] }),
  row("kitty", "kitty", "terminal", NIX, { app: "kitty.app", cmd: "kitty", args: ["--directory", "{dir}"] }),
  row("alacritty", "Alacritty", "terminal", NIX, { app: "Alacritty.app", cmd: "alacritty", args: ["--working-directory", "{dir}"] }),
  row("wezterm", "WezTerm", "terminal", NIX, { app: "WezTerm.app", cmd: "wezterm", args: ["start", "--cwd", "{dir}"] }),
  row("gnome-terminal", "GNOME Terminal", "terminal", LINUX, { cmd: "gnome-terminal", args: ["--working-directory={dir}"] }),
  row("konsole", "Konsole", "terminal", LINUX, { cmd: "konsole", args: ["--workdir", "{dir}"] }),
  row("wt", "Windows Terminal", "terminal", WIN, { cmd: "wt", args: ["-d", "{dir}"] }),
  row("vscode", "VS Code", "ide", ALL, { app: "Visual Studio Code.app", cmd: "code" }),
  row("cursor", "Cursor", "ide", ALL, { app: "Cursor.app", cmd: "cursor" }),
  row("windsurf", "Windsurf", "ide", ALL, { app: "Windsurf.app", cmd: "windsurf" }),
  row("zed", "Zed", "ide", NIX, { app: "Zed.app", cmd: "zed" }),
  row("sublime", "Sublime Text", "ide", ALL, { app: "Sublime Text.app", cmd: "subl" }),
  row("webstorm", "WebStorm", "ide", ALL, { app: "WebStorm.app", cmd: "webstorm" }),
  row("idea", "IntelliJ IDEA", "ide", ALL, { app: "IntelliJ IDEA.app", cmd: "idea" }),
  row("xcode", "Xcode", "ide", MAC, { app: "Xcode.app" }),
  row("nova", "Nova", "ide", MAC, { app: "Nova.app" }),
];

const MAC_APP_DIRS = ["/Applications", "~/Applications", "/System/Applications", "/System/Applications/Utilities"];

export interface Probe {
  /** 路径存在（`~` 由调用方展开） */
  exists: (path: string) => boolean;
  /** PATH 里找得到命令 */
  which: (cmd: string) => boolean;
}

/** 系统自带的文件管理器不用探测 */
const BUILT_IN = new Set(["finder", "explorer"]);
const macAppInstalled = (app: string, probe: Probe): boolean => MAC_APP_DIRS.some((d) => probe.exists(`${d}/${app}`));

function usable(c: Candidate, platform: Platform, probe: Probe): boolean {
  if (!c.platforms.includes(platform)) return false;
  if (BUILT_IN.has(c.id)) return true;
  return platform === "darwin" && c.app ? macAppInstalled(c.app, probe) : !!c.cmd && probe.which(c.cmd);
}

/** 按 TABLE 顺序返回本机可用的打开方式（每种 kind 内的顺序即菜单顺序） */
export function detectOpeners(platform: Platform, probe: Probe): Opener[] {
  return TABLE.filter((c) => usable(c, platform, probe)).map(({ id, label, kind }) => ({ id, label, kind }));
}

/** 打开 dir 的 argv；id 不在表里或不适用于该平台 → null（客户端传来的 id 只在这里被认） */
export function openArgv(id: string, dir: string, platform: Platform, probe: Probe): string[] | null {
  const c = TABLE.find((x) => x.id === id);
  if (!c || !usable(c, platform, probe)) return null;
  const args = (c.args ?? ["{dir}"]).map((a) => a.replace("{dir}", dir));
  if (platform === "darwin" && c.kind === "files") return ["open", dir];
  if (platform === "darwin" && c.app) {
    // 用 .app 打开，不依赖命令行工具是否装进 PATH；带多段自定义参数的终端（kitty 等）走 --args
    const app = c.app.replace(/\.app$/, "");
    return c.args && c.args.length > 1 ? ["open", "-a", app, "--args", ...args] : ["open", "-a", app, dir];
  }
  if (platform === "win32" && c.id === "explorer") return ["explorer", dir];
  return c.cmd ? [c.cmd, ...args] : null;
}

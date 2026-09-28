/**
 * Autopilot 判「这一轮有没有实质进展」用的工具分类（tests/autopilot-tools.test.ts）。只影响推进节奏（会不会进待命），不是权限闸。
 * 只读的不算进展：等 CI / 等 peer / 等人时 agent 每轮 Read 一下台账、跑一句 git status，都不该让它每 45 秒被推一次。
 * shell 先分词（lib/shell-words.ts）再按段判：每一段都是认得的只读命令、没有写文件的重定向、没有命令 / 进程替换，才算只读。
 * 名字按 Claude Code 的形状；Codex（exec_command / shell / apply_patch）、Pi（bash / edit / write）的裸名一并认。
 */
import { parseShell, type Segment } from "./shell-words.js";

/** 不改东西的工具 */
const READ_ONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "ToolSearch", "TodoWrite", "TaskList", "TaskGet", "TaskOutput", "NotebookRead",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "read", "grep", "find", "ls",
]);
/** Claudestra 的通信 / 查询工具：MCP 名（mcp__<server>__x，server 名里可以有下划线）或 Pi 裸名。不算「调了工具」 */
const COMMS = "reply|react|edit_message|fetch_messages|download_attachment|check_inbox|project_info|list_shared_channels|send_to_agent|forward_to_agent";
const COMMS_TOOLS = new RegExp(`^(?:mcp__.+__)?(?:${COMMS})$`);
const READ_ONLY_MCP = /^mcp__.+__(ask_codex|memory_search|memory_list|memory_read)$/;
const SHELL_TOOLS = new Set(["Bash", "bash", "exec_command", "shell"]);
/** 只读的子 agent 类型：探索 / 规划不改东西；其余子 agent 当作在干活 */
const READ_ONLY_AGENTS = /"subagent_type"\s*:\s*"(Explore|Plan|claude-code-guide)"/;

/** 通信工具不算「调了工具」：没事可做时 agent 也会 reply 一句「没有要推进的」 */
export function countsAsTool(name: string): boolean {
  return !COMMS_TOOLS.test(name);
}

// ── shell ──

const ALWAYS_READ = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "pwd", "echo", "printf", "which", "type", "stat", "du", "df", "ps", "jq",
  "cut", "tr", "file", "basename", "dirname", "uptime", "whoami", "id", "hostname", "uname", "true", "false", "test", "[", "[[", "readlink",
  "realpath", "less", "more", "nl", "od", "xxd", "hexdump", "diff", "cmp", "tree", "printenv", "column", "comm", "seq", "sleep", "wait",
  "pgrep", "lsof", "cd", "pushd", "popd", "colordiff", "shasum", "md5", "md5sum", "sha256sum",
]);
/** 允许出现在命令前面的环境变量（能执行命令的 GIT_EXTERNAL_DIFF / PAGER=任意程序 之类不在内） */
const SAFE_ENV = /^(LANG|LC_\w+|TZ|NO_COLOR|TERM|COLUMNS|FORCE_COLOR|CI)=|^(GIT_PAGER|PAGER|GH_PAGER)=(cat|)$/;

const hasAny = (args: string[], flags: RegExp) => args.some((a) => flags.test(a));
/** 短选项簇里有没有某些字母（-sSo 里的 o）；长选项另判 */
const shortHas = (args: string[], letters: string) => args.some((a) => /^-[^-]/.test(a) && [...a.slice(1)].some((ch) => letters.includes(ch)));

const GIT_READ = new Set([
  "status", "log", "show", "diff", "blame", "shortlog", "rev-parse", "rev-list", "merge-base", "ls-files", "ls-tree", "describe", "cat-file",
  "grep", "count-objects", "show-ref", "for-each-ref", "whatchanged", "cherry", "range-diff", "name-rev", "check-ignore",
]);
const BRANCH_WRITE = /^(-[dDmMcCfsua]$|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|annotate|sign|message|file)\b)/;

/** git：-C <dir> / --no-pager 可以；-c 能注入会执行命令的配置，算写。子命令按参数判 */
function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (args[i]?.startsWith("-")) {
    const a = args[i];
    if (a === "-C" || a === "--git-dir" || a === "--work-tree") i += 2;
    else if (a === "--no-pager" || a === "-P" || /^--(git-dir|work-tree)=/.test(a)) i++;
    else return false;
  }
  const [sub, ...rest] = args.slice(i);
  const flags = rest.filter((a) => a.startsWith("-"));
  const positional = rest.filter((a) => !a.startsWith("-"));
  if (hasAny(rest, /^--output(=|$)|^--ext-diff$/)) return false;
  if (GIT_READ.has(sub)) return true;
  switch (sub) {
    case "fetch": return !positional.some((p) => p.includes(":")); // 带 refspec 的 fetch 会改本地分支
    case "remote": return positional.length === 0 || ["show", "get-url"].includes(positional[0]);
    case "worktree": return positional[0] === "list";
    case "stash": return positional[0] === "list" || positional[0] === "show";
    case "reflog": return !positional.length || positional[0] === "show";
    case "config": return hasAny(flags, /^(--get|--get-all|--get-regexp|--list|-l)$/);
    case "branch": case "tag":
      if (hasAny(flags, BRANCH_WRITE)) return false;
      return !positional.length || hasAny(flags, /^(-l|--list|--contains|--merged|--no-merged|--points-at|--show-current)/);
    default: return false;
  }
}

const GH_VIEWS: Record<string, string[]> = {
  pr: ["view", "list", "checks", "status", "diff"], run: ["view", "list", "watch"], issue: ["view", "list", "status"],
  release: ["view", "list"], repo: ["view"], workflow: ["view", "list"],
};

/** gh：只认看的子命令；gh api 只认 GET（-X / --method，连写的 -XPOST 也算）且不带字段（带 -f / -F 时 gh 默认 POST） */
function ghReadOnly(args: string[]): boolean {
  const [a, b] = args;
  if (a === "api") {
    for (let i = 1; i < args.length; i++) {
      if (/^(-f|-F|--field|--raw-field|--input)/.test(args[i])) return false;
      const m = /^(?:-X|--method)(?:=?(.+))?$/.exec(args[i]);
      if (m && (m[1] ?? args[i + 1] ?? "").toUpperCase() !== "GET") return false;
    }
    return true;
  }
  if (a === "search" || (a === "auth" && b === "status")) return true;
  return !!GH_VIEWS[a]?.includes(b);
}

/** curl：只认 GET 且不写文件、不带请求体 / 配置文件 */
function curlReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--(output|remote-name|remote-name-all|data|data-\w+|json|form|form-string|upload-file|config)(=|$)/.test(a)) return false;
    const req = /^--request(?:=(.+))?$/.exec(a) ?? /^-[^-]*X(.*)$/.exec(a); // --request / -X / -sX / -XPOST
    if (req && (req[1] || args[i + 1] || "").toUpperCase() !== "GET") return false;
  }
  return !shortHas(args, "oOdFTK");
}

function sedReadOnly(args: string[]): boolean {
  if (hasAny(args, /^--in-place/) || shortHas(args.filter((a) => /^-[a-zA-Z]+/.test(a)), "i")) return false;
  return !args.some((a) => /(^|[;}\s])[wWe]\s|\/[gpiI0-9]*w\s/.test(a)); // sed 的 w 命令写文件，e 命令执行
}

/** 单个命令（已去掉前缀）只读吗 */
function commandReadOnly(cmd: string, args: string[]): boolean {
  if (ALWAYS_READ.has(cmd)) return true;
  switch (cmd) {
    case "git": return gitReadOnly(args);
    case "gh": return ghReadOnly(args);
    case "curl": return curlReadOnly(args);
    case "sed": return sedReadOnly(args);
    case "date": return !hasAny(args, /^(-s|--set)/);
    case "env": return args.length === 0;
    case "rg": return !hasAny(args, /^--pre/);
    case "sort": return !hasAny(args, /^--output/) && !shortHas(args, "o");
    case "uniq": return args.filter((a) => !a.startsWith("-")).length <= 1; // 第二个位置参数是输出文件
    case "find": return !hasAny(args, /^-\w*(delete|exec|ok|fprint|fls)/); // 认不全的 -xxx 变体也按写
    case "awk": return !args.some((a) => /system\s*\(|[>|]/.test(a)); // print > file、print | cmd
    case "tmux": return /^(capture-pane|list-\w+|display-message|display|has-session)$/.test(args[0] ?? "") && !args.includes("-b");
    case "bun": case "npm": return args[0] === "test" || (args[0] === "run" && /^(check|typecheck|test|guard|lint)$/.test(args[1] ?? ""));
    default: return false;
  }
}

/** 去掉前缀：安全的 VAR=值、timeout N、time、nice；返回真正的命令词。出现不安全的环境变量 → null（按写算） */
function stripPrefix(words: string[]): string[] | null {
  let w = words;
  for (;;) {
    if (!w.length) return w;
    if (/^[A-Za-z_]\w*=/.test(w[0])) {
      if (!SAFE_ENV.test(w[0])) return null;
      w = w.slice(1);
    } else if (w[0] === "timeout") {
      let i = 1;
      while (w[i]?.startsWith("-")) i += /^-[ks]$/.test(w[i]) ? 2 : 1;
      w = w.slice(i + 1); // 跳过时长
    } else if (w[0] === "time" || w[0] === "nice") w = w.slice(1);
    else return w;
  }
}

const SAFE_TARGET = /^(\/dev\/null|\/dev\/stdout|\/dev\/stderr|&\d|&-)$/;

function segmentReadOnly(s: Segment): boolean {
  if (s.redirects.some((r) => r.op !== "<" && !SAFE_TARGET.test(r.target))) return false;
  const w = stripPrefix(s.words);
  if (!w) return false;
  if (!w.length) return true; // 只有安全的环境变量 / 只读重定向
  return commandReadOnly(w[0], w.slice(1));
}

export function isReadOnlyBash(command: string): boolean {
  const p = parseShell(command);
  if (p.broken || p.substitution || !p.segments.length) return false;
  return p.segments.every(segmentReadOnly);
}

/**
 * tool_start 事件的 detail 里取命令：Bash 是「描述\n───\n命令」（jsonl-watcher formatToolDetail）；
 * Codex / Pi 的 shell 工具是参数 JSON（cmd / command，数组就用空格拼）。
 */
export function bashCommandOf(detail: unknown): string {
  const s = typeof detail === "string" ? detail : "";
  if (s.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(s) as { cmd?: unknown; command?: unknown };
      const c = j.cmd ?? j.command;
      if (Array.isArray(c)) return c.map(String).join(" ");
      if (typeof c === "string") return c;
    } catch {
      // 不是完整 JSON（detail 被截断）：当普通文本往下走，认不出就按写算
    }
  }
  const i = s.lastIndexOf("\n───\n");
  return i >= 0 ? s.slice(i + 5) : s;
}

/** 可能改了东西的工具调用：只读工具、通信工具、只读 MCP 查询、只读 shell、探索类子 agent 以外都算 */
export function isMutatingTool(name: string, detail?: unknown): boolean {
  if (!countsAsTool(name) || READ_ONLY_TOOLS.has(name) || READ_ONLY_MCP.test(name)) return false;
  if (SHELL_TOOLS.has(name)) return !isReadOnlyBash(bashCommandOf(detail));
  if (name === "Agent" || name === "Task") return !READ_ONLY_AGENTS.test(typeof detail === "string" ? detail : "");
  return true;
}

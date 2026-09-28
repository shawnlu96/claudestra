/**
 * 被打断的工具调用可能留下什么半截副作用：按工具名 + Bash 命令前缀分四类（规则表逐条单测 tests/side-effects.test.ts）。
 * 只用来给 agent 写「打断收尾」提醒，不替它做决定、不自动重放。宁严勿宽：认不出的 Bash 一律 check_first，
 * 对外 / 不可逆的名单宁可列宽——把不可逆的判成「可以重跑」，代价是重复下单、重复发版。
 */

export type SideEffect = "none" | "idempotent" | "check_first" | "external";

export interface SideEffectVerdict {
  kind: SideEffect;
  /** 给 agent 的核对建议（例如「先 gh pr view 看是否已合并」） */
  hint?: string;
}

const RANK: Record<SideEffect, number> = { none: 0, idempotent: 1, check_first: 2, external: 3 };

/** 取更重的一类（多个工具 / 多段命令合并用） */
export function heavier(a: SideEffectVerdict, b: SideEffectVerdict): SideEffectVerdict {
  return RANK[b.kind] > RANK[a.kind] ? b : a;
}

/** 给人看的类别说明（抬头 / 收尾提醒里跟在工具后面） */
export function sideEffectLabel(kind: SideEffect): string {
  switch (kind) {
    case "none": return "只读，没有副作用";
    case "idempotent": return "可以直接重跑";
    case "check_first": return "先核对现状再重来";
    case "external": return "对外 / 不可逆，先核对再决定";
  }
}

const v = (kind: SideEffect, hint?: string): SideEffectVerdict => (hint ? { kind, hint } : { kind });

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "ToolSearch", "TaskList", "TaskGet", "TaskOutput", "NotebookRead"]);
const LOCAL_BOOKKEEPING = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);
const FILE_WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** MCP 工具名（最后一段按 _ 切词）：有写动词就不是只读；没有写动词、有读动词才算只读 */
const MCP_WRITE_WORD = /^(write|create|update|delete|remove|send|post|put|set|add|click|type|fill|upload|drop|drag|edit|run|exec|merge|publish|press|select|navigate|close|batch)$/i;
const MCP_READ_WORD = /^(read|get|list|search|query|fetch|find|check|view|describe|snapshot|screenshot|status|info|messages)$/i;
function mcpReadOnly(short: string): boolean {
  const words = short.split(/[_-]/);
  return !words.some((w) => MCP_WRITE_WORD.test(w)) && words.some((w) => MCP_READ_WORD.test(w));
}

/**
 * 分类一次工具调用。command：Bash 的命令原文（jsonl-watcher 的 detail 里「描述 ─── 命令」取后半，见 bashCommandOf）；
 * input：非 Bash 工具的关键入参（目前只看 send_to_agent 的 target）。extraExternal：项目登记的对外关键字（如交易脚本名）。
 */
export function classifyTool(name: string, opts: { command?: string; target?: string; extraExternal?: readonly string[] } = {}): SideEffectVerdict {
  if (name === "Bash") return classifyBash(opts.command ?? "", opts.extraExternal);
  if (READ_TOOLS.has(name)) return v("none");
  if (LOCAL_BOOKKEEPING.has(name)) return v("idempotent");
  if (FILE_WRITES.has(name)) return v("check_first", "先看文件现状，改了一半就补完，已改好就跳过");
  if (name === "Agent" || name === "Task") return v("check_first", "子 agent 可能已经做了一部分，先看它留下的改动");
  const short = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (short === "send_to_agent") {
    return /@|^peer:/.test(opts.target ?? "") ? v("external", "发给另一个实例的请求可能已经送达，先问对方收没收到") : v("check_first", "先看消息发出去没有，别重复发");
  }
  if (short === "reply") return v("check_first", "先看回复发出去没有，别重复发");
  if (mcpReadOnly(short)) return v("none");
  return v("check_first");
}

/** jsonl-watcher 的 Bash detail 是「描述\n───\n命令」（没有描述就只有命令），取命令 */
export function bashCommandOf(detail: string): string {
  const i = detail.lastIndexOf("\n───\n");
  return i >= 0 ? detail.slice(i + 5) : detail;
}

/** 按 && || ; | 换行切成几段，逐段分类取最重的一段 */
export function classifyBash(command: string, extraExternal: readonly string[] = []): SideEffectVerdict {
  const cmd = command.trim();
  if (!cmd) return v("check_first");
  for (const kw of extraExternal) {
    if (kw && cmd.includes(kw)) return v("external", `项目登记的对外操作（${kw}）：先查状态，不要直接重跑`);
  }
  let out: SideEffectVerdict = v("none");
  for (const seg of cmd.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    if (seg.trim()) out = heavier(out, classifySegment(seg));
  }
  return out;
}

/** 去掉前导的 VAR=x、sudo / time / nohup / env / timeout N 这类外壳，返回真正的命令词 */
function tokensOf(seg: string): string[] {
  const toks = seg.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ""));
  while (toks.length) {
    const t = toks[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || ["sudo", "time", "nohup", "env", "command", "exec"].includes(t)) toks.shift();
    else if (t === "timeout" || t === "gtimeout") toks.splice(0, 2);
    else break;
  }
  return toks;
}

const READ_CMDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "echo", "printf", "pwd", "which", "whoami", "jq", "sort", "uniq", "tree", "file", "stat",
  "du", "df", "ps", "pgrep", "lsof", "date", "printenv", "type", "test", "true", "false", "sleep", "cd", "diff", "cut", "tr", "basename",
  "dirname", "realpath", "readlink", "less", "more", "column", "hostname", "uname", "id", "tsc", "shasum", "md5", "sha256sum", "[", "fd",
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "blame", "ls-files", "ls-remote", "grep", "describe", "shortlog", "reflog", "config", "remote", "merge-base", "cat-file"]);
const MANAGER_READ = /^(list|sessions|doctor|version|cost|status|help|--help|.*-list|.*-test)$/;

function classifySegment(seg: string): SideEffectVerdict {
  const t = tokensOf(seg);
  const [c0 = "", c1 = "", c2 = ""] = t;
  const has = (re: RegExp) => t.slice(1).some((x) => re.test(x));
  if (!c0) return v("none");
  const base = classifyCommand(t, has);
  // 重定向写文件（> / >>，不含 2>&1、>/dev/null）：至少先看文件现状
  return /(^|[^0-9&>])>>?\s*(?!&|\/dev\/null)\S/.test(seg) ? heavier(base, v("check_first", "命令会写文件，先看文件现状")) : base;
}

function classifyCommand(t: string[], has: (re: RegExp) => boolean): SideEffectVerdict {
  const [c0 = "", c1 = "", c2 = ""] = t;
  if (c0 === "git") return classifyGit(t);
  if (c0 === "gh") return classifyGh(t);
  if (c0 === "curl" || c0 === "wget" || c0 === "http") {
    const mutating = has(/^-X(POST|PUT|DELETE|PATCH)?$|^--request$|^(-d|--data.*|-F|--form|--upload-file|-T)$/) && !has(/^-XGET$/);
    return mutating ? v("external", "请求可能已经发出，先查对方状态，别重复提交") : v("none");
  }
  if (["npm", "bun", "yarn", "pnpm", "cargo", "docker"].includes(c0) && ["publish", "push"].includes(c1)) {
    return v("external", "可能已经发布了，先查线上版本");
  }
  if (c0 === "ssh" || c0 === "scp" || c0 === "rsync") return v("check_first", "远端可能已经改了一部分，先上去看现状");
  if ((c0 === "bun" || c0 === "node") && /manager\.ts$/.test(c1)) return classifyManager(c2, t.slice(3));
  if (c0 === "claudestra") return classifyManager(c1, t.slice(2));
  if (c0 === "launchctl") {
    if (["list", "print", "blame"].includes(c1)) return v("none");
    if (c1 === "kickstart") return v("idempotent", "先看服务的 pid / 启动时间，确认没重启过再重跑");
    return v("check_first", "先 launchctl list 看服务现在是否已加载");
  }
  if (c0 === "tmux") return /^(capture-pane|list-|display|has-session|show)/.test(c1) ? v("none") : v("check_first");
  if (["bun", "npm", "yarn", "pnpm", "npx", "bunx"].includes(c0)) return classifyPkg(c0, c1, c2, t);
  if (c0 === "find") return has(/^-(delete|exec|execdir|ok)$/) ? v("check_first") : v("none");
  if (c0 === "sed") return has(/^-i/) ? v("check_first", "先看文件现状") : v("none");
  if (c0 === "mkdir" && has(/^-p$/)) return v("idempotent");
  if (READ_CMDS.has(c0)) return v("none");
  return v("check_first", "先核对这条命令做到了哪一步");
}

function classifyGit(all: string[]): SideEffectVerdict {
  // git -C <dir> / -c k=v 这类全局参数不影响分类
  const t = [...all];
  while (t.length > 1 && /^-[Cc]$/.test(t[1])) t.splice(1, 2);
  const sub = t[1] ?? "";
  const rest = t.slice(2);
  if (GIT_READ.has(sub)) return sub === "config" && rest.length > 1 && !rest.includes("--get") ? v("check_first") : v("none");
  if (sub === "branch" || sub === "stash" && rest[0] === "list" || sub === "worktree" && rest[0] === "list") {
    return rest.every((x) => /^-(a|v|vv|r|l|-list|-show-current|-all)$/.test(x) || x === "list") ? v("none") : v("check_first");
  }
  if (sub === "tag") {
    return rest.length === 0 || rest.some((x) => /^(-l|--list|-n\d*|--contains|--points-at)$/.test(x))
      ? v("none")
      : v("external", "tag 可能已经推上去了，先 git ls-remote --tags 核对，要不要重打由 owner 定");
  }
  if (sub === "push") {
    if (rest.some((x) => /^(-f|--force|--force-with-lease.*|--delete|-d|--mirror|--prune)$/.test(x) || /^:/.test(x) || /^\+/.test(x))) {
      return v("external", "强推 / 删远端分支可能已经生效，先 git ls-remote 核对远端，不要直接重跑");
    }
    if (rest.includes("--tags") || rest.some((x) => /^refs\/tags\/|^v\d/.test(x))) return v("external", "tag 可能已经推上去了，先 git ls-remote --tags 核对");
    return v("idempotent", "非强推可以重跑；先 git status 看是否已经推上去");
  }
  if (sub === "fetch" || sub === "pull") return v("idempotent");
  if (sub === "add") return v("idempotent");
  if (sub === "commit") return v("check_first", "先 git log -1 看是否已经提交，别重复提交");
  return v("check_first", `先 git status 看 ${sub || "git"} 做到了哪一步`);
}

function classifyGh(t: string[]): SideEffectVerdict {
  const [, noun = "", verb = ""] = t;
  if (/^(view|list|diff|checks|status|watch)$/.test(verb) || noun === "search" || noun === "auth" && verb === "status") return v("none");
  if (noun === "api") {
    const writes = t.some((x) => /^(-X|--method|-X(POST|PUT|DELETE|PATCH)|-f|-F|--field|--raw-field|--input)$/.test(x));
    return writes ? v("external", "API 写操作可能已经生效，先查对方状态") : v("none");
  }
  if (noun === "release") return v("external", "先 gh release view <tag> 核对，要不要重发由 owner 定");
  if (noun === "pr" && verb === "merge") return v("check_first", "先 gh pr view 看是否已经合并");
  if (noun === "pr" && verb === "checkout") return v("idempotent");
  if ((noun === "pr" || noun === "issue") && /^(create|comment|review|close|reopen|edit)$/.test(verb)) return v("external", "别人可能已经看到了，先 gh pr/issue view 核对，别重复发");
  return v("check_first");
}

function classifyManager(sub: string, rest: string[]): SideEffectVerdict {
  if (MANAGER_READ.test(sub)) return v("none");
  if (sub === "web-release" && rest[0] === "deploy") return v("idempotent", "有构建锁和原子切换，可以直接重跑");
  if (sub === "web-release" && /^(list|status|current)$/.test(rest[0] ?? "")) return v("none");
  if (sub === "auto-update" && (rest[0] ?? "status") === "status") return v("none");
  if (/^peer-|^token-|^pair$/.test(sub)) return v("external", "凭据 / 邀请可能已经生成或作废，先 list 核对");
  return v("check_first", `先 manager list / doctor 看 ${sub || "这次操作"} 做到了哪一步`);
}

function classifyPkg(c0: string, c1: string, c2: string, t: string[]): SideEffectVerdict {
  const script = c1 === "run" ? c2 : c1;
  if (c0 === "bunx" || c0 === "npx") return c1 === "tsc" && t.includes("--noEmit") ? v("none") : v("check_first");
  if (/^(test|check|guard|typecheck|lint|tsc)$/.test(script) || c1 === "test") return v("none");
  if (/^(build|build:.*)$/.test(script) || c1 === "build") return v("idempotent");
  if (c1 === "install" || c1 === "i" || c1 === "ci") return v("idempotent");
  return v("check_first");
}

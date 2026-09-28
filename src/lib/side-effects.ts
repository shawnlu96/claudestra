/**
 * 被打断的工具调用可能留下什么半截副作用：按工具名 + Bash 命令前缀分四类（规则表逐条单测 tests/side-effects.test.ts）。
 * 只用来给 agent 写「打断收尾」提醒，不替它做决定、不自动重放。宁严勿宽：认不出的 Bash 一律 check_first，
 * 对外 / 不可逆的名单宁可列宽——把不可逆的判成「可以重跑」，代价是重复下单、重复发版。
 */

import { classifyCloud, classifyPublish } from "./side-effects-cli.js";

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
const MCP_WRITE_WORD =
  new RegExp("^(write|create|update|delete|remove|send|post|put|set|add|click|type|fill|upload|drop|drag|edit|run|exec|execute|merge|publish|press|select|navigate"
    + "|close|batch|apply|submit|approve|cancel|insert|upsert|invoke|trigger|deploy|start|stop|kill|terminate|restart|reset|revoke|grant|move|rename|archive"
    + "|restore|install|enable|disable|purge|flush|truncate|in)$", "i"); // in：check_in、log_in
const MCP_READ_WORD = /^(read|get|list|search|query|fetch|find|check|view|describe|snapshot|screenshot|status|info|messages)$/i;
function mcpReadOnly(short: string): boolean {
  const words = short.split(/[_-]/);
  return !words.some((w) => MCP_WRITE_WORD.test(w)) && words.some((w) => MCP_READ_WORD.test(w));
}
/** 这些服务的 MCP 写操作别人看得见 / 收不回（发消息、开 PR、发邮件、扣款）：写动词一律算对外 */
const MCP_EXTERNAL_SERVER = /slack|github|gitlab|gmail|mail|linear|jira|notion|discord|telegram|twitter|x_com|stripe|calendar|drive|figma|asana/i;
/** 下单 / 转账这类动作不管哪个服务都收不回 */
const MCP_MONEY_WORD = /^(place|order|buy|sell|trade|refund|charge|pay|payment|transfer|withdraw)$/i;
/** 数据库类服务：query / execute 可能是写语句，不能按「query = 读」放行 */
const MCP_DB_SERVER = /db|sql|postgres|mysql|sqlite|mongo|redis|supabase|database|bigquery|snowflake|clickhouse|neon|prisma/i;
/** 服务名不在上表也认（Cloudflare 的 d1_database_query、turso / redshift 的 query）：工具名本身像在跑语句 */
const MCP_DB_TOOL = /sql|query|cypher|statement|database|(^|[_-])d1([_-]|$)/i;

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
  const server = name.startsWith("mcp__") ? name.split("__")[1] ?? "" : "";
  if (short.split(/[_-]/).some((w) => MCP_MONEY_WORD.test(w))) return v("external", "交易 / 支付可能已经生效，先去对方那边查订单状态，别重复下");
  if (MCP_DB_SERVER.test(server) && /query|exec|sql|migrat/i.test(short) || MCP_DB_TOOL.test(short)) return v("check_first", "语句可能已经执行（写语句收不回），先查数据现状");
  if (mcpReadOnly(short)) return v("none");
  if (MCP_EXTERNAL_SERVER.test(server)) return v("external", "对外操作可能已经生效（消息已发、PR 已开），先去对方那边核对，别重复做");
  return v("check_first");
}

/** jsonl-watcher 的 Bash detail 是「描述\n───\n命令」（没有描述就只有命令），取命令 */
export function bashCommandOf(detail: string): string {
  const i = detail.lastIndexOf("\n───\n");
  return i >= 0 ? detail.slice(i + 5) : detail;
}

/**
 * 按 && || ; | 换行切成几段，逐段分类取最重的一段。先把「\ + 换行」续行并成一行（否则 -d 落到下一段就认不出）；
 * $( … )、反引号、<( … ) 里的命令单独再分类一遍（echo "$(curl -X POST …)" 不是只读的 echo）。
 */
export function classifyBash(command: string, extraExternal: readonly string[] = [], depth = 0): SideEffectVerdict {
  const cmd = command.replace(/\\\r?\n/g, " ").trim();
  if (!cmd) return v("check_first");
  for (const kw of extraExternal) {
    if (kw && cmd.includes(kw)) return v("external", `项目登记的对外操作（${kw}）：先查状态，不要直接重跑`);
  }
  let out: SideEffectVerdict = v("none");
  const inner = substitutions(cmd);
  if (inner === null || (inner.length && depth >= 3)) out = v("check_first", "命令里套了子命令，先核对它做到了哪一步");
  else for (const c of inner) out = heavier(out, classifyBash(c, extraExternal, depth + 1));
  // 单个 & 是后台接着跑下一条（2>&1、&> 里的 & 不算分隔）；分隔符留在奇数位，管道右侧的段要知道自己读 stdin
  const parts = cmd.split(/\s*(&&|\|\||;|\||\n|&(?![>\d]))\s*/);
  for (let k = 0; k < parts.length; k += 2) {
    if (parts[k].trim()) out = heavier(out, classifySegment(parts[k], parts[k - 1] === "|"));
  }
  return out;
}

/** $( … ) / <( … ) / >( … ) / 反引号里的命令（只取最外层）；括号或反引号不配对 = null（认不出，按先核对） */
function substitutions(cmd: string): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === "`") {
      const j = cmd.indexOf("`", i + 1);
      if (j < 0) return null;
      out.push(cmd.slice(i + 1, j));
      i = j;
    } else if (/[$<>]/.test(cmd[i]) && cmd[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) if (cmd[j] === "(") depth++; else if (cmd[j] === ")" && --depth === 0) break;
      if (j >= cmd.length) return null;
      const body = cmd.slice(i + 2, j);
      if (!/^\(.*\)$/s.test(body)) out.push(body); // $(( 算术 )) 里没有命令
      i = j;
    }
  }
  return out;
}

/** 命令外壳，值是它哪些选项带值（sudo -u deploy、nice -n 10）：连外壳带选项一起去掉 */
const WRAPPERS: Record<string, RegExp> = {
  sudo: /^-[ugCDhpUrtT]$/, nice: /^-n$/, stdbuf: /^-[ioe]$/, caffeinate: /^-[tw]$/, env: /^-u$/, time: /^$/, nohup: /^$/, command: /^$/, exec: /^-a$/,
};
/** shell 结构的前缀（for … do X、if … then X、{ X; }、( X )、! X）：真正的命令在后面 */
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "!", "{", "("]);

/** 去掉前导的 VAR=x、sudo / time / nohup / env / nice / timeout N 这类外壳和 shell 结构词，返回真正的命令词 */
function tokensOf(seg: string): string[] {
  const toks = seg.trim().split(/\s+/).map((t) => t.replace(/['"]/g, "")); // -X"POST" 与 -XPOST 一样
  if (/^[({]./.test(toks[0] ?? "")) toks[0] = toks[0].replace(/^[({]+/, ""); // (cd x、{curl
  while (toks.length) {
    const t = toks[0];
    const valued = Object.hasOwn(WRAPPERS, t) ? WRAPPERS[t] : undefined;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || SHELL_KEYWORDS.has(t)) toks.shift();
    else if (valued) {
      toks.shift();
      while (toks[0]?.startsWith("-")) toks.splice(0, valued.test(toks[0]) ? 2 : 1);
    } else if (t === "timeout" || t === "gtimeout") toks.splice(0, 2);
    else break;
  }
  return toks;
}

/** 把别的命令当参数跑的（bash -c '…'、xargs …、watch …）：取出里面那条命令，没有就 undefined */
function innerCommand(t: string[]): string | undefined {
  const [c0 = ""] = t;
  if (/^(bash|sh|zsh|dash)$/.test(c0)) {
    const k = t.findIndex((x, i) => i > 0 && /^-[a-z]*c$/.test(x));
    return k > 0 ? t.slice(k + 1).join(" ") : undefined;
  }
  if (c0 !== "xargs" && c0 !== "watch") return undefined;
  const valued = c0 === "xargs" ? /^-[InPLdEsa]$/ : /^-n$/;
  let k = 1;
  while (k < t.length && t[k].startsWith("-")) k += valued.test(t[k]) ? 2 : 1;
  return t.slice(k).join(" ");
}

const READ_CMDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "echo", "printf", "pwd", "which", "whoami", "jq", "sort", "uniq", "tree", "file", "stat",
  "du", "df", "ps", "pgrep", "lsof", "date", "printenv", "type", "test", "true", "false", "sleep", "cd", "diff", "cut", "tr", "basename",
  "dirname", "realpath", "readlink", "less", "more", "column", "hostname", "uname", "id", "shasum", "md5", "sha256sum", "[", "fd",
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "blame", "ls-files", "ls-remote", "grep", "describe", "shortlog", "merge-base", "cat-file"]);
const MANAGER_READ = /^(list|sessions|doctor|version|cost|status|help|--help|.*-list|.*-test)$/;

function classifySegment(seg: string, piped = false): SideEffectVerdict {
  const t = tokensOf(seg);
  const has = (re: RegExp) => t.slice(1).some((x) => re.test(x));
  if (!t[0]) return v("none");
  const inner = innerCommand(t);
  const base = inner !== undefined ? classifyBash(inner) : classifyCommand(t, has, seg, piped);
  // 重定向写文件（> / >>，不含 2>&1、>/dev/null）：至少先看文件现状
  return /(^|[^0-9&>])>>?\s*(?!&|\/dev\/null)\S/.test(seg) ? heavier(base, v("check_first", "命令会写文件，先看文件现状")) : base;
}

function classifyCommand(t: string[], has: (re: RegExp) => boolean, seg: string, piped: boolean): SideEffectVerdict {
  const [c0 = "", c1 = "", c2 = ""] = t;
  if (c0 === "git") return classifyGit(t);
  if (c0 === "gh") return classifyGh(t);
  if (["curl", "wget", "http", "https", "xh"].includes(c0)) {
    return httpMutates(t, seg, piped) ? v("external", "请求可能已经发出，先查对方状态，别重复提交") : v("none");
  }
  const cloud = classifyCloud(t) ?? classifyPublish(t);
  if (cloud) return cloud;
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
  if (c0 === "fd") return has(/^(-x|-X|--exec|--exec-batch)(=|$)/) ? v("check_first", "fd 对每个结果执行了命令，先核对做到了哪一个") : v("none");
  if (c0 === "sed") return has(/^(-[a-zA-Z]*i|--in-place)/) ? v("check_first", "先看文件现状") : v("none");
  if (c0 === "sort" && has(/^(-[a-zA-Z]*o|--output)/)) return v("check_first", "命令会写文件，先看文件现状");
  if (c0 === "tsc") return has(/^--noEmit$/) ? v("none") : v("idempotent");
  if (c0 === "mkdir" && has(/^-p$/)) return v("idempotent");
  if (READ_CMDS.has(c0)) return v("none");
  return v("check_first", "先核对这条命令做到了哪一步");
}

const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;

/** curl / wget / httpie（http、https、xh）会不会改对方的东西：显式写方法，或带请求体（httpie 从 stdin 读到请求体就默认 POST，管道右侧也算） */
function httpMutates(t: string[], seg: string, piped: boolean): boolean {
  const args = t.slice(1);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    // 短选项可以连写：-sX POST / -sXPOST / -sd@order.json
    const shortX = /^-[a-zA-Z]*X(.*)$/.exec(a);
    const method = (shortX ? shortX[1] || args[k + 1] : undefined) ?? /^--(?:request|method)=(.+)$/.exec(a)?.[1] ?? (/^(--request|--method)$/.test(a) ? args[k + 1] : undefined);
    if (method && WRITE_METHOD.test(method)) return true;
    if (/^-[a-zA-Z]*[dFT]/.test(a) && !a.startsWith("--")) return true;
    if (/^(--data.*|--form.*|--json|--upload-file|--post-data|--post-file|--body-data|--body-file)(=.*)?$/.test(a)) return true;
  }
  // httpie：任何一个位置参数是写方法（带值选项 -a user:pass、--timeout 5 会占掉第一个位置），或带 key=value / key:=json 数据项、--raw 请求体
  if (["http", "https", "xh"].includes(t[0] ?? "")) {
    if (piped && !args.includes("--ignore-stdin") || /(^|[^<0-9])<(?!\()|<<</.test(seg)) return true;
    if (args.some((a) => /^(--raw|--multipart)(=|$)/.test(a))) return true;
    const pos = args.filter((a) => !a.startsWith("-") && !a.startsWith("<"));
    return pos.some((a) => WRITE_METHOD.test(a)) || pos.slice(1).some((a) => /^[\w.-]+(:=|=(?!=))/.test(a)); // q==x 是查询参数
  }
  return false;
}

function classifyGit(all: string[]): SideEffectVerdict {
  // git -C <dir> / -c k=v / --git-dir=… / --no-pager 这类全局参数不影响分类
  const t = [...all];
  while (t.length > 1 && /^(-[Cc]|--git-dir|--work-tree|--namespace|-[CcP]\S+|--[\w-]+=.*|--no-pager|--paginate|--bare|--no-replace-objects)$/.test(t[1])) {
    t.splice(1, /^(-[Cc]|--git-dir|--work-tree|--namespace)$/.test(t[1]) ? 2 : 1);
  }
  const sub = t[1] ?? "";
  const rest = t.slice(2);
  if (GIT_READ.has(sub)) return v("none");
  // 这三个既能看也能改：只有看的写法算只读（git reflog expire、git remote set-url、git config k v 都是改）
  if (sub === "config") {
    const read = rest.length <= 1 && !/^--(unset|add|replace|remove|rename)/.test(rest[0] ?? "") || rest.some((x) => /^(--get|--get-all|--list|-l)$/.test(x));
    return read ? v("none") : v("check_first");
  }
  if (sub === "reflog") return /^(show|exists)?$/.test(rest.find((x) => !x.startsWith("-")) ?? "") ? v("none") : v("check_first", "reflog 改了就找不回旧提交，先核对");
  if (sub === "remote") return /^(-v|--verbose|show|get-url)?$/.test(rest[0] ?? "") ? v("none") : v("check_first", "先 git remote -v 看现状");
  if (sub === "branch" || sub === "stash" && rest[0] === "list" || sub === "worktree" && rest[0] === "list") {
    return rest.every((x) => /^-(a|v|vv|r|l|-list|-show-current|-all)$/.test(x) || x === "list") ? v("none") : v("check_first");
  }
  if (sub === "tag") {
    return rest.length === 0 || rest.some((x) => /^(-l|--list|-n\d*|--contains|--points-at)$/.test(x))
      ? v("none")
      : v("external", "tag 可能已经推上去了，先 git ls-remote --tags 核对，要不要重打由 owner 定");
  }
  if (sub === "push") {
    // 短选项连写（-fu、-df）也算强推 / 删除
    if (rest.some((x) => /^-[a-zA-Z]*[fd]/.test(x) && !x.startsWith("--") || /^(--force.*|--delete|--mirror|--prune)$/.test(x) || /^[:+]/.test(x))) {
      return v("external", "强推 / 删远端分支可能已经生效，先 git ls-remote 核对远端，不要直接重跑");
    }
    if (rest.some((x) => x === "--tags" || x === "--follow-tags" || /^refs\/tags\/|^v\d/.test(x))) return v("external", "tag 可能已经推上去了，先 git ls-remote --tags 核对");
    return v("idempotent", "非强推可以重跑；先 git status 看是否已经推上去");
  }
  if (sub === "fetch" || sub === "pull") return v("idempotent");
  if (sub === "add") return v("idempotent");
  if (sub === "commit") return v("check_first", "先 git log -1 看是否已经提交，别重复提交");
  return v("check_first", `先 git status 看 ${sub || "git"} 做到了哪一步`);
}

function classifyGh(all: string[]): SideEffectVerdict {
  const t = [...all]; // gh -R o/r pr create：全局的 -R / --repo 先跳过
  while (t.length > 1 && /^(-R|--repo)(=.*)?$/.test(t[1])) t.splice(1, t[1].includes("=") ? 1 : 2);
  const [, noun = "", verb = ""] = t;
  if (/^(view|list|diff|checks|status|watch)$/.test(verb) || noun === "search" || noun === "auth" && verb === "status") return v("none");
  if (noun === "api") {
    const method = t.map((x, k) => /^(-X|--method)$/.test(x) ? t[k + 1] ?? "" : /^(?:-X|--method=)(.+)$/.exec(x)?.[1]).find((m) => m !== undefined);
    const writes = method !== undefined ? WRITE_METHOD.test(method) : t.some((x) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x));
    return writes ? v("external", "API 写操作可能已经生效，先查对方状态") : v("none");
  }
  if (noun === "workflow" && verb === "run" || noun === "repo" && /^(create|delete|rename|archive|edit|fork)$/.test(verb)) return v("external", "对外操作可能已经生效，先去 GitHub 上核对");
  if (noun === "release") return v("external", "先 gh release view <tag> 核对，要不要重发由 owner 定");
  if (/^(secret|variable)$/.test(noun) && /^(set|delete|remove)$/.test(verb) || noun === "gist" && /^(create|edit|delete)$/.test(verb)
    || noun === "run" && /^(cancel|rerun|delete)$/.test(verb)) return v("external", "对外操作可能已经生效，先去 GitHub 上核对");
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
  if (t.some((x) => /^--(fix|write)$/.test(x))) return v("check_first", "带 --fix / --write 会改文件，先看文件现状");
  if (/^(test|check|guard|typecheck|lint|tsc)$/.test(script) || c1 === "test") return v("none");
  if (/^(build|build:.*)$/.test(script) || c1 === "build") return v("idempotent");
  if (c1 === "install" || c1 === "i" || c1 === "ci") return v("idempotent");
  return v("check_first");
}

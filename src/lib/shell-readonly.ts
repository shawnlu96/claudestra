/**
 * 一条 shell 命令是不是只读（Autopilot 判「这一轮有没有实质进展」用，lib/autopilot-tools.ts；不是权限闸）。tests/autopilot-tools.test.ts。
 * 先分词（lib/shell-words.ts）再按段判：每一段都是认得的只读命令、没有写文件的重定向；有命令 / 进程替换、没加引号的括号、
 * 解析不完整的一律按写。分不清的都按写——误判成写只是多推一轮，误判成只读会让真在干活的 agent 进待命。
 */
import { parseShell, type Segment } from "./shell-words.js";

/** 任何参数都不会写东西的命令 */
const ALWAYS_READ = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "pwd", "echo", "which", "type", "stat", "du", "df", "ps", "jq",
  "cut", "tr", "basename", "dirname", "uptime", "whoami", "id", "uname", "true", "false", "readlink",
  "realpath", "more", "nl", "od", "hexdump", "diff", "cmp", "printenv", "column", "comm", "seq", "sleep",
  "pgrep", "lsof", "cd", "pushd", "popd", "colordiff", "shasum", "md5", "md5sum", "sha256sum",
]);
/** 参数里有运行时才知道的值（$X、$'…'、{a,b}）也无妨的命令：没有会写东西的标志位 */
const DYNAMIC_OK = new Set(["echo", "cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "cd", "pwd", "stat", "du", "basename",
  "dirname", "realpath", "readlink", "which", "type", "sleep", "jq", "cut", "nl", "diff", "cmp"]);
/** 允许出现在命令前面的环境变量（能执行命令的 GIT_EXTERNAL_DIFF / PAGER=任意程序 之类不在内） */
const SAFE_ENV = /^(LANG|LC_\w+|TZ|NO_COLOR|TERM|COLUMNS|FORCE_COLOR|CI)=|^(GIT_PAGER|PAGER|GH_PAGER)=(cat|)$/;
/** 绝对路径的标准命令目录：/usr/bin/git 按 git 判；其它路径（./x、~/bin/x）认不出 */
const STD_BIN = /^\/(usr\/(local\/)?)?(s?bin)\/|^\/opt\/homebrew\/bin\//;
/** 控制结构的关键字：去掉后按剩下的命令判 */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"]);

const hasAny = (args: string[], flags: RegExp) => args.some((a) => flags.test(a));
/** 短选项簇里有没有某些字母（-sSo 里的 o）；长选项另判 */
const shortHas = (args: string[], letters: string) => args.some((a) => /^-[^-]/.test(a) && [...a.slice(1)].some((ch) => letters.includes(ch)));
const positionals = (args: string[]) => args.filter((a) => !a.startsWith("-"));
/** --name[=值] 的 name；不是长选项 / 单独的 -- 返回 null */
const longName = (a: string) => /^--([^=]+)/.exec(a)?.[1] ?? null;
/** getopt_long、git、curl 都接受唯一前缀的缩写（--outp= 就是 --output=）：name 是某个危险长选项的前缀就算命中 */
const longHits = (args: string[], names: string[]) => args.some((a) => {
  const n = longName(a);
  return n !== null && names.some((d) => d.startsWith(n));
});
/**
 * 按标志位判的小命令认得的长选项：其余 --xxx（包括认得的选项的缩写）一律按写，省得逐个追缩写和新选项。
 * 不在这里的命令（git / gh / curl / rg / find / tmux）各自判，缩写用 longHits 兜。
 */
const SAFE_LONG: Record<string, string[]> = {
  sort: ["numeric-sort", "reverse", "key", "field-separator", "unique", "human-numeric-sort", "version-sort", "ignore-case", "stable",
    "general-numeric-sort", "month-sort", "random-sort", "dictionary-order", "ignore-leading-blanks", "check", "merge", "zero-terminated",
    "parallel", "buffer-size", "debug", "help", "version"],
  sed: ["quiet", "silent", "expression", "regexp-extended", "null-data", "zero-terminated", "separate", "posix", "debug", "sandbox",
    "unbuffered", "line-length", "help", "version"],
  less: ["RAW-CONTROL-CHARS", "raw-control-chars", "chop-long-lines", "quit-if-one-screen", "no-init", "LINE-NUMBERS", "line-numbers",
    "ignore-case", "IGNORE-CASE", "squeeze-blank-lines", "help", "version"],
  awk: ["field-separator", "assign", "posix", "traditional", "re-interval", "characters-as-bytes", "sandbox", "help", "version"],
  uniq: ["count", "repeated", "unique", "ignore-case", "skip-fields", "skip-chars", "check-chars", "zero-terminated", "all-repeated",
    "group", "help", "version"],
  file: ["brief", "mime", "mime-type", "mime-encoding", "dereference", "no-dereference", "help", "version"],
  date: ["date", "utc", "universal", "iso-8601", "rfc-3339", "rfc-email", "reference", "debug", "help", "version"],
  tree: ["noreport", "dirsfirst", "charset", "gitignore", "prune", "du", "filelimit", "sort", "matchdirs", "ignore-case", "help", "version"],
  xxd: [],
};

const GIT_READ = new Set([
  "status", "log", "show", "diff", "blame", "shortlog", "rev-parse", "rev-list", "merge-base", "ls-files", "ls-tree", "describe", "cat-file",
  "count-objects", "show-ref", "for-each-ref", "whatchanged", "cherry", "range-diff", "name-rev", "check-ignore",
]);
const BRANCH_WRITE_LONG = ["delete", "move", "copy", "force", "set-upstream-to", "unset-upstream", "edit-description", "annotate", "sign",
  "message", "file", "local-user"];

function gitRefsReadOnly(sub: string, flags: string[], pos: string[]): boolean {
  if (longHits(flags, BRANCH_WRITE_LONG) || shortHas(flags, sub === "branch" ? "dDmMcCfu" : "dasfmFu")) return false;
  return !pos.length || hasAny(flags, /^(-l|--list|--contains|--merged|--no-merged|--points-at|--show-current)/);
}

/** git：-C <dir> / --no-pager 可以；-c / --exec-path 等能注入要执行的东西，算写。子命令按参数判 */
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
  const pos = positionals(rest);
  if (longHits(rest, ["output", "ext-diff"])) return false;
  if (GIT_READ.has(sub)) return true;
  switch (sub) {
    case "grep": return !hasAny(flags, /^-O/) && !longHits(flags, ["open-files-in-pager"]); // -O 用参数当分页程序执行
    case "fetch": return !pos.some((p) => p.includes(":")) && !hasAny(flags, /^-u/) && !longHits(flags, ["upload-pack"]);
    case "remote": return pos.length === 0 || ["show", "get-url"].includes(pos[0]);
    case "worktree": return pos[0] === "list";
    case "stash": return pos[0] === "list" || pos[0] === "show";
    case "reflog": return !pos.length || pos[0] === "show";
    case "config":
      return hasAny(flags, /^(--get|--get-all|--get-regexp|--list|-l)$/) && pos.length <= 1
        && flags.every((f) => /^(--get|--get-all|--get-regexp|--list|-l|--global|--local|--system|--show-origin|--name-only|-z)$/.test(f));
    case "branch": case "tag": return gitRefsReadOnly(sub, flags, pos);
    default: return false;
  }
}

const GH_VIEWS: Record<string, string[]> = {
  pr: ["view", "list", "checks", "status", "diff"], run: ["view", "list", "watch"], issue: ["view", "list", "status"],
  release: ["view", "list"], repo: ["view"], workflow: ["view", "list"],
};

/** 取 -X / --request / --method 的值：-X GET、-XGET、-iXGET、--method=GET 都认 */
function methodOf(args: string[], i: number, long: RegExp): string | null {
  const a = args[i];
  const l = long.exec(a);
  if (l) return (l[1] ?? args[i + 1] ?? "").toUpperCase();
  const s = /^-[a-zA-Z]*X(.*)$/.exec(a);
  return s ? (s[1] || args[i + 1] || "").toUpperCase() : null;
}

/** gh：只认看的子命令；gh api 只认 GET 且不带字段（带 -f / -F 时 gh 默认 POST） */
function ghReadOnly(args: string[]): boolean {
  const [a, b] = args;
  if (a === "api") {
    for (let i = 1; i < args.length; i++) {
      if (/^(-f|-F|--field|--raw-field|--input)/.test(args[i])) return false;
      const m = methodOf(args, i, /^--method(?:=(.+))?$/);
      if (m !== null && m !== "GET") return false;
    }
    return true;
  }
  if (a === "search" || (a === "auth" && b === "status")) return true;
  return !!GH_VIEWS[a]?.includes(b);
}

const CURL_WRITE_LONG = [
  "output", "remote-name", "remote-name-all", "data", "data-ascii", "data-binary", "data-raw", "data-urlencode", "json", "form", "form-string",
  "upload-file", "config", "dump-header", "cookie-jar", "trace", "trace-ascii", "stderr", "libcurl", "etag-save", "output-dir", "create-dirs",
];

/** curl：只认 GET 且不写文件、不带请求体 / 配置文件；-w 里的 %output{…} 也会写文件 */
function curlReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (longHits([a], CURL_WRITE_LONG)) return false;
    const m = methodOf(args, i, /^--request(?:=(.+))?$/);
    if (m === null && longName(a) !== "request" && longHits([a], ["request"])) return false; // --req=POST 这类缩写
    if (m !== null && m !== "GET") return false;
    if (/%output\{/.test(a)) return false;
  }
  return !shortHas(args, "oOdFTKDc");
}

/** sed 脚本会不会写文件 / 执行命令：去掉 s/// 和 /地址/ 之后还剩 w / W / e 命令，或 s 的标志里有 w / e */
function sedScriptWrites(script: string): boolean {
  let t = script;
  const sCmd = /s(.)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1([a-zA-Z0-9]*)/g;
  let hit = false;
  t = t.replace(sCmd, (_m, _d, _re, _rep, fl: string) => {
    if (/[we]/.test(fl)) hit = true;
    return "s";
  });
  t = t.replace(/y(.)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1/g, "y").replace(/\/(?:\\.|[^/])*\//g, "");
  return hit || /[wWe]/.test(t);
}

function sedReadOnly(args: string[]): boolean {
  if (hasAny(args, /^--(in-place|file)/) || shortHas(args.filter((a) => /^-[a-zA-Z]+/.test(a)), "iIf")) return false;
  const scripts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" || args[i] === "--expression") scripts.push(args[++i] ?? "");
    else if (/^--expression=/.test(args[i])) scripts.push(args[i].split("=").slice(1).join("="));
  }
  if (!scripts.length) scripts.push(positionals(args)[0] ?? "");
  return !scripts.some(sedScriptWrites);
}

/** 单个命令（已去掉前缀）只读吗 */
function commandReadOnly(cmd: string, args: string[]): boolean {
  if (ALWAYS_READ.has(cmd)) return true;
  const safe = SAFE_LONG[cmd];
  if (safe && args.some((a) => { const n = longName(a); return n !== null && !safe.includes(n); })) return false;
  switch (cmd) {
    case "git": return gitReadOnly(args);
    case "gh": return ghReadOnly(args);
    case "curl": return curlReadOnly(args);
    case "sed": return sedReadOnly(args);
    // 数组下标里的 $(…) 会被求值：read 'a[$(touch P)]'、wait -p 'a[$(…)]'（单引号挡不住，赋值时才展开）
    case "test": case "[": case "[[": case "read": case "wait": return !args.some((a) => /\[.*(\$\(|`)/.test(a));
    case "printf": return !args.includes("-v");
    case "date": return !hasAny(args, /^(-s|--set)/);
    case "env": case "hostname": return args.length === 0;
    case "xxd": return !hasAny(args, /^-r/) && positionals(args).length <= 1; // xxd 按前缀认选项：-r / -rp / -revert // 第二个位置参数是输出文件
    case "tree": return !shortHas(args, "o");
    case "less": return !shortHas(args, "oO") && !args.some((a) => a.startsWith("+")); // +命令 可以是 !shell
    case "file": return !shortHas(args, "C");
    case "rg": return !hasAny(args, /^--pre/);
    case "sort": return !shortHas(args, "o");
    case "uniq": return positionals(args).length <= 1; // 第二个位置参数是输出文件
    case "find": return !hasAny(args, /^-\w*(delete|exec|ok|fprint|fls)/); // 认不全的 -xxx 变体也按写
    // -f / -E 读程序文件，-i / -l 加载扩展（-i inplace 就地改），-o / -p / -d 把输出写进文件，-W 能带任意长选项
    case "awk": return !hasAny(args, /^-[fEilopdDW]/) && !args.some((a) => /system\s*\(|[>|]/.test(a)); // print > file、print | cmd
    case "tmux":
      return /^(capture-pane|list-\w+|display-message|display|has-session)$/.test(args[0] ?? "") && !shortHas(args, "bI") // -b 写缓冲区，-I 把 stdin 送进 pane
        && !args.some((a) => a === ";" || a.includes("#("));
    case "bun": case "npm": return args[0] === "test" || (args[0] === "run" && /^(check|typecheck|test|guard|lint)$/.test(args[1] ?? ""));
    case "npx": return args[0] === "tsc" && args.includes("--noEmit");
    default: return false;
  }
}

/** 去掉前缀：安全的 VAR=值、timeout N、time、nice、nohup、stdbuf；返回真正的命令词。出现不安全的环境变量 → null（按写算） */
function stripPrefix(words: string[]): string[] | null {
  let w = words;
  const skipFlags = (from: number, withValue: RegExp) => {
    let i = from;
    while (w[i]?.startsWith("-")) i += withValue.test(w[i]) ? 2 : 1;
    return i;
  };
  for (;;) {
    if (!w.length) return w;
    const h = w[0];
    if (/^[A-Za-z_]\w*=/.test(h)) {
      if (!SAFE_ENV.test(h)) return null;
      w = w.slice(1);
    } else if (h === "timeout") w = w.slice(skipFlags(1, /^-[ks]$/) + 1); // 跳过时长
    else if (h === "nice") w = w.slice(skipFlags(1, /^-n$/));
    else if (h === "time" || h === "nohup" || h === "stdbuf") w = w.slice(skipFlags(1, /^-[ioe]$/));
    else if (KEYWORDS.has(h)) w = w.slice(1);
    else return w;
  }
}

const SAFE_TARGET = /^(\/dev\/null|\/dev\/stdout|\/dev\/stderr|&\d|&-)$/;

function segmentReadOnly(s: Segment): boolean {
  if (s.redirects.some((r) => r.op !== "<" && !SAFE_TARGET.test(r.target))) return false;
  const w = stripPrefix(s.words);
  if (!w) return false;
  if (!w.length) return true; // 只有安全的环境变量 / 只读重定向
  const cmd = STD_BIN.test(w[0]) ? w[0].replace(/^.*\//, "") : w[0];
  if (cmd === "done" || cmd === "fi" || cmd === "esac") return w.length === 1;
  if (cmd === "for") return w[2] === "in" || w.length === 2; // for x in …：只是循环头，循环体是后面的段
  if (s.dynamic && !DYNAMIC_OK.has(cmd)) return false; // find . ${X:--delete}、sed $'-i'：看不到真实参数
  return commandReadOnly(cmd, w.slice(1));
}

export function isReadOnlyBash(command: string): boolean {
  const p = parseShell(command);
  if (p.broken || p.substitution || p.structural || !p.segments.length) return false;
  return p.segments.every(segmentReadOnly);
}

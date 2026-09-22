// guard 的规则数据：上限、分层表、patterns、twins。规则逻辑在 rules/，这里只放数字和清单。
// 改这里等于改闸门本身：commit message 里写清楚为什么（guard 会对此打警告）。

/** 默认上限：代码文件 / tests / 数据文件（纯表格型，行多但无逻辑）。 */
const CODE_CAP = 400;
const TEST_CAP = 600;
const DATA_CAP = 1000;
const DATA_FILES: RegExp[] = [/^web\/lib\/i18n-dict\.ts$/, /^src\/bridge\/slash-catalog\.ts$/];

/** 单行超过这么多字符（JS 字符串长度）算一行「压行」。 */
export const LONG_LINE = 200;
/** 函数超过这么多行，超出部分计入 fn:overflow；超长函数的签名行计入 fnLong。 */
export const FN_CAP = 100;
/** 重复检测窗口：连续这么多条有效行完全相同算重复。 */
export const DUP_WINDOW = 6;
/** 函数体内（缩进 ≥2）连续这么多行注释算一个长注释块。 */
export const COMMENT_BLOCK_MIN = 8;

/** 按字节计的文档（每个会话都会加载，只许变小）。 */
export const DOC_FILES = ["CLAUDE.md", "CLAUDE.zh-CN.md", "web/CLAUDE.md"];

/** 扫描范围：git ls-files 这些目录下的 ts/tsx/mjs。 */
export const SCAN_DIRS = ["src", "web", "tests", "scripts"];
export const EXCLUDE: RegExp[] = [/^web\/\.packages\//, /^web\/lib\/build-info\.ts$/, /(^|\/)node_modules\//];

/** 双份文件：去注释后必须逐行一致；dup 规则跳过第二份。web 与 src 共用逻辑只能以 twin 的形式存在。 */
export const TWINS: [string, string][] = [
  ["src/lib/inline-buttons.ts", "web/lib/chat/inline-buttons.ts"],
  ["src/lib/attachment-name.ts", "web/lib/chat/attachment-name.ts"],
];

/** web/app/api 下不调 isAuthed 的公开路由（新增公开路由必须登记在这里）。 */
export const PUBLIC_ROUTES = [
  "web/app/api/version/route.ts",
  "web/app/api/push/ack/route.ts",
  "web/app/api/auth/login/route.ts",
  "web/app/api/auth/logout/route.ts",
  "web/app/api/auth/me/route.ts",
  "web/app/api/auth/passkey/login/route.ts",
];

/** bridge 的枢纽模块：只允许 bridge.ts（入口）import。 */
export const BRIDGE_HUBS = new Set(["api-routes", "management", "web-terminal", "web-gateway"]);
/** watcher 之间不互相 import：共用的纯函数下沉到 src/lib。 */
export const WATCHERS = new Set([
  "jsonl-watcher", "bg-activity-watcher", "permission-watcher", "wedge-watcher",
  "session-reconciler", "model-drift", "thinking-telemetry", "archive-sweeper",
]);

export interface PatternDef {
  id: string;
  re: RegExp;
  /** 这些文件是规范实现本身，不计数。 */
  allow: RegExp;
  hint: string;
}

/** 绕过规范 helper 的写法（按全仓总数棘轮）。catch 类吞错单独在 rules/patterns.ts 里判注释质量。 */
export const PATTERNS: PatternDef[] = [
  {
    id: "tmux-target-literal",
    re: /[`"']master:(\$\{|0)/g,
    allow: /^src\/lib\/tmux-helper\.ts$/,
    hint: "tmux 目标用 windowTarget(name)（src/lib/tmux-helper.ts）",
  },
  {
    id: "master-session-concat",
    re: /\$\{MASTER_SESSION\}:/g,
    allow: /^src\/lib\/tmux-helper\.ts$/,
    hint: "tmux 目标用 windowTarget(name)（src/lib/tmux-helper.ts）",
  },
  {
    id: "raw-tmux-spawn",
    re: /\[\s*["']tmux["']/g,
    allow: /^src\/lib\/tmux-helper\.ts$|^src\/setup\.ts$|^src\/pi\//,
    hint: "tmux 调用走 tmuxRaw / tmuxFire / tmuxInterrupt（src/lib/tmux-helper.ts）",
  },
  {
    id: "registry-path-literal",
    re: /["'`,]\s*registry\.json["'`]|\/registry\.json`/g,
    allow: /^src\/lib\/registry\.ts$/,
    hint: "registry 路径用 REGISTRY_PATH（src/lib/registry.ts）",
  },
  {
    id: "web-route-401-boilerplate",
    re: /\{ error: "未登录" \}, \{ status: 401 \}/g,
    allow: /^web\/lib\//,
    hint: "401 响应抽成 web/lib 里的共用 helper，不要每个路由各写一遍",
  },
];

/** catch 块里的占位注释：写了等于没写，按吞错计。比较前先小写、去标点和空白。 */
export const PLACEHOLDER_COMMENTS = new Set([
  "noncritical", "ignore", "ignored", "noop", "nop", "besteffort", "fallback", "skip", "swallow",
  "ok", "fine", "同上", "忽略", "无所谓", "静默", "吞掉", "不关心",
]);
/** catch 注释去掉标点和空白后至少这么多字（CJK 一个字算 1）。 */
export const CATCH_COMMENT_MIN = 6;

/** 每类违规的改法（CLI 输出里每条违规附一行）。 */
export const HINTS: Record<string, string> = {
  size: "新逻辑放新模块（≤400 行），大文件里只留一行调用；或先抽出等量代码",
  doc: "功能细节写进 docs/，这里只留一行指针",
  longLine: "别压行：拆成多行（单行 ≤200 字符）",
  fn: "拆函数；把超长函数原样搬出大文件不算违规（按全仓总量计）",
  fnLong: "新写的（或改了签名行的）函数超过 100 行：拆开",
  dup: "抽成函数复用，别复制；看具体克隆：npx jscpd@5.3.1 src web -f typescript,tsx",
  comments: "注释 ≤6 行、写现行约束；演变史/事故/原话进 commit message",
  catch: "吞错要写一句为什么丢了也没事（≥6 字，占位词不算），能打日志就打日志",
  route: "web/app/api 路由必须调 isAuthed；公开路由登记进 scripts/guard/config.ts 的 PUBLIC_ROUTES",
  deps: "依赖方向违规：纯函数下沉到 src/lib，运行时状态查询改用注入",
  dead: "未使用的导出：删掉，或者真的用上它",
  twins: "twin 文件不一致：两份同步修改（去注释后逐行比对）",
};

/** 某个 baseline key 在没有 baseline 条目时的默认上限。 */
export function capFor(key: string): number {
  if (!key.startsWith("size:")) return 0;
  const file = key.slice(5);
  if (DATA_FILES.some((re) => re.test(file))) return DATA_CAP;
  return file.startsWith("tests/") ? TEST_CAP : CODE_CAP;
}

/** key 的规则前缀：`size:src/x.ts` → size，`pattern:tmux-target-literal` → pattern。 */
export function prefixOf(key: string): string {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
}

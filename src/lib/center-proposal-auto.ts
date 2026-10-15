/** PROPAUTO1 分类（纯函数）：中心待批提案 → auto（系统代 owner 批）或 owner（照旧出卡，带原因）。任一条命中就判 owner。
 * 主判据是节点 fileGlobs：空的、格式不对的、出了 src/ tests/ docs/ web/ 的、和保护集合相交的（宽 glob 的静态前缀是保护路径的祖先、
 * 且能匹配到它，同样算相交）。保护集合 = peer-pr-surface 的敏感目录 / 固定文件 / 文件名规则 + scopeWireProtected 的权限闸 +
 * 删数据 / schema 类路径。文本词表只补判 owner，没命中不能当安全的证明。修订提案按新的全量节点判，被移除的节点不判。
 * 接线在 bridge/center-proposal-inbox.ts；执行占位 / 结果事件在 center-proposal-auto-exec.ts。docs/architecture/center-proposal-auto.md。
 */
import { scopeWireProtected } from "./ask-scope-registry.js";
import { DIRS, FILE_PATTERNS, FILES, KEYWORDS } from "./peer-pr-surface.js";
import type { ProposalRecord } from "./shared-ledger-feature-proposals.js";

export type AutoReason =
  | "nodes_empty" | "glob_empty" | "glob_invalid" | "glob_outside_roots" | "glob_wide"
  | "glob_unresolved" | "glob_security_surface" | "glob_permission_gate" | "glob_data_schema" | "text_sensitive_word"
  /** 执行阶段改出 owner 卡的两种（不是分类结论）：3 次结果都不明 / 中心明确拒绝 */
  | "auto_unconfirmed" | "auto_center_refused";
export interface AutoVerdict { route: "auto" | "owner"; reasons: AutoReason[] }

const REASON_TEXT: Record<AutoReason, string> = {
  nodes_empty: "提案没有节点",
  glob_empty: "有节点没写文件范围",
  glob_invalid: "文件范围格式不对",
  glob_outside_roots: "文件范围不在 src/ tests/ docs/ web/ 下",
  glob_wide: "文件范围太宽，覆盖到受保护的文件",
  glob_unresolved: "文件范围的通配符看不清是否盖到受保护的文件",
  glob_security_surface: "改动安全敏感目录或文件",
  glob_permission_gate: "改动权限闸文件",
  glob_data_schema: "涉及删数据、迁移或 schema",
  text_sensitive_word: "标题 / 说明里提到安全、权限或数据相关的词",
  auto_unconfirmed: "自动批准没有确认结果",
  auto_center_refused: "中心拒绝了自动批准",
};
/** 卡上那一行的中文（code = 中心拒绝时的固定错误码） */
export function reasonText(reasons: readonly AutoReason[], code?: string): string {
  return reasons.map(r => r === "auto_center_refused" && code ? `${REASON_TEXT[r]}（错误码 ${code}）` : REASON_TEXT[r]).join("；");
}

const KNOWN_ROOTS = ["src/", "tests/", "docs/", "web/"];
/** peer-pr-surface 同款：tests/ docs/ 下的文件名关键词不算 */
const NO_KEYWORD_ROOTS = ["tests/", "docs/"];
/** 删数据 / schema 类路径的名字规则（对 glob 原文判，大小写不敏感） */
const DATA_SCHEMA = /ledger-store|ledger-schema|migrat|\.sql(?:$|[^a-z])|shared-ledger-contract|recovery-key-(?:class|defaults)|(?:^|\/)scripts\/guard\//i;
/** 宽 glob 要能覆盖到的具体保护文件（仓库现有文件另外逐个核，见 globHits；这里兜住还没检出 / 被删掉又加回的保护路径） */
const PERMISSION_FILES = [
  "src/lib/peer-scope-gate.ts", "src/lib/peer-secret-gate.ts", "src/lib/order-tool-route.ts", "src/lib/caller-identity.ts",
  "src/bridge/api-auth.ts", "src/bridge/terminal-auth.ts", "src/bridge/interrupt-gate.ts", "src/bridge/web-gateway.ts",
  "src/bridge/local-api/control.ts", "src/bridge/local-api/shared-projects-auth.ts", "src/lib/ledger-checks.ts",
  "src/lib/ask-scope-registry.ts", "src/lib/order-ask.ts", "src/lib/order-deliver-scope.ts",
];
const DATA_FILES = [
  "src/lib/ledger-store.ts", "src/lib/ledger-schema.ts", "src/lib/sqlite-migrate.ts", "src/lib/ledger-feature-migrate.ts",
  "src/lib/shared-ledger-v2-migration.ts", "src/lib/shared-ledger-contract.ts", "src/lib/shared-ledger-contract-v2.ts",
  "src/lib/recovery-key-class.ts", "src/lib/recovery-key-defaults.ts", "src/bridge/startup-migrations.ts", "src/lib/acp/migration.ts",
];
/** FILE_PATTERNS 每条的代表路径（tests 核过每条都命中对应规则） */
export const PATTERN_PROBES = ["CLAUDE.md", "web/next.config.js", "web/public/sw.js"];

type Hit = Exclude<AutoReason, "nodes_empty" | "glob_empty" | "glob_invalid" | "glob_outside_roots" | "glob_wide" | "glob_unresolved"
  | "text_sensitive_word" | "auto_unconfirmed" | "auto_center_refused">;
const CONCRETE: readonly (readonly [string, Hit])[] = [
  ...FILES.map(f => [f, "glob_security_surface"] as const),
  ...PATTERN_PROBES.map(f => [f, "glob_security_surface"] as const),
  ...PERMISSION_FILES.map(f => [f, "glob_permission_gate"] as const),
  ...DATA_FILES.map(f => [f, "glob_data_schema"] as const),
];
const PROTECTED_DIRS: readonly (readonly [string, Hit])[] = [
  ...DIRS.map(d => [d, "glob_security_surface"] as const), [".claude/", "glob_security_surface"], ["src/lib/floka-migration/", "glob_data_schema"],
];

const WILD = /[*?[\]{}!]/;
const malformed = (g: string) => !g || g.length > 500 || g.startsWith("/") || g.includes("\\") || g.split("/").some(s => s === ".." || s === ".") || g.includes("//");

/** 静态前缀：第一个带通配的段之前（以 / 结尾，可为空）；没有通配 → null（整条是字面路径） */
function staticPrefix(g: string): string | null {
  const segs = g.split("/"), i = segs.findIndex(s => WILD.test(s));
  return i < 0 ? null : segs.slice(0, i).map(s => `${s}/`).join("");
}

/** 通配 glob 能不能匹配到目录 dir 下的某个文件（dir 在静态前缀之下）：剩余段带 ** 一律算能；否则逐段比，段数要比 dir 多 */
function reachesDir(g: string, prefix: string, dir: string): boolean {
  const rest = g.slice(prefix.length).split("/"), under = dir.slice(prefix.length).split("/").filter(Boolean);
  if (rest.some(s => s.includes("**"))) return true;
  return rest.length > under.length && under.every((s, i) => new Bun.Glob(rest[i]!).match(s));
}

/** 一条具体路径（或 glob 原文）按名字 / 目录 / 固定文件规则的命中。names=false：只看 .claude / FILE_PATTERNS，不看名字规则 */
function literalHits(g: string, hits: Set<AutoReason>, names = true): void {
  const name = (g.split("/").pop() ?? "").toLowerCase();
  if (g.split("/").includes(".claude") || FILE_PATTERNS.some(([, re]) => re.test(g))
    || (names && !NO_KEYWORD_ROOTS.some(r => g.startsWith(r)) && KEYWORDS.some(k => name.includes(k)))) hits.add("glob_security_surface");
  if (names && scopeWireProtected(g)) hits.add("glob_permission_gate");
  if (names && DATA_SCHEMA.test(g)) hits.add("glob_data_schema");
}

/** 仓库里现有的文件（git ls-files，进程内只读一次）；读不到 = null，带通配的 glob 一律判 owner */
let repoFilesCache: readonly string[] | null | undefined;
function repoFiles(): readonly string[] | null {
  if (repoFilesCache !== undefined) return repoFilesCache;
  try {
    const r = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "ignore" });
    repoFilesCache = r.exitCode === 0 ? r.stdout.toString().split("\0").filter(Boolean) : null;
  } catch { repoFilesCache = null; }
  return repoFilesCache;
}

/**
 * 一条 glob 的命中（去重，按发现顺序）。files = 仓库现有文件：带通配的 glob 对能匹配到的每个现有文件套全部保护规则
 * （src/lib/scheduler-wip-?ate.ts 盖到 scheduler-wip-gate.ts 就算），不只核固定的代表清单。
 * 文件名段里有 ? / [ ] 这种按字符遮名字的，或读不到仓库文件清单，交 owner（glob_unresolved）。
 */
export function globHits(raw: string, files: readonly string[] | null = repoFiles()): AutoReason[] {
  const g = raw.replace(/^\.\//, "");
  if (!g.trim()) return ["glob_empty"];
  if (malformed(g)) return ["glob_invalid"];
  const hits = new Set<AutoReason>();
  if (!KNOWN_ROOTS.some(r => g.startsWith(r))) hits.add("glob_outside_roots");
  // 名字规则对 glob 原文判：src/lib/*-gate.ts、src/lib/ledger-schema*.ts 这种字面上就带出来的
  literalHits(g, hits);
  const prefix = staticPrefix(g);
  if (prefix === null) {
    // 字面路径：是保护文件本身、在保护目录下，或者它本身是个目录、下面有保护文件
    for (const [d, why] of PROTECTED_DIRS) if (`${g}/`.startsWith(d) || d.startsWith(`${g}/`)) hits.add(why);
    for (const [f, why] of CONCRETE) if (f === g || f.startsWith(`${g}/`)) hits.add(why);
    return [...hits];
  }
  if (/[?[\]]/.test(g.slice(g.lastIndexOf("/") + 1)) || files === null) hits.add("glob_unresolved");
  const glob = new Bun.Glob(g);
  for (const [d, why] of PROTECTED_DIRS) {
    if (prefix.startsWith(d)) hits.add(why);
    else if (d.startsWith(prefix) && reachesDir(g, prefix, d)) hits.add(why).add("glob_wide");
  }
  const covered = (f: string, why: AutoReason) => {
    hits.add(why);
    // 前缀比保护文件所在目录浅 = 宽 glob 盖过去的
    if (f.lastIndexOf("/") + 1 > prefix.length) hits.add("glob_wide");
  };
  for (const [f, why] of CONCRETE) if (f.startsWith(prefix) && glob.match(f)) covered(f, why);
  for (const f of files ?? []) {
    if (!f.startsWith(prefix) || !glob.match(f)) continue;
    const one = new Set<AutoReason>();
    for (const [d, why] of PROTECTED_DIRS) if (f.startsWith(d)) one.add(why);
    // docs / tests 下的现有文件不套名字规则（-gate、migrat…管的是会运行的代码，peer-pr-surface 同款），docs/** 不因 docs/x-gate.md 出卡
    literalHits(f, one, !NO_KEYWORD_ROOTS.some(r => f.startsWith(r)));
    for (const why of one) covered(f, why);
  }
  return [...hits];
}

/** 固定词表（大小写不敏感）：只补判 owner */
const SENSITIVE_WORDS = [
  "安全", "权限", "鉴权", "授权", "凭据", "密钥", "令牌", "加密", "签名", "删除数据", "删库", "清库", "迁移", "schema", "表结构",
  "auth", "credential", "secret", "token", "password", "permission", "encrypt", "signature", "migration", "drop table",
];
const hasWord = (s: string | null | undefined) => !!s && SENSITIVE_WORDS.some(w => s.toLowerCase().includes(w));

const ORDER: readonly AutoReason[] = [
  "nodes_empty", "glob_empty", "glob_invalid", "glob_outside_roots", "glob_wide", "glob_unresolved",
  "glob_security_surface", "glob_permission_gate", "glob_data_schema", "text_sensitive_word",
];

/** 纯函数：同一提案（同 rev）→ 同一结论；reasons 按固定顺序、去重 */
export function classifyProposal(r: ProposalRecord, files: readonly string[] | null = repoFiles()): AutoVerdict {
  const p = r.proposal, hits = new Set<AutoReason>();
  if (!p.nodes.length) hits.add("nodes_empty");
  for (const n of p.nodes) {
    if (!n.fileGlobs.length) hits.add("glob_empty");
    for (const g of n.fileGlobs) for (const h of globHits(g, files)) hits.add(h);
    if (hasWord(n.oneLine)) hits.add("text_sensitive_word");
  }
  if (hasWord(p.title) || hasWord(p.description) || hasWord(p.ownerWords)) hits.add("text_sensitive_word");
  const reasons = ORDER.filter(x => hits.has(x));
  return reasons.length ? { route: "owner", reasons } : { route: "auto", reasons: [] };
}

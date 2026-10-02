/**
 * 记忆写入口的防噪闸 memoryLint（设计稿 docs/design/project-memory.md §2.3）：工具（record_memory）、CLI（ledger memory-record）与之后的自动写
 * （M3 沉淀 / M6 导入）写记忆前都过这里，命中即拒并说明是第几条、为什么——不改写、不截断、不降级。
 * 八条按编号报（rule），调用方原样回给写入者：
 *   1 进度 / 状态（那是事件）  2 代码本身读得出的事实  3 规格复述、一次性的错别字 / 格式 / 命名意见、P2  4 环境个例（本机 Bun / 网络 / 配额）
 *   5 无来源的推测（坑要有 sources 或出自审查员 / PM / owner；导入的要 sourceNote）  6 秘密、地址、本机绝对路径、个人信息、商业内容（只报字段位置）
 *   7 重复（同 family 且文件有交集的 open / fixing 坑已在、同内容已在、或语义余弦 ≥0.92）  8 长度超限（不截断）
 * 文本类规则（1–4）只看 title 与「怎么避免」一段（rule）——症状里提到「已合并」「本机」是在描述现场，不算。
 * tests/memory-lint.test.ts（八条各一条拒绝用例 + 不误伤用例）。
 */
import type { Database } from "bun:sqlite";
import { redactForPeer } from "./dispatch-redact.js";
import { MEMORY_LIMITS as LIMITS, memoryState, memoryDigest, type Memory, type MemoryInput } from "./ledger-memory.js";

const MEMORY_LINT_RULES = {
  1: "进度 / 状态不是记忆（那是事件，台账里已有）",
  2: "代码本身就能读出来的事实不用记",
  3: "规格复述、本卡一次性的错别字 / 格式 / 命名意见不记；P2 不沉淀成坑",
  4: "环境个例（本机 Bun 版本、本机网络 / 配额）已在标准答复里，记了会误导别人",
  5: "无来源的推测：坑要带来源事件，或出自审查员 / PM / owner；导入的要写 sourceNote",
  6: "含秘密、地址、本机绝对路径、个人信息或商业内容",
  7: "重复：已有同一条记忆",
  8: "长度超限（不截断，请改短）",
} as const;
type MemoryLintRule = keyof typeof MEMORY_LINT_RULES;

export type MemoryLintResult = { ok: true } | { ok: false; rule: MemoryLintRule; error: string; duplicateOf?: string };

export interface MemoryLintInput extends MemoryInput {
  /** 自动沉淀时来源 finding 的级别：P2 一律不沉淀（第 3 条） */
  severity?: "P0" | "P1" | "P2";
}

export interface MemoryLintDeps {
  /** 语义近邻（M4 的嵌入；没有就不给）：返回与 text 余弦最高的已有记忆 */
  similar?(project: string, text: string): { id: string; cosine: number }[];
}

const SEMANTIC_DUP = 0.92;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const refuse = (rule: MemoryLintRule, why: string, extra: { duplicateOf?: string } = {}): MemoryLintResult =>
  ({ ok: false, rule, error: `memoryLint 第 ${rule} 条：${MEMORY_LINT_RULES[rule]}——${why}`, ...extra });

const STATUS = /(已经?(完成|提交|合并|推送|交付|上线|修好|处理)|完成了|等(待)?\s*(审查|合并|回复|CI)|待审查?|进行中|进度[:：]|\bWIP\b|\bTODO\b|\bin progress\b|\bwaiting (for|on) review\b|\b(is|was) (done|merged|finished)\b)/i;
/** 「X 函数在 y.ts」「函数 X 在 y.ts」这类定位事实（\x60 = 反引号）；带「要 / 必须 / 不要 / 别 / 否则」的是规矩，不算 */
const CODE_KIND = String.raw`(?:函数|方法|类|常量|变量|类型|接口|字段|模块|\bfunction|\bclass|\bmethod|\bconst|\btype)`;
const CODE_NAME = String.raw`\x60?[\w.$#]+\x60?`;
const CODE_AT = String.raw`\s*(?:在|位于|定义在|放在|写在|\bis (?:defined |declared )?in|\blives in|\bis located in)\s*` +
  String.raw`\x60?[\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|sql|sh)\x60?`;
const CODE_FACT = new RegExp(`(?:${CODE_KIND}\\s*${CODE_NAME}|${CODE_NAME}\\s*${CODE_KIND})${CODE_AT}`, "i");
const RULE_WORDS = /(要|必须|不要|不能|别|禁止|否则|只能|一律|先|\bmust\b|\bnever\b|\balways\b|\bdon'?t\b|\bavoid\b)/i;
const ONE_OFF = /(错别字|拼写|笔误|\btypo\b|格式化|缩进|空格|换行风格|命名(不规范|不统一|建议|风格)|改个名|重命名一下|\bnaming\b|\bformatting\b|\bwhitespace\b|规格(里|中)?(写|要求|说|规定)|按规格|照规格|\bspec says\b)/i;
const ENV = new RegExp([
  String.raw`(本机|本地|我这台|我的机器|这台机器)\S{0,6}(bun|node|版本|网络|代理|配额|额度)`, String.raw`bun\s*(的)?\s*版本`, String.raw`\bbun version\b`,
  String.raw`与\s*CI\s*(的)?\s*(版本)?不(同|一致|一样)`, String.raw`和\s*CI\s*不一样`, "网络(超时|不通|抖动|慢)", "(配额|额度|quota)(用完|不足|超了|耗尽)", String.raw`\brate[- ]limit`,
].join("|"), "i");
const LOCAL_PATH = /(^|[\s`'"(=:])(\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/|~\/|[A-Za-z]:\\)/;
const ANY_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const COMMERCIAL = /(报价|合同金额|营收|利润|毛利|客户名单|售价|定价策略|融资|商业计划|\brevenue\b|\bprofit\b|\bpricing strategy\b|[¥￥]\s?\d|\$\s?\d[\d,]*(\.\d+|\s?(k|m|万|元|美元)))/i;

function lengths(input: MemoryLintInput): MemoryLintResult {
  const over = (field: string, v: unknown, max: number) => typeof v === "string" && bytes(v) > max ? refuse(8, `${field} ${bytes(v)} 字节，上限 ${max}`) : null;
  return over("title", input.title, LIMITS.title)
    ?? over("symptom", input.symptom, LIMITS.symptom) ?? over("rule", input.rule, LIMITS.rule)
    ?? over("body", input.body, input.kind === "summary" ? LIMITS.summary : LIMITS.decision)
    ?? over("sourceNote", input.sourceNote, LIMITS.sourceNote)
    ?? (Array.isArray(input.files) && input.files.length > LIMITS.files ? refuse(8, `files ${input.files.length} 项，上限 ${LIMITS.files}`) : null)
    ?? { ok: true };
}

/** 第 6 条：所有调用方给的文本字段都查，报错只说字段名，不带原文 */
function sensitive(input: MemoryLintInput): MemoryLintResult {
  const fields: Record<string, unknown> = {
    title: input.title, symptom: input.symptom, rule: input.rule, body: input.body, family: input.family, sourceNote: input.sourceNote,
    ...Object.fromEntries((input.files ?? []).map((f, i) => [`files[${i}]`, f])),
  };
  const hits = Object.entries(fields).filter(([, v]) => typeof v === "string" && !!v &&
    (redactForPeer(v).count > 0 || ANY_IPV4.test(v) || LOCAL_PATH.test(v) || COMMERCIAL.test(v))).map(([k]) => k);
  return hits.length ? refuse(6, `命中字段 ${hits.join(", ")}（去掉后重写；不会降级成只留本机）`) : { ok: true };
}

/** 纯文本的几条（1–6、8），不碰库 */
export function lintText(input: MemoryLintInput): MemoryLintResult {
  const len = lengths(input);
  if (!len.ok) return len;
  const title = typeof input.title === "string" ? input.title : "";
  const rule = typeof input.rule === "string" ? input.rule : "";
  if (STATUS.test(title)) return refuse(1, "标题读起来是进度 / 状态");
  if (CODE_FACT.test(title) || (CODE_FACT.test(rule) && !RULE_WORDS.test(rule))) return refuse(2, "写的是「某某在某文件」这类定位事实，不是会再犯的坑");
  if (input.severity === "P2") return refuse(3, "来源是 P2");
  if (ONE_OFF.test(title) || ONE_OFF.test(rule)) return refuse(3, "读起来是规格复述或一次性的格式 / 命名意见");
  if (ENV.test(title) || ENV.test(rule)) return refuse(4, "读起来是本机环境个例");
  if (input.kind === "pitfall") {
    const hasSource = (input.sources?.length ?? 0) > 0;
    if (input.via === "import" && !hasSource && !input.sourceNote) return refuse(5, "导入的坑没有来源事件也没写 sourceNote");
    if (!hasSource && !input.sourceNote && !["reviewer", "pm", "owner"].includes(input.authorRole)) return refuse(5, `作者角色 ${input.authorRole} 且没有来源事件`);
  }
  return sensitive(input);
}

const literalPrefix = (g: string) => g.split(/[*?[{]/)[0];

/** 两组路径 / glob 有没有交集：路径对 glob 用 Bun.Glob 判；glob 对 glob 按字面前缀互为前缀判（宁可多判重：重复只是改用 confirm 追加来源） */
export function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return !a.length && !b.length;
  const isGlob = (s: string) => /[*?[{]/.test(s);
  return a.some((x) => b.some((y) => {
    if (x === y) return true;
    if (isGlob(x) && !isGlob(y)) return new Bun.Glob(x).match(y);
    if (isGlob(y) && !isGlob(x)) return new Bun.Glob(y).match(x);
    if (isGlob(x) && isGlob(y)) { const p = literalPrefix(x), q = literalPrefix(y); return p.startsWith(q) || q.startsWith(p); }
    return false;
  }));
}

const bodyOf = (input: MemoryLintInput): string =>
  input.kind === "pitfall" ? JSON.stringify({ symptom: input.symptom, rule: input.rule }) : String(input.body ?? "");

/**
 * 重试判定（memory-tools recordAs 用）：已有记忆与这次输入的作者、类别、正文与文件（digest）、family、fixable、锚点全都一致才算同一次写；
 * 第 7 条的同 family 有交集、语义近邻不算，照样回拒绝和 confirm / supersede 指引。
 */
export function sameMemoryWrite(prev: Memory, actor: string, input: MemoryInput): boolean {
  const anchored = input.taskId ? prev.taskId === input.taskId && prev.head === (input.head ?? null) && prev.specRev === (input.specRev ?? null)
    : prev.taskId === null && prev.featureId === (input.featureId ?? null);
  return anchored && prev.author === actor && prev.kind === input.kind && prev.family === (input.family ?? null) && prev.fixable === (input.fixable ?? null)
    && prev.digest === memoryDigest(input.title, bodyOf(input), input.files ?? []);
}

/** 第 7 条：本项目里同内容的、同 family 且文件有交集的 open / fixing 坑、语义近邻 */
function lintDuplicate(db: Database, input: MemoryLintInput, deps: MemoryLintDeps = {}): MemoryLintResult {
  const files = input.files ?? [];
  const digest = memoryDigest(input.title, bodyOf(input), files);
  const live = (id: string) => {
    const s = memoryState(db, id);
    return !!s && s.status !== "retracted" && s.status !== "superseded";
  };
  const same = db.prepare("SELECT id FROM memories WHERE project = ? AND digest = ?").all(input.project, digest) as { id: string }[];
  const hit = same.find((r) => live(r.id));
  if (hit) return refuse(7, `与 ${hit.id} 内容相同；要补来源请 mark_memory confirm ${hit.id}`, { duplicateOf: hit.id });
  if (input.kind === "pitfall" && input.family) {
    const rows = db.prepare("SELECT id, files FROM memories WHERE project = ? AND kind = 'pitfall' AND family = ? ORDER BY createdAt DESC")
      .all(input.project, input.family) as { id: string; files: string }[];
    for (const r of rows) {
      const s = memoryState(db, r.id);
      if (!s || (s.status !== "open" && s.status !== "fixing")) continue;
      if (filesOverlap(files, JSON.parse(r.files) as string[])) {
        return refuse(7, `同 family ${input.family} 且文件有交集的坑 ${r.id} 还开着；不新开，改用 mark_memory confirm ${r.id} 追加来源`, { duplicateOf: r.id });
      }
    }
  }
  const near = deps.similar?.(input.project, `${input.title}\n${bodyOf(input)}`).find((n) => n.cosine >= SEMANTIC_DUP && live(n.id));
  if (near) return refuse(7, `与 ${near.id} 语义几乎相同（余弦 ${near.cosine.toFixed(2)}）；改用 mark_memory confirm ${near.id}`, { duplicateOf: near.id });
  return { ok: true };
}

/** 写入口统一调这一个：先文本几条，再查库判重 */
export function memoryLint(db: Database, input: MemoryLintInput, deps: MemoryLintDeps = {}): MemoryLintResult {
  const t = lintText(input);
  return t.ok ? lintDuplicate(db, input, deps) : t;
}

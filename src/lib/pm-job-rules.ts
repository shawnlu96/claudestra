/**
 * PM 处理员的白名单与升级判定（agents-PMJOB1 规格 PM 定 2 / 3，agents-PMJOB2 放宽），全是代码规则，模型改不了：
 * - gatesOf：按问题原文判命中了哪些门，不靠模型自报。门分两种：
 *   硬门 = 权限、删数据、release、tag、中心限流、schema、改额度线、owner 决策、凭据安全，命中就永远升级，任何类型都越不过；
 *   软门 = 改规格、改范围、「能不能 / 可不可以 / can I」这类要人点头的问法，只有规格（含 PM 补）已写明（specDecided）才能代答。
 *   问题正文过全部门，候选项只过硬门（「批准 / 不批准」这类候选不挡单）。不再有「像不像查证」那道门：把关交给输出核对。
 * - judgePmJobOutput：模型输出要是约定的 JSON、类型在白名单、自称有把握、模型的话里没有批准口吻、每条依据都是批准路径里
 *   真实存在的 文件:行，才算可直回；specDecided 还要求依据全是规格文件本身的行，答复开头由代码逐行引用规格原文。
 */
import { PM_JOB_TYPES, type PmJobEvidence, type PmJobResult } from "./pm-job-types.js";

/** 一句之内（不跨标点 / 换行）的间隔 */
const GAP = "[^\\n，。；,.;?？!！]";
const re = (...parts: string[]): RegExp => new RegExp(parts.join("|").replaceAll("~", GAP), "i");

/** hard = 硬门（永远升级）；其余是软门（只有 specDecided 能越过） */
const FORBIDDEN: readonly [id: string, label: string, re: RegExp, hard?: true][] = [
  ["spec", "改规格", re("改规格", "规格~{0,12}(?:改|调整|变更|重写|补一?条|加一?条)", "(?:修改|更新|调整|重写)~{0,8}规格", "验收线~{0,8}(?:改|放宽|删|去掉)",
    "\\b(?:chang|modif|edit|rewrit|amend|relax|loosen|waiv|drop|remov|skip|updat|alter)\\w*\\b~{0,40}"
      + "\\b(?:spec(?:ification)?s?|acceptance|criteri\\w+|requirements?)\\b")],
  ["scope", "改范围", re("扩围", "改范围", "加进(?:本卡)?范围", "范围~{0,8}(?:加|扩|放开|调整)", "fileGlobs~{0,20}(?:加|追加|改|add|append|chang|extend)", "(?:改|动|碰)~{0,12}(?:未列|范围外)",
    "\\b(?:chang|expand|extend|widen|broaden|enlarg|increas|adjust|modif|alter|updat)\\w*\\b~{0,40}\\bscope\\b",
    "\\bscope\\b~{0,40}\\b(?:chang|expand|extend|widen|includ|add|cover)\\w*",
    "\\bout[- ]of[- ]scope\\b", "\\b(?:outside|beyond)\\b~{0,20}\\bscope\\b", "\\b(?:unlisted|not listed)\\b")],
  ["permission", "权限", re("权限", "授权", "提权", "allowlist", "白名单~{0,8}(?:加|扩|放开)",
    "\\bpermissions?\\b", "\\bauthori[sz]\\w*", "\\bprivileg\\w*", "\\b(?:grant|elevat)\\w*\\b", "\\bsudo\\b"), true],
  ["delete", "删数据", re("删(?:除|掉)?~{0,12}(?:数据|台账|记录|表|库|备份|状态文件)", "清空", "drop\\s+table", "truncate", "rm\\s+-",
    "\\b(?:delet|remov|drop|wip|purg|eras|destroy|clear|reset)\\w*\\b~{0,40}\\b(?:data|databases?|db|records?|rows?|tables?|ledger|backups?|state|history|logs?)\\b"), true],
  ["release", "release", re("\\breleas\\w*", "发版", "发布(?:版本|正式)", "上线正式", "\\b(?:publish|ship|deploy)\\w*\\b~{0,20}\\b(?:version|prod\\w*)\\b"), true],
  ["tag", "tag", re("git\\s+tag", "打\\s*tag", "\\btag(?:s|ged|ging)?\\b", "版本号", "\\bversion (?:bump|number)\\b"), true],
  ["ratelimit", "中心限流", re("限流", "限频", "rate.?limit", "\\bthrottl\\w*"), true],
  ["schema", "schema", re("schema", "表结构", "加(?:一)?列", "迁移脚本", "migrat\\w*", "ALTER\\s+TABLE", "\\b(?:add|drop|alter|renam)\\w*\\b~{0,20}\\bcolumns?\\b"), true],
  ["quotaline", "改额度线", re("额度线", "codexWeeklyLinePct", "codex-line", "借额度", "换\\s*Claude", "\\bquota\\b~{0,30}\\b(?:line|limit|threshold|cap)\\b",
    "\\b(?:rais|bump|borrow|increas|lift)\\w*\\b~{0,30}\\b(?:quota|budget)\\b"), true],
  ["owner", "owner 决策", re("owner", "所有者", "拍板", "老板", "\\bsign[- ]?off\\b"), true],
  ["secret", "凭据 / 安全", re("凭据", "密钥", "token", "密码", "\\.env", "\\.pem", "auth\\.json", "安全漏洞", "\\bcredentials?\\b", "\\bsecrets?\\b", "\\bpasswords?\\b",
    "\\bapi.?keys?\\b", "\\bprivate keys?\\b", "\\bvulnerabilit\\w*"), true],
  // 要人点头的问法：不管问的是什么，都不是「查证」
  ["decide", "请求批准 / 决策", re("可以", "能不能", "能否", "可否", "可不可以", "要不要", "该不该", "应不应该", "需不需要", "行不行", "好不好",
    "能~{0,20}[吗么]", "需要~{0,20}[吗么]", "申请", "请批", "求批", "准许", "放行", "(?:是否|能否)(?:批准|同意|允许)", "(?:批准|同意|允许)[吗么我]", "我们?(?:想|打算|准备|计划|建议)", "建议(?:改|把|将)",
    "\\b(?:can|may|could|should|shall|must|might)\\s+(?:i|we)\\b", "\\b(?:am i|are we)\\s+(?:allowed|permitted|free|supposed)\\b",
    "\\b(?:is it|would it be|is that|is this)\\s+(?:ok|okay|fine|acceptable|allowed|permitted|safe)\\b",
    "\\ballow(?:ed|s|ing)?\\b", "\\bapprov\\w*", "\\bpermit(?:s|ted)?\\b",
    "\\b(?:i|we)(?:'d| would)? (?:want|like|plan|intend|propose|need)\\b", "\\blet (?:me|us)\\b", "\\bok(?:ay)? (?:to|if)\\b", "\\bdo you mind\\b")],
];

/** 批准口吻：处理员没有批准权，答复里出现就不直回 */
const GRANT = re("\\bapproved?\\b", "\\bgo ahead\\b", "\\byou (?:may|can|are (?:allowed|free|permitted))\\b", "\\bpermitted\\b", "\\bgranted\\b",
  "\\bfeel free\\b", "已?批准", "准许", "放行", "同意(?:你|了|这)", "可以(?:改|删|扩|加|发|动|直接|这么|这样)", "你可以", "没问题");

/** 匹配前归一：全角 / 兼容字形折成普通字形，去零宽与格式控制字符（拆词绕不过去） */
const norm = (s: string): string => s.normalize("NFKC").replace(/\p{Cf}+/gu, "");

export interface PmJobGates {
  /** 命中的全部门（标签，按规则顺序） */
  all: string[];
  /** 其中有硬门 */
  hard: boolean;
}

const HARD = new Set(FORBIDDEN.filter(([, , , hard]) => hard).map(([, label]) => label));

const hits = (text: string, hardOnly: boolean): [label: string, hard: boolean][] => {
  const t = norm(text);
  return FORBIDDEN.filter(([, , r, hard]) => (hard || !hardOnly) && r.test(t)).map(([, label, , hard]) => [label, !!hard]);
};

/** 问题正文过全部门，候选项只过硬门；同一个门只记一次 */
export function gatesOf(question: string, options: readonly string[] = []): PmJobGates {
  const got = [...hits(question, false), ...options.flatMap((o) => hits(o, true))];
  const all = [...new Set(got.map(([label]) => label))];
  return { all, hard: got.some(([, hard]) => hard) };
}

/** 第一个命中的门（标签）；null = 一道门都没命中 */
export function forbiddenOf(question: string): string | null {
  return gatesOf(question).all[0] ?? null;
}

interface Raw { type?: unknown; answer?: unknown; evidence?: unknown; confident?: unknown; pending?: unknown; reason?: unknown }

/** 取输出里最后一个 JSON 对象（围栏里的优先）；解析不了 = null */
function parseOutput(text: string): Raw | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  for (const cand of [...fenced.reverse(), ...(start >= 0 && end > start ? [text.slice(start, end + 1)] : [])]) {
    try {
      const v = JSON.parse(cand) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Raw;
    } catch { /* 这段不是 JSON：换下一个候选再试 */ }
  }
  return null;
}

export interface JudgeCtx {
  /** 接单时代码判出的第一个门 */
  forbidden: string | null;
  /** 接单时命中的全部门；没有（PMJOB2 之前的旧单子）= forbidden 一律按硬门算 */
  gates?: PmJobGates;
  /** 这个仓库相对路径（或规格文件）在批准路径里的行数；不在批准路径 / 读不到 = null */
  lines(file: string): number | null;
  /** 规格文件路径（specDecided 的依据只能是它）和它第 n 行的原文（worker 跑的那份规格；读不到 = null） */
  specPath?: string;
  specLine?(n: number): string | null;
}

const ANSWER_MAX = 2000;
const EVIDENCE_MAX = 20;
const QUOTE_MAX = 200;
const clean = (s: string): string => s.replace(/\p{Cf}+/gu, "").replace(/[\u2028\u2029]/g, "\n").replace(/[^\S\n]+/g, " ").trim();

export function judgePmJobOutput(text: string, ctx: JudgeCtx): PmJobResult {
  const raw = parseOutput(text);
  const pending = Array.isArray(raw?.pending) ? raw.pending.filter((p): p is string => typeof p === "string").map((p) => clean(p).slice(0, 300)).slice(0, 10) : [];
  const type = typeof raw?.type === "string" ? raw.type.slice(0, 40) : "unknown";
  const answer = typeof raw?.answer === "string" ? clean(raw.answer).slice(0, ANSWER_MAX) : "";
  const rawEvidence: unknown[] = Array.isArray(raw?.evidence) ? raw.evidence : [];
  const evidence: PmJobEvidence[] = rawEvidence.flatMap((e) => {
    const file = (e as PmJobEvidence | null)?.file, line = (e as PmJobEvidence | null)?.line;
    return typeof file === "string" && typeof line === "number" && Number.isInteger(line) ? [{ file, line }] : [];
  });
  const escalate = (reason: string): PmJobResult => ({ verdict: "escalate", type, answer, evidence: evidence.slice(0, EVIDENCE_MAX), reason, pending });
  if (!raw) return escalate("处理员输出不是约定的 JSON");
  const gates = ctx.gates ?? { all: ctx.forbidden ? [ctx.forbidden] : [], hard: !!ctx.forbidden };
  if (gates.hard) return escalate(`问题属于必须由 PM 处理的类别：${(ctx.gates ? gates.all.filter((l) => HARD.has(l)) : gates.all).join("、")}`);
  if (!Object.hasOwn(PM_JOB_TYPES, type)) return escalate(`不在白名单的问题类型：${type}`);
  if (gates.all.length && type !== "specDecided") return escalate(`问题涉及${gates.all.join("、")}，只有规格（含 PM 补）已写明的才能代答（specDecided）`);
  if (raw.confident !== true) return escalate(`处理员没把握${typeof raw.reason === "string" ? `：${clean(raw.reason).slice(0, 300)}` : ""}`);
  if (!answer) return escalate("处理员没有给出答复");
  if (GRANT.test(norm(answer))) return escalate("答复带批准口吻，处理员没有批准权");
  if (!evidence.length) return escalate("答复没有 文件:行 依据");
  // 先校验完整原始列表，再裁剪展示：格式不合法或超条数的依据不能被静默丢掉后放行
  if (evidence.length !== rawEvidence.length) return escalate("依据格式不合法（每条须是 {file: 字符串, line: 整数}）");
  if (evidence.length > EVIDENCE_MAX) return escalate(`依据超过 ${EVIDENCE_MAX} 条`);
  const bad = evidence.find((e) => { const n = ctx.lines(e.file); return n === null || e.line < 1 || e.line > n; });
  if (bad) return escalate(`依据无效（不在批准路径或行号不存在）：${bad.file.slice(0, 200)}:${bad.line}`);
  if (type !== "specDecided") return { verdict: "answer", type, answer, evidence, reason: "", pending };
  const off = evidence.find((e) => !ctx.specPath || e.file !== ctx.specPath);
  if (off) return escalate(`规格已定的依据只能是规格文件的行：${off.file.slice(0, 200)}:${off.line}`);
  const quoted = specQuotes(evidence, ctx);
  if (!quoted) return escalate("规格行读不到，引不出原文");
  return { verdict: "answer", type, answer: [...quoted, answer].join("\n"), evidence, reason: "", pending };
}

/** specDecided 的答复开头：每条依据一行，代码引用规格原文（批准口吻检查不查这部分，「PM 补 已批准」这类原话可以原样转给提问方） */
function specQuotes(evidence: readonly PmJobEvidence[], ctx: JudgeCtx): string[] | null {
  const out: string[] = [];
  for (const n of [...new Set(evidence.map((e) => e.line))]) {
    const l = ctx.specLine?.(n);
    if (l === null || l === undefined) return null;
    const t = clean(l);
    out.push(`规格第 ${n} 行：『${t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}…` : t}』`);
  }
  return out;
}

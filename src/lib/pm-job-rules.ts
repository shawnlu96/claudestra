/**
 * PM 处理员的白名单与升级判定（agents-PMJOB1，规格 PM 定 2 / 3），全是代码规则，模型改不了：
 * - forbiddenOf：按问题原文（含候选项）判这张单能不能当直回候选，不靠模型自报。三道门，命中任何一道就只出草稿、原通知立刻送 PM：
 *   ① 必须升级的类别（改规格 / 改范围 / 七类 owner 决策 / 凭据安全），中英文都认；② 问的是「能不能 / 可不可以 / can I」这类要人点头的事；
 *   ③ 保守白名单：问题本身要像查证（问规格 / 验收线 / 范围 / 标准答复 / 某个文件「是什么、多少、在哪」），不像的一律不接成直回。
 * - judgePmJobOutput：模型输出要是约定的 JSON、类型是白名单自有的三类之一、自称有把握、答复里没有批准口吻、每条依据都是批准路径里
 *   真实存在的 文件:行，才算可直回；其余（解析不了、无依据、材料缺、没把握、类型不认识）一律升级。
 */
import { PM_JOB_TYPES, type PmJobEvidence, type PmJobResult } from "./pm-job-types.js";

/** 一句之内（不跨标点 / 换行）的间隔 */
const GAP = "[^\\n，。；,.;?？!！]";
const re = (...parts: string[]): RegExp => new RegExp(parts.join("|").replaceAll("~", GAP), "i");

const FORBIDDEN: readonly [id: string, label: string, re: RegExp][] = [
  ["spec", "改规格", re("改规格", "规格~{0,12}(?:改|调整|变更|重写|补一?条|加一?条)", "(?:修改|更新|调整|重写)~{0,8}规格", "验收线~{0,8}(?:改|放宽|删|去掉)",
    "\\b(?:chang|modif|edit|rewrit|amend|relax|loosen|waiv|drop|remov|skip|updat|alter)\\w*\\b~{0,40}"
      + "\\b(?:spec(?:ification)?s?|acceptance|criteri\\w+|requirements?)\\b")],
  ["scope", "改范围", re("扩围", "改范围", "加进(?:本卡)?范围", "范围~{0,8}(?:加|扩|放开|调整)", "fileGlobs~{0,20}(?:加|追加|改|add|append|chang|extend)", "(?:改|动|碰)~{0,12}(?:未列|范围外)",
    "\\b(?:chang|expand|extend|widen|broaden|enlarg|increas|adjust|modif|alter|updat)\\w*\\b~{0,40}\\bscope\\b",
    "\\bscope\\b~{0,40}\\b(?:chang|expand|extend|widen|includ|add|cover)\\w*",
    "\\bout[- ]of[- ]scope\\b", "\\b(?:outside|beyond)\\b~{0,20}\\bscope\\b", "\\b(?:unlisted|not listed)\\b")],
  ["permission", "权限", re("权限", "授权", "提权", "allowlist", "白名单~{0,8}(?:加|扩|放开)",
    "\\bpermissions?\\b", "\\bauthori[sz]\\w*", "\\bprivileg\\w*", "\\b(?:grant|elevat)\\w*\\b", "\\bsudo\\b")],
  ["delete", "删数据", re("删(?:除|掉)?~{0,12}(?:数据|台账|记录|表|库|备份|状态文件)", "清空", "drop\\s+table", "truncate", "rm\\s+-",
    "\\b(?:delet|remov|drop|wip|purg|eras|destroy|clear|reset)\\w*\\b~{0,40}\\b(?:data|databases?|db|records?|rows?|tables?|ledger|backups?|state|history|logs?)\\b")],
  ["release", "release", re("\\breleas\\w*", "发版", "发布(?:版本|正式)", "上线正式", "\\b(?:publish|ship|deploy)\\w*\\b~{0,20}\\b(?:version|prod\\w*)\\b")],
  ["tag", "tag", re("git\\s+tag", "打\\s*tag", "\\btag(?:s|ged|ging)?\\b", "版本号", "\\bversion (?:bump|number)\\b")],
  ["ratelimit", "中心限流", re("限流", "限频", "rate.?limit", "\\bthrottl\\w*")],
  ["schema", "schema", re("schema", "表结构", "加(?:一)?列", "迁移脚本", "migrat\\w*", "ALTER\\s+TABLE", "\\b(?:add|drop|alter|renam)\\w*\\b~{0,20}\\bcolumns?\\b")],
  ["quotaline", "改额度线", re("额度线", "codexWeeklyLinePct", "codex-line", "借额度", "换\\s*Claude", "\\bquota\\b~{0,30}\\b(?:line|limit|threshold|cap)\\b",
    "\\b(?:rais|bump|borrow|increas|lift)\\w*\\b~{0,30}\\b(?:quota|budget)\\b")],
  ["owner", "owner 决策", re("owner", "所有者", "拍板", "老板", "\\bsign[- ]?off\\b")],
  ["secret", "凭据 / 安全", re("凭据", "密钥", "token", "密码", "\\.env", "\\.pem", "auth\\.json", "安全漏洞", "\\bcredentials?\\b", "\\bsecrets?\\b", "\\bpasswords?\\b",
    "\\bapi.?keys?\\b", "\\bprivate keys?\\b", "\\bvulnerabilit\\w*")],
  // 要人点头的问法：不管问的是什么，都不是「查证」
  ["decide", "请求批准 / 决策", re("可以", "能不能", "能否", "可否", "可不可以", "要不要", "该不该", "应不应该", "需不需要", "行不行", "好不好",
    "能~{0,20}[吗么]", "需要~{0,20}[吗么]", "申请", "请批", "求批", "准许", "放行", "(?:是否|能否)(?:批准|同意|允许)", "(?:批准|同意|允许)[吗么我]", "我们?(?:想|打算|准备|计划|建议)", "建议(?:改|把|将)",
    "\\b(?:can|may|could|should|shall|must|might)\\s+(?:i|we)\\b", "\\b(?:am i|are we)\\s+(?:allowed|permitted|free|supposed)\\b",
    "\\b(?:is it|would it be|is that|is this)\\s+(?:ok|okay|fine|acceptable|allowed|permitted|safe)\\b",
    "\\ballow(?:ed|s|ing)?\\b", "\\bapprov\\w*", "\\bpermit(?:s|ted)?\\b",
    "\\b(?:i|we)(?:'d| would)? (?:want|like|plan|intend|propose|need)\\b", "\\blet (?:me|us)\\b", "\\bok(?:ay)? (?:to|if)\\b", "\\bdo you mind\\b")],
];

/** 查证问题要同时有：问的对象（规格 / 验收线 / 范围 / 标准答复 / 实现 / 某个文件）和问事实的问法 */
const SUBJECT = re("规格", "验收", "范围", "标准答复", "实现", "定义", 
  "\\b(?:spec(?:ification)?|acceptance|criteri\\w+|scope|standard answers?|implement\\w*|defined?)\\b", "[\\w-]+\\.(?:tsx?|jsx?|mjs|md|json|sh|py|css|html)\\b");
const FACT = re("多少", "什么", "哪", "几", "指的?是", "是指", "算不算", "是不是", "含不含", "包不包[括含]", 
  "\\b(?:what|which|where|how many|how much)\\b", "\\b(?:does|do|is|are)\\b~{0,60}\\b(?:mean|say|refer|cover|include|count|defined?|located|implemented|live)\\b");
const NOT_LOOKUP = "不像白名单内的查证问题";
/** 批准口吻：处理员没有批准权，答复里出现就不直回 */
const GRANT = re("\\bapproved?\\b", "\\bgo ahead\\b", "\\byou (?:may|can|are (?:allowed|free|permitted))\\b", "\\bpermitted\\b", "\\bgranted\\b",
  "\\bfeel free\\b", "已?批准", "准许", "放行", "同意(?:你|了|这)", "可以(?:改|删|扩|加|发|动|直接|这么|这样)", "你可以", "没问题");

/** 匹配前归一：全角 / 兼容字形折成普通字形，去零宽与格式控制字符（拆词绕不过去） */
const norm = (s: string): string => s.normalize("NFKC").replace(/\p{Cf}+/gu, "");

/** 这个问题不能当直回候选的原因（标签）；null = 像白名单内的查证问题，可以交处理员试答 */
export function forbiddenOf(question: string): string | null {
  const q = norm(question);
  return FORBIDDEN.find(([, , r]) => r.test(q))?.[1] ?? (SUBJECT.test(q) && FACT.test(q) ? null : NOT_LOOKUP);
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
  /** 接单时代码判出的必须升级类别 */
  forbidden: string | null;
  /** 这个仓库相对路径（或规格文件）在批准路径里的行数；不在批准路径 / 读不到 = null */
  lines(file: string): number | null;
}

const ANSWER_MAX = 2000;
const clean = (s: string): string => s.replace(/\p{Cf}+/gu, "").replace(/[\u2028\u2029]/g, "\n").replace(/[^\S\n]+/g, " ").trim();

export function judgePmJobOutput(text: string, ctx: JudgeCtx): PmJobResult {
  const raw = parseOutput(text);
  const pending = Array.isArray(raw?.pending) ? raw.pending.filter((p): p is string => typeof p === "string").map((p) => clean(p).slice(0, 300)).slice(0, 10) : [];
  const type = typeof raw?.type === "string" ? raw.type.slice(0, 40) : "unknown";
  const answer = typeof raw?.answer === "string" ? clean(raw.answer).slice(0, ANSWER_MAX) : "";
  const evidence: PmJobEvidence[] = (Array.isArray(raw?.evidence) ? raw.evidence : []).flatMap((e) => {
    const file = (e as PmJobEvidence | null)?.file, line = (e as PmJobEvidence | null)?.line;
    return typeof file === "string" && typeof line === "number" && Number.isInteger(line) ? [{ file, line }] : [];
  }).slice(0, 20);
  const escalate = (reason: string): PmJobResult => ({ verdict: "escalate", type, answer, evidence, reason, pending });
  if (!raw) return escalate("处理员输出不是约定的 JSON");
  if (ctx.forbidden) return escalate(`问题属于必须由 PM 处理的类别：${ctx.forbidden}`);
  if (!Object.hasOwn(PM_JOB_TYPES, type)) return escalate(`不在白名单的问题类型：${type}`);
  if (raw.confident !== true) return escalate(`处理员没把握${typeof raw.reason === "string" ? `：${clean(raw.reason).slice(0, 300)}` : ""}`);
  if (!answer) return escalate("处理员没有给出答复");
  if (GRANT.test(norm(answer))) return escalate("答复带批准口吻，处理员没有批准权");
  if (!evidence.length) return escalate("答复没有 文件:行 依据");
  const bad = evidence.find((e) => { const n = ctx.lines(e.file); return n === null || e.line < 1 || e.line > n; });
  if (bad) return escalate(`依据无效（不在批准路径或行号不存在）：${bad.file.slice(0, 200)}:${bad.line}`);
  return { verdict: "answer", type, answer, evidence, reason: "", pending };
}

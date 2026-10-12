/**
 * PM 处理员的白名单与升级判定（agents-PMJOB1，规格 PM 定 2 / 3），全是代码规则，模型改不了：
 * - forbiddenOf：按问题原文判必须升级给 PM 的类别（改规格 / 改范围 / 七类 owner 决策 / 凭据安全）；命中的单不直回，只出草稿。
 * - judgePmJobOutput：模型输出要是约定的 JSON、类型在白名单里、自称有把握、每条依据都是批准路径里真实存在的 文件:行，才算可直回；
 *   其余（解析不了、无依据、材料缺、没把握、类型不认识）一律升级。
 */
import { PM_JOB_TYPES, type PmJobEvidence, type PmJobResult } from "./pm-job-types.js";

const FORBIDDEN: readonly [id: string, label: string, re: RegExp][] = [
  ["spec", "改规格", /改规格|规格[^\n，。；]{0,12}(?:改|调整|变更|重写|补一?条|加一?条)|(?:修改|更新|调整|重写)[^\n，。；]{0,8}规格|验收线[^\n，。；]{0,8}(?:改|放宽|删|去掉)/],
  ["scope", "改范围", /扩围|改范围|加进(?:本卡)?范围|范围[^\n，。；]{0,8}(?:加|扩|放开|调整)|fileGlobs[^\n，。；]{0,12}(?:加|追加|改)|(?:改|动|碰)[^\n，。；]{0,12}(?:未列|范围外)/],
  ["permission", "权限", /权限|授权|提权|allowlist|白名单[^\n，。；]{0,8}(?:加|扩|放开)/i],
  ["delete", "删数据", /删(?:除|掉)?[^\n，。；]{0,12}(?:数据|台账|记录|表|库|备份|状态文件)|清空|drop\s+table|truncate|rm\s+-rf/i],
  ["release", "release", /\brelease\b|发版|发布(?:版本|正式)|上线正式/i],
  ["tag", "tag", /git\s+tag|打\s*tag|\btag\b|版本号/i],
  ["ratelimit", "中心限流", /限流|限频|rate.?limit/i],
  ["schema", "schema", /schema|表结构|加(?:一)?列|迁移脚本|migration|ALTER\s+TABLE/i],
  ["quotaline", "改额度线", /额度线|codexWeeklyLinePct|codex-line|借额度|换\s*Claude/i],
  ["owner", "owner 决策", /owner|所有者|拍板|老板/i],
  ["secret", "凭据 / 安全", /凭据|密钥|token|密码|\.env|\.pem|auth\.json|安全漏洞/i],
];

/** 问题原文命中的必须升级类别（标签），没命中 = null */
export function forbiddenOf(question: string): string | null {
  return FORBIDDEN.find(([, , re]) => re.test(question))?.[1] ?? null;
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
  if (!(type in PM_JOB_TYPES)) return escalate(`不在白名单的问题类型：${type}`);
  if (raw.confident !== true) return escalate(`处理员没把握${typeof raw.reason === "string" ? `：${clean(raw.reason).slice(0, 300)}` : ""}`);
  if (!answer) return escalate("处理员没有给出答复");
  if (!evidence.length) return escalate("答复没有 文件:行 依据");
  const bad = evidence.find((e) => { const n = ctx.lines(e.file); return n === null || e.line < 1 || e.line > n; });
  if (bad) return escalate(`依据无效（不在批准路径或行号不存在）：${bad.file.slice(0, 200)}:${bad.line}`);
  return { verdict: "answer", type, answer, evidence, reason: "", pending };
}

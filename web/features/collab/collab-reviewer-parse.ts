/**
 * 审查员子 agent 的 description → 审的是哪条任务、第几轮、是不是对抗式（T12c）。纯函数，单测 tests/web-collab-reviewers.test.ts。
 * 规则收紧成「审查关键词在开头、审查对象紧跟其后」：PM 的子 agent 标题里提到 review 的远不止审查员
 * （「Fix T5 review findings」「Merge T12b after review」「Write T12d spec from T12c review」），挂错了还会把真实的「卡住」
 * 降成「等待」（审查 T12C r1 P2-2）。认的写法：
 *   [前缀] 关键词 [of|for|on] 对象 [轮次]      Review T12c r2 · Adversarial final review of T6a · Code-review T5 · Review PR #150
 *   [前缀] 审查|复核|审核 对象 [轮次]           复核 T8e 第 2 轮 · 对抗式审查 T14 · 审查T5第2轮
 *   对象 [:] 关键词 [轮次]                      T5: review · T5 审查 第二轮
 * 对象是台账里有的任务号（大小写不敏感，大小写全对的优先；形如 R2 的词是轮次写法，不当任务号），或 PR #N（按任务的 pr 对上）。
 * 轮次只认紧跟在对象（或第三种写法的关键词）后面的 round N / rN / 第 N 轮，「(reviewer r3 left)」「v2 r10」不算。
 */

export interface ReviewerHit {
  taskId: string;
  /** 标题里写了第几轮；没写为 null，由台账推 */
  round: number | null;
  adversarial: boolean;
}

export interface ReviewTarget {
  id: string;
  pr?: string | null;
}

const PREFIX = String.raw`(?:(?:adversarial|final|targeted|independent|second|quick|full|对抗式|对抗|最终)[\s-]*)*`;
const EN_KW = String.raw`(?:code[\s-]?)?(?:re-?review(?:ing)?|review(?:ing)?|re-?check(?:ing)?|audit(?:ing)?)(?![a-z])`;
const ZH_KW = "(?:审查|复核|审核)";
const CONNECT = String.raw`(?:\s*[:：-]\s*|\s+)(?:(?:of|for|on)\s+)?`;
/** 对象：PR #N，或一个由字母数字与连字符组成的词（再去台账里对） */
const TARGET = String.raw`(PR\s*#?\d+|[A-Za-z0-9][A-Za-z0-9-]*)`;

const FORMS: RegExp[] = [
  new RegExp(`^${PREFIX}${EN_KW}${CONNECT}${TARGET}`, "i"),
  new RegExp(`^${PREFIX}${ZH_KW}\\s*${TARGET}`, "i"),
  new RegExp(`^${TARGET}\\s*[:：-]?\\s*(?:${PREFIX}(?:${EN_KW}|${ZH_KW}))`, "i"),
];
const ADVERSARIAL_RE = /adversarial|对抗/i;
const ZH_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROUND_RE = /^\s*[,，·-]?\s*(?:round\s*(\d{1,3})(?!\d)|r(\d{1,3})(?![a-z0-9])|第\s*(\d{1,3}|[一二三四五六七八九十])\s*轮)/i;

function resolveTarget(token: string, targets: readonly ReviewTarget[]): string | null {
  const pr = /^PR\s*#?(\d+)$/i.exec(token);
  if (pr) {
    const hit = targets.find((t) => t.pr && new RegExp(`(?:^|[^\\d])${pr[1]}$`).test(t.pr.trim().replace(/\/+$/, "")));
    return hit?.id ?? null;
  }
  if (/^r\d+$/i.test(token)) return null;
  const same = targets.filter((t) => t.id.toLowerCase() === token.toLowerCase());
  return (same.find((t) => t.id === token) ?? same[0])?.id ?? null;
}

function roundAt(rest: string): number | null {
  const m = ROUND_RE.exec(rest);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  return ZH_NUM[raw] ?? Number(raw);
}

export function parseReviewer(title: string, targets: readonly ReviewTarget[]): ReviewerHit | null {
  const t = title.replace(/^\s*🤖\s*/u, "").trim();
  for (const re of FORMS) {
    const m = re.exec(t);
    if (!m) continue;
    const taskId = resolveTarget(m[1], targets);
    if (!taskId) return null;
    return { taskId, round: roundAt(t.slice(m[0].length)), adversarial: ADVERSARIAL_RE.test(t.slice(0, m[0].length)) };
  }
  return null;
}

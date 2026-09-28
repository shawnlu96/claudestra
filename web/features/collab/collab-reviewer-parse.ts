/**
 * 审查员子 agent 的 description → 审的是哪条任务、第几轮、是不是对抗式（T12c）。纯函数，单测 tests/web-collab-reviewers.test.ts。
 * 这是兜底：台账有了 dispatch 事件（T30）后协作视图优先认台账，这里只求常见写法挂对、别的宁可不挂，别再往复杂里写。
 * 规则是「审查关键词在开头、审查对象紧跟其后」——PM 的子 agent 提到 review 的远不止审查员（Fix T5 review findings）：
 *   [前缀] review|recheck|audit [of|the|task] 对象 [轮次]   Review T12c r2 · Adversarial final review of T6a · Review PR #150 (T26)
 *   adversarial [final] 对象                               Adversarial final T13a
 *   [前缀] 审查|复核|审核 对象 [轮次]                       审查 T12c 第二轮 · 复核T5的修复
 *   [对] 对象 [第 N 轮] [做][对抗式] 审查|复核|审核            T12c 第二轮审查 · 对 T12c 做对抗式审查
 *   对象 [:] review [轮次]，关键词后面只能是结尾 / 轮次 / 标点   T5: review（「T5 review findings fix」不算）
 * recheck / audit 比 review 宽泛（Recheck T5 CI status），对象后面只接受结尾、轮次、标点或 P0-P2 / fix 字样。
 * 对象是台账任务号（大小写不敏感，大小写全对的优先；R2 这类是轮次不是任务号；T12c-r2 拆成 T12c + 第 2 轮），
 * 或 PR #N（按任务的 pr 对上；后面括号里写了任务号就以括号为准）。先做 NFKC，全角 ＃ 与全角数字按半角认。
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
const REVIEW = String.raw`(?:code[\s-]?)?(?:re-?)?review(?:ing)?`;
const LOOSE = String.raw`re-?check(?:ing)?|audit(?:ing)?`;
const ZH_KW = "(?:审查|复核|审核)";
const CONNECT = String.raw`(?:\s*[:：-]\s*|\s+)(?:(?:of|for|on|the|task)\s+)*`;
const TARGET = String.raw`((?:PR\s*)?#\d+|PR\s*\d+|[A-Za-z0-9][A-Za-z0-9-]*)`;
const ROUND = String.raw`(?:round\s*\d{1,3}|r\d{1,3}|第\s*(?:\d{1,3}|[一二三四五六七八九十])\s*轮)`;
/** 关键词 / 对象之后「到此为止」：结尾、轮次或标点 */
const STOP = String.raw`(?=\s*(?:$|${ROUND}(?![a-z0-9])|[,，.。;；:：(（)）]))`;

/** [正则, 宽泛关键词要检查对象后面的内容] */
const FORMS: [RegExp, boolean][] = [
  [new RegExp(`^${PREFIX}${REVIEW}(?![a-z])${CONNECT}${TARGET}`, "i"), false],
  [new RegExp(`^${PREFIX}(?:${LOOSE})(?![a-z])${CONNECT}${TARGET}`, "i"), true],
  [new RegExp(`^adversarial(?:[\\s-]+final)?[\\s-]+${TARGET}`, "i"), false],
  [new RegExp(`^${PREFIX}${ZH_KW}\\s*${TARGET}`, "i"), false],
  [new RegExp(`^对?\\s*${TARGET}\\s*(?:${ROUND}\\s*)?(?:做)?\\s*${PREFIX}${ZH_KW}`, "i"), false],
  [new RegExp(`^${TARGET}\\s*[:：-]?\\s*${PREFIX}(?:${REVIEW}|${LOOSE})${STOP}`, "i"), false],
];
const LOOSE_TAIL = new RegExp(`^\\s*(?:$|${ROUND}(?![a-z0-9])|[,，.。;；:：(（)）]|p[0-2](?![a-z0-9])|fix)`, "i");
const ADVERSARIAL_RE = /adversarial|对抗/i;
const ZH_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROUND_RE = /(?:round\s*(\d{1,3})(?!\d)|r(\d{1,3})(?![a-z0-9])|第\s*(\d{1,3}|[一二三四五六七八九十])\s*轮)/i;
const ROUND_AFTER = new RegExp(`^\\s*[,，·(（-]?\\s*${ROUND_RE.source}`, "i");

function toRound(m: RegExpExecArray | null): number | null {
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  return ZH_NUM[raw] ?? Number(raw);
}

function byId(token: string, targets: readonly ReviewTarget[]): string | null {
  if (/^r\d+$/i.test(token)) return null;
  const same = targets.filter((t) => t.id.toLowerCase() === token.toLowerCase());
  return (same.find((t) => t.id === token) ?? same[0])?.id ?? null;
}

/** 对象 → 任务号 + 从对象里拆出来的轮次（T12c-r2） */
function resolve(token: string, rest: string, targets: readonly ReviewTarget[]): { id: string | null; round: number | null } {
  const pr = /^(?:PR\s*)?#?(\d+)$/i.exec(token);
  if (pr && /^(?:PR|#)/i.test(token)) {
    // 括号里写了任务号就以它为准：PR 号可能没填进台账，也可能填错
    const paren = /^\s*[(（]\s*([A-Za-z0-9][A-Za-z0-9-]*)\s*[)）]/.exec(rest);
    const fromParen = paren ? byId(paren[1], targets) : null;
    if (paren) return { id: fromParen, round: null };
    const hit = targets.find((t) => t.pr && new RegExp(`(?:^|[^\\d])${pr[1]}$`).test(t.pr.trim().replace(/\/+$/, "")));
    return { id: hit?.id ?? null, round: null };
  }
  const direct = byId(token, targets);
  if (direct) return { id: direct, round: null };
  const split = /^(.+?)-r(\d{1,3})$/i.exec(token);
  return split ? { id: byId(split[1], targets), round: Number(split[2]) } : { id: null, round: null };
}

export function parseReviewer(title: string, targets: readonly ReviewTarget[]): ReviewerHit | null {
  const t = title.normalize("NFKC").replace(/^\s*🤖\s*/u, "").trim();
  for (const [re, loose] of FORMS) {
    const m = re.exec(t);
    if (!m) continue;
    const rest = t.slice(m.index + m[0].length);
    if (loose && !LOOSE_TAIL.test(rest)) return null;
    const { id, round } = resolve(m[1], rest, targets);
    if (!id) return null;
    const head = t.slice(0, m.index + m[0].length);
    // 轮次：对象里拆出来的（T12c-r2）→ 对象和关键词之间的（T12c 第二轮审查）→ 紧跟在后面的（Review T12c r2）
    const between = head.slice(head.indexOf(m[1]) + m[1].length);
    return { taskId: id, round: round ?? toRound(ROUND_RE.exec(between)) ?? toRound(ROUND_AFTER.exec(rest)), adversarial: ADVERSARIAL_RE.test(head) };
  }
  return null;
}

/**
 * 开卡预检的观察期核对（merge-arch-SPECOBS1）：code / ui / security 规格都要有唯一的「## 上线后 PM」，正文第一个非空行是
 * 「观察期：N 小时」（N ≥ 1 整数），随后至少一行 PM 核对动作。取节用提醒侧同一个 postVerifySection（围栏感知、标题后空行忽略），
 * 首行用同一个 parseObservation（中英文冒号 / 空格、超过 168 按 168 封顶），两边读出来的观察期不会不一样。
 * 恢复键 specObservationHours（缺省 observe）：on = preflightStart 在建卡 / worktree / agent、资源申领之前拒 spec_lint；
 * observe = 放行，将拒原因按 project + 卡号 + 规格摘要 + 规则版本去重记一份 statePath("spec-observation")/<键摘要>.json（独占创建 = 并发也只记一次；
 * 不写台账 note：预检本不写台账，开卡流程的既有台账记录保持原样）；off = 不跑。UI 必填 / 授权闸不受它影响。
 * tests/spec-lint-observation.test.ts、tests/dag-tools-start-observation.test.ts。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "./paths.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { parseObservation } from "./scheduler-post-verify-defer.js";
import { postVerifySection } from "./scheduler-post-verify-ledger.js";
import { headingCount } from "./spec-lint-section.js";
import { readTextSoft } from "./task-spec.js";

/** 认法变了就加一：observe 的去重记录带它，规则改了同一份规格会重新记 */
export const SPEC_OBSERVATION_RULE = 1;
const HEADING = "## 上线后 PM";
const FORMAT = "正文第一行整行写「观察期：N 小时」（N 为 1 以上整数，超过 168 按 168 算），下一行起写上线后 PM 要核的动作";
const NOT_BODY = /^(?:[-*+]\s|\d+[.)]\s|>|#{1,6}\s|```|~~~)/;
const HEAD_ONLY = /^(?:#{1,6}\s|```|~~~)/;

/** 规格的观察期问题；null = 通过。text 为 null / 空 = 没有规格 */
export function lintObservation(text: string | null | undefined): string | null {
  if (!text?.trim()) return `缺规格 / 缺观察期：开卡前先写规格，并在「${HEADING}」${FORMAT}`;
  const n = headingCount(text, HEADING);
  if (n > 1) return `「${HEADING}」出现了 ${n} 次：只留一节，${FORMAT}`;
  const body = postVerifySection(text);
  if (!body) return `${n ? `「${HEADING}」是空节` : `缺「${HEADING}」`}：补上这一节，${FORMAT}`;
  const [first, ...rest] = body.split(/\r?\n/);
  const o = parseObservation(body);
  if (o === null) {
    const where = body.includes("观察期") ? "观察期没写在正文第一行（写到了后面的行、子标题或代码块里不算）" : "正文第一行没写观察期";
    return `「${HEADING}」${where}：${FORMAT}`;
  }
  if (o === "bad") {
    const why = NOT_BODY.test(first.trim()) ? "观察期写在列表项 / 引用 / 子标题 / 代码块里，不算正文首行" : `「${first.trim().slice(0, 60)}」格式没认出`;
    return `「${HEADING}」${why}：${FORMAT}`;
  }
  if (!rest.some((l) => l.trim() && !HEAD_ONLY.test(l.trim()))) return `「${HEADING}」只有观察期，没有 PM 核对动作：${FORMAT}`;
  return null;
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);

/** observe 的记录：同一键只有第一次写成（wx），已有就不再写 */
function recordWouldRefuse(dir: string, rec: { project: string; taskId: string; digest: string; reason: string; at: number }): void {
  const key = JSON.stringify([rec.project, rec.taskId, rec.digest, SPEC_OBSERVATION_RULE]);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, `${digest(key)}.json`), `${JSON.stringify({ ...rec, rule: SPEC_OBSERVATION_RULE, mechanism: "specObservationHours" })}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/**
 * preflightStart 用：inline 是 spec 参数给的正文，没有就读 <ledgerDir>/docs/tasks/<卡号>.md（与 uiSpecGate 同一份）。
 * 返回拒绝原因只在 on 档；observe 去重记一份后放行（记不上不拦开卡），off 不读规格。observeDir 缺省 statePath("spec-observation")。
 */
export function observationGate(q: { ledgerDir: string; project: string; taskId: string; inline?: string },
  opts: { policy?: RecoveryPolicyPort; now?: number; observeDir?: string } = {}): string | null {
  const mode = (opts.policy ?? recoveryPolicy)(q.project, "specObservationHours").mode;
  if (mode === "off") return null;
  const text = q.inline ?? readTextSoft(join(q.ledgerDir, "docs", "tasks", `${q.taskId}.md`));
  const why = lintObservation(text);
  if (!why || mode === "on") return why;
  try {
    recordWouldRefuse(opts.observeDir ?? statePath("spec-observation"),
      { project: q.project, taskId: q.taskId, digest: digest(text ?? ""), reason: why, at: opts.now ?? Date.now() });
  } catch (e) {
    console.error(`⚠️ 观察期核对（observe）没记上 ${q.taskId}：${(e as Error).message}`);
  }
  return null;
}

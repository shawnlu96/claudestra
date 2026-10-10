import type { WriteOffer } from "./ledger-lend-lease.js";
import type { WriteProbe } from "./lend-write-materials.js";
import type { OrderWire } from "./order-wire.js";
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { fixBounce } from "./scheduler-merge-conflict.js";

const ENV = "远端工作副本环境：";
const REF = "refs/remotes/origin/HEAD";
const STOP = "基线 ref 缺失或 SHA 不符就停止并交回本机处理，不自行猜测基线";
/** Fix orders without a merge bounce carry no baseline SHA: the worker may only merge the ref against a value the PM wrote in the spec. */
export const FIX_MAIN_LINE = `副本禁止 fetch。规格或审查要求合入 main 时，用 git rev-parse ${REF} 核对前 12 位，等于规格里 PM 写的核对值才合入这个 ref；规格没写核对值就不合，交付说明里写明。`;

/** The material slot already reaches the order builder; bounce orders never consume a review report. */
export async function lendFixMaterials(fp: string, q: { repo: string; base: string }, probe: WriteProbe,
  ctx?: { db: Database; task: LedgerTask }): Promise<WriteOffer> {
  const r = await probe.remoteHead(q.repo, q.base);
  const sha = r.ok && /^[a-f0-9]{40}$/i.test(r.head) ? r.head.slice(0, 12).toLowerCase() : null;
  const note = `${ENV}${sha ? `本机查询基线 ${q.base} 的 SHA 前 12 位为 ${sha}；` : "本机未能核定基线 SHA，停止并交回本机处理；"}` +
    `用 git rev-parse ${REF} 核对 SHA 前 12 位${sha ? `等于 ${sha}` : "（尚无可核对值）"}；${STOP}。`;
  const events = ctx ? listEvents(ctx.db, { project: ctx.task.project, target: ctx.task.id }) : [];
  const b = ctx ? fixBounce(events, ctx.task.stage) : null;
  const seq = events.findLast((e) => e.kind === "stage" && e.data.to === ctx?.task.stage)?.seq;
  const omitted = b?.cause === "update_fail" && HEX40.test(b.error ?? "") ? withheldError(seq) : null;
  return { fp, base: q.base, baseSha: null, report: JSON.stringify({ note, omitted }) };
}

const HEX40 = /[a-f0-9]{40}/i;

/** Hash-bearing errors can also contain credentials; retain the whole original locally rather than rewrite its tokens. */
function withheldError(seq?: number): string {
  return ["更新分支失败：update_fail", Number.isSafeInteger(seq) ? `本机事件 #${seq}` : "本机事件号未提供，请发起方核对台账",
    "原文含提交号，留在发起方台账"].join("；");
}

function environment(report: string | null): { note: string; omitted: string | null } | null {
  if (!report?.startsWith('{"note":')) return null;
  try {
    const value = JSON.parse(report);
    return typeof value.note === "string" && value.note.startsWith(ENV)
      && (value.omitted === null || typeof value.omitted === "string" && !HEX40.test(value.omitted)) ? value : null;
  } catch {
    return null; // Invalid internal material has no trustworthy baseline; the order's fallback requires local handling.
  }
}

export function lendFixEnv(wire: OrderWire, bounce: { inputs: string[]; acceptance: string[] } | null | undefined, report: string | null): OrderWire {
  if (!bounce) return wire.step !== "fix" || wire.acceptance.includes(FIX_MAIN_LINE) ? wire : { ...wire, acceptance: [...wire.acceptance, FIX_MAIN_LINE] };
  const needsBase = bounce.acceptance.some((s) => s.includes("git fetch"));
  const material = environment(report);
  const env = material?.note ?? `${ENV}用 git rev-parse ${REF} 读取 SHA；本机未提供核对值，停止并交回本机处理；${STOP}。`;
  const inputs = wire.inputs.map((s) => bounce.inputs.includes(s) && s.startsWith("更新分支失败：") && HEX40.test(s)
    ? material?.omitted ?? withheldError() : s);
  const acceptance = wire.acceptance.map((s) => s.replace("git fetch 后合入最新 origin/main", `核对基线后合入 ${REF}`)
    .replace("推送后报新 head", "提交后用 deliver 报新 head，由出借服务推送"));
  if (needsBase) {
    inputs.push(env);
    if (bounce.inputs.some((s) => s.startsWith("解冲突："))) inputs.push("冲突单还须核对 ref 的 SHA 与退回原因中的 main SHA 一致；不一致就停止并交回本机处理");
    acceptance.push("副本禁止 fetch、禁止改 git 配置；基线核对通过后才能合入");
  }
  return { ...wire, inputs, acceptance };
}

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

/** The material slot already reaches the order builder; bounce orders never consume a review report. */
export async function lendFixMaterials(fp: string, q: { repo: string; base: string }, probe: WriteProbe,
  ctx?: { db: Database; task: LedgerTask }): Promise<WriteOffer> {
  const r = await probe.remoteHead(q.repo, q.base);
  const sha = r.ok && /^[a-f0-9]{40}$/i.test(r.head) ? r.head.slice(0, 12).toLowerCase() : null;
  const note = `${ENV}${sha ? `本机查询基线 ${q.base} 的 SHA 前 12 位为 ${sha}；` : "本机未能核定基线 SHA，停止并交回本机处理；"}` +
    `用 git rev-parse ${REF} 核对 SHA 前 12 位${sha ? `等于 ${sha}` : "（尚无可核对值）"}；${STOP}。`;
  const b = ctx ? fixBounce(listEvents(ctx.db, { project: ctx.task.project, target: ctx.task.id }), ctx.task.stage) : null;
  const known = [ctx?.task.headSHA, b?.prHead, b?.mainHead, r.ok ? r.head : null].filter((s): s is string => !!s && /^[a-f0-9]{40}$/i.test(s));
  return { fp, base: q.base, baseSha: null, report: JSON.stringify({ note, known }) };
}

/** Hex values are commit references only when ledger facts or the baseline probe establish their identity. */
const shortSha = (s: string, known: Set<string>): string => s.replace(/[a-f0-9]+/gi,
  (hex) => known.has(hex) ? `${hex.slice(0, 12)}（SHA 已缩为 12 位）` : hex);

function environment(report: string | null): { note: string; known: string[] } | null {
  if (!report?.startsWith('{"note":')) return null;
  try {
    const value = JSON.parse(report);
    return typeof value.note === "string" && value.note.startsWith(ENV) && Array.isArray(value.known)
      && value.known.every((s: unknown) => typeof s === "string" && /^[a-f0-9]{40}$/i.test(s)) ? value : null;
  } catch {
    return null; // Invalid internal material has no trustworthy baseline; the order's fallback requires local handling.
  }
}

export function lendFixEnv(wire: OrderWire, bounce: { inputs: string[]; acceptance: string[] } | null | undefined, report: string | null): OrderWire {
  if (!bounce) return wire;
  const needsBase = bounce.acceptance.some((s) => s.includes("git fetch"));
  const material = environment(report), known = new Set([wire.head, ...(material?.known ?? [])].filter((s): s is string => !!s));
  const env = material?.note ?? `${ENV}用 git rev-parse ${REF} 读取 SHA；本机未提供核对值，停止并交回本机处理；${STOP}。`;
  const inputs = wire.inputs.map((s) => bounce.inputs.includes(s) && s.startsWith("更新分支失败：") ? shortSha(s, known) : s);
  const acceptance = wire.acceptance.map((s) => s.replace("git fetch 后合入最新 origin/main", `核对基线后合入 ${REF}`)
    .replace("推送后报新 head", "提交后用 deliver 报新 head，由出借服务推送"));
  if (needsBase) {
    inputs.push(env);
    if (bounce.inputs.some((s) => s.startsWith("解冲突："))) inputs.push("冲突单还须核对 ref 的 SHA 与退回原因中的 main SHA 一致；不一致就停止并交回本机处理");
    acceptance.push("副本禁止 fetch、禁止改 git 配置；基线核对通过后才能合入");
  }
  return { ...wire, inputs, acceptance };
}

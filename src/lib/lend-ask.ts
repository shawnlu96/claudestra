/**
 * 出借的逐单确认（docs/design/remote-capacity.md §1.1、§2.3 第 2 步）：confirm=per-order 时，claim 之前先在 B 的「待你处理」开一张
 * authorize ask（bind.action lend_claim），只认 owner 本人点了「批准」、参数哈希对得上、没过期的答复。正文写明这会让外来任务在 owner 的用户下
 * 跑一个 shell（§5：真正的闸门是 repos 白名单与逐单确认，不是 env -i）。ask 由调度服务经 `ledger lend-ask` 开，核对在服务里读台账做。
 * 纯函数 + 读库，tests/lend-ask.test.ts。
 */
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk, hasAsksTable, MASTER_PROJECT, ownerAnswered, type NewAsk } from "./ledger-asks.js";
import { isFullSha } from "./order-wire.js";

export const LEND_ASK_ACTION = "lend_claim";
export const LEND_APPROVE = "lend_claim_approve";
const LEND_REJECT = "lend_claim_reject";
/** 发起方写死是调度服务：checkAsk 要求核对者 = 发起者，别的 agent 拿同一张卡去核对不算数 */
export const LEND_ASKER = "scheduler";

export interface LendAskParams {
  orderId: string;
  peer: string;
  fp: string | null;
  family: string;
  repo: string;
  pr: number | null;
  head: string;
  taskId: string;
  step: string;
  /** 预计额度的人话（今天第几单 / 占第几个位），由 lend 循环按声明算好 */
  quota: string;
}

const ORDER_ID = /^[\w.:-]{1,200}$/;
const NAME = /^[\w.-]{1,64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const FP = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/i;

/** 参数形状；null = 合法。每个值都进 ask 正文，所以一律按格式收，不收自由文本（quota 由本机代码拼，另限长度与字符） */
export function lendAskProblem(p: unknown): string | null {
  const r = p as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return "参数要是对象";
  const keys = ["orderId", "peer", "fp", "family", "repo", "pr", "head", "taskId", "step", "quota"];
  const extra = Object.keys(r).filter((k) => !keys.includes(k));
  if (extra.length) return `不认识的字段 ${extra.join(", ")}`;
  if (typeof r.orderId !== "string" || !ORDER_ID.test(r.orderId)) return "orderId 格式不对";
  for (const k of ["peer", "family", "taskId", "step"] as const) if (typeof r[k] !== "string" || !NAME.test(r[k] as string)) return `${k} 格式不对`;
  if (r.fp !== null && (typeof r.fp !== "string" || !FP.test(r.fp))) return "fp 格式不对";
  if (typeof r.repo !== "string" || !REPO.test(r.repo)) return "repo 要是 GitHub owner/repo";
  if (r.pr !== null && !(Number.isInteger(r.pr) && (r.pr as number) > 0 && (r.pr as number) < 1e9)) return "pr 要是正整数或 null";
  if (typeof r.head !== "string" || !isFullSha(r.head)) return "head 要是完整 SHA";
  if (typeof r.quota !== "string" || r.quota.length > 200 || /[\p{Cc}]/u.test(r.quota)) return "quota 要是 200 字以内的一行字";
  return null;
}

const bindOf = (p: LendAskParams) => ({ action: LEND_ASK_ACTION, params: p, approve: [LEND_APPROVE] });

export function lendAskInput(p: LendAskParams): NewAsk {
  const bind = bindOf(p);
  const pr = p.pr ? `#${p.pr}（https://github.com/${p.repo}/pull/${p.pr}）` : "（无 PR，按 head 审）";
  const family = p.family === "codex" ? "Codex" : p.family === "claude" ? "Claude" : p.family;
  return {
    project: MASTER_PROJECT, source: "system", kind: "authorize", fromAgent: LEND_ASKER, createdBy: "system:scheduler", blocking: false,
    title: `出借确认：${p.peer} 想借一个 ${family} 位审 ${p.repo}${p.pr ? `#${p.pr}` : ""}`,
    context: `lend.json 对 ${p.peer} 设了逐单确认`,
    body: [
      "这会让一个外来任务在你的用户下跑一个 shell：它和你是同一个系统用户，能读你家目录里的文件、能用你机器上的 git / SSH 凭据。只在你信任对方和这个仓库时批准。",
      `对方：${p.peer}${p.fp ? `（实例指纹 ${p.fp}）` : ""}`,
      `仓库：${p.repo}`,
      `PR：${pr}`,
      `head：${p.head}`,
      `对方的卡：${p.taskId} · ${p.step}`,
      `预计额度：${p.quota}`,
      "批准后调度服务才去领这张单，在单独的新目录里 clone 这个 head、起一个一次性 worker；不批或过期 = 放弃这张单。",
    ].join("\n"),
    options: [{ type: "buttons", buttons: [{ id: LEND_APPROVE, label: "批准这一单", style: "success" }, { id: LEND_REJECT, label: "不借", style: "danger" }] }],
    dedupKey: `lend:${p.orderId}:ask`, askKey: `${LEND_ASK_ACTION}:${p.orderId}`,
    bind: { ...bind, paramsHash: bindHash(bind, LEND_ASKER) },
    extra: { lendOrder: p.orderId },
  };
}

export type LendAskVerdict = { state: "approved" } | { state: "waiting" } | { state: "declined"; reason: string };

/**
 * 这张单的 ask 批了没有：还开着且没过期 = waiting；owner 本人点了批准、参数没变、没过期 = approved；其余一律 declined（不批、过期、被取代、
 * 参数对不上、不是 owner 答的——推不出「批了」就当没批）。
 */
export function lendAskVerdict(db: Database, askId: string, p: LendAskParams, now = Date.now()): LendAskVerdict {
  const a = hasAsksTable(db) ? getAsk(db, askId) : null;
  if (!a) return { state: "declined", reason: `ask ${askId} 不见了` };
  if (a.bind?.action !== LEND_ASK_ACTION) return { state: "declined", reason: `ask ${askId} 授权的不是 ${LEND_ASK_ACTION}` };
  if (a.state === "open" && a.expiresAt > now) return { state: "waiting" };
  const r = checkAsk(a, bindHash(bindOf(p), LEND_ASKER), LEND_ASKER, now);
  if (!r.ok) return { state: "declined", reason: r.reason };
  if (!ownerAnswered(a.answer)) return { state: "declined", reason: `ask ${askId} 不是 owner 本人答的` };
  return { state: "approved" };
}

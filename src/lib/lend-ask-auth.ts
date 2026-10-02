/**
 * 出借 / 借入声明的 owner 按钮卡授权（i28-OA1）：agent 先 `--print-bind` 拿到 bind，用 reply 的 authorize 卡问 owner，owner 点了批准，
 * 带同样的参数加 `--ask <askId>` 执行（manager/lend.ts 接入）。owner / master 不走这里。
 * 核对在 lend.json 写锁里做（参数是锁内实际要写的条目）：checkAsk 原语义 + 动作名一致 + 参数哈希一致 + 这张卡没执行过。
 * 「执行过」是台账里一条 decision 事件（dedupKey ask-exec:<askId>，库里 UNIQUE），也在锁内、写 lend.json 之前记下：
 * 先写文件后记账会让两个并发的进程都核过同一张卡；先记账最坏是这张卡作废、重新发卡（失败关闭）。tests/lend-ask-auth.test.ts。
 */
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk, hasAsksTable } from "./ledger-asks.js";
import { getEventByDedup, LEDGER_PATH, openLedger } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { readLend, type BorrowEntry, type LendEntry, type LendFile } from "./lend-config.js";
import { readLendContext, type Built } from "./lend-policy.js";

export type LendAskAction = "lend_grant" | "lend_revoke" | "borrow_set" | "borrow_off";

export const lendAskAction = (kind: "lend" | "borrow", op: "set" | "off"): LendAskAction =>
  kind === "lend" ? (op === "set" ? "lend_grant" : "lend_revoke") : op === "set" ? "borrow_set" : "borrow_off";

export const ASK_USAGE =
  " ｜ 非 owner / master（agent）：先加 --print-bind 拿到 bind（只打印，不写），用 reply 的 ask（kind authorize，bind 就用它的 action + params，approve 写批准按钮 id）问 owner；" +
  "owner 点了批准，带同样的参数（--until 换成打印出的绝对时间）加 --ask <askId> 执行，一张卡只能执行一次";

const RETRY = "下一步：带同样的参数加 --print-bind 拿到 bind，重新发授权卡给 owner，批了再带 --ask <新 askId> 执行";

/** 被拒（没带 --ask）时追在守卫报错后面的那句 */
export const ASK_HINT = `agent 要执行得先拿到 owner 的按钮卡授权：${RETRY}`;

/** 写进 lend.json 的条目 → bind.params：grantedAt 是写入时刻（每次都变）、出借条目的 roles 是固定值，都不进；其余（含指纹、到期绝对时间）全进 */
export function bindParamsOf(action: LendAskAction, entry: LendEntry | BorrowEntry): Record<string, unknown> {
  if (action === "lend_grant") {
    const { grantedAt: _g, roles: _r, ...rest } = entry as LendEntry;
    return rest;
  }
  return { ...entry };
}

/** revoke / off 的参数：不带 --peer = 全部收回，peer 记 null */
export const offParams = (peer: string | undefined): Record<string, unknown> => ({ peer: peer ?? null });

export interface AskGateDeps {
  db: () => Database;
  now: () => number;
}

const realDeps: AskGateDeps = { db: () => openLedger(LEDGER_PATH), now: () => Date.now() };

export const usedKey = (askId: string): string => `ask-exec:${askId}`;

/**
 * 核对一张卡能不能执行这组参数；能 → 当场记成「已执行」并返回 null，不能 → 返回给 agent 看的报错（checkAsk 的 reason 原样 + 下一步）。
 * 只在 lend.json 写锁里调。
 */
export function consumeAsk(db: Database, askId: string, action: LendAskAction, params: unknown, caller: string, now: number): string | null {
  const deny = (why: string) => `owner 的授权没核过（${askId}）：${why}；${RETRY}`;
  const a = hasAsksTable(db) ? getAsk(db, askId) : null;
  if (a?.bind && a.bind.action !== action) return deny(`${askId} 授权的是 ${a.bind.action}，这次执行的是 ${action}`);
  const r = checkAsk(a, a?.bind ? bindHash({ ...a.bind, params }, caller) : "", caller, now);
  if (!r.ok) return deny(r.reason);
  return tx(db, () => {
    if (getEventByDedup(db, usedKey(askId))) return deny(`${askId} 已经执行过一次，一张卡只能用一次`);
    insertEvent(db, { actor: caller, now, dedupKey: usedKey(askId) }, {
      project: a!.project, target: a!.taskId ?? "", kind: "decision", text: `按 owner 批准的授权卡执行 ${action}`,
      data: { op: "ask_executed", askId, action },
    }, true);
    return null;
  });
}

export interface AskGate {
  /** 包 setEntry 的 build：锁内组好条目后核卡，核不过整次不写 */
  wrap<E extends LendEntry | BorrowEntry, C, F>(build: (ctx: C, file: F) => Built<E>): (ctx: C, file: F) => Built<E>;
  /** revoke / off 在锁内先调：null = 放行 */
  check(params: unknown): string | null;
}

/** caller 是守卫认出的 actor（认不出 = "?"，一律拒） */
export function askGate(askId: string, caller: string, action: LendAskAction, deps: AskGateDeps = realDeps): AskGate {
  const check = (params: unknown): string | null =>
    caller === "?" ? `认不出调用方身份，不能凭授权卡执行；${RETRY}` : consumeAsk(deps.db(), askId, action, params, caller, deps.now());
  return {
    check,
    wrap: (build) => (ctx, file) => {
      const b = build(ctx, file);
      if (!b.ok) return b;
      const no = check(bindParamsOf(action, b.entry));
      return no ? { ok: false, error: no } : b;
    },
  };
}

type Ctx = Awaited<ReturnType<typeof readLendContext>>;

/** `--print-bind`：按现在的 lend.json 与联系人组出这次要写的内容，只打印 bind，不写、不过守卫 */
export async function printBind(
  action: LendAskAction, what: { off: Record<string, unknown> } | { build: (ctx: Ctx, file: LendFile) => Built<LendEntry | BorrowEntry> },
): Promise<Record<string, unknown>> {
  let params: Record<string, unknown>;
  if ("off" in what) params = what.off;
  else {
    const read = await readLend();
    if (read.status === "invalid") return { ok: false, error: `lend.json 无效（${read.error}）` };
    const b = what.build(await readLendContext(), structuredClone(read.file));
    if (!b.ok) return { ok: false, error: b.error };
    params = bindParamsOf(action, b.entry);
  }
  const until = typeof params.until === "string" ? `；执行时 --until 写成 ${params.until}（打印的是绝对时间，相对写法到执行时会变）` : "";
  return {
    ok: true, bind: { action, params },
    message: `用 reply 的 ask {kind:"authorize", bind:{action, params, approve:[批准按钮 id]}} 问 owner，批了带同样的参数加 --ask <askId> 执行${until}`,
  };
}

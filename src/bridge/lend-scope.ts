/**
 * 出借方 B 在消息路由上的窄例外（i28-W6）：发起方 A 的 peer token 一般不含 B 的出借 worker，但 A 的 owner 要能直接给
 * 「替 A 跑着单的那个 worker」发一句话。只在 POST /agents/:name/messages 那一行调（api-routes.ts），其余路由一律不认它。
 * 全部满足才放行，每次请求现读、不缓存，任何一样读不了就拒（fail-closed）：
 *   调用方过 lendCallerRefusal（已兑换的 peer token、E2E、钉了钥、带签名）；名字是 agent-lend-<10 hex>；JSON 文本请求；
 *   journal 里这个 worker 的单属于这个 peer、正在 started，且领单时记的指纹就是对方此刻钉的那把钥匙；lend.json 对这个 peer 的授权还在。
 * 判定核心 judgeLendScope 依赖全注入（tests/lend-scope.test.ts）；路由行为 tests/lend-scope-route.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { keyFingerprint } from "../lib/instance-key.js";
import { readLend } from "../lib/lend-config.js";
import { LEND_JOURNAL_PATH } from "../lib/lend-journal.js";
import { effectiveLend, readLendContext } from "../lib/lend-policy.js";
import { isLendWorkerName } from "../lib/lend-workers-view.js";
import type { Principal } from "../lib/principals.js";
import { lendCallerRefusal } from "./local-api/lend.js";
import { peerSignatureState } from "./peer-signature.js";

export interface LendScopeDeps {
  callerRefusal: () => string | null;
  /** 对方此刻钉住的钥匙的指纹；没钉 = null */
  pinnedFp: (peer: string) => string | null;
  /** journal 里 agent = 该名、peer = 该 peer、state = started 的那一行的指纹；没有这一行 = undefined。读不了就抛 */
  startedFp: (agent: string, peer: string) => string | null | undefined;
  /** 此刻对这个 peer 的出借授权：还在且指纹对得上 = null，否则是原因。读不了就抛 */
  grantProblem: (peer: string, fp: string) => Promise<string | null>;
}

export interface LendScopeInput { agent: string; peer: string | undefined; contentType: string; hasAsk: boolean }

const JOURNAL_BUSY_MS = 2_000;

/** 媒体类型（参数前那段）必须正好是 application/json；下游消息路由按子串认 multipart，所以参数里出现 multipart/form-data 也拒（tests/lend-scope.test.ts） */
function isJsonOnly(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.split(";")[0]!.trim() === "application/json" && !ct.includes("multipart/form-data");
}

/** null = 放行；否则是拒绝原因（只记日志，调用方照旧回 not in scope，不把内部状态说给对方） */
export async function judgeLendScope(i: LendScopeInput, d: LendScopeDeps): Promise<string | null> {
  if (!isLendWorkerName(i.agent)) return "不是出借 worker";
  if (!isJsonOnly(i.contentType) || i.hasAsk) return "只收 JSON 文本消息（附件、ask 回答不走例外）";
  const why = d.callerRefusal();
  if (why) return why;
  const peer = i.peer as string; // callerRefusal 已保证是已兑换的 peer
  const agent = i.agent.startsWith("agent-") ? i.agent : `agent-${i.agent}`;
  try {
    const pinned = d.pinnedFp(peer);
    if (!pinned) return "对方没有钉住的钥匙";
    const fp = d.startedFp(agent, peer);
    if (fp === undefined) return "journal 里没有这个 peer 正在跑的这张单";
    if (!fp || fp.toLowerCase() !== pinned.toLowerCase()) return "领单时的指纹和对方现在钉的钥匙对不上";
    return await d.grantProblem(peer, fp.toLowerCase());
  } catch (e) {
    return `读不了出借状态：${(e as Error).message}`;
  }
}

/** 只读打开、等锁有上限（同 lib/lend-watchdog.ts）：不调 openLendJournal，它会跑迁移、建目录 */
export function startedFpFromJournal(path = LEND_JOURNAL_PATH): LendScopeDeps["startedFp"] {
  return (agent, peer) => {
    if (!existsSync(path)) throw new Error("出借 journal 不在");
    const db = new Database(path, { readonly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${JOURNAL_BUSY_MS}`);
      const row = db.query("SELECT fp FROM lend_orders WHERE agent = ? AND peer = ? AND state = 'started' LIMIT 1").get(agent, peer) as { fp: string | null } | null;
      return row ? row.fp : undefined;
    } finally {
      db.close();
    }
  };
}

/** 现读 lend.json 与联系人按此刻重算（effectiveLend）；条目没写指纹的按联系人记录的比 */
async function grantFromLendFile(peer: string, fp: string): Promise<string | null> {
  const [read, ctx] = await Promise.all([readLend(), readLendContext()]);
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, Date.now());
  if (eff.invalid) return `lend.json 无效：${eff.invalid}`;
  const entry = eff.lend.find((e) => e.peer === peer);
  if (!entry) return `没有给 ${peer} 的出借授权`;
  const want = entry.fp ?? ctx.contacts.find((c) => c.name === peer)?.fp;
  return want?.toLowerCase() === fp ? null : `${peer} 的出借授权指纹对不上`;
}

const realDeps = (req: Request, principal: Principal): LendScopeDeps => ({
  callerRefusal: () => lendCallerRefusal(req, principal),
  pinnedFp: (peer) => {
    const k = peerSignatureState(peer)?.publicKey;
    return k ? keyFingerprint(k) : null;
  },
  startedFp: startedFpFromJournal(),
  grantProblem: grantFromLendFile,
});

export async function lendScopeAllows(req: Request, principal: Principal, agentParam: string): Promise<boolean> {
  if (!isLendWorkerName(agentParam)) return false; // 普通目标零开销、行为不变
  const input = { agent: agentParam, peer: principal.peer, contentType: req.headers.get("content-type") ?? "", hasAsk: new URL(req.url).searchParams.has("ask") };
  const why = await judgeLendScope(input, realDeps(req, principal));
  if (why) console.warn(`[lend-scope] ${principal.peer ?? principal.id} → ${agentParam} 不放行：${why}`);
  return why === null;
}

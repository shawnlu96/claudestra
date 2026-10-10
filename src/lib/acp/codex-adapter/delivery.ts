/**
 * 投递对账（I14）：带用户输入的请求（turn/start、turn/steer、thread/compact/start）确认超时、回包坏、出错、写出后断线时，
 * 判断这条输入到底进没进 app-server。**只能证明「已投递」**：查到就接管，查不到 / 查询出错 / 翻页没翻完一律返回 null，
 * 由调用方判结果不明（不重排、不续跑、走 I12）。app-server 不按 clientId 去重（Q0-9），所以不能「查不到就重发」。
 * - userMessage：先看实时记录（item/started 里见过的 clientId），再在发出 ≥1s 后（turn/start 回包后要 24–55ms 才可见）倒序翻
 *   thread/items/list，最多 3 页 150 项、10s；-32601「not supported yet」（新线程第一轮落盘前）按暂时查不到在预算内重试（R43）。
 * - compaction：参数里没有 clientId，找发出之后新出现、带 contextCompaction 的回合；界不住「之后」（没有时间戳、也没有已知回合垫底）就不认。
 * tests/codex-adapter-delivery.test.ts。
 */
import { RpcError } from "../rpc.js";
import type { AppServer } from "./app-server.js";
import { type ResultOf, USED } from "./protocol.js";
import type { Reconciler } from "./turns.js";

type Entry = ResultOf<"thread/items/list">["data"][number];
const TIMINGS = { budgetMs: 10_000, minDelayMs: 1_000, retryMs: 200, pageLimit: 50, maxPages: 3 };
const METHOD_NOT_FOUND = -32601;
/** 时间戳比发出时刻早这么多以内仍算「之后」（同一台机器，只防毫秒取整） */
const SKEW_MS = 1_000;
const ITEM = USED.extraInbound["v2/ThreadItem"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function createReconciler(app: Pick<AppServer, "call">, log: (msg: string) => void, timings: Partial<typeof TIMINGS> = {}): Reconciler {
  const t = { ...TIMINGS, ...timings };

  /** 倒序翻历史，match 命中就返回 turnId；整轮翻完没命中、或查询出错返回 null */
  const search = async (threadId: string, sentAt: number, match: (e: Entry) => boolean, live: () => string | undefined): Promise<string | null> => {
    const deadline = Date.now() + t.budgetMs;
    while (Date.now() < deadline) {
      const hit = live();
      if (hit) return hit;
      if (Date.now() < sentAt + t.minDelayMs) {
        await sleep(Math.min(sentAt + t.minDelayMs, deadline) - Date.now());
        continue;
      }
      const r = await pages(threadId, deadline, match);
      if (r !== "notYet") return r ?? live() ?? null;
      await sleep(t.retryMs);
    }
    log(`对账 ${t.budgetMs}ms 内没查完（thread/items/list 一直不可用），按查不到处理`);
    return live() ?? null;
  };

  const pages = async (threadId: string, deadline: number, match: (e: Entry) => boolean): Promise<string | null | "notYet"> => {
    let cursor: string | null = null;
    for (let page = 0; page < t.maxPages; page++) {
      let r: ResultOf<"thread/items/list">;
      try {
        r = await app.call("thread/items/list", { threadId, sortDirection: "desc", limit: t.pageLimit, cursor }, { timeoutMs: Math.max(1, deadline - Date.now()) });
      } catch (e) {
        if (e instanceof RpcError && e.code === METHOD_NOT_FOUND) return "notYet";
        log(`对账查询出错，按查不到处理：${e instanceof Error ? e.message : e}`);
        return null;
      }
      const hit = r.data.find(match);
      if (hit) return hit.turnId;
      cursor = r.nextCursor ?? null;
      if (!cursor) return null;
    }
    log(`对账翻了 ${t.maxPages} 页（${t.maxPages * t.pageLimit} 项）没找到，按查不到处理`);
    return null;
  };

  return {
    userMessage(threadId, clientId, sentAt, live) {
      const match = (e: Entry) => {
        const item = e.item.type === "userMessage" ? ITEM.safeParse(e.item) : null;
        return !!item?.success && item.data.type === "userMessage" && item.data.clientId === clientId;
      };
      return search(threadId, sentAt, match, () => live(clientId));
    },
    compaction(threadId, sentAt, known) {
      let reachedKnown = false;
      const match = (e: Entry) => {
        if (known.has(e.turnId)) reachedKnown = true;
        if (e.item.type !== "contextCompaction" || known.has(e.turnId)) return false;
        return e.startedAtMs ? e.startedAtMs >= sentAt - SKEW_MS : !reachedKnown && known.size > 0;
      };
      return search(threadId, sentAt, match, () => undefined);
    },
  };
}

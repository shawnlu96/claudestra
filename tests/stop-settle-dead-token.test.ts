/**
 * Stop 兜底结 API 请求之前先核对 token（src/bridge/stop-settle.ts takeLiveApiWaiters，判定复用 lib/api-reply-target.ts）。
 * 现场：对方的同步等待还开着时 token 被撤销，agent 没调 reply() 就结束回合——reply 那条路已经拒了，Stop 兜底却照样出队、
 * 把这一轮的文字 resolve 给旧 token。这里按 bridge 的 Stop 收尾原样走一遍：出队 → 记结果 → resolve → 发事件。
 * 核对、出队、交结果必须在同一段同步代码里（「竞态」一组）：逐个 token await 着判，先判过的在等后面的时候被撤销就漏了。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { takeLiveApiWaiters, type ApiWaiter, type ApiWaiterResult, type StopTurn } from "../src/bridge/stop-settle.js";
import { liveApiTargets } from "../src/lib/api-reply-target.js";
import { readPrincipalsStrictSync, type Principal } from "../src/lib/principals.js";

const SECRET = "s3cr3t-never-in-logs";
const CID = "c-agent";
const dir = mkdtempSync(join(tmpdir(), "stop-settle-dead-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tok = (id: string, extra: Partial<Principal> = {}): Principal =>
  ({ id: `token:${id}`, role: "external", name: `n-${id}`, agents: ["*"], secret: SECRET, createdAt: "2026-10-01T00:00:00Z", ...extra });
let seq = 0;
type Live = (tokenIds: string[]) => ReadonlySet<string>;
/** 一份真的 principals.json + 走真 liveApiTargets 的核对；revoke / disable 就是改这份文件。onRead：读盘前一刻插一脚（竞态用例） */
function principals(...list: Principal[]) {
  const path = join(dir, `p-${++seq}.json`);
  let cur = list;
  const write = (ps: Principal[]) => writeFileSync(path, JSON.stringify({ principals: (cur = ps) }));
  write(list);
  const p = {
    path, reads: 0, onRead: undefined as (() => void) | undefined,
    live: ((ids) => liveApiTargets(ids, () => (p.reads++, p.onRead?.(), readPrincipalsStrictSync(path)), () => {})) as Live,
    revoke: (id: string) => write(cur.filter((x) => x.id !== `token:${id}`)),
    disable: (id: string) => write(cur.map((x) => (x.id === `token:${id}` ? { ...x, disabled: true } : x))),
  };
  return p;
}

type Waiter = ApiWaiter & { resolve?: (r: ApiWaiterResult | null) => void };
/** api-routes 挂同步等待的写法：entry.resolve + 到点 resolve(null)（= HTTP 回 202 timedOut） */
function hang(queues: Map<string, Waiter[]>, tokenId: string, n: number, waitMs = 30) {
  const w: Waiter = { agentChannelId: CID, agentName: "agent-x", threadId: `thr-${tokenId}-${n}`, tokenId, messageId: `m-${tokenId}-${n}` };
  const key = `${tokenId}|${CID}`;
  queues.set(key, [...(queues.get(key) ?? []), w]);
  const got = new Promise<ApiWaiterResult | null>((resolve) => {
    w.resolve = resolve;
    setTimeout(() => resolve(null), waitMs);
  });
  return { w, got };
}
const turn = (drain: StopTurn["drain"], event = "Stop"): StopTurn => ({ cid: CID, stopChannelId: CID, stopWs: 1, candidateWs: 1, event, drain });

/** bridge.ts Stop 收尾里那个循环：拿到的每一条都记结果、resolve、发事件。整段同步，和 bridge 一样中间没有 await */
function stop(queues: Map<string, Waiter[]>, t: StopTurn, own: boolean, live: Live, log: string[] = []) {
  const results = new Map<string, ApiWaiterResult>();
  const events: string[] = [];
  const taken = takeLiveApiWaiters(queues, t, own, undefined, undefined, undefined, live, (m) => log.push(m));
  expect(Array.isArray(taken)).toBe(true); // 不是 Promise：调用方不用（也不能）await
  for (const { waiter, result } of taken) {
    results.set(waiter.threadId, result);
    waiter.resolve?.(result);
    events.push(`api:${waiter.tokenId}`);
  }
  return { results, events, log };
}

type Revoke = (p: ReturnType<typeof principals>, id: string) => void;
const REVOKES: [string, Revoke][] = [
  ["deleted（token-revoke 删掉了）", (p, id) => p.revoke(id)],
  ["disabled（peer 重新配对 / 被移除，旧 token 停用）", (p, id) => p.disable(id)],
];

describe("撤销时同步等待还开着：回合结束后对方拿不到文本", () => {
  test.each(REVOKES)("%s", async (_name, revoke) => {
    const p = principals(tok("tok_v", { peer: "Shawn" }), tok("tok_new", { peer: "Shawn" }));
    const queues = new Map<string, Waiter[]>();
    const { w, got } = hang(queues, "tok_v", 1);
    revoke(p, "tok_v");
    const r = stop(queues, turn({ text: "这一轮的答复，不该交给旧 token" }), true, p.live);
    expect(r.results.size).toBe(0);
    expect(r.events).toEqual([]);
    expect(queues.get(`tok_v|${CID}`)).toEqual([w]); // 没出队：留给超时 / TTL
    expect(await got).toBeNull(); // 同步等待按超时收尾（202 timedOut），没拿到文字
  });

  test("对照：token 还有效 → 照旧结掉，文字交到对方手上", async () => {
    const p = principals(tok("tok_v", { peer: "Shawn" }));
    const queues = new Map<string, Waiter[]>();
    const { got } = hang(queues, "tok_v", 1);
    const r = stop(queues, turn({ text: "答复" }), true, p.live);
    expect(await got).toEqual({ threadId: "thr-tok_v-1", agent: "agent-x", viaFallback: true, reply: "答复" });
    expect(r.events).toEqual(["api:tok_v"]);
    expect(queues.size).toBe(0);
  });

  test("以 API 错误结束的一轮：reply:null + apiError 也是结果，不发给撤销了的 token", async () => {
    const p = principals(tok("tok_v"), tok("tok_ok"));
    const queues = new Map<string, Waiter[]>();
    const dead = hang(queues, "tok_v", 1);
    const ok = hang(queues, "tok_ok", 1);
    p.revoke("tok_v");
    stop(queues, turn({ text: null, apiError: true, error: { error: "rate_limit", text: "limit" } }, "StopFailure"), false, p.live);
    expect(await ok.got).toMatchObject({ reply: null, apiError: true, error: "rate_limit" });
    expect(await dead.got).toBeNull();
  });

  test("同一个 agent 名下有效的和撤销的各有请求：只结有效的那个；撤销的每一条都留着", async () => {
    const p = principals(tok("tok_v"), tok("tok_ok"));
    const queues = new Map<string, Waiter[]>();
    const d1 = hang(queues, "tok_v", 1), d2 = hang(queues, "tok_v", 2);
    const ok = hang(queues, "tok_ok", 1);
    p.revoke("tok_v");
    const r = stop(queues, turn({ text: "答复" }), true, p.live);
    expect([...r.results.keys()]).toEqual(["thr-tok_ok-1"]);
    expect((await ok.got)?.reply).toBe("答复");
    expect([await d1.got, await d2.got]).toEqual([null, null]);
    expect([...queues.keys()]).toEqual([`tok_v|${CID}`]);
    expect(queues.get(`tok_v|${CID}`)).toHaveLength(2);
  });
});

describe("竞态：核对别的 token 的时候撤销，先排到的那个也不能结（PR1192-r1 stop-token-check-stale）", () => {
  // 审查员的探针：tok_a、tok_b 各一条等待，轮到核对 tok_b 时把 tok_a 撤掉。逐个 await 着判的写法里 tok_a 已经进了名单、照样结掉。
  // 现在是一次同步快照判全部：没有「核对 tok_b 期间」这个时刻，能插进去的最晚一刻是读盘前——在那一刻撤。
  test.each(REVOKES)("核对期间 %s", async (_name, revoke) => {
    const p = principals(tok("tok_a"), tok("tok_b"));
    const queues = new Map<string, Waiter[]>();
    const a = hang(queues, "tok_a", 1), b = hang(queues, "tok_b", 1);
    p.onRead = () => revoke(p, "tok_a");
    const r = stop(queues, turn({ text: "回合正文" }), true, p.live);
    expect([...r.results.keys()]).toEqual(["thr-tok_b-1"]);
    expect(r.events).toEqual(["api:tok_b"]);
    expect(await a.got).toBeNull();
    expect((await b.got)?.reply).toBe("回合正文");
    expect(queues.get(`tok_a|${CID}`)).toEqual([a.w]);
    expect(p.reads).toBe(1); // 两个 token 一次读盘判完，不是一人读一次
  });

  test("核对和出队之间不让出事件循环：调用前排好的微任务 / 定时器（等着去撤销的）插不进来，都排在交完结果之后", async () => {
    const p = principals(tok("tok_a"), tok("tok_b"));
    const queues = new Map<string, Waiter[]>();
    hang(queues, "tok_a", 1);
    hang(queues, "tok_b", 1);
    const order: string[] = [];
    queueMicrotask(() => order.push("microtask"));
    const timer = new Promise<void>((done) => setTimeout(() => (order.push("timer"), done()), 0));
    p.onRead = () => order.push("check");
    const r = stop(queues, turn({ text: "答复" }), true, p.live);
    order.push(`settled:${r.results.size}`);
    await timer;
    expect(order).toEqual(["check", "settled:2", "microtask", "timer"]);
  });

  test("核对那一刻请求还在队里；核对当中才挂上的别的 token 不在名单里，不结", async () => {
    const queues = new Map<string, Waiter[]>();
    const first = hang(queues, "tok_a", 1);
    let late: ReturnType<typeof hang> | undefined;
    const live: Live = (ids) => {
      expect(ids).toEqual(["tok_a"]);
      expect(queues.get(`tok_a|${CID}`)).toEqual([first.w]);
      late = hang(queues, "tok_late", 1);
      return new Set(ids);
    };
    const r = stop(queues, turn({ text: "答复" }), true, live);
    expect([...r.results.keys()]).toEqual(["thr-tok_a-1"]);
    expect(await late!.got).toBeNull();
    expect(queues.get(`tok_late|${CID}`)).toEqual([late!.w]);
  });
});

describe("只在真要结的时候读盘", () => {
  test("重复的 Stop / 别人的频道 / 别的 agent 的请求 / 名下没有请求：本来就不结，不读 principals", () => {
    const p = principals();
    const queues = new Map<string, Waiter[]>();
    hang(queues, "tok_v", 1);
    stop(queues, { ...turn({ text: "x" }), repeated: true }, true, p.live);
    stop(queues, { ...turn({ text: "x" }), stopChannelId: "c-else", candidateWs: 2 }, false, p.live);
    stop(queues, { ...turn({ text: "x" }), cid: "c-other", stopChannelId: "c-other" }, true, p.live);
    stop(new Map(), turn({ text: "x" }), true, p.live);
    expect(p.reads).toBe(0);
    expect(queues.get(`tok_v|${CID}`)).toHaveLength(1);
  });

  test("owner:self 不核对、照结（principals 里没有它，只有它时不读盘）；几个 token、几条请求只读一次", async () => {
    const p = principals(tok("tok_ok"));
    const queues = new Map<string, Waiter[]>();
    const owner = hang(queues, "owner:self", 1);
    expect(stop(queues, turn({ text: "答复" }), true, p.live).results.size).toBe(1);
    expect((await owner.got)?.reply).toBe("答复");
    expect(p.reads).toBe(0);
    hang(queues, "owner:self", 2);
    hang(queues, "tok_ok", 1);
    hang(queues, "tok_ok", 2);
    expect(stop(queues, turn({ text: "答复" }), true, p.live).results.size).toBe(3);
    expect(p.reads).toBe(1);
  });

  test("principals.json 读坏了：和 reply 一样放行（照旧结），不把 owner 的等待也卡住；日志不带文件内容和路径", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, `{"principals":[{"secret":"${SECRET}" LEAKED`);
    const queues = new Map<string, Waiter[]>();
    const { got } = hang(queues, "tok_any", 1);
    const warns: string[] = [];
    const r = stop(queues, turn({ text: "答复" }), true, (ids) => liveApiTargets(ids, () => readPrincipalsStrictSync(path), (m) => warns.push(m)));
    expect((await got)?.reply).toBe("答复");
    expect(r.log).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("api:tok_any");
    for (const leak of [SECRET, "LEAKED", path]) expect(warns[0]).not.toContain(leak);
  });
});

describe("日志：只写 token id 和原因，一条等待只记一次", () => {
  test("不带密钥、peer 名、别的 token、这一轮的文字；后面的 Stop 再判到同一条不重复记，新挂上的才记", () => {
    const p = principals(tok("tok_v", { peer: "Shawn" }), tok("tok_new", { peer: "Shawn" }));
    const queues = new Map<string, Waiter[]>();
    hang(queues, "tok_v", 1);
    p.disable("tok_v");
    const log: string[] = [];
    stop(queues, turn({ text: "机密答复" }), true, p.live, log);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("api:tok_v");
    expect(log[0]).toContain("1 条");
    for (const leak of [SECRET, "Shawn", "tok_new", "机密答复", p.path]) expect(log[0]).not.toContain(leak);
    stop(queues, turn({ text: "下一轮" }), true, p.live, log);
    expect(log).toHaveLength(1);
    hang(queues, "tok_v", 2);
    stop(queues, turn({ text: "再下一轮" }), true, p.live, log);
    expect(log).toHaveLength(2);
    expect(queues.get(`tok_v|${CID}`)).toHaveLength(2);
  });
});

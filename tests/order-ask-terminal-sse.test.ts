/**
 * followup-reliability-ASKT：随出借单结清关掉的提问，提交后由 bridge ledger feed 读事件发 type=ask 的 SSE（bridge/ledger-feed.ts +
 * lib/order-ask-terminal.ts settledAskClosuresSince）。真 event-bus 订阅 + sseEventAllow 过滤；只收 types=ask 的非台账身份也能把轮询起起来；
 * 首拍 / 重启 / 换库不洪泛历史，同拍多笔与批量都发、回滚不发、读库 / emit 出错不丢不重；不走 publishAsk 的订阅者（推送 / 横幅）。
 * 关闭行用 closeAsk 带 extra.settledOrder 写（与 order-ask-terminal.ts closeOne 同形）；真实结清路径的发帧见 ledger-lend-terminal-asks.test.ts。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { onAsk } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { setLedgerFeedForTest, sseEventAllow } from "../src/bridge/ledger-feed.js";
import { canReadLedger } from "../src/lib/devices.js";
import { closeAsk, openAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { SettledAskClosure } from "../src/lib/order-ask-terminal.js";
import { guest, owner } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const G1 = guest("aa11");
const SECRET = "问句原文-SSE-不该出现";
let path = "";
let db: Database;
let seq = 0;

/** 一条 worker 提问；settled = 随出借单结清关（closeOne 同形），否则按别的原因关 / 不关 */
function ask(opts: { assignee?: string; now?: number } = {}): string {
  return openAsk(db, {
    project: "p", taskId: "T1", source: "reply", kind: "decide", title: SECRET, body: SECRET, fromAgent: "agent-lend-1@mate",
    ...(opts.assignee ? { assignee: opts.assignee } : {}), extra: { via: "mcp_ask", orderId: `lend:T1:${++seq}` },
  }, opts.now ?? Date.now()).id;
}
const settle = (id: string, now = Date.now()) => closeAsk(db, id, "cancelled", "出借单已结清", now, { settledOrder: { orderId: "lend:T1:x", status: "done", by: "lend" } })!;

beforeEach(() => {
  path = tempLedgerPath("askt-sse-");
  db = openLedger(path);
});
afterEach(() => {
  setLedgerFeedForTest(undefined);
  closeLedger(path);
});

describe("真订阅：types=ask 的连接", () => {
  test("只收 ask、读不了台账的 guest 也能起轮询并收到指给自己的关闭；过滤仍按 canSeeAsk；只带最小 data；不触发 publishAsk 订阅者", async () => {
    expect(canReadLedger(G1)).toBe(false);
    const mine = ask({ assignee: "local:guest:aa11" });
    const plain = ask({ assignee: "local:guest:aa11" });
    setLedgerFeedForTest({ path }); // 真 emit 到 event-bus；不手动 tick，靠 sseEventAllow 懒启动的定时轮询
    const got: BridgeEvent[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.type === "ask" && got.push(e)));
    let listener = 0;
    const off = onAsk(() => void listener++);
    try {
      const allowG1 = sseEventAllow(G1, ["ask"]);
      await Bun.sleep(1200); // 已起轮询：首拍取基线
      closeAsk(db, plain, "cancelled", "别的原因"); // 不是随单结清：不发
      settle(mine);
      for (let i = 0; i < 40 && !got.length; i++) await Bun.sleep(100);
      await Bun.sleep(1100);
      expect(got.map((e) => (e.data as { askId: string }).askId)).toEqual([mine]);
      const e = got[0]!;
      expect(e.data).toEqual({ project: "p", askId: mine, state: "cancelled", fromAgent: "agent-lend-1@mate", assignee: "local:guest:aa11" });
      expect(JSON.stringify(e)).not.toContain(SECRET);
      expect(allowG1(e)).toBe(true);
      expect(sseEventAllow(guest("bb22"), ["ask"])(e)).toBe(false);
      expect(sseEventAllow(owner(), ["ask"])(e)).toBe(true);
      expect(sseEventAllow(owner(), ["ledger"])(e)).toBe(false); // types 过滤照旧
      expect(listener).toBe(0); // 推送 / 横幅只挂在 publishAsk 上，这里不碰
    } finally {
      unsub();
      off();
    }
  });
});

describe("轮询游标（手动 tick）", () => {
  const start = () => {
    const got: SettledAskClosure[] = [];
    let fail: ((c: SettledAskClosure) => boolean) | null = null;
    const tick = setLedgerFeedForTest({ path, emit: () => {}, emitAsk: (c) => {
      if (fail?.(c)) throw new Error("emit 坏了");
      got.push(c);
    } })!;
    return { got, tick, failOn: (f: typeof fail) => void (fail = f) };
  };
  const ids = (xs: SettledAskClosure[]) => xs.map((c) => c.askId);

  test("首拍不补历史；同一拍多笔提交与一笔里批量取消全发；回滚不发；再拍不重复", () => {
    const old = ask();
    settle(old);
    const f = start();
    f.tick();
    expect(f.got).toEqual([]);
    const a = ask(), b = ask(), c = ask(), d = ask(), e = ask();
    settle(a);
    settle(b);
    db.transaction(() => [c, d].forEach((id) => settle(id)))();
    expect(() => db.transaction(() => {
      settle(e);
      throw new Error("回滚");
    })()).toThrow("回滚");
    f.tick();
    expect(ids(f.got)).toEqual([a, b, c, d]);
    f.tick();
    expect(f.got).toHaveLength(4);
  });

  test("emit 抛了停在那条，下拍从它续发、已发的不重发；读库出错游标不动、恢复后补发", () => {
    const f = start();
    f.tick();
    const a = ask(), b = ask(), c = ask();
    [a, b, c].forEach((id) => settle(id));
    f.failOn((x) => x.askId === b);
    f.tick();
    expect(ids(f.got)).toEqual([a]);
    f.failOn(null);
    f.tick();
    expect(ids(f.got)).toEqual([a, b, c]);

    const d = ask();
    settle(d);
    db.run("ALTER TABLE asks RENAME TO asks_x"); // 只读连接这拍读不到 asks：抛错
    f.tick();
    expect(ids(f.got)).toEqual([a, b, c]);
    db.run("ALTER TABLE asks_x RENAME TO asks");
    f.tick();
    expect(ids(f.got)).toEqual([a, b, c, d]);
  });

  test("重启（新的 feed）只取基线：之前的关闭不洪泛，之后的照发", () => {
    const f1 = start();
    f1.tick();
    const a = ask();
    settle(a);
    f1.tick();
    expect(ids(f1.got)).toEqual([a]);
    const f2 = start(); // bridge 重启 = 新的游标
    f2.tick();
    expect(f2.got).toEqual([]);
    const b = ask();
    settle(b);
    f2.tick();
    expect(ids(f2.got)).toEqual([b]);
  });

  /** 把当前库换成 alt（checkpoint、旧文件挪开、alt 改名到原路径），db 指向换上来的库 */
  const swapIn = (alt: string) => {
    closeLedger(path);
    for (const x of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(x)) renameSync(x, `${x}.old`);
    renameSync(alt, path);
    db = openLedger(path);
  };
  /** 在 alt 库上做 fn 再关掉它（db 临时指过去） */
  const onAlt = (alt: string, fn: () => void) => {
    const keep = db;
    db = openLedger(alt);
    fn();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    closeLedger(alt);
    db = keep;
  };

  test("换库（同源副本）：事件 ts 早于上次读成功、但没发过的关闭照发；旧库里已有 / 已发的不重发（复现 ask-sse r2）", () => {
    const hist = ask();
    settle(hist); // 首拍前的历史
    const f = start();
    const requestStartedAt = Date.now() - 60_000; // 结清请求先取时间、后等锁提交：事件 ts 早于下面的基线读
    f.tick();
    const a = ask();
    settle(a);
    f.tick();
    expect(ids(f.got)).toEqual([a]);
    const y = ask();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const alt = tempLedgerPath("askt-sse-alt-");
    copyFileSync(path, alt); // 备份 / 迁移出来的同源库
    let x = "";
    onAlt(alt, () => {
      x = ask({ now: requestStartedAt });
      settle(x, requestStartedAt);
    });
    swapIn(alt);
    f.tick();
    expect(ids(f.got)).toEqual([a, x]);
    f.tick();
    expect(f.got).toHaveLength(2);
    settle(y); // 换上来的库里接着关：seq 游标照常
    f.tick();
    expect(ids(f.got)).toEqual([a, x, y]);
  });

  test("换库：emit 中途抛了，下拍只补没发出去的，不重发、不跳过", () => {
    const f = start();
    f.tick();
    const alt = tempLedgerPath("askt-sse-alt-");
    let b = "", c = "";
    onAlt(alt, () => {
      const t = Date.now() - 60_000;
      b = ask({ now: t });
      c = ask({ now: t });
      settle(b, t);
      settle(c, t);
    });
    swapIn(alt);
    f.failOn((z) => z.askId === c);
    f.tick();
    expect(ids(f.got)).toEqual([b]);
    f.failOn(null);
    f.tick();
    expect(ids(f.got)).toEqual([b, c]);
    f.tick();
    expect(f.got).toHaveLength(2);
  });
});

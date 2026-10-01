/**
 * i28-W6 B 侧消息例外的判定（bridge/lend-scope.ts judgeLendScope + 只读 journal 读取）。临时 journal 用 recordAsked + advance
 * 推到 started 并写 agent（W1 / W3 的行形状）；授权核对和调用方核对注入假实现。验收线 1、2：只放行该放的、立刻失效、读不到就拒。
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { judgeLendScope, startedFpFromJournal, type LendScopeDeps, type LendScopeInput } from "../src/bridge/lend-scope.js";
import { workerName } from "../src/lib/lend-drive.js";
import { advance, openLendJournal, recordAsked, type LendState } from "../src/lib/lend-journal.js";

const dir = mkdtempSync(join(tmpdir(), "lend-scope-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FP = "abcd-ef01-2345-6789";
const OTHER_FP = "1111-2222-3333-4444";
const ORDER = "t68:s1:r0:review:a0";
const AGENT = workerName(ORDER);
let path: string;
let n = 0;

/** journal 里一单：asked → claimed → cloned → started（写 agent），可再往后推 */
function seed(o: { orderId?: string; peer?: string; fp?: string | null; to?: LendState[] } = {}): string {
  const db = openLendJournal(path);
  const orderId = o.orderId ?? ORDER;
  recordAsked(db, { orderId, peer: o.peer ?? "mate", fp: o.fp === undefined ? FP : o.fp, family: "codex", preview: {} });
  advance(db, orderId, "asked", "claimed", { leaseGen: 1 });
  advance(db, orderId, "claimed", "cloned");
  advance(db, orderId, "cloned", "started", { agent: workerName(orderId) });
  let cur: LendState = "started";
  for (const s of o.to ?? []) { advance(db, orderId, cur, s); cur = s; }
  db.close();
  return workerName(orderId);
}

let grant: string | null;
const deps = (over: Partial<LendScopeDeps> = {}): LendScopeDeps => ({
  callerRefusal: () => null,
  pinnedFp: (peer) => (peer === "mate" ? FP : peer === "rival" ? OTHER_FP : null),
  startedFp: startedFpFromJournal(path),
  grantProblem: async () => grant,
  ...over,
});
const input = (over: Partial<LendScopeInput> = {}): LendScopeInput => ({ agent: AGENT, peer: "mate", contentType: "application/json", hasAsk: false, ...over });
const judge = (i: Partial<LendScopeInput> = {}, d: Partial<LendScopeDeps> = {}) => judgeLendScope(input(i), deps(d));

beforeEach(() => {
  path = join(dir, `journal-${++n}.sqlite`);
  grant = null;
});

describe("放行", () => {
  test("合规调用方 + 本 peer 的 started 单 + 指纹相符 + 授权在：放行；去掉 agent- 前缀的写法同样", async () => {
    seed();
    expect(await judge()).toBeNull();
    expect(await judge({ agent: AGENT.replace(/^agent-/, "") })).toBeNull();
    expect(await judge({ contentType: "application/json; charset=utf-8" })).toBeNull();
  });
});

describe("验收线 1：只放行该放的", () => {
  const callerCases = ["lend 只收已兑换的 peer token", "lend 只收端到端加密的请求", "lend 只收钉了钥、带实例签名的请求"];
  for (const why of callerCases) {
    test(`调用方不合规（${why}）→ 拒`, async () => {
      seed();
      expect(await judge({}, { callerRefusal: () => why })).toBe(why);
    });
  }

  test("名字不是 agent-lend-*：B 本机的其他 agent 一律不走例外，连 journal 都不读", async () => {
    seed();
    let read = 0;
    const startedFp = () => { read++; return FP; };
    for (const agent of ["claudestra", "agent-claudestra", "master", "lend-0123", `${AGENT}x`, `${AGENT}@mate`]) {
      expect(await judge({ agent }, { startedFp })).toBe("不是出借 worker");
    }
    expect(read).toBe(0);
  });

  test("别的 peer 的单的 worker → 拒", async () => {
    seed({ peer: "rival", fp: OTHER_FP });
    expect(await judge()).toContain("journal 里没有");
  });

  test("自己也有单、但点的是别的 peer 那单的 worker → 拒", async () => {
    seed();
    const rivals = seed({ orderId: "t68:s2:r0:review:a0", peer: "rival", fp: OTHER_FP });
    expect(await judge({ agent: rivals })).toContain("journal 里没有");
  });

  test("journal 里的指纹和对方现在钉的钥匙对不上（同名 peer 换了实例）→ 拒", async () => {
    seed({ fp: OTHER_FP });
    expect(await judge()).toContain("指纹");
  });

  test("领单时没记指纹 → 拒", async () => {
    seed({ fp: null });
    expect(await judge()).toContain("指纹");
  });

  test("对方没有钉住的钥匙 → 拒", async () => {
    seed();
    expect(await judge({}, { pinnedFp: () => null })).toContain("钉住");
  });

  test("还没到 started（asked / claimed / cloned）→ 拒", async () => {
    const db = openLendJournal(path);
    recordAsked(db, { orderId: ORDER, peer: "mate", fp: FP, family: "codex", preview: {} });
    db.run("UPDATE lend_orders SET agent = ? WHERE orderId = ?", [AGENT, ORDER]);
    for (const [from, to] of [[null, "asked"], ["asked", "claimed"], ["claimed", "cloned"]] as const) {
      if (from) advance(db, ORDER, from, to);
      expect(await judge()).toContain("journal 里没有");
    }
    db.close();
  });

  test("附件（multipart）和带 ?ask= 的请求不走例外", async () => {
    seed();
    expect(await judge({ contentType: "multipart/form-data; boundary=x" })).toContain("只收 JSON");
    expect(await judge({ contentType: "" })).toContain("只收 JSON");
    expect(await judge({ hasAsk: true })).toContain("只收 JSON");
  });

  test("Content-Type 按媒体类型精确比：参数里藏 application/json 的 multipart、参数里藏 multipart 的 JSON、近似类型都拒", async () => {
    seed();
    for (const contentType of [
      "multipart/form-data; boundary=x; note=application/json", "Multipart/Form-Data; boundary=x; a=Application/JSON",
      "application/json; x=multipart/form-data", "application/json-patch+json", "text/plain; charset=application/json", "application/jsonx",
    ]) expect(await judge({ contentType })).toContain("只收 JSON");
    for (const contentType of ["application/json", " Application/JSON ; charset=utf-8", "application/json;charset=UTF-8"]) expect(await judge({ contentType })).toBeNull();
  });
});

describe("验收线 2：立刻失效、读不到就拒", () => {
  for (const end of [["result_pending"], ["stopped"], ["cancelled"], ["result_pending", "acked"]] as LendState[][]) {
    test(`单进入 ${end.join(" → ")} 后立刻拒`, async () => {
      seed();
      expect(await judge()).toBeNull();
      const db = openLendJournal(path);
      let cur: LendState = "started";
      for (const s of end) { advance(db, ORDER, cur, s); cur = s; }
      db.close();
      expect(await judge()).toContain("journal 里没有");
    });
  }

  test("授权收回（worker 还没被停的窗口）→ 拒；授权核对拿到的是 journal 的指纹", async () => {
    seed();
    const seen: string[] = [];
    grant = "没有给 mate 的出借授权";
    expect(await judge({}, { grantProblem: async (peer, fp) => { seen.push(`${peer}/${fp}`); return grant; } })).toBe(grant);
    expect(seen).toEqual([`mate/${FP}`]);
  });

  test("journal 不在 → 拒", async () => {
    expect(await judge()).toContain("journal 不在");
  });

  test("journal 被独占锁住（等锁超时）→ 拒", async () => {
    // WAL 下读不被写挡：这里用回滚日志模式的同形最小表，独占事务才挡得住只读连接
    const w = new Database(path);
    w.exec("CREATE TABLE lend_orders (orderId TEXT, agent TEXT, peer TEXT, state TEXT, fp TEXT)");
    w.run("INSERT INTO lend_orders VALUES (?, ?, 'mate', 'started', ?)", [ORDER, AGENT, FP]);
    expect(await judge()).toBeNull();
    w.exec("BEGIN EXCLUSIVE");
    w.run("UPDATE lend_orders SET fp = fp");
    try {
      expect(await judge()).toContain("读不了");
    } finally {
      w.exec("ROLLBACK");
      w.close();
    }
  }, 10_000);

  test("journal 不是 sqlite → 拒", async () => {
    await Bun.write(path, "not a database");
    expect(await judge()).toContain("读不了");
  });

  test("授权读不了（抛错）→ 拒", async () => {
    seed();
    expect(await judge({}, { grantProblem: async () => { throw new Error("lend.json 读失败"); } })).toContain("读不了");
  });

  test("每次现读不缓存：同一判定器，单结束后下一次就拒", async () => {
    seed();
    const d = deps();
    expect(await judgeLendScope(input(), d)).toBeNull();
    const db = openLendJournal(path);
    advance(db, ORDER, "started", "stopped");
    db.close();
    expect(await judgeLendScope(input(), d)).toContain("journal 里没有");
  });
});

/** T94 逐单确认门（src/lib/lend-ask.ts）：只认 owner 本人点「批准」、参数没变、没过期 */
import { afterEach, describe, expect, test } from "bun:test";
import { answerAsk, closeAsk, openAskFull, type AskAnswer } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { LEND_APPROVE, lendAskInput, lendAskProblem, lendAskVerdict, lendInformText, type LendAskParams } from "../src/lib/lend-ask.js";
import { runLedger } from "../src/manager/ledger.js";

const P: LendAskParams = {
  orderId: "int_abc:1", peer: "team-a", fp: "abcd-ef01-2345-6789", family: "codex", repo: "shawnlu96/claudestra", pr: 270, head: "c".repeat(40),
  taskId: "T93", step: "review", quota: "今天第 1/5 单，codex 位 0/2",
};
const T0 = 1_000_000;
const answer = (button: string, over: Partial<AskAnswer> = {}): AskAnswer =>
  ({ choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner:self", via: "web_card", at: T0 + 10, owner: true, ...over });

afterEach(() => closeLedger(":memory:"));

function opened() {
  const db = openLedger(":memory:");
  return { db, id: openAskFull(db, lendAskInput(P), T0).ask.id };
}

describe("T94 逐单确认 ask", () => {
  test("正文写明外来任务会在 owner 的用户下跑一个 shell，并写出仓库、PR、预计额度；卡标题在第一行", () => {
    const a = lendAskInput(P);
    expect(a.kind).toBe("authorize");
    expect(a.body).toContain("这会让一个外来任务在你的用户下跑一个 shell");
    for (const s of ["shawnlu96/claudestra", "#270", "c".repeat(40), P.quota]) expect(a.body).toContain(s);
    expect(a.title).toContain("team-a");
  });

  test("没人答 = waiting；owner 点批准 = approved", () => {
    const { db, id } = opened();
    expect(lendAskVerdict(db, id, P, T0 + 5).state).toBe("waiting");
    answerAsk(db, id, answer(LEND_APPROVE));
    expect(lendAskVerdict(db, id, P, T0 + 20).state).toBe("approved");
  });

  test("点了「不借」、不是 owner 本人答的、guest 答的，都不算批准", () => {
    for (const a of [answer("lend_claim_reject"), answer(LEND_APPROVE, { owner: undefined }), answer(LEND_APPROVE, { external: true })]) {
      const { db, id } = opened();
      answerAsk(db, id, a);
      expect(lendAskVerdict(db, id, P, T0 + 20).state).toBe("declined");
      closeLedger(":memory:");
    }
  });

  test("过期没答 / 批了但已过有效期 / 被撤 → declined", () => {
    let { db, id } = opened();
    expect(lendAskVerdict(db, id, P, T0 + 5 * 3600_000).state).toBe("declined");
    closeLedger(":memory:");
    ({ db, id } = opened());
    answerAsk(db, id, answer(LEND_APPROVE));
    expect(lendAskVerdict(db, id, P, T0 + 5 * 3600_000).state).toBe("declined");
    closeLedger(":memory:");
    ({ db, id } = opened());
    closeAsk(db, id, "cancelled", "test", T0 + 1);
    expect(lendAskVerdict(db, id, P, T0 + 20).state).toBe("declined");
  });

  test("批的是这组参数：换了 head / 仓库 / peer 拿去核对都不算", () => {
    const { db, id } = opened();
    answerAsk(db, id, answer(LEND_APPROVE));
    for (const changed of [{ head: "d".repeat(40) }, { repo: "evil/repo" }, { peer: "team-b" }]) {
      expect(lendAskVerdict(db, id, { ...P, ...changed }, T0 + 20)).toMatchObject({ state: "declined" });
    }
  });

  test("同一张单重复开只有一张 ask", () => {
    const db = openLedger(":memory:");
    const a = openAskFull(db, lendAskInput(P), T0);
    const b = openAskFull(db, lendAskInput(P), T0 + 1);
    expect(b.existed).toBe(true);
    expect(b.ask.id).toBe(a.ask.id);
  });

  test("参数形状：多字段、非完整 SHA、带换行的额度文字都拒", () => {
    expect(lendAskProblem(P)).toBeNull();
    expect(lendAskProblem({ ...P, x: 1 })).toMatch(/不认识/);
    expect(lendAskProblem({ ...P, head: "abc" })).toMatch(/head/);
    expect(lendAskProblem({ ...P, quota: "a\nb" })).toMatch(/quota/);
    expect(lendAskProblem({ ...P, repo: "../x" })).toMatch(/repo/);
  });
});

describe("T94 预先授权的每单通知（specRev 2）", () => {
  const run = (actor: string, notifyOwner?: (t: string) => Promise<boolean>) => runLedger(["lend-inform", "--params", JSON.stringify(P)], {
    db: openLedger(":memory:"), actor, projectIds: [], now: () => T0,
    loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {}, ...(notifyOwner ? { notifyOwner } : {}),
  }) as Promise<Record<string, unknown>>;

  test("正文写明外来任务会在 owner 的用户下跑一个 shell，并写出仓库、PR、head", () => {
    const t = lendInformText(P);
    expect(t).toContain("这会让一个外来任务在你的用户下跑一个 shell");
    for (const s of ["shawnlu96/claudestra", "#270", "c".repeat(40), P.quota]) expect(t).toContain(s);
  });

  test("ledger lend-inform 只给调度服务身份；送到 = notified:true，没通道 = notified:false", async () => {
    const sent: string[] = [];
    expect(await run("owner", async (t) => { sent.push(t); return true; })).toMatchObject({ ok: false });
    expect(await run("agent-lend-0123456789", async (t) => { sent.push(t); return true; })).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    expect(await run("scheduler", async (t) => { sent.push(t); return true; })).toMatchObject({ ok: true, notified: true });
    expect(sent).toHaveLength(1);
    expect(await run("scheduler")).toMatchObject({ ok: true, notified: false });
    expect(await run("scheduler", async () => false)).toMatchObject({ ok: true, notified: false });
  });
});

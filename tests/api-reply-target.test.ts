/**
 * reply 发到 api:<tokenId> 的收件判定（src/lib/api-reply-target.ts）+ 失败那条不让 Stop 反复逼补发。
 * 现场：peer 重新配对后旧 token 被停用，agent 两次 reply 到旧 chat_id，工具都回 `Sent message(s): []`，对方一条没收到。
 * 顺序照 bridge.ts deliverToApi：先 checkApiTarget（出队前），再按「有没有挂着的请求」判 orphanReplyReason。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { apiTargetVerdict, checkApiTarget, orphanReplyReason, type ApiTarget } from "../src/lib/api-reply-target.js";
import { readPrincipalsStrict, type Principal, type PrincipalsFile } from "../src/lib/principals.js";
import { settleOwedReplies } from "../src/lib/pending-reply-scope.js";
import { pickUnrepliedForNudge } from "../src/lib/reply-nudge.js";

const SECRET = "s3cr3t-never-in-reasons";
const tok = (id: string, extra: Partial<Principal> = {}): Principal =>
  ({ id: `token:${id}`, role: "external", name: `n-${id}`, agents: ["*"], secret: SECRET, createdAt: "2026-10-01T00:00:00Z", ...extra });
const file = (...principals: Principal[]): PrincipalsFile => ({ principals });

// 生产现场的形状：同一 peer 的旧 token 停用、新 token 启用；另有一个普通外部 token 和一个停用的 guest
const PROD = file(
  tok("tok_old", { peer: "Shawn", disabled: true }),
  tok("tok_new", { peer: "Shawn" }),
  tok("tok_other", { peer: "Bob" }),
  tok("tok_web"),
  { id: "guest:abcd", role: "external", name: "guest", agents: ["a"], createdAt: "2026-10-01T00:00:00Z", disabled: true },
);

/** deliverToApi 的两道判定合起来：null = 照常投递 */
async function refusal(f: PrincipalsFile, tokenId: string, hasWaiter: boolean): Promise<string | null> {
  const t = await checkApiTarget(tokenId, async () => f);
  return t.ok ? orphanReplyReason(t, hasWaiter, tokenId) : t.reason;
}

describe("deliverToApi 收件判定（入口顺序同 bridge.ts）", () => {
  test("失效 token（principals 里没有）→ 拒，说明不存在 / 已撤销", async () => {
    const r = await refusal(PROD, "tok_gone", true);
    expect(r).toContain("api:tok_gone 的 token 不存在");
  });

  test("已撤销（停用）的 peer 旧 token → 拒；附同一 peer 当前启用的那个 chat_id，不列别的 token，不带密钥", async () => {
    const r = (await refusal(PROD, "tok_old", true))!;
    expect(r).toContain("peer「Shawn」已停用的旧 token");
    expect(r).toContain("chat_id 是 api:tok_new");
    expect(r).toContain('send_to_agent(target="<对方 agent>@Shawn")');
    for (const other of ["tok_other", "tok_web", "guest:abcd", SECRET]) expect(r).not.toContain(other);
  });

  test("同一 peer 启用的 token 不止一个 / 一个都没有（peer 已移除）→ 不猜，不附 chat_id", () => {
    const two = file(tok("tok_old", { peer: "Shawn", disabled: true }), tok("tok_a", { peer: "Shawn" }), tok("tok_b", { peer: "Shawn" }));
    const none = file(tok("tok_old", { peer: "Shawn", disabled: true }));
    for (const f of [two, none]) {
      const v = apiTargetVerdict(f, "tok_old");
      expect(v.ok).toBe(false);
      expect(!v.ok && v.reason).not.toContain("chat_id 是");
    }
  });

  test("停用的非 peer principal（token / 凭据全撤了的 guest）→ 拒", async () => {
    expect(await refusal(file(tok("tok_web", { disabled: true })), "tok_web", true)).toContain("已停用");
    expect(await refusal(PROD, "guest:abcd", false)).toContain("api:guest:abcd 的 token 已停用");
  });

  test("有效 peer token、没有在等的请求 → 拒，说明没有调用方在等", async () => {
    const r = await refusal(PROD, "tok_new", false);
    expect(r).toContain("peer「Shawn」没有在等这条回复的请求");
    expect(r).toContain('send_to_agent(target="<对方 agent>@Shawn")');
  });

  test("有效 peer token、有挂着的请求 → 照常回推", async () => {
    expect(await refusal(PROD, "tok_new", true)).toBeNull();
    expect(apiTargetVerdict(PROD, "tok_new")).toEqual({ ok: true, peer: "Shawn" });
  });

  test("owner:self 照常：principals 里没有它、也没有挂着的请求都不拦，且不读盘", async () => {
    let reads = 0;
    const t = await checkApiTarget("owner:self", async () => (reads++, file()));
    expect(t).toEqual({ ok: true });
    expect(reads).toBe(0);
    expect(await refusal(file(), "owner:self", false)).toBeNull();
  });

  test("非 peer 的有效 token（网页设备 / 外部 token）没有挂着的请求也照常：靠 SSE + 历史收", async () => {
    expect(await refusal(PROD, "tok_web", false)).toBeNull();
  });

  test("orphanReplyReason 只管 peer：判定已拒的、非 peer 的都返回 null", () => {
    const dead: ApiTarget = { ok: false, reason: "x" };
    expect(orphanReplyReason(dead, false, "t")).toBeNull();
    expect(orphanReplyReason({ ok: true }, false, "t")).toBeNull();
  });
});

describe("checkApiTarget 读 principals.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-reply-target-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("文件损坏（strict 读抛错）→ 按旧行为放行，不挡回复", async () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    expect(await checkApiTarget("tok_any", () => readPrincipalsStrict(p))).toEqual({ ok: true });
  });

  test("文件不存在 = 没有任何 token → 拒（owner:self 除外）", async () => {
    const p = join(dir, "missing.json");
    expect((await checkApiTarget("tok_any", () => readPrincipalsStrict(p))).ok).toBe(false);
    expect((await checkApiTarget("owner:self", () => readPrincipalsStrict(p))).ok).toBe(true);
  });

  test("真文件里的停用 token → 拒并附新 chat_id", async () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify(PROD));
    const t = await checkApiTarget("tok_old", () => readPrincipalsStrict(p));
    expect(!t.ok && t.reason).toContain("api:tok_new");
  });
});

describe("reply 到失效 api chat_id 不让 Stop 反复逼补发", () => {
  const wsA = { id: "agent-a" }, wsB = { id: "agent-b" };
  const now = 1_000_000;
  const book = () => new Map([
    ["thr_dead", { msgId: "m1", ts: now - 60_000, intendedReplyChannel: "api:tok_old", targetWs: wsA, threadId: "thr_dead", fromKind: "api" }],
    ["thr_b", { msgId: "m2", ts: now - 60_000, intendedReplyChannel: "api:tok_old", targetWs: wsB, threadId: "thr_b", fromKind: "api" }],
  ]);
  const cands = (b: ReturnType<typeof book>, ws: unknown) =>
    [...b.entries()].filter(([, p]) => p.targetWs === ws).map(([key, p]) => ({ key, ts: p.ts }));

  test("ws reply 分支在投递前就销账：这次 reply 被拒（dropped），Stop 也不再要求补 reply", async () => {
    const b = book();
    expect(pickUnrepliedForNudge(cands(b, wsA), { event: "Stop", stopHookActive: false, now })?.key).toBe("thr_dead");
    expect(settleOwedReplies(b, wsA, "api:tok_old")).toBe(1);
    expect(await refusal(PROD, "tok_old", true)).not.toBeNull(); // 这次投递是失败的
    expect(pickUnrepliedForNudge(cands(b, wsA), { event: "Stop", stopHookActive: false, now })).toBeNull();
  });

  test("只销自己的账：别的 agent 欠同一地址的账留着", () => {
    const b = book();
    settleOwedReplies(b, wsA, "api:tok_old");
    expect([...b.keys()]).toEqual(["thr_b"]);
  });
});

/**
 * 显式 ask 与授权绑定（lib/ask-bind.ts + `ledger ask-check`）：reply 的 ask 字段校验、参数哈希与键序无关、ask-check 的每条拒绝理由；
 * 参数变了旧按钮失效（superseded）在 tests/asks-v2.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { bindHash, bindTaskTarget, canonicalJson, checkAsk, hasDuplicateKeys, parseReplyAsk } from "../src/lib/ask-bind.js";
import { answerAsk, closeAsk, getAsk, openAsk, openAskFull, type Ask, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { runLedger } from "../src/manager/ledger.js";

const bind = { action: "release", params: { tag: "v2.32.0", sha: "818a473" }, approve: ["go"] };
const draft = (over: Partial<NewAsk> = {}): NewAsk => ({
  project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "authorize", title: "发 v2.32.0 吗",
  options: [{ type: "buttons", buttons: [{ id: "go", label: "发" }, { id: "no", label: "不发" }] }],
  bind: { ...bind, paramsHash: bindHash(bind, "agent-x") }, askKey: "release", ...over,
});
const pick = (a: Ask, id: string, at = 2_000) => answerAsk(openLedger(":memory:"), a.id, { choices: [`[button:${id}]`], labels: [id], text: "", principal: "owner:self", via: "web_card", at });

afterEach(() => closeLedger(":memory:"));

describe("reply 的 ask 字段", () => {
  test("合格的：kind、key、why / ifIgnored 截断、expiresIn 取整；authorize 必带 bind（action / params / approve）", () => {
    expect(parseReplyAsk({ kind: "decide", key: "t2b:scope", why: " 为什么 ", expiresIn: 3600.4 })).toEqual({ ask: { kind: "decide", key: "t2b:scope", why: "为什么", expiresIn: 3600 } });
    expect(parseReplyAsk({ kind: "authorize", bind })).toEqual({ ask: { kind: "authorize", bind } });
    expect(parseReplyAsk({ kind: "inform" })).toEqual({ ask: { kind: "inform" } });
  });

  test("不合格的整条拒掉，理由写给 agent 看", () => {
    const bad: [unknown, RegExp][] = [
      [[], /must be an object/],
      [{ kind: "assigned" }, /kind must be one of/],
      [{ kind: "decide", key: "有 空格" }, /key must match/],
      [{ kind: "decide", blocking: "yes" }, /blocking must be a boolean/],
      [{ kind: "decide", expiresIn: 5 }, /expiresIn is seconds/],
      [{ kind: "authorize" }, /bind is required/],
      [{ kind: "authorize", bind: { ...bind, approve: [] } }, /approve must list/],
      [{ kind: "authorize", bind: { action: "rel ease", params: {}, approve: ["go"] } }, /action must match/],
      [{ kind: "authorize", bind: { action: "release", approve: ["go"] } }, /params is required/],
      [{ kind: "authorize", bind: { ...bind, params: { blob: "x".repeat(5000) } } }, /too large/],
    ];
    for (const [raw, re] of bad) expect((parseReplyAsk(raw) as { error: string }).error).toMatch(re);
  });

  test("哈希只看内容：键的顺序、undefined 字段不影响；参数、action、version、发起 agent 任一变了哈希就变", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    const h = (b: Partial<typeof bind> & { version?: string }, agent = "agent-x") => bindHash({ ...bind, ...b }, agent);
    expect(h({ params: { sha: "818a473", tag: "v2.32.0" } })).toBe(h({}));
    for (const other of [h({ params: { ...bind.params, tag: "v2.32.1" } }), h({ action: "deploy" }), h({ version: "2" }), h({}, "agent-y")]) expect(other).not.toBe(h({}));
  });

  test("会撞哈希的参数拒掉（adv1 P2-3）：超过 2^53 的整数、非有限数；重复键只有原始 JSON 看得出（ask-check --params）", () => {
    const withParams = (params: unknown) => parseReplyAsk({ kind: "authorize", bind: { ...bind, params } });
    expect((withParams({ channel: 1495997330061791353 }) as { error: string }).error).toMatch(/2\^53/);
    expect(withParams({ channel: "1495997330061791353", n: 9007199254740991 })).toHaveProperty("ask");
    expect([hasDuplicateKeys('{"tag":"a","tag":"b"}'), hasDuplicateKeys('{"a":{"x":1},"b":{"x":1}}'), hasDuplicateKeys('{"a":"\\u0062","\\u0061":1}')]).toEqual([true, false, true]);
    expect(hasDuplicateKeys('["tag","tag"]')).toBe(false);
  });
});

describe("ask-check 的判定", () => {
  const h = bindHash(bind, "agent-x");
  test("批准：已答、选的是 approve 里的按钮、哈希一致、还在有效期内、核对的就是发起的 agent", () => {
    const a = openAsk(openLedger(":memory:"), draft(), 1_000);
    expect(checkAsk(pick(a, "go"), h, "agent-x", 3_000)).toEqual({ ok: true });
    expect((checkAsk(getAsk(openLedger(":memory:"), a.id), h, "agent-y", 3_000) as { reason: string }).reason).toMatch(/not agent-y/);
  });

  test("拒绝：不存在、没有绑定、还没答、答了「不发」、哈希不一致、过了有效期、被取代、过期 / 撤销", () => {
    const db = openLedger(":memory:");
    const reason = (a: Ask | null, hash = h, now = 3_000) => (checkAsk(a, hash, "agent-x", now) as { reason: string }).reason;
    expect(reason(null)).toMatch(/not found/);
    expect(reason(openAsk(db, draft({ kind: "decide", bind: null, askKey: null }), 1_000))).toMatch(/no authorization binding/);
    const open = openAsk(db, draft({ askKey: "k1" }), 1_000);
    expect(reason(open)).toMatch(/not answered yet/);
    expect(reason(pick(open, "no"))).toMatch(/without approving/);
    const ok = pick(openAsk(db, draft({ askKey: "k2" }), 1_000), "go");
    expect(reason(ok, bindHash({ ...bind, params: { ...bind.params, tag: "v9" } }, "agent-x"))).toMatch(/hash mismatch/);
    expect(reason(ok, h, ok.expiresAt + 1)).toMatch(/approval window ended/);
    const first = openAsk(db, draft({ askKey: "k3" }), 1_000);
    openAskFull(db, draft({ askKey: "k3" }), 1_500);
    expect(reason(getAsk(db, first.id))).toMatch(/superseded/);
    const gone = closeAsk(db, openAsk(db, draft({ askKey: "k4" }), 1_000).id, "expired", "", 1_100)!;
    expect(reason(gone)).toMatch(/is expired/);
  });

  test("CLI：ask-check <id> --hash / --params 都行，拒绝时 ok:false（退出码非 0）带理由；参数缺了、JSON 坏了报 invalid", async () => {
    const db = openLedger(":memory:");
    const a = pick(openAsk(db, draft(), Date.now()), "go", Date.now());
    const deps = { db, actor: "agent-x", projectIds: ["p"], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => Date.now() };
    const run = (...args: string[]) => runLedger(args, deps);
    expect(await run("ask-check", a.id, "--hash", h)).toMatchObject({ ok: true, approved: true });
    expect(await run("ask-check", a.id, "--params", JSON.stringify({ sha: "818a473", tag: "v2.32.0" }))).toMatchObject({ ok: true });
    expect(await run("ask-check", a.id, "--params", JSON.stringify({ tag: "v2.32.1", sha: "818a473" }))).toMatchObject({ ok: false, approved: false, error: expect.stringMatching(/hash mismatch/) });
    expect(await run("ask-check", a.id)).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("ask-check", a.id, "--params", "{nope")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("ask-check", "ask_none", "--hash", h)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(await run("ask-check", a.id, "--params", '{"tag":"v2.32.0","tag":"v2.32.0","sha":"818a473"}')).toMatchObject({ ok: false, code: "invalid" });
    // 别的 agent 拿这条批准去核对：一律拒（adv1 P2-2）
    expect(await runLedger(["ask-check", a.id, "--hash", h], { ...deps, actor: "agent-y" })).toMatchObject({ ok: false, approved: false, error: expect.stringMatching(/not agent-y/) });
  });
});


describe("bindTaskTarget（i28-ASKID1，接线与台账组合在 tests/ask-bind-task.test.ts）", () => {
  test("只认顶层 task / taskId；没写、带 peer、params 不是对象 → 不挂卡", () => {
    expect(bindTaskTarget({ task: "T1", tag: "v" })).toEqual({ taskId: "T1" });
    expect(bindTaskTarget({ taskId: "T1" })).toEqual({ taskId: "T1" });
    expect(bindTaskTarget({ task: "T1", taskId: "T1" })).toEqual({ taskId: "T1" });
    expect(bindTaskTarget({ tag: "v", nested: { task: "T1" } })).toEqual({ taskId: null });
    expect(bindTaskTarget({ peer: "P", task: "D12" })).toEqual({ taskId: null });
    expect(bindTaskTarget("T1")).toEqual({ taskId: null });
  });

  test("自相矛盾 / 写法不对 → 拒，不挑一个", () => {
    expect(bindTaskTarget({ task: "T1", taskId: "T2" })).toMatchObject({ error: expect.stringMatching(/different tasks/) });
    expect(bindTaskTarget({ task: 1 })).toMatchObject({ error: expect.stringMatching(/task id string/) });
    expect(bindTaskTarget({ taskId: "a b" })).toMatchObject({ error: expect.stringMatching(/task id string/) });
  });
});

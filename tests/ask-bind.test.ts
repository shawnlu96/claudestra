/**
 * 显式 ask 与授权绑定（lib/ask-bind.ts + `ledger ask-check`）：reply 的 ask 字段校验、参数哈希与键序无关、ask-check 的每条拒绝理由；
 * 参数变了旧按钮失效（superseded）在 tests/asks-v2.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { canonicalJson, checkAsk, paramsHash, parseReplyAsk } from "../src/lib/ask-bind.js";
import { answerAsk, closeAsk, getAsk, openAsk, openAskFull, type Ask, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { runLedger } from "../src/manager/ledger.js";

const bind = { action: "release", params: { tag: "v2.32.0", sha: "818a473" }, approve: ["go"] };
const draft = (over: Partial<NewAsk> = {}): NewAsk => ({
  project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "authorize", title: "发 v2.32.0 吗",
  options: [{ type: "buttons", buttons: [{ id: "go", label: "发" }, { id: "no", label: "不发" }] }],
  bind: { ...bind, paramsHash: paramsHash(bind.params) }, askKey: "release", ...over,
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

  test("参数哈希只看内容：键的顺序、undefined 字段不影响；值变了哈希就变", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    expect(paramsHash({ tag: "v2.32.0", sha: "818a473" })).toBe(paramsHash({ sha: "818a473", tag: "v2.32.0" }));
    expect(paramsHash({ tag: "v2.32.1", sha: "818a473" })).not.toBe(paramsHash(bind.params));
  });
});

describe("ask-check 的判定", () => {
  const h = paramsHash(bind.params);
  test("批准：已答、选的是 approve 里的按钮、哈希一致、还在有效期内", () => {
    const a = openAsk(openLedger(":memory:"), draft(), 1_000);
    expect(checkAsk(pick(a, "go"), h, 3_000)).toEqual({ ok: true });
  });

  test("拒绝：不存在、没有绑定、还没答、答了「不发」、哈希不一致、过了有效期、被取代、过期 / 撤销", () => {
    const db = openLedger(":memory:");
    const reason = (a: Ask | null, hash = h, now = 3_000) => (checkAsk(a, hash, now) as { reason: string }).reason;
    expect(reason(null)).toMatch(/not found/);
    expect(reason(openAsk(db, draft({ kind: "decide", bind: null, askKey: null }), 1_000))).toMatch(/no authorization binding/);
    const open = openAsk(db, draft({ askKey: "k1" }), 1_000);
    expect(reason(open)).toMatch(/not answered yet/);
    expect(reason(pick(open, "no"))).toMatch(/without approving/);
    const ok = pick(openAsk(db, draft({ askKey: "k2" }), 1_000), "go");
    expect(reason(ok, paramsHash({ ...bind.params, tag: "v9" }))).toMatch(/hash mismatch/);
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
  });
});


/**
 * i28-OA1：agent 凭 owner 批过的授权卡执行 lend grant / revoke、borrow set / off（lib/lend-ask-auth.ts）。
 * 临时 CLAUDESTRA_STATE_DIR（台账库、lend.json 都在里面）里跑 manager 子进程；ask 直接写进同一个临时台账库（假 ask 表）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, getAsk, openAskFull, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { bindParamsOf, consumeAsk, lendAskAction, offParams, usedKey } from "../src/lib/lend-ask-auth.js";

const state = mkdtempSync(join(tmpdir(), "lend-ask-auth-"));
writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {
  "agent-exec": { channelId: "222", status: "active" }, "agent-other": { channelId: "333", status: "active" } } }));
writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }], pendingInvites: [] }));
mkdirSync(join(state, "orch"));
writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "orch", name: "orch", dirs: [join(state, "orch")], createdAt: "" }] }));
const LEDGER = join(state, "ledger.sqlite");
const LEND = join(state, "lend.json");
const manager = join(import.meta.dir, "../src/manager.ts");
afterAll(() => closeLedger(LEDGER));

const run = (args: string[], channel?: string): Record<string, any> => {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, DISCORD_CHANNEL_ID: channel };
  if (!channel) delete env.DISCORD_CHANNEL_ID;
  delete env.CLAUDESTRA_LEND_WORKER; // 本测试自己可能就跑在出借 worker 里：子进程要按频道认身份
  const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
};
const AGENT = "222";
const bytes = () => (existsSync(LEND) ? readFileSync(LEND, "utf8") : "<missing>");
const db = () => openLedger(LEDGER);

type Bind = { action: string; params: unknown };
const BUTTONS = [{ type: "buttons", buttons: [{ id: "go", label: "批准" }, { id: "no", label: "不批" }] }];

/** 开一张授权卡；answer = 选哪个按钮（不给 = 不答）；expiresAt / at 可改；key 同 = 后开的取代先开的 */
function card(bind: Bind, o: { from?: string; answer?: string; expiresAt?: number; answeredAt?: number; key?: string } = {}): Ask {
  const from = o.from ?? "agent-exec";
  const now = Date.now();
  const a = openAskFull(db(), {
    project: "p", source: "reply", kind: "authorize", title: "授权", fromAgent: from, options: BUTTONS, chatId: "api:owner:self",
    bind: { ...bind, approve: ["go"], paramsHash: bindHash(bind, from) }, askKey: o.key ?? `k${Math.random()}`, expiresAt: o.expiresAt ?? now + 3_600_000,
  }, now - 10_000).ask;
  if (o.answer) answerAsk(db(), a.id, { choices: [`[button:${o.answer}]`], labels: [o.answer], text: "", principal: "owner", via: "web_card", at: o.answeredAt ?? now - 5_000, owner: true });
  return getAsk(db(), a.id)!;
}

const grant = (...extra: string[]) => ["lend", "grant", "team-a", "--repos", "shawnlu96/claudestra", ...extra];

describe("lend grant --ask", () => {
  test("验收 3：agent 不带 --ask 照旧被拒（报错带下一步）；owner 不带 --ask 照旧成功", () => {
    const denied = run(grant("--until", "3d"), AGENT);
    expect(denied).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("--print-bind") });
    expect(bytes()).toBe("<missing>");
    expect(run(grant("--until", "3d", "--codex", "2"))).toMatchObject({ ok: true, lend: { families: { codex: 2 } } });
    expect(run(["lend", "revoke"])).toMatchObject({ ok: true });
  }, 60_000);

  test("验收 1 + 4：--print-bind（不写、不要权限）→ 发卡批准 → 带 --until <绝对时间> --ask 执行成功；同一张卡再用 → 拒，lend.json 不变", async () => {
    const before = bytes();
    const printed = run(grant("--until", "3d", "--codex", "8", "--claude", "5", "--print-bind"), AGENT);
    expect(bytes()).toBe(before);
    expect(structuredClone(printed)).toMatchObject({ ok: true, bind: { action: "lend_grant", params: { peer: "team-a", fp: "aaaa-bbbb-cccc-dddd", families: { codex: 8, claude: 5 },
      repos: ["shawnlu96/claudestra"], ordersPerDay: 200, until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } } });
    expect(printed.bind.params).not.toHaveProperty("grantedAt");
    const until: string = printed.bind.params.until;
    const a = card(printed.bind, { answer: "go" });
    await Bun.sleep(1_100); // 打印和执行之间隔了一段：相对写法再打一次已经变了，绝对时间照样对得上
    expect(run(grant("--until", "3d", "--codex", "8", "--claude", "5", "--print-bind"), AGENT).bind.params.until).not.toBe(until);
    const ok = run(grant("--until", until, "--codex", "8", "--claude", "5", "--ask", a.id), AGENT);
    expect(ok).toMatchObject({ ok: true, lend: { peer: "team-a", families: { codex: 8, claude: 5 }, until } });
    expect(JSON.parse(bytes()).lend[0]).toMatchObject({ families: { codex: 8, claude: 5 }, until });
    expect(listEvents(db(), { project: "p" }).some((e) => e.dedupKey === usedKey(a.id) && e.kind === "decision" && e.data.askId === a.id)).toBe(true);
    const after = bytes();
    const again = run(grant("--until", until, "--codex", "8", "--claude", "5", "--ask", a.id), AGENT);
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining("只能用一次") });
    expect(bytes()).toBe(after);
  }, 60_000);

  test("验收 2：动作 / 参数 / 未答 / 非批准按钮 / 过期 / 别的 agent / 被取代 —— 都拒，lend.json 逐字节不变", () => {
    const printed = run(grant("--until", "2d", "--codex", "8", "--print-bind"), AGENT);
    const until: string = printed.bind.params.until;
    const exec = (askId: string, codex = "8") => run(grant("--until", until, "--codex", codex, "--ask", askId), AGENT);
    const ten = { ...printed.bind.params, families: { codex: 10 } };
    const keyed = card(printed.bind, { key: "same" });
    card(printed.bind, { key: "same" });
    const cases: [string, Ask, string, string?][] = [
      ["动作不匹配", card({ action: "lend_revoke", params: printed.bind.params }, { answer: "go" }), "lend_revoke"],
      ["参数不同（批 8 执行 10）", card(printed.bind, { answer: "go" }), "hash mismatch", "10"],
      ["参数不同（批 10 执行 8）", card({ action: "lend_grant", params: ten }, { answer: "go" }), "hash mismatch"],
      ["还没作答", card(printed.bind), "not answered"],
      ["选的不是批准按钮", card(printed.bind, { answer: "no" }), "without approving"],
      ["已过期", card(printed.bind, { answer: "go", expiresAt: Date.now() - 1_000, answeredAt: Date.now() - 2_000 }), "approval window ended"],
      ["别的 agent 发起的", card(printed.bind, { answer: "go", from: "agent-other" }), "agent-other"],
      ["被取代", getAsk(db(), keyed.id)!, "superseded"],
    ];
    expect(cases.at(-1)![1].state).toBe("superseded");
    const before = bytes();
    for (const [name, a, why, codex] of cases) {
      const r = exec(a.id, codex);
      expect({ name, ok: r.ok }).toEqual({ name, ok: false });
      expect(r.error).toContain(why);
      expect(r.error).toContain("重新发授权卡");
      expect(bytes()).toBe(before);
    }
    expect(exec("ask_nope")).toMatchObject({ ok: false, error: expect.stringContaining("ask not found") });
    // 被拒的卡没被记成「已执行」
    expect(listEvents(db(), { project: "p" }).filter((e) => e.data.op === "ask_executed")).toHaveLength(1);
    expect(bytes()).toBe(before);
  }, 120_000);

  test("revoke / borrow set / borrow off 同一套：动作名固定、参数是锁内要写的内容", () => {
    const rv = run(["lend", "revoke", "--peer", "team-a", "--print-bind"], AGENT);
    expect(structuredClone(rv)).toMatchObject({ ok: true, bind: { action: "lend_revoke", params: { peer: "team-a" } } });
    expect(run(["lend", "revoke", "--peer", "team-a", "--ask", card(rv.bind, { answer: "go" }).id], AGENT)).toMatchObject({ ok: true });
    expect(JSON.parse(bytes()).lend).toEqual([]);
    const bs = run(["borrow", "set", "team-a", "--projects", "orch", "--max-open", "2", "--print-bind"], AGENT);
    expect(structuredClone(bs)).toMatchObject({ ok: true, bind: { action: "borrow_set", params: { peer: "team-a", projects: ["orch"], maxOpen: 2 } } });
    const bsAsk = card(bs.bind, { answer: "go" });
    const before = bytes();
    expect(run(["borrow", "set", "team-a", "--projects", "orch", "--max-open", "3", "--ask", bsAsk.id], AGENT)).toMatchObject({ ok: false });
    expect(bytes()).toBe(before);
    expect(run(["borrow", "set", "team-a", "--projects", "orch", "--max-open", "2", "--ask", bsAsk.id], AGENT)).toMatchObject({ ok: true });
    expect(JSON.parse(bytes()).borrow).toMatchObject([{ peer: "team-a", maxOpen: 2 }]);
    const bo = run(["borrow", "off", "--print-bind"], AGENT);
    expect(structuredClone(bo)).toMatchObject({ ok: true, bind: { action: "borrow_off", params: { peer: null } } });
    // 批的是「全部清空」，执行的是只删 team-a：参数不同，拒
    expect(run(["borrow", "off", "--peer", "team-a", "--ask", card(bo.bind, { answer: "go" }).id], AGENT)).toMatchObject({ ok: false });
    expect(run(["borrow", "off", "--ask", card(bo.bind, { answer: "go" }).id], AGENT)).toMatchObject({ ok: true });
    expect(JSON.parse(bytes()).borrow).toEqual([]);
  }, 120_000);
});

describe("纯函数", () => {
  test("动作名固定；lend 条目去掉 grantedAt / roles，其余（指纹、到期）都进参数", () => {
    expect([lendAskAction("lend", "set"), lendAskAction("lend", "off"), lendAskAction("borrow", "set"), lendAskAction("borrow", "off")])
      .toEqual(["lend_grant", "lend_revoke", "borrow_set", "borrow_off"]);
    const e = { peer: "x", fp: "f", families: { codex: 1 }, roles: ["review", "write"] as never, repos: ["o/r"], ordersPerDay: 1, until: "2026-10-05T00:00:00.000Z", grantedAt: "g" };
    expect(bindParamsOf("lend_grant", e)).toEqual({ peer: "x", fp: "f", families: { codex: 1 }, repos: ["o/r"], ordersPerDay: 1, until: "2026-10-05T00:00:00.000Z" });
    expect(offParams(undefined)).toEqual({ peer: null });
  });

  test("consumeAsk：调用方不是发起方 → 拒且不记账", () => {
    const params = { peer: "zz" };
    const a = card({ action: "lend_revoke", params }, { answer: "go" });
    expect(consumeAsk(db(), a.id, "lend_revoke", params, "agent-other", Date.now())).toContain("not agent-other");
    expect(listEvents(db(), { project: "p" }).some((e) => e.dedupKey === usedKey(a.id))).toBe(false);
    expect(consumeAsk(db(), a.id, "lend_revoke", params, "agent-exec", Date.now())).toBeNull();
    expect(consumeAsk(db(), a.id, "lend_revoke", params, "agent-exec", Date.now())).toContain("只能用一次");
  });
});

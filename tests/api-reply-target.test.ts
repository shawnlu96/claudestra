/**
 * reply 发到 api:<tokenId> 时 token 还收不收得到（src/lib/api-reply-target.ts，bridge.ts deliverToApi 在认领请求之前调）。
 * 现场：peer 重新配对后旧 token 被停用，agent reply 到旧 chat_id，工具回 `Sent message(s): []`，对方一条没收到。
 * 「有效 peer 没有在等的请求」归 lib/pending-reply-scope.ts claimApiReply（tests/api-reply-claim.test.ts），这里只管 token 本身。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deadApiTarget, deadApiTargetReason } from "../src/lib/api-reply-target.js";
import { readPrincipalsStrict, type Principal, type PrincipalsFile } from "../src/lib/principals.js";

const SECRET = "s3cr3t-never-in-reasons";
const tok = (id: string, extra: Partial<Principal> = {}): Principal =>
  ({ id: `token:${id}`, role: "external", name: `n-${id}`, agents: ["*"], secret: SECRET, createdAt: "2026-10-01T00:00:00Z", ...extra });
const file = (...principals: Principal[]): PrincipalsFile => ({ principals });

// 现场的形状：同一 peer 的旧 token 停用、新 token 启用；另有别的 peer、普通外部 token、凭据全撤了的 guest
const PROD = file(
  tok("tok_old", { peer: "Shawn", disabled: true }),
  tok("tok_new", { peer: "Shawn" }),
  tok("tok_other", { peer: "Bob" }),
  tok("tok_web"),
  { id: "guest:abcd", role: "external", name: "guest", agents: ["a"], createdAt: "2026-10-01T00:00:00Z", disabled: true },
);

describe("deadApiTargetReason：token 本身收不到", () => {
  test("已删除（principals 里没有）→ 说明不存在、没有投递", () => {
    const r = deadApiTargetReason(PROD, "tok_gone");
    expect(r).toContain("api:tok_gone 的 token 不存在");
    expect(r).toContain("没有投递");
  });

  test("停用的 peer 旧 token → 附同一 peer 当前启用的那个 chat_id 和 send_to_agent；不列别的 token、不带密钥", () => {
    const r = deadApiTargetReason(PROD, "tok_old")!;
    expect(r).toContain("peer「Shawn」已停用的旧 token");
    expect(r).toContain("没有投递");
    expect(r).toContain("chat_id 是 api:tok_new");
    expect(r).toContain('send_to_agent(target="<对方 agent>@Shawn")');
    for (const other of ["tok_other", "tok_web", "guest:abcd", SECRET]) expect(r).not.toContain(other);
  });

  test("同一 peer 启用的 token 不止一个 / 一个都没有（peer 已移除）/ 只剩没兑换的邀请 → 不猜，不附 chat_id", () => {
    const old = tok("tok_old", { peer: "Shawn", disabled: true });
    const two = file(old, tok("tok_a", { peer: "Shawn" }), tok("tok_b", { peer: "Shawn" }));
    const none = file(old);
    const otherPeerOnly = file(old, tok("tok_bob", { peer: "Bob" }), tok("tok_inv", { peer: "invite:Shawn" }));
    for (const f of [two, none, otherPeerOnly]) {
      const r = deadApiTargetReason(f, "tok_old")!;
      expect(r).toContain("已停用");
      expect(r).not.toContain("chat_id 是");
    }
  });

  test("停用的非 peer principal（外部 token / 凭据全撤了的 guest）→ 拒", () => {
    expect(deadApiTargetReason(file(tok("tok_web", { disabled: true })), "tok_web")).toContain("api:tok_web 的 token 已停用");
    expect(deadApiTargetReason(PROD, "guest:abcd")).toContain("api:guest:abcd 的 token 已停用");
  });

  test("有效的不拦：peer token、网页 / 外部 token", () => {
    expect(deadApiTargetReason(PROD, "tok_new")).toBeNull();
    expect(deadApiTargetReason(PROD, "tok_other")).toBeNull();
    expect(deadApiTargetReason(PROD, "tok_web")).toBeNull();
  });

  test("owner:self 永不拦：principals 里没有它（还没配对过设备）也照发", () => {
    expect(deadApiTargetReason(file(), "owner:self")).toBeNull();
    expect(deadApiTargetReason(PROD, "owner:self")).toBeNull();
  });
});

describe("deadApiTarget：读 principals.json（现成的 readPrincipalsStrict）", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-reply-target-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = () => {};

  test("owner:self 不读盘", async () => {
    let reads = 0;
    expect(await deadApiTarget("owner:self", async () => (reads++, file()), quiet)).toBeNull();
    expect(reads).toBe(0);
  });

  test("文件损坏 → 放行（不挡 owner 的回复）；日志只有 token id 和原因，不带文件内容和路径", async () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, `{"principals":[{"secret":"${SECRET}" LEAKED_CONTENT`);
    const logs: string[] = [];
    expect(await deadApiTarget("tok_any", () => readPrincipalsStrict(p), (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("api:tok_any");
    for (const leak of [SECRET, "LEAKED_CONTENT", "principals\":", p]) expect(logs[0]).not.toContain(leak);
  });

  test("文件不存在 = 没有任何 token → 拒（owner:self 除外）", async () => {
    const p = join(dir, "missing.json");
    expect(await deadApiTarget("tok_any", () => readPrincipalsStrict(p), quiet)).toContain("不存在");
    expect(await deadApiTarget("owner:self", () => readPrincipalsStrict(p), quiet)).toBeNull();
  });

  test("真文件：停用的旧 token 拒并附新 chat_id，有效 token 放行", async () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify(PROD));
    expect(await deadApiTarget("tok_old", () => readPrincipalsStrict(p), quiet)).toContain("api:tok_new");
    expect(await deadApiTarget("tok_new", () => readPrincipalsStrict(p), quiet)).toBeNull();
  });
});

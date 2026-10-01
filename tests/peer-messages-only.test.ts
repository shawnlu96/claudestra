/**
 * 「只能投递消息」的 token（lib/peer-scope-gate.ts messagesOnlyAllows / setMessagesOnly，bridge/api-auth.ts 的闸门）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { messagesOnlyAllows, setMessagesOnly } from "../src/lib/peer-scope-gate.js";

describe("messagesOnlyAllows", () => {
  test("只放行投递、轮询回复、列 agent", () => {
    expect(messagesOnlyAllows("POST", "/api/v1/agents/claudestra/messages")).toBe(true);
    expect(messagesOnlyAllows("GET", "/api/v1/threads/thr_1_abc")).toBe(true);
    expect(messagesOnlyAllows("get", "/api/v1/agents")).toBe(true);
  });
  test("委托卡的台账接口也放行（只碰委托给它的卡，权限在接口里判）", () => {
    expect(messagesOnlyAllows("GET", "/api/v1/peer-ledger")).toBe(true);
    expect(messagesOnlyAllows("GET", "/api/v1/peer-ledger/tasks/T46")).toBe(true);
    expect(messagesOnlyAllows("POST", "/api/v1/peer-ledger/tasks/T46")).toBe(true);
    expect(messagesOnlyAllows("POST", "/api/v1/peer-ledger")).toBe(false);
    expect(messagesOnlyAllows("DELETE", "/api/v1/peer-ledger/tasks/T46")).toBe(false);
  });
  test("历史、事件流、打断、别的方法和畸形路径都拒", () => {
    for (const [m, p] of [
      ["GET", "/api/v1/agents/claudestra/history"],
      ["GET", "/api/v1/events"],
      ["POST", "/api/v1/agents/claudestra/interrupt"],
      ["GET", "/api/v1/agents/claudestra/messages"],
      ["POST", "/api/v1/agents/claudestra/messages/"],
      ["POST", "/api/v1/agents/a/b/messages"],
      ["DELETE", "/api/v1/threads/thr_1"],
      ["GET", "/api/v1/threads/thr_1/x"],
      ["GET", "/api/v1/ledger/p"],
    ]) expect(messagesOnlyAllows(m, p)).toBe(false);
  });
});

describe("出借接口（i28-W2）", () => {
  test("v1 四个、v2 的 hello / beat / ask，加出借方收推送的 offer：只认 POST 精确路径", () => {
    for (const e of ["poll", "claim", "lease", "result", "hello", "beat", "ask", "offer"]) expect(messagesOnlyAllows("POST", `/api/v1/lend/${e}`)).toBe(true);
  });
  test("lend 以外的新路径、lend 下别的名字、别的方法、多一段都拒", () => {
    for (const [m, p] of [
      ["GET", "/api/v1/lend/hello"],
      ["POST", "/api/v1/lend/hello/"],
      ["POST", "/api/v1/lend/beat/x"],
      ["POST", "/api/v1/lend/pushed"],
      ["GET", "/api/v1/lend/workers"],
      ["POST", "/api/v1/lend/workers"],
      ["POST", "/api/v1/lend/grant"],
      ["POST", "/api/v1/lend"],
      ["POST", "/api/v1/lendx/hello"],
      ["POST", "/api/v1/asks"],
    ]) expect(messagesOnlyAllows(m, p)).toBe(false);
  });
});

describe("setMessagesOnly", () => {
  test("只动该 peer 的有效 token，返回改动条数；重复设置为 0", () => {
    const ps = [
      { peer: "Shawn", agents: ["a"] },
      { peer: "Shawn", agents: ["a"], disabled: true },
      { peer: "Other", agents: ["a"] },
    ] as { peer: string; agents: string[]; disabled?: boolean; messagesOnly?: boolean }[];
    expect(setMessagesOnly(ps, "Shawn", true)).toBe(1);
    expect(ps.map((p) => !!p.messagesOnly)).toEqual([true, false, false]);
    expect(setMessagesOnly(ps, "Shawn", true)).toBe(0);
    expect(setMessagesOnly(ps, "Shawn", false)).toBe(1);
    expect("messagesOnly" in ps[0]).toBe(false);
  });
});

describe("鉴权闸门", () => {
  let dir: string;
  const SECRET = "a".repeat(48);
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "msg-only-"));
    const principals = [{ id: "token:tok_mo", role: "external", name: "script", agents: ["*"], secret: SECRET, createdAt: "2026-09-29T00:00:00Z", messagesOnly: true }];
    writeFileSync(join(dir, "principals.json"), JSON.stringify({ principals }));
    setApiAuthPrincipalsPathForTest(join(dir, "principals.json"));
  });
  afterAll(() => {
    setApiAuthPrincipalsPathForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string) => {
    const r = new Request(`http://bridge.local${path}`, { method, headers: { Authorization: `Bearer ${SECRET}` } });
    setRequestContext(r, { source: "lan", clientIp: "192.0.2.1", https: true });
    return authenticateApi(r, new URL(r.url), { rateLimit: false });
  };
  test("投递放行，读历史 / 事件流 / 打断 403 messages_only", async () => {
    expect((await call("POST", "/api/v1/agents/x/messages")) instanceof Response).toBe(false);
    for (const [m, p] of [["GET", "/api/v1/agents/x/history"], ["GET", "/api/v1/events"], ["POST", "/api/v1/agents/x/interrupt"]]) {
      const res = (await call(m, p)) as Response;
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("messages_only");
    }
  });
});

/**
 * Chat 的 HTTP 口与 bridge 接线（bridge/local-api/talk*.ts、bridge/talk*.ts）：
 * 权限矩阵（owner / guest / 别的 guest / 集成 token / peer）、guest 在 API 层读不到自己不在的房间、SSE 只推给成员、
 * 发 chat 不投给任何 agent、丢进工作台预览与 agent 收到的逐字一致、连点只投一次、押后的结局回写。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setAsksForTest } from "../src/bridge/asks.js";
import { notifyHeldSettled } from "../src/bridge/held-queue.js";
import { sseEventAllow } from "../src/bridge/ledger-feed.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { renderApiInbound, type ApiUserEndpoint, type Delivery, type Envelope } from "../src/bridge/router.js";
import { setTalkForTest } from "../src/bridge/talk.js";
import { effectivePrincipal, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const FP = "aaaa-bbbb-cccc-dddd";
const at = "2026-09-29T00:00:00Z";
const cred = (id: string, grant: Grant) => ({ id, v: 1 as const, type: "bearer" as const, hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const guestBase = (hex: string, name: string, disabled = false): Principal => ({ id: `guest:${hex}`, role: "external", name, agents: ["agent-x"], createdAt: at, ...(disabled ? { disabled } : {}) });
const GUESTS = [guestBase("aa", "小王"), guestBase("a2", "小王的平板"), guestBase("bb", "老李"), guestBase("cc", "停用的", true)];
const owner = effectivePrincipal({ principal: OWNER_BASE, credential: cred("dev_o", { agents: ["*", "master"], terminal: true, manage: true }) });
const guest = (hex: string) => effectivePrincipal({ principal: GUESTS.find((g) => g.id === `guest:${hex}`)!, credential: cred(`dev_${hex}`, { agents: ["agent-x"], terminal: false, manage: false }) });
const INTEGRATION: Principal = { id: "token:tok_int", role: "external", name: "integration", agents: ["*"], createdAt: at };
const SCOPED: Principal = { id: "token:tok_s", role: "external", name: "bot", agents: ["agent-x"], createdAt: at };
const PEER: Principal = { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at };

const REGISTRY = [
  { name: "agent-x", channelId: "111", status: "active" },
  { name: "agent-y", channelId: "222", status: "active" },
] as RegistryAgent[];
const delivered: Envelope[] = [];
const held: Envelope[] = [];
let online = true;
const clients = new Map<string, { ws: never; cwd?: string }>();

async function api(p: Principal, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const url = new URL(`http://x/api/v1${path}`);
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = body instanceof Uint8Array ? body : JSON.stringify(body);
  const r = await handleLocalApi(new Request(url.toString(), init), url, p);
  if (!r) throw new Error(`no route: ${method} ${path}`);
  return { status: r.status, json: r.headers.get("content-type")?.includes("json") ? ((await r.json()) as Record<string, any>) : {} };
}
const post = (p: Principal, room: string, text: string, extra: Record<string, unknown> = {}) =>
  api(p, "POST", `/talk/rooms/${encodeURIComponent(room)}/messages`, { id: `tm_${randomUUID()}`, text, ...extra });

let dm = "";
let firstMsg = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "talk-api-"));
  setTalkForTest({ dbPath: join(dir, "talk.sqlite"), attDir: join(dir, "att"), fp: () => FP, principals: async () => ({ principals: [OWNER_BASE, ...GUESTS] }), ownerNickname: () => "Shawn" });
  clients.set("111", { ws: { tag: "ws" } as never });
  setAsksForTest({
    path: tempLedgerPath(),
    registry: REGISTRY,
    deps: {
      clients: clients as never,
      deliver: async (env: Envelope): Promise<Delivery> => {
        if (!online) return { envelope: env, outcome: { kind: "error", error: new Error("offline") } } as Delivery;
        delivered.push(env);
        return { envelope: env, outcome: { kind: "sent" } } as Delivery;
      },
      hold: (env: Envelope) => void held.push(env),
      controlChannelId: "999",
    },
  });
  const r = await api(owner, "POST", "/talk/rooms", { kind: "dm", with: "local:guest:aa" });
  dm = r.json.room.key;
  firstMsg = (await post(owner, dm, "你看下这个设计", { mentions: ["local:guest:aa"] })).json.message.key;
});
afterAll(() => {
  setTalkForTest(undefined);
  setAsksForTest(undefined);
});

describe("权限矩阵", () => {
  test("集成 token、scoped token、peer 都不是人：talk 全部 403", async () => {
    for (const p of [INTEGRATION, SCOPED, PEER]) {
      expect((await api(p, "GET", "/talk/rooms")).status).toBe(403);
      expect((await api(p, "GET", `/talk/rooms/${dm}/messages`)).status).toBe(403);
    }
  });
  test("guest 在 API 层读不到自己不在的房间：列表里没有，直接按键读 / 写 / 删都是 404", async () => {
    expect((await api(guest("aa"), "GET", "/talk/rooms")).json.rooms.map((r: any) => r.key)).toEqual([dm]);
    expect((await api(guest("bb"), "GET", "/talk/rooms")).json.rooms).toEqual([]);
    expect((await api(guest("bb"), "GET", `/talk/rooms/${dm}/messages`)).status).toBe(404);
    expect((await post(guest("bb"), dm, "混进来")).status).toBe(404);
    const [origin, id] = firstMsg.split("/");
    expect((await api(guest("bb"), "DELETE", `/talk/rooms/${dm}/messages/${origin}/${id}`)).status).toBe(404);
  });
  test("guest 只能和 owner 开 dm、不能建 thread；目录里看不到别的 guest", async () => {
    expect((await api(guest("aa"), "POST", "/talk/rooms", { kind: "dm", with: "local:guest:bb" })).status).toBe(403);
    expect((await api(guest("aa"), "POST", "/talk/rooms", { kind: "thread", members: ["local:guest:bb"] })).status).toBe(403);
    const people = (await api(guest("bb"), "GET", "/talk/people")).json.people.map((p: any) => p.id);
    expect(people).toEqual(["local:owner:self"]);
    const all = (await api(owner, "GET", "/talk/people")).json.people.map((p: any) => p.id).sort();
    expect(all).toEqual(["local:guest:a2", "local:guest:aa", "local:guest:bb", "local:owner:self"]);
  });
  test("停用的 guest 开不了 dm；guest 改不了别人的备注名、合并不了人", async () => {
    expect((await api(owner, "POST", "/talk/rooms", { kind: "dm", with: "local:guest:cc" })).status).toBe(404);
    expect((await api(guest("aa"), "PATCH", "/talk/people/local%3Aguest%3Abb", { displayName: "x" })).status).toBe(403);
    expect((await api(guest("aa"), "POST", "/talk/people/local%3Aguest%3Aa2/merge", { into: "local:guest:aa" })).status).toBe(403);
  });
  test("删除只有作者或 owner", async () => {
    const m = (await post(owner, dm, "owner 写的")).json.message;
    expect((await api(guest("aa"), "DELETE", `/talk/rooms/${dm}/messages/${m.origin}/${m.id}`)).status).toBe(403);
    const g = (await post(guest("aa"), dm, "小王写的")).json.message;
    expect((await api(owner, "DELETE", `/talk/rooms/${dm}/messages/${g.origin}/${g.id}`)).status).toBe(200);
  });
});

describe("合并同一个人的多台 guest 设备（Q5）", () => {
  test("owner 把平板并进小王：平板看得到小王的房间，显示成同一个人", async () => {
    expect((await api(guest("a2"), "GET", "/talk/rooms")).json.rooms).toEqual([]);
    expect((await api(owner, "POST", "/talk/people/local%3Aguest%3Aa2/merge", { into: "local:guest:aa" })).status).toBe(200);
    expect((await api(guest("a2"), "GET", "/talk/rooms")).json.rooms.map((r: any) => r.key)).toEqual([dm]);
    const m = (await post(guest("a2"), dm, "平板上发的")).json.message;
    expect(m.author).toEqual({ id: "local:guest:aa", name: "小王" });
    expect(m.mine).toBe(true);
    expect((await api(owner, "POST", "/talk/people/local%3Aguest%3Aa2/unmerge", {})).status).toBe(200);
    expect((await api(guest("a2"), "GET", "/talk/rooms")).json.rooms).toEqual([]);
  });
});

describe("SSE 与「不烧 token」", () => {
  test("talk 事件只推给房间成员", () => {
    const evt = { seq: 1, ts: at, agent: "", chatId: "", type: "talk" as const, data: { room: dm, members: [`${FP}/owner:self`, `${FP}/guest:aa`], what: "message" } };
    expect(sseEventAllow(owner)(evt)).toBe(true);
    expect(sseEventAllow(guest("aa"))(evt)).toBe(true);
    expect(sseEventAllow(guest("bb"))(evt)).toBe(false);
    expect(sseEventAllow(INTEGRATION)(evt)).toBe(false);
    expect(sseEventAllow(PEER)(evt)).toBe(false);
  });
  test("发 chat、@ 人、建房都不投给任何 agent", async () => {
    const before = [delivered.length, held.length];
    await post(guest("aa"), dm, "@owner 看这里", { mentions: ["local:owner:self"] });
    await api(owner, "POST", "/talk/rooms", { kind: "thread", members: ["local:guest:aa", "local:guest:bb"], title: "评审" });
    expect([delivered.length, held.length]).toEqual(before);
  });
  test("@ 的对象必须在房间里", async () => {
    expect((await post(owner, dm, "hi", { mentions: ["local:guest:bb"] })).status).toBe(400);
  });
});

describe("丢进工作台", () => {
  const renderLikeBridge = (env: Envelope) => renderApiInbound({ from: env.from as ApiUserEndpoint, content: env.content });

  test("预览就是 agent 收到的原文（含 Web 用户抬头），以发起人自己的身份；连点同一个 dropId 只投一次", async () => {
    const pv = await api(guest("aa"), "POST", "/talk/drops/preview", { room: dm, msgs: [firstMsg], agent: "agent-x" });
    expect(pv.status).toBe(200);
    expect(pv.json.content).toContain("[🌐 来自 Web 端用户「小王」");
    expect(pv.json.content).toContain("你看下这个设计");
    const dropId = `td_${randomUUID()}`;
    const n = delivered.length;
    const [a, b] = await Promise.all([
      api(guest("aa"), "POST", "/talk/drops", { dropId, sha: pv.json.sha, room: dm, msgs: [firstMsg], agent: "agent-x" }),
      api(guest("aa"), "POST", "/talk/drops", { dropId, sha: pv.json.sha, room: dm, msgs: [firstMsg], agent: "agent-x" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(delivered.length).toBe(n + 1);
    const env = delivered[delivered.length - 1];
    expect(renderLikeBridge(env)).toBe(pv.json.content);
    expect(env.from).toMatchObject({ kind: "api", tokenId: "guest:aa", name: "小王" });
    expect((env.from as ApiUserEndpoint).owner).toBeUndefined();
    expect(env.intent).toBe("notification");
    expect((await api(guest("aa"), "POST", "/talk/drops", { dropId, sha: pv.json.sha, room: dm, msgs: [firstMsg], agent: "agent-x" })).json.drop.state).toBe("sent");
    expect(delivered.length).toBe(n + 1);
    expect((await api(owner, "POST", "/talk/drops", { dropId, sha: pv.json.sha, room: dm, msgs: [firstMsg], agent: "agent-x" })).status).toBe(409);
  });
  test("预览过期（中间改了备注名）回 409；目标不在发起人 scope 里 403；不是成员 404", async () => {
    const pv = await api(owner, "POST", "/talk/drops/preview", { room: dm, msgs: [firstMsg], agent: "agent-x" });
    await api(owner, "PATCH", "/talk/people/local%3Aowner%3Aself", { displayName: "老板" });
    expect((await api(owner, "POST", "/talk/drops", { dropId: `td_${randomUUID()}`, sha: pv.json.sha, room: dm, msgs: [firstMsg], agent: "agent-x" })).status).toBe(409);
    expect((await api(guest("aa"), "POST", "/talk/drops/preview", { room: dm, msgs: [firstMsg], agent: "agent-y" })).status).toBe(403);
    expect((await api(guest("aa"), "POST", "/talk/drops/preview", { room: dm, msgs: [firstMsg], agent: "master" })).status).toBe(403);
    expect((await api(guest("bb"), "POST", "/talk/drops/preview", { room: dm, msgs: [firstMsg], agent: "agent-x" })).status).toBe(404);
  });
  test("投不出去进押后队列不丢；押后送达 → sent，24 小时放弃 → failed", async () => {
    online = false;
    const go = async () => {
      const pv = await api(owner, "POST", "/talk/drops/preview", { room: dm, msgs: [firstMsg], agent: "agent-x" });
      return (await api(owner, "POST", "/talk/drops", { dropId: `td_${randomUUID()}`, sha: pv.json.sha, room: dm, msgs: [firstMsg], agent: "agent-x" })).json.drop;
    };
    const d1 = await go();
    const d2 = await go();
    online = true;
    expect([d1.state, d2.state]).toEqual(["held", "held"]);
    const e1 = held.find((e) => e.meta.messageId === d1.messageId)!;
    const e2 = held.find((e) => e.meta.messageId === d2.messageId)!;
    notifyHeldSettled(e1, "delivered");
    notifyHeldSettled(e2, "gave-up");
    notifyHeldSettled(e1, "gave-up");
    const again = async (d: any) => (await api(owner, "POST", "/talk/drops", { dropId: d.dropId, sha: d.contentSha, room: dm, msgs: d.msgIds, agent: "agent-x" })).json.drop;
    expect((await again(d1)).state).toBe("sent");
    expect((await again(d2)).state).toBe("failed");
  });
});

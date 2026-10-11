/** 本地 API：GET/PUT /api/v1/notify 与 POST /api/v1/notify/test（src/bridge/local-api/notify.ts）——只给全权、密钥不回显且不传沿用、测试发送、沙箱拒发 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setNotifyIoForTest } from "../src/bridge/local-api/notify.js";
import type { NotifyFile } from "../src/lib/notify-channels.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };

let file: NotifyFile = { channels: [] };
const sent: { url: string; body: Record<string, unknown> }[] = [];
let status = 200;
let sandboxed = false;
beforeAll(() => {
  setNotifyIoForTest({
    sandboxed: () => sandboxed,
    lookup: async () => ["203.0.113.7"],
    read: () => file,
    write: (f) => {
      file = f;
    },
    linkBase: () => "https://relay.example",
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status });
    }) as unknown as typeof fetch,
  });
});
afterAll(() => setNotifyIoForTest(undefined));

const call = async (method: string, path: string, who: Principal, body?: unknown) => {
  const url = new URL(`http://127.0.0.1/api/v1${path}`);
  const req = new Request(url.href, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  const res = (await handleLocalApi(req, url, who))!;
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

describe("/notify", () => {
  test("没有全权：读、写、测试都 403", async () => {
    expect((await call("GET", "/notify", GUEST)).status).toBe(403);
    expect((await call("PUT", "/notify", GUEST, { channels: [] })).status).toBe(403);
    expect((await call("POST", "/notify/test", GUEST, { id: "x" })).status).toBe(403);
  });

  test("PUT 保存后 GET 不回显密钥；再 PUT 不带密钥沿用旧值", async () => {
    const put = await call("PUT", "/notify", OWNER, { channels: [{ id: "bark0001", kind: "bark", name: "iPhone", deviceKey: "AbCdEf123456" }] });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.json)).not.toContain("AbCdEf123456");
    const got = await call("GET", "/notify", OWNER);
    expect(got.json).toMatchObject({ ok: true, linkBase: "https://relay.example", openUrl: "" });
    expect(got.json.channels[0]).toMatchObject({ id: "bark0001", deviceKeySet: true, deviceKeyHint: "…3456" });
    expect(got.json.channels[0]).not.toHaveProperty("deviceKey");
    await call("PUT", "/notify", OWNER, { channels: [{ id: "bark0001", kind: "bark", name: "我的 iPhone", types: ["ask"] }] });
    expect(file.channels[0]).toMatchObject({ name: "我的 iPhone", deviceKey: "AbCdEf123456", types: ["ask"] });
  });

  test("不合法的配置 400，原配置不动", async () => {
    const before = JSON.stringify(file);
    const r = await call("PUT", "/notify", OWNER, { channels: [{ kind: "ntfy", topic: "has space" }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(file)).toBe(before);
  });

  test("测试发送：已保存的按 id；草稿缺密钥按 id 取旧值；结果进最近记录；未知 id 400", async () => {
    sent.length = 0;
    const r = await call("POST", "/notify/test", OWNER, { id: "bark0001" });
    expect(r.json.result).toMatchObject({ ok: true, status: 200, type: "test" });
    expect(sent[0]).toMatchObject({ url: "https://api.day.app/push", body: { device_key: "AbCdEf123456" } });
    expect(String(sent[0].body.url)).toStartWith("https://relay.example/chat");
    const draft = await call("POST", "/notify/test", OWNER, { channel: { id: "bark0001", kind: "bark", server: "https://bark.example" } });
    expect(draft.json.result.ok).toBe(true);
    expect(sent[1]).toMatchObject({ url: "https://bark.example/push", body: { device_key: "AbCdEf123456" } });
    status = 500;
    const failed = await call("POST", "/notify/test", OWNER, { id: "bark0001" });
    expect(failed.json.result).toMatchObject({ ok: false, status: 500 });
    status = 200;
    expect((await call("GET", "/notify", OWNER)).json.recent.bark0001[0]).toMatchObject({ ok: false, status: 500 });
    expect((await call("POST", "/notify/test", OWNER, { id: "nope0000" })).status).toBe(400);
  });

  test("沙箱里测试发送直接 409，不发请求", async () => {
    sent.length = 0;
    sandboxed = true;
    const r = await call("POST", "/notify/test", OWNER, { id: "bark0001" });
    sandboxed = false;
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("sandbox");
    expect(sent).toHaveLength(0);
  });
});

test("Codex 复审 r2 #6：借已保存的 id 带草稿配置测试，也算草稿（全局每分钟 10 条）", async () => {
  sent.length = 0;
  const codes: string[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await call("POST", "/notify/test", OWNER, { channel: { id: "bark0001", kind: "bark", server: `https://bark${i}.example` } });
    codes.push(r.json.result.error ?? "ok");
  }
  // 前面「测试发送」用例已经发过 1 条草稿：这一分钟一共只放 10 条草稿
  expect(codes.filter((c) => c !== "rate_limited")).toHaveLength(9);
});

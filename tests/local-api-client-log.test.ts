/** 本地 API：POST /api/v1/client-log——文本或 {lines}，每行 ≤ 2 KB，每凭据 60 行/分钟，扩展注入的报错丢掉，追加到 client.log */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientLogLines, setClientLogPathForTest } from "../src/bridge/local-api/client-log.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import type { Principal } from "../src/lib/principals.js";

let dir: string;
let logPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "client-log-"));
  logPath = join(dir, "web", "client.log");
  setClientLogPathForTest(logPath);
});
afterAll(() => {
  setClientLogPathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** 限流按凭据；每个用例用自己的凭据，互不影响 */
const principal = (credential: string): Principal => ({ id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential });
async function post(body: string, credential: string, contentType = "text/plain"): Promise<Response> {
  const r = new Request("http://bridge.local/api/v1/client-log", { method: "POST", body, headers: { "content-type": contentType, "user-agent": "Mozilla/5.0 (iPhone) Safari" } });
  return (await handleLocalApi(r, new URL(r.url), principal(credential)))!;
}
const logLines = () => readFileSync(logPath, "utf8").split("\n").filter(Boolean);

describe("POST /api/v1/client-log", () => {
  test("纯文本按行追加：时间戳 + 内容 + UA 前 40 字；空行跳过", async () => {
    const res = await post("[boot] v2.28.0 abc123\n\n[sse] reconnect #1\n", "dev_a");
    expect(await res.json()).toEqual({ ok: true, written: 2, dropped: 0 });
    const lines = logLines();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[boot\] v2\.28\.0 abc123 \| Mozilla\/5\.0 \(iPhone\) Safari$/);
    expect(lines[1]).toContain("[sse] reconnect #1 |");
  });
  test("JSON {lines}；旧客户端的 {msg} 也认；坏 JSON / 形状不对 400", async () => {
    expect(await (await post(JSON.stringify({ lines: ["a", 1, "b"] }), "dev_b", "application/json")).json()).toEqual({ ok: true, written: 2, dropped: 0 });
    expect(await (await post(JSON.stringify({ msg: "legacy" }), "dev_b", "application/json")).json()).toEqual({ ok: true, written: 1, dropped: 0 });
    expect((await post("{bad", "dev_b", "application/json")).status).toBe(400);
    expect((await post(JSON.stringify({ nope: true }), "dev_b", "application/json")).status).toBe(400);
    expect(parseClientLogLines("x\r\ny", "text/plain")).toEqual(["x", "y"]);
    expect(parseClientLogLines("[]", "application/json")).toBeNull();
  });
  test("浏览器扩展注入脚本的报错丢掉；控制字符去掉、内嵌换行折成 ⏎；超过 2 KB 截断", async () => {
    const before = logLines().length;
    const res = await post(`[pwa] error chrome-extension://abc/inpage.js func not found\n[tap]\u0007 a\u0000b\n${"x".repeat(5000)}`, "dev_c");
    expect(await res.json()).toEqual({ ok: true, written: 2, dropped: 1 });
    const lines = logLines().slice(before);
    expect(lines[0]).toContain("[tap] ab |");
    expect(lines[1].length).toBeLessThan(2048 + 80);
    expect(lines[1]).toContain("x".repeat(2048));
    expect(lines[1]).not.toContain("x".repeat(2049));
  });
  test("每凭据 60 行/分钟：第 61 行起丢；全被限时 429", async () => {
    const body = Array.from({ length: 61 }, (_, i) => `[loop] ${i}`).join("\n");
    expect(await (await post(body, "dev_d")).json()).toEqual({ ok: true, written: 60, dropped: 1 });
    const res = await post("[loop] more", "dev_d");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false, written: 0, dropped: 1 });
    // 别的凭据不受影响
    expect(await (await post("[loop] other", "dev_e")).json()).toEqual({ ok: true, written: 1, dropped: 0 });
  });
  test("体超 64 KB → 413；GET → null", async () => {
    expect((await post("y".repeat(65 * 1024), "dev_f")).status).toBe(413);
    const r = new Request("http://bridge.local/api/v1/client-log", { method: "GET" });
    expect(await handleLocalApi(r, new URL(r.url), principal("dev_f"))).toBeNull();
  });
});

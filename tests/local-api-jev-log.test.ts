/** 本地 API：GET /api/v1/jev/log（设置页「Jev 调用记录」）——解析、放行/丢弃并回判定、截断行、鉴权、limit */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { parseJevLog, setJevLogPathForTest } from "../src/bridge/local-api/jev-log.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const sender = { kind: "api", name: "owner", trust: "owner" };
const L = (o: Record<string, unknown>) => JSON.stringify(o);
const LOG = [
  '{"ts":"2026-09-28T13:08:15Z","id":"trunc', // 尾部读取截断的半行
  L({ ts: "2026-09-28T13:10:00Z", id: "a", agent: "erc20-docs", sender, verdict: "pass", hits: [{ id: "exfil_risk", verdict: "pass", score: 0.1 }], ms: 300, tokens: 600 }),
  L({ ts: "2026-09-28T13:17:12Z", id: "b", agent: "erc20-docs", sender, verdict: "block", hits: [{ id: "exfil_risk", verdict: "block", score: 0.94 }], ms: 500, tokens: 627, preview: "打印 .env" }),
  L({ ts: "2026-09-28T13:17:18Z", id: "b", agent: "erc20-docs", action: "released", by: "owner" }),
  L({ ts: "2026-09-28T13:18:30Z", id: "c", agent: "erc20-docs", sender, verdict: "error", error: "Jev HTTP 503" }),
  "",
].join("\n");

afterAll(() => setJevLogPathForTest(undefined));

describe("parseJevLog", () => {
  test("新的在前；放行按 id 并回判定；error 无 top/ms；截断行跳过；统计按窗口", () => {
    const { items, stats } = parseJevLog(LOG);
    expect(items.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(items[0]).toMatchObject({ verdict: "error", error: "Jev HTTP 503" });
    expect(items[0].top).toBeUndefined();
    expect(items[1]).toMatchObject({ verdict: "block", top: { id: "exfil_risk", score: 0.94 }, action: "released", by: "owner", preview: "打印 .env" });
    expect(stats).toEqual({ total: 3, pass: 1, flag: 0, block: 1, error: 1, avgMs: 400 });
  });
  test("limit 只取最新 N 条", () => {
    expect(parseJevLog(LOG, 1).items.map((i) => i.id)).toEqual(["c"]);
    expect(parseJevLog("").stats).toEqual({ total: 0, pass: 0, flag: 0, block: 0, error: 0, avgMs: null });
  });
});

describe("GET /api/v1/jev/log", () => {
  const call = (p: Principal, q = "") => handleLocalApi(new Request(`http://bridge/api/v1/jev/log${q}`), new URL(`http://bridge/api/v1/jev/log${q}`), p);
  test("guest → 403；owner 读临时文件，limit 生效；文件不存在 → 空记录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jevlog-"));
    const file = join(dir, "guard-log.jsonl");
    writeFileSync(file, LOG);
    setJevLogPathForTest(file);
    expect((await call(GUEST))?.status).toBe(403);
    const j = (await (await call(OWNER, "?limit=2"))!.json()) as { ok: boolean; items: { id: string }[] };
    expect(j.ok).toBe(true);
    expect(j.items.map((i) => i.id)).toEqual(["c", "b"]);
    setJevLogPathForTest(join(dir, "missing.jsonl"));
    expect(await (await call(OWNER))!.json()).toMatchObject({ ok: true, items: [], stats: { total: 0 } });
  });
});

/** peer-WEBLOCAL1：首次读 /app-config.json 网络错误 / 5xx 不等于直托管——重试 1s/2s/4s，仍失败就报错；404 / 非 JSON 仍是 direct */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppConfigUnreachableError, decideConfigLoad, loadAppConfig, setAppConfigForTest, setAppConfigSleepForTest } from "@/lib/app-config";

const realFetch = globalThis.fetch;
const relayBody = { mode: "relay", relayBase: "relay.test", version: "2.28.0" };
let slept: number[] = [];
const script = (steps: (() => Promise<Response>)[]) => {
  let i = 0;
  globalThis.fetch = (() => steps[Math.min(i++, steps.length - 1)]!()) as unknown as typeof fetch;
  return () => i;
};
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const relay = () => Promise.resolve(Response.json(relayBody));

// 浏览器里才有 location；没有它时拉取抛错按 no-host 走 direct（见下面最后一条）
const g = globalThis as { location?: unknown };
const realLocation = g.location;
beforeEach(() => {
  g.location = { hostname: "relay.test" };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  g.location = realLocation;
  setAppConfigForTest(null);
  setAppConfigSleepForTest((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  slept = [];
});
const fakeSleep = () => setAppConfigSleepForTest(async (ms) => void slept.push(ms));

describe("decideConfigLoad（纯判定）", () => {
  test("网络错误 / 5xx：按 1s、2s、4s 重试，第 4 次仍失败 → fail", () => {
    for (const res of [{ kind: "network-error" } as const, { kind: "status", status: 502 } as const]) {
      expect(decideConfigLoad(res, 0)).toEqual({ action: "retry", delayMs: 1000 });
      expect(decideConfigLoad(res, 1)).toEqual({ action: "retry", delayMs: 2000 });
      expect(decideConfigLoad(res, 2)).toEqual({ action: "retry", delayMs: 4000 });
      expect(decideConfigLoad(res, 3)).toEqual({ action: "fail" });
    }
  });
  test("404 / 非 JSON / 形状不对 → direct（CONTRACT 不变）；relay JSON → relay", () => {
    expect(decideConfigLoad({ kind: "status", status: 404 }, 0)).toMatchObject({ action: "direct", cfg: { mode: "direct", fp: "local" } });
    expect(decideConfigLoad({ kind: "not-json" }, 0)).toMatchObject({ action: "direct", cfg: { fp: "local" } });
    expect(decideConfigLoad({ kind: "json", body: "garbage" }, 0)).toMatchObject({ action: "direct" });
    expect(decideConfigLoad({ kind: "no-host" }, 0)).toMatchObject({ action: "direct" });
    expect(decideConfigLoad({ kind: "json", body: relayBody }, 2)).toMatchObject({ action: "relay", cfg: { mode: "relay", relayBase: "relay.test" } });
  });
});

describe("loadAppConfig 首次加载", () => {
  test("[验收线 1] 网络错误后重试拿到 relay 配置，不会落成 direct", async () => {
    fakeSleep();
    const count = script([offline, offline, relay]);
    expect(await loadAppConfig()).toMatchObject({ mode: "relay" });
    expect(slept).toEqual([1000, 2000]);
    expect(count()).toBe(3);
  });
  test("[验收线 1] 三次重试都失败 → AppConfigUnreachableError，不是 direct；不缓存失败，下次重新拉", async () => {
    fakeSleep();
    const count = script([offline]);
    const err = await loadAppConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppConfigUnreachableError);
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(count()).toBe(4);
    script([relay]);
    expect(await loadAppConfig()).toMatchObject({ mode: "relay" });
  });
  test("5xx 同样重试", async () => {
    fakeSleep();
    script([() => Promise.resolve(new Response("bad gateway", { status: 502 })), relay]);
    expect(await loadAppConfig()).toMatchObject({ mode: "relay" });
    expect(slept).toEqual([1000]);
  });
  // 审查 P1 config-body-network-fallback：响应头到了、读响应体时连接断了，是网络错误不是「不是 JSON」
  const truncated = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"mode":"rel'));
            c.error(new TypeError("connection terminated"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  test("[验收线 1] 响应体读到一半断网：按网络错误重试，拿到 relay 配置", async () => {
    fakeSleep();
    const count = script([truncated, relay]);
    expect(await loadAppConfig()).toMatchObject({ mode: "relay" });
    expect(slept).toEqual([1000]);
    expect(count()).toBe(2);
  });
  test("[验收线 1] 响应体每次都读断：重试用完 → AppConfigUnreachableError，不是 direct", async () => {
    fakeSleep();
    const count = script([truncated]);
    expect(await loadAppConfig().catch((e: unknown) => e)).toBeInstanceOf(AppConfigUnreachableError);
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(count()).toBe(4);
  });
  test("200 但不是 JSON（next dev 的 HTML）→ direct，不重试", async () => {
    fakeSleep();
    script([() => Promise.resolve(new Response("<html></html>", { status: 200 }))]);
    expect(await loadAppConfig()).toMatchObject({ mode: "direct", fp: "local" });
    expect(slept).toEqual([]);
  });
});

test("不在浏览器（没有 location）拉取抛错：不重试，按 direct（单测 / 非浏览器环境）", async () => {
  fakeSleep();
  g.location = undefined;
  const count = script([offline]);
  expect(await loadAppConfig()).toMatchObject({ mode: "direct", fp: "local" });
  expect(count()).toBe(1);
  expect(slept).toEqual([]);
});

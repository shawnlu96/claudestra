/** web/lib/app-config.ts 的 loadAppConfig：只拉一次、refresh 重拉并更新、刷新失败保留旧值（不会把模式抖成 direct） */
import { afterEach, describe, expect, test } from "bun:test";
import { loadAppConfig, setAppConfigForTest } from "@/lib/app-config";

const realFetch = globalThis.fetch;
let calls = 0;
let answer: (() => Promise<Response>) | null = null;
const install = (fn: () => Promise<Response>) => {
  answer = fn;
  globalThis.fetch = ((input: unknown) => {
    calls++;
    expect(String(input)).toBe("/app-config.json");
    return answer!();
  }) as typeof fetch;
};
const relay = (webCommit: string) => () => Promise.resolve(Response.json({ mode: "relay", relayBase: "relay.test", version: "2.28.0", webCommit }));

afterEach(() => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  calls = 0;
});

describe("loadAppConfig", () => {
  test("默认缓存：并发两次只拉一次，之后不再拉", async () => {
    install(relay("aaa1111"));
    const [a, b] = await Promise.all([loadAppConfig(), loadAppConfig()]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ mode: "relay", webCommit: "aaa1111" });
    expect(await loadAppConfig()).toBe(a);
    expect(calls).toBe(1);
  });
  test("refresh 重拉并更新 webCommit；拉不到时保留旧配置而不是退回 direct", async () => {
    install(relay("aaa1111"));
    await loadAppConfig();
    answer = relay("bbb2222");
    expect(await loadAppConfig({ refresh: true })).toMatchObject({ mode: "relay", webCommit: "bbb2222" });
    answer = () => Promise.reject(new Error("offline"));
    expect(await loadAppConfig({ refresh: true })).toMatchObject({ mode: "relay", webCommit: "bbb2222" });
    answer = () => Promise.resolve(new Response("nope", { status: 404 }));
    expect(await loadAppConfig({ refresh: true })).toMatchObject({ mode: "relay", webCommit: "bbb2222" });
    expect(calls).toBe(4);
  });
  test("首次就拉不到 → direct 兜底（本地 next dev 直连 bridge）", async () => {
    install(() => Promise.resolve(new Response("nope", { status: 404 })));
    expect(await loadAppConfig()).toMatchObject({ mode: "direct", fp: "local" });
  });
});

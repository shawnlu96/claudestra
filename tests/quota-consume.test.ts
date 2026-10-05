/**
 * 使用 Codex 重置卡（lib/quota-consume.ts + QuotaScheduler.consumeCodexReset）：先用现拉的数据核对再 POST、POST 只发一次、
 * 请求形状照官方 codex CLI、上游各种答复与失败原样返回、事后刷新入库、并发连点只发一次、开关 / 凭据挡在 POST 之前。
 * 上游全是假的（fakeFetch / fakePost）：真实的「使用」接口一次都不调。
 */

import { describe, expect, test } from "bun:test";
import { CODEX_CONSUME_URL } from "../src/lib/quota-consume.js";
import type { FetchErrorCode } from "../src/lib/quota-providers.js";
import { hmacHex } from "../src/lib/quota-credentials.js";
import { memoryQuotaStore } from "../src/lib/quota-state.js";
import {
  CODEX_ACCOUNT, CODEX_TOKEN, CREDIT_IDS, SECRET, expectNoSentinel, fakePost, jsonResponse, usableRoutes, type PostCall,
} from "./quota-fixtures.js";
import { harness } from "./quota-scheduler-harness.js";

const ACCOUNT_KEY = hmacHex(SECRET, "codex", CODEX_ACCOUNT);
const keyOf = (rawId: string) => hmacHex(SECRET, ACCOUNT_KEY, rawId);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESET = () => jsonResponse(200, { code: "reset", credit: { id: CREDIT_IDS[0] }, windows_reset: 2 });

/** 上游：POST 之前此刻可用 1 次，POST 之后（不管答复什么）变 0，用来证明事后刷新真的入库了 */
function setup(answer: (c: PostCall) => Response | Promise<Response> = RESET, usableBefore = 1) {
  let posted = false;
  const post = fakePost(async (c) => {
    posted = true;
    return answer(c);
  });
  const h = harness(usableRoutes(() => (posted ? 0 : usableBefore)), memoryQuotaStore(), post);
  const gets = () => h.fetch.calls.map((c) => c.url.split("/").pop());
  return { h, post, gets };
}

describe("成功路径", () => {
  test("先拉 usage + 明细核对，再 POST 一次：最早到期那张的原始 id + 新请求号，请求头与 GET 同一份", async () => {
    const { h, post, gets } = setup();
    expect(await h.scheduler.consumeCodexReset(null)).toEqual({ status: "done", code: "reset", windowsReset: 2 });
    expect(post.calls).toHaveLength(1);
    const c = post.calls[0];
    expect([c.url, c.method, c.redirect]).toEqual([CODEX_CONSUME_URL, "POST", "manual"]);
    expect(Object.keys(c.body).sort()).toEqual(["credit_id", "redeem_request_id"]);
    expect(c.body.credit_id).toBe(CREDIT_IDS[0]); // 10-04 到期，比 10-22 那张早
    expect(String(c.body.redeem_request_id)).toMatch(UUID);
    expect(c.headers.Authorization).toBe(`Bearer ${CODEX_TOKEN}`);
    expect(c.headers["ChatGPT-Account-Id"]).toBe(CODEX_ACCOUNT);
    expect(c.headers["Content-Type"]).toBe("application/json");
    for (const g of h.fetch.calls) expect([g.method, g.headers.Authorization, g.headers["ChatGPT-Account-Id"]]).toEqual(["GET", c.headers.Authorization, CODEX_ACCOUNT]);
    expect(gets().slice(0, 2)).toEqual(["usage", "rate-limit-reset-credits"]);
    expect(gets().slice(2).sort()).toEqual(["rate-limit-reset-credits", "usage"]); // POST 之后再拉一次两份
  });

  test("事后刷新入库：看板下一拉就是新数（此刻可用 0）；结果与状态里都没有原始 credit id / token", async () => {
    const { h } = setup();
    const r = await h.scheduler.consumeCodexReset(null);
    const view = await h.scheduler.view();
    expect(view.codex.endpoints.codex_usage?.snapshot?.data.resetCredits?.applicableAvailableCount).toBe(0);
    expect(view.codex.endpoints.codex_reset_credits?.snapshot?.data.credits.map((x) => x.key)).toEqual(CREDIT_IDS.map(keyOf));
    expectNoSentinel(JSON.stringify(r));
    expectNoSentinel(JSON.stringify(await h.store.load()));
  });

  test("指定 creditKey：只用那张", async () => {
    const { h, post } = setup();
    expect((await h.scheduler.consumeCodexReset(keyOf(CREDIT_IDS[1]))).status).toBe("done");
    expect(post.calls[0].body.credit_id).toBe(CREDIT_IDS[1]);
  });

  test("不走 60 秒间隔闸，但记了一次尝试：紧接着的普通查询照样守 60 秒", async () => {
    const { h } = setup();
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("fetched");
    expect((await h.scheduler.consumeCodexReset(null)).status).toBe("done");
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("skipped_interval");
  });
});

describe("核对不过：POST 一次都不发", () => {
  test("此刻可用为 0 → not_applicable，明细都不拉", async () => {
    const { h, post, gets } = setup(RESET, 0);
    expect(await h.scheduler.consumeCodexReset(null)).toEqual({ status: "refused", code: "not_applicable" });
    expect(post.calls).toHaveLength(0);
    expect(gets()).toEqual(["usage"]);
  });

  test("指定的键对不上任何可用卡 → credit_unavailable", async () => {
    const { h, post } = setup();
    expect(await h.scheduler.consumeCodexReset("0".repeat(32))).toEqual({ status: "refused", code: "credit_unavailable" });
    expect(post.calls).toHaveLength(0);
  });

  test("核对用的 GET 失败 → refused 带固定错误码", async () => {
    const { h, post } = setup();
    h.route = (u) => (u.endsWith("/wham/usage") ? jsonResponse(429, {}) : jsonResponse(200, {}));
    expect(await h.scheduler.consumeCodexReset(null)).toEqual({ status: "refused", code: "http_429" });
    h.route = (u) => (u.endsWith("/wham/usage") ? usableRoutes(() => 1)(u) : jsonResponse(500, {}));
    expect(await h.scheduler.consumeCodexReset(null)).toEqual({ status: "refused", code: "http_5xx" });
    expect(post.calls).toHaveLength(0);
  });

  test("开关关着 / 没接 POST / 凭据读不到 → 挡在 POST 之前", async () => {
    const off = setup();
    off.h.enabled = false;
    expect(await off.h.scheduler.consumeCodexReset(null)).toEqual({ status: "refused", code: "disabled" });
    expect([off.post.calls.length, off.h.fetch.calls.length]).toEqual([0, 0]);

    const bare = harness(usableRoutes(() => 1));
    expect(await bare.scheduler.consumeCodexReset(null)).toEqual({ status: "refused", code: "disabled" });
    expect(bare.fetch.calls).toHaveLength(0);

    const noAuth = setup();
    noAuth.h.cd.files.delete("/home/u/.codex/auth.json");
    expect(await noAuth.h.scheduler.consumeCodexReset(null)).toEqual({ status: "refused", code: "auth_missing" });
    expect([noAuth.post.calls.length, noAuth.h.fetch.calls.length]).toEqual([0, 0]);
  });
});

describe("上游答复与失败原样返回（POST 只发一次、从不自动重发）", () => {
  for (const code of ["nothing_to_reset", "no_credit", "already_redeemed"] as const) {
    test(`上游答 ${code}`, async () => {
      const { h, post } = setup(() => jsonResponse(200, { code }));
      expect(await h.scheduler.consumeCodexReset(null)).toEqual({ status: "done", code, windowsReset: 0 });
      expect(post.calls).toHaveLength(1);
    });
  }

  const failures: [string, () => Response | Promise<Response>, FetchErrorCode][] = [
    ["5xx", () => jsonResponse(503, { detail: "x" }), "http_5xx"],
    ["4xx", () => jsonResponse(400, { detail: "x" }), "http_4xx"],
    ["跳转", () => new Response(null, { status: 302, headers: { location: "https://chatgpt.com/auth" } }), "redirect"],
    ["2xx 但认不出", () => jsonResponse(200, { code: "something_new" }), "bad_shape"],
    ["不是 JSON", () => new Response("<html>", { status: 200 }), "bad_json"],
    ["网络断", () => Promise.reject(new Error("socket hang up")), "network"],
  ];
  for (const [name, answer, code] of failures) {
    test(`POST ${name} → failed ${code}（扣没扣不知道），事后照样刷新`, async () => {
      const { h, post, gets } = setup(answer);
      expect(await h.scheduler.consumeCodexReset(null)).toEqual({ status: "failed", code });
      expect(post.calls).toHaveLength(1);
      expect(gets()).toHaveLength(4);
    });
  }
});

describe("并发连点", () => {
  test("两次同时点只发一次 POST，后到的直接 busy；结束后可以再来", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { h, post } = setup(async () => {
      await gate;
      return RESET();
    });
    const first = h.scheduler.consumeCodexReset(null);
    const second = await h.scheduler.consumeCodexReset(null);
    expect(second).toEqual({ status: "busy" });
    release();
    expect((await first).status).toBe("done");
    expect(post.calls).toHaveLength(1);
    expect(await h.scheduler.consumeCodexReset(null)).toEqual({ status: "refused", code: "not_applicable" }); // 刚用掉，此刻可用已是 0
    expect(post.calls).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { buildJevRequest, choice, JEV_DEFAULT_MODEL, JEV_ENDPOINT, jevAsk, jevConfigured, jevCostUsd, JevError, jevKeyHint, noul, score } from "../src/lib/jev";

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const answers = {
  urgent: { type: "noul", noul: 0.93 },
  kind: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 }, confidence: 0.85 },
};
const good = { model: "jev-1.13.0", answers, usage: { input_tokens: 300, output_tokens: 20 } };
const Q = { urgent: noul("Urgent?"), kind: choice("Kind?", { billing: null, other: null }) };
const noSleep = async () => {};

describe("jevAsk（TypeSafe System One 客户端）", () => {
  test("请求体 / 头 / 答案原样带类型返回，附耗时与成本", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const r = await jevAsk(
      "hello",
      Q,
      {},
      {
        readKey: async () => "sk-test-1234",
        fetch: async (url, init) => {
          calls.push({ url, init });
          return ok(good);
        },
        sleep: noSleep,
      },
    );
    expect(calls[0].url).toBe(JEV_ENDPOINT);
    expect(JEV_DEFAULT_MODEL).toBe("jev-latest");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-1234");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ state: "hello", model: "jev-latest", questions: Q });
    expect(r.answers.urgent.noul).toBe(0.93);
    expect(r.answers.kind.choice).toBe("billing");
    expect(r.model).toBe("jev-1.13.0");
    expect(r.costUsd).toBeCloseTo((300 / 1e6) * 0.042, 12);
  });
  test("没有 key → not_configured，不发请求；jevConfigured 同源判断", async () => {
    expect(await jevConfigured({ readKey: async () => "" })).toBe(false);
    expect(await jevConfigured({ readKey: async () => "k" })).toBe(true);
    let called = false;
    await expect(
      jevAsk(
        "x",
        Q,
        {},
        {
          readKey: async () => "",
          fetch: async () => {
            called = true;
            return ok(good);
          },
          sleep: noSleep,
        },
      ),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(called).toBe(false);
  });
  test("429 按 retry-after 退避后重试；用完重试次数才抛 rate_limited", async () => {
    let n = 0;
    const slept: number[] = [];
    const r = await jevAsk(
      "x",
      Q,
      { retries: 2 },
      {
        readKey: async () => "k",
        fetch: async () => (++n < 3 ? ok({ error: "slow down" }, 429, { "retry-after": "1" }) : ok(good)),
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(n).toBe(3);
    expect(slept).toEqual([1000, 1000]);
    expect(r.answers.urgent.noul).toBe(0.93);
    n = 0;
    await expect(
      jevAsk(
        "x",
        Q,
        { retries: 1 },
        {
          readKey: async () => "k",
          fetch: async () => {
            n++;
            return ok({}, 429);
          },
          sleep: noSleep,
        },
      ),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(n).toBe(2);
  });
  test("401 / 422 / 500 映射到各自的 code 并带服务端说明；坏 JSON → bad_response", async () => {
    const codes: string[] = [];
    for (const [status, body] of [
      [401, { error: "bad key" }],
      [422, { error: "questions.kind.criteria required" }],
      [500, {}],
    ] as const) {
      try {
        await jevAsk("x", Q, {}, { readKey: async () => "k", fetch: async () => ok(body, status), sleep: noSleep });
      } catch (e) {
        codes.push((e as JevError).code + ((e as JevError).message.includes("bad key") ? ":detail" : ""));
      }
    }
    expect(codes).toEqual(["unauthorized:detail", "invalid_request", "http"]);
    await expect(
      jevAsk("x", Q, {}, { readKey: async () => "k", fetch: async () => new Response("<html>", { status: 200 }), sleep: noSleep }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
  test("辅助：提示只露尾四位；score 的 criteria 是等级数组；buildJevRequest 可钉模型", () => {
    expect(jevKeyHint("sk-abcdefgh")).toBe("····efgh");
    expect(jevKeyHint(undefined)).toBeNull();
    expect(score("How bad?", ["Calm", "Angry"])).toEqual({ type: "score", instructions: "How bad?", criteria: ["Calm", "Angry"] });
    expect(buildJevRequest("s", Q, "jev-1.13.0").model).toBe("jev-1.13.0");
    expect(jevCostUsd({ input_tokens: 1_000_000, output_tokens: 5 })).toBeCloseTo(0.042, 9);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { type FakeResponses, inputTexts, replyFrames, requestKind, startFakeResponses, toolNames } from "./helpers/fake-responses.ts";

/** 把 SSE 文本拆成 [{event, data}]；每帧必须是 event 行 + data 行 + 空行，data.type 与 event 一致 */
function parseSse(raw: string): Array<{ event: string; data: any }> {
  expect(raw.endsWith("\n\n")).toBe(true);
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const [ev, data, ...rest] = frame.split("\n");
      expect(rest).toEqual([]);
      expect(ev!.startsWith("event: ")).toBe(true);
      expect(data!.startsWith("data: ")).toBe(true);
      const parsed = JSON.parse(data!.slice(6));
      expect(parsed.type).toBe(ev!.slice(7));
      return { event: ev!.slice(7), data: parsed };
    });
}

let fake: FakeResponses | null = null;
afterEach(() => {
  fake?.stop();
  fake = null;
});

describe("fake-responses SSE", () => {
  test("文字回复：created → added → 分段 delta → done → completed，delta 拼起来等于全文", () => {
    const frames = parseSse(replyFrames({ type: "text", text: "hello world", chunks: 3 }, 7).join(""));
    expect(frames.map((f) => f.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(frames.filter((f) => f.event.endsWith(".delta")).map((f) => f.data.delta).join("")).toBe("hello world");
    expect(frames[5]!.data.item).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello world" }] });
    expect(frames[6]!.data.response).toMatchObject({ id: "resp_7", usage: { total_tokens: 15 } });
  });

  test("工具调用：function_call 的 arguments 是 JSON 字符串，call_id 稳定", () => {
    const frames = parseSse(replyFrames({ type: "tool", name: "exec_command", args: { cmd: "ls" } }, 2).join(""));
    const done = frames.find((f) => f.event === "response.output_item.done")!.data.item;
    expect(done).toMatchObject({ type: "function_call", name: "exec_command", call_id: "call_2" });
    expect(JSON.parse(done.arguments)).toEqual({ cmd: "ls" });
    expect(frames.at(-1)!.event).toBe("response.completed");
  });

  test("hang 只有 created；流内失败是 response.failed", () => {
    expect(parseSse(replyFrames({ type: "hang" }, 1).join("")).map((f) => f.event)).toEqual(["response.created"]);
    const failed = parseSse(replyFrames({ type: "fail", message: "boom" }, 1).join("")).at(-1)!;
    expect(failed).toMatchObject({ event: "response.failed", data: { response: { error: { message: "boom" } } } });
  });
});

describe("fake-responses 服务", () => {
  test("只绑 127.0.0.1；记录路径、正文，并抹掉鉴权头；按剧本回 SSE / JSON / HTTP 错误", async () => {
    fake = startFakeResponses((r) => {
      if (r.path.endsWith("/models")) return { type: "json", body: { models: [] } };
      if (r.path.endsWith("/broken")) return { type: "fail", message: "nope", status: 503 };
      return { type: "text", text: `seq ${r.seq}` };
    });
    expect(fake.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const body = { model: "m", tools: [{ type: "function", name: "exec_command" }], input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    const res = await fetch(`${fake.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer sk-should-not-be-kept", "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) },
      body: JSON.stringify(body),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(parseSse(await res.text()).at(-1)!.event).toBe("response.completed");
    expect(await (await fetch(`${fake.baseUrl}/models`)).json()).toEqual({ models: [] });
    expect((await fetch(`${fake.baseUrl}/broken`, { method: "POST", body: "not json" })).status).toBe(503);

    const [first, second, third] = fake.requests;
    expect(first).toMatchObject({ seq: 1, method: "POST", path: "/v1/responses", body });
    expect(first!.headers.authorization).toBe("<redacted>");
    expect(JSON.stringify(fake.requests)).not.toContain("sk-should-not-be-kept");
    expect(second).toMatchObject({ seq: 2, method: "GET", path: "/v1/models", body: null });
    expect(third!.body).toBe("not json");
    expect(requestKind(first!)).toBe("compaction");
    expect(requestKind(second!)).toBeUndefined();
    expect(toolNames(first!.body)).toEqual(["exec_command"]);
    expect(inputTexts(first!.body)).toEqual(["hi"]);
  });

  test("并发请求的 seq 不重复：序号在读正文之前就占住（慢正文的请求先到，仍是 1 号）", async () => {
    fake = startFakeResponses(() => ({ type: "text", text: "ok" }));
    const port = Number(new URL(fake.baseUrl).port);
    // 用裸 TCP 先发请求头、过一会儿再发正文：服务端先进 handler，正文要等
    const rawPost = (body: string, bodyDelayMs: number) =>
      new Promise<void>((ok, fail) => {
        const s = connect(port, "127.0.0.1", () => {
          s.write(`POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`);
          setTimeout(() => s.write(body), bodyDelayMs);
        });
        s.on("data", () => {});
        s.on("end", () => ok());
        s.on("error", fail);
      });
    const slow = rawPost(JSON.stringify({ n: "slow" }), 100);
    await new Promise((r) => setTimeout(r, 30));
    await Promise.all([slow, rawPost(JSON.stringify({ n: "fast" }), 0)]);
    expect(fake.requests.map((r) => r.seq).sort()).toEqual([1, 2]);
    expect(fake.requests.find((r) => (r.body as { n: string }).n === "slow")!.seq).toBe(1);
    expect(fake.requests.find((r) => (r.body as { n: string }).n === "fast")!.seq).toBe(2);
  });
});

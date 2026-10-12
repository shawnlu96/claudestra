/** LST-2：manager list 不可用 → 503 + 可重试语义；其它异常的映射不变 */
import { expect, test } from "bun:test";
import { apiErrorResponse } from "../src/bridge/api-respond.ts";
import { findListedAgent } from "../src/bridge/agent-lookup.ts";
import { ListUnavailableError } from "../src/lib/run-manager.ts";

test("findApiAgent 的 list 超时被映射成 503 + retryable + Retry-After", async () => {
  const thrown = await findListedAgent(async () => ({ ok: false, error: "manager list 超时（>15s）已强杀" }), "alpha").catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(ListUnavailableError);
  const res = apiErrorResponse(thrown);
  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("5");
  expect(await res.json()).toMatchObject({ ok: false, code: "list_unavailable", retryable: true });
});

test("其它异常照旧：URIError 400，普通错误 500", async () => {
  expect(apiErrorResponse(new URIError("x")).status).toBe(400);
  const res = apiErrorResponse(new Error("boom"));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ ok: false, error: "boom" });
});

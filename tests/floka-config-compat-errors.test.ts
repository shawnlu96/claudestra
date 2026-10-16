import { expect, test } from "bun:test";
import { ConfigChangedError, retryConfigWrite } from "../src/lib/floka-config/retry.ts";
import { apiErrorResponse } from "../src/bridge/api-respond.ts";

test("[验收线 2] HTTP boundary returns 409 and a retry instruction for an exhausted setter", async () => {
  const response = apiErrorResponse(new ConfigChangedError("配置刚被别处改过,请重试"));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, error: "配置刚被别处改过,请重试" });
});

test("[验收线 2] validation, barrier and I/O failures never trigger a retry", async () => {
  const failure = new Error("not a stale snapshot");
  let attempts = 0;
  await expect(retryConfigWrite(async () => { attempts++; throw failure; })).rejects.toBe(failure);
  expect(attempts).toBe(1);
});

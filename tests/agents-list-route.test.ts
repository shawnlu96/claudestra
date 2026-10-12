/** LST-2：GET /api/v1/agents 在 manager list 失败时回 503 可重试，不再 200 + 空列表（peer 会当成对方没有 agent） */
import { expect, test } from "bun:test";
import { handleAgentsList } from "../src/bridge/agents-list-route.ts";
import type { Principal } from "../src/lib/principals.ts";

test("list 超时 → 503 retryable，而不是 200 + agents:[]", async () => {
  const principal = { tokenId: "t", name: "peer-x", agents: ["*"], peer: true } as unknown as Principal;
  const res = await handleAgentsList(new URL("http://x/api/v1/agents"), principal, {
    runManager: async () => ({ ok: false, error: "manager list 超时（>15s）已强杀" }) as { agents?: unknown[] },
    clients: new Map(),
    controlChannelId: "",
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ ok: false, code: "list_unavailable", retryable: true });
});

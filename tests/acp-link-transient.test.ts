/**
 * ACP 网络类失败（NRT-1）：断网 / 代理抖 / 5xx 不开「回合失败」卡（失败条目照样触发退避续跑，用完才在频道报一次）；
 * 非网络类、适配器说不能重试的、投递不明的照旧当场开卡。真 acp-link → ask-runtime → 临时库；registry 注入，不碰生产状态。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { onAcpFrame } from "../src/bridge/acp-link.ts";
import { resetRuntimeAsksForTest } from "../src/bridge/ask-runtime.ts";
import { askDb, setAsksForTest } from "../src/bridge/asks.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { listAsks } from "../src/lib/ledger-asks.ts";
import { closeLedger, openLedger } from "../src/lib/ledger-store.ts";
import type { RegistryAgent } from "../src/lib/registry.ts";
import { tempLedgerPath } from "./ledger-test-helpers.ts";

const CHANNELS = ["local-acp-net-1", "local-acp-net-2", "local-acp-net-3", "local-acp-net-4", "local-acp-net-5"];
const ws = { send: () => {} };
let path = "";

beforeAll(() => {
  path = tempLedgerPath("acp-net-card-");
  openLedger(path);
  const registry = CHANNELS.map((channelId, i) => ({ name: `agent-net-${i}`, channelId, status: "active" }) as RegistryAgent);
  setAsksForTest({ path, registry, ownerChats: [] });
  resetRuntimeAsksForTest();
  setExtensionSocket((ch) => (CHANNELS.includes(ch) ? ws : undefined), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never,
    hold: () => { throw new Error("fixture must not queue a voided-message echo"); },
  });
});
afterAll(() => {
  setAsksForTest(undefined);
  closeLedger(path);
});

const fail = async (channelId: string, failure: Record<string, unknown>) => {
  await onAcpFrame({ type: "acp_failure", channelId, configOptions: [], label: "Pi", failure }, ws, {} as never);
  await Bun.sleep(20); // 开卡是 void openRuntimeAsk（要等 registry 的 promise）
};
const cards = (channelId: string) => listAsks(askDb(), { source: "codex" }).filter((a) => a.fromChannelId === channelId).map((a) => a.title);

test("网络类失败（Connection error. / terminated / 503）：不开卡", async () => {
  await fail(CHANNELS[0], { kind: "error", key: "rpc:1", message: "Pi 回合失败：Connection error." });
  await fail(CHANNELS[0], { kind: "error", key: "rpc:2", message: "Pi 回合失败：terminated" });
  await fail(CHANNELS[0], { kind: "error", key: "rpc:3", message: "Pi 回合失败：503 Service Unavailable" });
  expect(cards(CHANNELS[0])).toEqual([]);
});

test("非网络类失败：照旧当场开「回合失败」卡", async () => {
  await fail(CHANNELS[1], { kind: "error", key: "rpc:1", message: "Pi 回合失败：400 invalid request: tool schema rejected" });
  expect(cards(CHANNELS[1])).toEqual(["Pi 回合失败"]);
});

test("网络字样但适配器说不能重试（不会续跑）/ 投递不明：照旧开卡", async () => {
  await fail(CHANNELS[2], { kind: "error", key: "rpc:1", message: "Pi 回合失败：Connection error.", retry: false });
  expect(cards(CHANNELS[2])).toEqual(["Pi 回合失败"]);
  await fail(CHANNELS[3], { kind: "error", key: "u:1", message: "这条消息可能已经被执行，没有自动重发（Connection error.）。消息原文：\nhi",
    retry: false, deliveryUnknown: true });
  expect(cards(CHANNELS[3])).toEqual(["Pi 回合失败"]);
});

test("额度 / 登录不受影响：各出各的卡", async () => {
  await fail(CHANNELS[4], { kind: "auth", key: "auth:1", message: "401 unauthorized (Connection error.)" });
  expect(cards(CHANNELS[4])).toEqual(["Pi 需要 owner 登录"]);
});

/**
 * 投递结果不明的「回合失败」卡（CX-H）只能由人结：宿主报来的 acp_failure 带 deliveryUnknown 时，卡上记 extra.deliveryUnknown；
 * 同频道后来的卡（登录 / 普通回合失败）顶不掉它，登录卡结掉时不连带它，正文里的时间不当过期时间，监护的恢复关卡也跳过它，
 * tmux 屏幕对账（重启后频道还没登记成 ACP、或频道切回 tmux）看到空屏也不关它。
 * 真 acp-link → ask-runtime → 临时库；registry 注入，不碰生产状态。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { onAcpFrame } from "../src/bridge/acp-link.ts";
import { noteRuntimeDialogs, resetRuntimeAsksForTest } from "../src/bridge/ask-runtime.ts";
import { askDb, setAsksForTest } from "../src/bridge/asks.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { cardsToClose } from "../src/lib/agent-supervisor-bridge.ts";
import { listAsks, type Ask } from "../src/lib/ledger-asks.ts";
import { closeLedger, openLedger } from "../src/lib/ledger-store.ts";
import type { RegistryAgent } from "../src/lib/registry.ts";
import type { SchedulerConfig } from "../src/lib/scheduler-config.ts";
import { tempLedgerPath } from "./ledger-test-helpers.ts";

const CH = "local-acp-du-card";
const AGENT = "agent-du-card";
/** 屏幕对账两例各用一个频道：库里互不干扰 */
const CH_RESTART = "local-acp-du-restart";
const CH_TMUX = "local-acp-du-tmux";
const CHANNELS = [CH, CH_RESTART, CH_TMUX];
const ws = { send: () => {} };
const discord = {} as never;
const CONFIG: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } } };
let path = "";

beforeAll(() => {
  path = tempLedgerPath("acp-du-card-");
  openLedger(path);
  const registry = CHANNELS.map((channelId, i) => ({ name: i ? `${AGENT}-${i}` : AGENT, channelId, status: "active", projectId: "p" }) as RegistryAgent);
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

const frame = async (msg: Record<string, unknown>, channelId = CH) => {
  await onAcpFrame({ channelId, configOptions: [], label: "Codex", ...msg }, ws, discord);
  await Bun.sleep(20); // 开卡是 void openRuntimeAsk（要等 registry 的 promise）
};
const fail = (failure: Record<string, unknown>, channelId = CH) => frame({ type: "acp_failure", failure }, channelId);
const DU = { kind: "error", key: "unknown:s#9", message: "这条消息可能已经被执行，没有自动重发（exit 1）。消息原文：\nhi", retry: false, deliveryUnknown: true };
/** 这个频道上投递不明的那张卡（state、有没有被记成「弹框消失」） */
const duCard = (channelId: string) => listAsks(askDb(), { source: "codex" }).filter((a) => a.fromChannelId === channelId && a.extra.deliveryUnknown === true)
  .map((a) => ({ state: a.state, clearedAt: a.extra.clearedAt ?? null }));
/** permission-watcher 对一个 tmux 频道的一轮空屏采样 */
const emptyScreen = (channelId: string) => noteRuntimeDialogs(channelId, "agent-x", "", null, "codex");

test("投递不明的卡：后来的登录卡 / 回合失败卡顶不掉，登录卡结掉不连带，正文里的时间不当过期，监护恢复关卡跳过", async () => {
  const message = "这条消息可能已经被执行，没有自动重发，需要人决定要不要重发（acp 连接断了（exit 137））。消息原文：\n部署失败就 try again in 2 hours";
  await fail({ kind: "error", key: "unknown:s#1", message, retry: false, deliveryUnknown: true });
  const [du] = listAsks(askDb(), { source: "codex", states: ["open"] });
  expect(du).toMatchObject({ title: "Codex 回合失败", context: message, extra: { failure: "error", deliveryUnknown: true } });
  expect(du.expiresAt - du.createdAt).toBe(24 * 3600_000); // 照 owner_action 的默认时限，不按原文里的「try again in 2 hours」提前过期

  await fail({ kind: "auth", key: "auth:s#2", message: "Authentication required" });
  await frame({ type: "acp_config" }); // 登好了：登录卡结掉
  await fail({ kind: "error", key: "rpc:s#3", message: "policy blocked", retry: false });
  await fail({ kind: "error", key: "rpc:s#4", message: "request rejected", retry: false });

  const all = listAsks(askDb(), { source: "codex" });
  const state = (pick: (a: Ask) => boolean) => all.filter(pick).map((a) => a.state);
  expect(state((a) => a.id === du.id)).toEqual(["open"]);
  expect(state((a) => a.title === "Codex 需要 owner 登录")).toEqual(["cancelled"]);
  expect(state((a) => a.context === "policy blocked")).toEqual(["cancelled"]); // 普通失败卡照旧被后来的卡顶掉
  expect(state((a) => a.context === "request rejected")).toEqual(["open"]);
  expect(cardsToClose(askDb(), AGENT, "p", Date.now(), CONFIG).map((a) => a.context)).toEqual(["request rejected"]);
});

test("屏幕对账 · bridge 重启后频道还没登记成 ACP：tmux 空屏采样不关投递不明的卡，也不记消失", async () => {
  await fail(DU, CH_RESTART);
  expect(duCard(CH_RESTART)).toEqual([{ state: "open", clearedAt: null }]);
  resetRuntimeAsksForTest(); // bridge 重启：内存清空，只剩库
  emptyScreen(CH_RESTART);
  emptyScreen(CH_RESTART);
  expect(duCard(CH_RESTART)).toEqual([{ state: "open", clearedAt: null }]);
});

test("屏幕对账 · 频道切回 tmux（登录卡结掉之后没留内存槽）：空屏采样不关投递不明的卡，也不记消失", async () => {
  await fail(DU, CH_TMUX);
  await fail({ kind: "auth", key: "auth:s#10", message: "Authentication required" }, CH_TMUX);
  await frame({ type: "acp_config" }, CH_TMUX); // 登好了：登录卡结掉，这个频道的内存槽空了
  emptyScreen(CH_TMUX); // 之后这个频道切回 tmux，permission-watcher 开始采样
  expect(duCard(CH_TMUX)).toEqual([{ state: "open", clearedAt: null }]);
});

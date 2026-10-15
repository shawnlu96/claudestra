/**
 * DPR-1 验收追加 7（dispatcher-files-late-reply）：转给调度助理的 peer 请求，空回合 Stop 结算后调度助理再带 reply_to 晚到回复，
 * 附件也不外发。真实链路：deliverPmLocal 转交 → Stop 兜底结算（apiQueueToSettle + 结算记录，同 bridge.ts）→ claimApiReply 晚到认领
 * → stageApiReplyFiles；附件 / 媒体目录隔离在临时目录。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { replyFilesRefusal, stageApiReplyFiles } from "../src/bridge/api-reply-files.js";
import { setAttachmentDirsForTest } from "../src/bridge/local-api/attachments.js";
import { setMediaForTest } from "../src/bridge/local-api/media-refresh.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { closeMediaIndex } from "../src/lib/media-index.js";
import { apiQueueToSettle, claimApiReply } from "../src/lib/pending-reply-scope.js";
import { renderMergedPush } from "../src/lib/peer-pr-message.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import type { PrincipalsFile } from "../src/lib/principals.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { A, D, pmFixture } from "./pm-role-fixture.test.js";

let root: string, inbox: string, file: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "peer-inbox-late-"));
  inbox = join(root, "inbox");
  mkdirSync(inbox);
  file = join(root, "report.txt");
  writeFileSync(file, "secret report");
  writeFileSync(join(root, "agent.jsonl"), "");
  setAttachmentDirsForTest({ uploadDir: join(root, "uploads"), inboxDirs: [inbox] });
  setMediaForTest({ db: join(root, "media.sqlite"), thumbs: join(root, "thumbs"), agents: async () => [{ name: D }, { name: A }],
    sources: async () => [{ agent: D, sessionId: "sid", path: join(root, "agent.jsonl") }] });
});
afterAll(() => {
  setMediaForTest(undefined);
  setAttachmentDirsForTest(undefined);
  closeMediaIndex(join(root, "media.sqlite"));
  rmSync(root, { recursive: true, force: true });
});

const fixtures: ReturnType<typeof pmFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const socket = () => ({ send: () => {} }) as unknown as LocalEndpoint["ws"];
type Receipt = { tokenId: string; agentChannelId: string; agentName: string; messageId: string; threadId: string; acceptsFiles?: boolean };
type Settled = { result: { reply: string | null; files?: unknown }; ts: number; tokenId?: string; agentChannelId?: string; messageId?: string };

/** 一条 peer 请求投给当班 PM A：machine=true 时是机器消息（开关 on → 转调度助理 D），否则真人消息留给 A */
async function world(id: string, machine: boolean) {
  const f = pmFixture(); fixtures.push(f);
  const reg = JSON.parse(readFileSync(join(f.dir, basename(REGISTRY_PATH)), "utf8")) as { agents: Record<string, object> };
  const agents = Object.entries(reg.agents).map(([name, v]) => ({ name, ...v }));
  const raw = JSON.parse(readFileSync(join(f.dir, "principals.json"), "utf8")) as PrincipalsFile;
  const principals: PrincipalsFile = { principals: raw.principals.map((p) => (p.id === "token:tok_peer" ? { ...p, agents: [A, D] } : p)) };
  const clients = new Map([["channel-a", { ws: socket() }], ["channel-d", { ws: socket() }]]);
  const r: Receipt = { tokenId: "tok_peer", agentChannelId: "channel-a", agentName: A, messageId: id, threadId: `thr-${id}`, acceptsFiles: true };
  const receipts = new Map<string, Receipt[]>([["tok_peer|channel-a", [r]]]);
  const env: Envelope = { from: { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" },
    to: { kind: "local", agentName: A, channelId: "channel-a", ws: socket() }, intent: "request",
    content: machine ? renderMergedPush(9, "ab".repeat(20), "x@remote") : "请把审查报告发我",
    meta: { messageId: id, triggerKind: "system", ts: "2026-10-15T00:00:00Z", threadId: `thr-${id}` } };
  const send = async (e: Envelope): Promise<Delivery> => ({ envelope: e, outcome: { kind: "sent" } });
  await deliverPmLocal(env, env.to as LocalEndpoint, clients, new AgentCallBook(null), receipts, send,
    { db: f.db, agents, principals: async () => principals, principalsSync: () => principals, peerInbox: () => true, online: (c) => clients.has(c) });
  return { r, receipts, channel: r.agentChannelId };
}

/** 空回合 Stop 兜底：从队列拿走、写结算记录（字段同 bridge.ts Stop 的 apiThreadResults.set） */
function settleEmptyTurn(receipts: Map<string, Receipt[]>, channel: string): Map<string, Settled> {
  const settled = new Map<string, Settled>();
  for (const p of apiQueueToSettle(receipts, `tok_peer|${channel}`, new Set())) {
    settled.set(p.threadId, { result: { reply: null }, ts: Date.now(), tokenId: p.tokenId, messageId: p.messageId, agentChannelId: p.agentChannelId });
  }
  return settled;
}

/** 回复认领 + 附件登记，参数与 bridge.ts deliverToApi 一致（receipt = 认领到的回执，threadId = 回执的或晚到认领的） */
async function reply(receipts: Map<string, Receipt[]>, settled: Map<string, Settled>, channel: string, replyTo: string, agent: string) {
  const queue = receipts.get(`tok_peer|${channel}`) ?? [];
  const claim = claimApiReply(queue, settled, { tokenId: "tok_peer", channelId: channel, peer: "remote", replyTo });
  expect(claim.error).toBeUndefined();
  const pending = claim.taken, threadId = pending?.threadId || claim.threadId;
  const table = new Map();
  const staged = await stageApiReplyFiles([file], { agent, tokenId: "tok_peer", table, receipt: pending, threadId,
    lookup: async () => ({ peer: "remote" }) });
  return { claim, staged, table };
}

test("空回合 Stop 结算后，调度助理 reply_to 晚到回复带附件：登记 0 个、表里 0 条、inbox 没有副本", async () => {
  const w = await world("api_late", true);
  expect(w.channel).toBe("channel-d"); // 已转给调度助理
  const settled = settleEmptyTurn(w.receipts, w.channel);
  expect(w.receipts.has("tok_peer|channel-d")).toBe(false); // 回执已被结算拿走
  const { claim, staged, table } = await reply(w.receipts, settled, w.channel, "api_late", D);
  expect([claim.taken, claim.threadId]).toEqual([undefined, "thr-api_late"]); // 走的是晚到认领
  expect([staged.files, staged.sent, table.size, readdirSync(inbox).length]).toEqual([[], [], 0, 0]);
  expect(staged.warning).toContain("调度助理");
});

test("在等时的正常认领照旧拦", async () => {
  const w = await world("api_live", true);
  const { claim, staged, table } = await reply(w.receipts, new Map(), w.channel, "api_live", D);
  expect(claim.taken?.messageId).toBe("api_live");
  expect([staged.files.length, table.size, readdirSync(inbox).length]).toEqual([0, 0, 0]);
});

test("对照：留给 PM 的请求（真人消息）晚到补答，附件照常登记", async () => {
  const w = await world("api_human", false);
  expect(w.channel).toBe("channel-a");
  const settled = settleEmptyTurn(w.receipts, w.channel);
  const { claim, staged, table } = await reply(w.receipts, settled, w.channel, "api_human", A);
  expect(claim.threadId).toBe("thr-api_human");
  expect([staged.files.length, table.size]).toEqual([1, 1]);
  expect(staged.warning ?? "").not.toContain("调度助理");
});

// 第 1 轮对抗式审查 P1 dispatcher-reply-missing-file：deliverToApi 认领前先查附件路径，路径失效会把整条文字也拒掉
test("调度助理 reply_to 带失效附件路径：在等的、空回合结算后晚到的都不拒文字；留给 PM 的照旧拒", async () => {
  const gone = join(root, "no-such-file.txt");
  const refusal = (receipts: Map<string, Receipt[]>, settled: Map<string, Settled>, channelId: string, replyTo?: string) =>
    replyFilesRefusal({ from: { kind: "local", channelId }, meta: { files: [gone], replyTo } }, "tok_peer", receipts, settled);
  const live = await world("api_gone_live", true);
  expect(await refusal(live.receipts, new Map(), live.channel, "api_gone_live")).toBeNull();
  expect(await refusal(live.receipts, new Map(), live.channel)).toBeNull(); // 没带 reply_to：在等的全被拦
  const late = await world("api_gone_late", true), settled = settleEmptyTurn(late.receipts, late.channel);
  expect(await refusal(late.receipts, settled, late.channel, "api_gone_late")).toBeNull();
  const human = await world("api_gone_human", false);
  expect(await refusal(human.receipts, new Map(), human.channel, "api_gone_human")).toContain("附件不存在");
  expect(await refusal(late.receipts, settled, late.channel, "api_other")).toContain("附件不存在"); // reply_to 对不上任何一条：不预判
});

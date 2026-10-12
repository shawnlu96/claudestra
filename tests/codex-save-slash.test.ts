/**
 * /save-compact、/save-clear 的入口（api-slash.ts → bridge/codex-save-slash.ts）与命令面板（lib/runtime-commands.ts）：
 * 只有 ACP 版 Codex 有；只给 owner（和 ACP /clear 同一条）；不收附件；不会原样当 prompt 发给 Codex。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { handleSlashPassthrough, SLASH_OWNER_ONLY, type SlashDeps } from "../src/bridge/api-slash.js";
import { codexSaveSlash } from "../src/bridge/codex-save-slash.js";
import { noteAcpChannel } from "../src/bridge/acp-state.js";
import { runtimeCommandsFor } from "../src/lib/runtime-commands.js";
import { handoffMarker } from "../src/lib/codex-save.js";
import type { BridgeEvent } from "../src/bridge/event-bus.js";
import type { Principal } from "../src/lib/principals.js";

const base = { createdAt: "2026-01-01T00:00:00Z" };
const OWNER: Principal = { ...base, id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], credential: "dev_o1" };
const GUEST: Principal = { ...base, id: "guest:1234", role: "external", name: "friend", agents: ["agent-cx"], credential: "dev_g1" };
const PEER: Principal = { ...base, id: "token:tok_peer", role: "external", name: "sekai", agents: ["agent-cx"], secret: "x", peer: "sekai" };
const ACP = { name: "agent-cx", channelId: "local-cx-save", cwd: "/tmp/cx", sessionId: "s1", runtime: "codex" };
const TMUX = { ...ACP, channelId: "local-cx-tmux" };

function harness() {
  const seen: string[] = [];
  const deps: SlashDeps = {
    sendLine: async (_w, t) => void seen.push(`tmux:${t}`),
    mirror: async (_to, _ch, t) => void seen.push(`mirror:${t}`),
    scheduleClearRotation: () => {},
    markThinking: () => void seen.push("thinking"),
    record: (cmd) => void seen.push(`record:${cmd}`),
    wallWait: async () => null,
    runManager: async () => ({ ok: true }),
  };
  return { seen, deps };
}
const send = (p: Principal, text: string, deps: SlashDeps, agent = ACP, hasAttachments = false) =>
  handleSlashPassthrough({ principal: p, tokenId: p.id, agent, text, hasAttachments }, deps);

beforeAll(() => noteAcpChannel(ACP.channelId, "acp"));
afterAll(() => noteAcpChannel(ACP.channelId, "tmux"));

test("命令面板：ACP 版 Codex 多了 save-compact / save-clear（会跑一轮）；tmux 版 Codex、Claude Code、Pi 不变", () => {
  const acp = runtimeCommandsFor("codex", "agent-cx", true)!;
  const tmux = runtimeCommandsFor("codex", "agent-cx", false)!;
  expect(acp.slice(0, tmux.length)).toEqual(tmux);
  expect(acp.slice(tmux.length).map((c) => [c.name, c.scope])).toEqual([["save-compact", "codex-turn"], ["save-clear", "codex-turn"]]);
  expect(acp.slice(tmux.length).every((c) => c.description.includes("跑一轮模型"))).toBe(true);
  expect(tmux.some((c) => c.name.startsWith("save-"))).toBe(false);
  expect(runtimeCommandsFor("claude-code", "x", true)).toBeNull();
  expect(runtimeCommandsFor("pi", "agent-no-snapshot", true)!.map((c) => c.name)).toEqual(["compact"]);
});

test("guest / scoped 凭据：403，什么都没发；peer 的斜杠文字照旧当普通消息", async () => {
  for (const cmd of ["/save-compact", "/save-clear"]) {
    const h = harness();
    const res = (await send(GUEST, cmd, h.deps))!;
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject(SLASH_OWNER_ONLY);
    expect(h.seen).toEqual([]);
    expect(await send(PEER, cmd, h.deps)).toBeNull();
  }
});

test("owner 带附件：409，什么都没做", async () => {
  const h = harness();
  const res = (await send(OWNER, "/save-clear", h.deps, ACP, true))!;
  expect(res.status).toBe(409);
  expect(h.seen).toEqual([]);
});

test("owner：截下来交给编排（202），不当 prompt 发给 Codex、不敲键；宿主不在线时停在落盘、告诉 owner", async () => {
  const h = harness();
  const res = (await send(OWNER, "/save-compact", h.deps))!;
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ ok: true, accepted: true, save: "save-compact", acp: true });
  expect(h.seen.slice(0, 3)).toEqual([expect.stringContaining("mirror:[⚙️ save-compact] 💾"), "record:save-compact", "thinking"]);
  await Bun.sleep(20);
  expect(h.seen.some((s) => s.startsWith("tmux:"))).toBe(false);
  expect(h.seen.at(-1)).toMatch(/停在「存交接」：没交给宿主：ACP 宿主不在线/);
});

test("同一 agent 跑着时再点：409", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const link = {
    opTurn: async () => (await gate, { ok: false, error: "x" }),
    slash: async () => ({ ok: false }), slotStatus: async () => ({ ok: false }), clear: async () => ({ ok: false }),
  };
  const req = { tokenId: "owner:self", by: "owner", agent: ACP, hasAttachments: false };
  expect((await codexSaveSlash(req, "save-clear", h.deps, { link })).status).toBe(202);
  expect((await codexSaveSlash(req, "save-compact", h.deps, { link })).status).toBe(409);
  release();
});

test("tmux 版 Codex：不认这两个命令，按普通消息投", async () => {
  expect(await send(OWNER, "/save-compact", harness().deps, TMUX)).toBeNull();
});

test("clear 结果不明：HTTP 202 之后，频道事件带结构化 codexSave {status:504, code:clear_result_unknown}，只清一次", async () => {
  const h = harness();
  const events: Omit<BridgeEvent, "seq" | "ts">[] = [];
  let saveOp = "";
  let clears = 0;
  const done = Promise.withResolvers<void>();
  const link = {
    opTurn: async (_c: string, _t: string, opId: string) => ((saveOp = opId), { ok: true, slot: { state: "queued" as const, opId, gen: 1, hostId: "h" } }),
    slash: async () => ({ ok: false }),
    slotStatus: async (_c: string, opId: string) => ({ ok: true, slot: { state: "ended" as const, opId, gen: 1, outcome: "done" as const, hostId: "h" } }),
    clear: async () => (clears++, { ok: false, uncertain: true as const, error: "宿主未在期限内回应，结果未确认" }),
  };
  const req = { tokenId: "owner:self", by: "owner", agent: { ...ACP, name: "agent-cx-504" }, hasAttachments: false };
  const res = await codexSaveSlash(req, "save-clear", h.deps, {
    link, readHandoff: async () => `${handoffMarker(saveOp)}\n# HANDOFF\n## 在做什么\n测 504 的结构化结果`,
    emit: (e) => (events.push(e), e.data?.codexSave && done.resolve(), e as BridgeEvent),
  });
  expect(res.status).toBe(202);
  await done.promise;
  const last = events.at(-1)!;
  expect(last).toMatchObject({ type: "chat_message", chatId: ACP.channelId });
  expect(last.data?.codexSave).toMatchObject({ ok: false, stage: "clear", status: 504, code: "clear_result_unknown" });
  expect(String(last.data?.text)).toContain("504 clear_result_unknown");
  expect(events.slice(0, -1).every((e) => !e.data?.codexSave)).toBe(true);
  expect(clears).toBe(1);
});

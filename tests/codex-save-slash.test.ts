/**
 * /save-compact、/save-clear 的入口（api-slash.ts → bridge/codex-save-slash.ts）与命令面板（lib/runtime-commands.ts）：
 * 只有 ACP 版 Codex 有；只给 owner（和 ACP /clear 同一条）；不收附件；不会原样当 prompt 发给 Codex。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { handleSlashPassthrough, SLASH_OWNER_ONLY, type SlashDeps } from "../src/bridge/api-slash.js";
import { codexSaveSlash } from "../src/bridge/codex-save-slash.js";
import { noteAcpChannel } from "../src/bridge/acp-state.js";
import { runtimeCommandsFor } from "../src/lib/runtime-commands.js";
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

/** OpenCode agent 的网页斜杠（OCR-4 第 1 轮 P1-3）：/clear 走宿主换会话（同 Codex / Pi 的 ACP 版），表外的 "/xxx" 按普通消息投递（发给 OpenCode 会被整条吞掉） */
import { expect, test } from "bun:test";
import { handleSlashPassthrough, type SlashDeps } from "../src/bridge/api-slash.ts";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { runtimeCommandsFor } from "../src/lib/runtime-commands.ts";

const OWNER: any = { createdAt: "2026-01-01T00:00:00Z", id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], credential: "dev_o1" };
const deps = {
  sendLine: async () => {}, mirror: async () => {}, scheduleClearRotation: () => {}, markThinking: () => {}, record: () => {},
  wallWait: async () => null, runManager: async () => ({ ok: true }),
} as unknown as SlashDeps;

async function slash(runtime: string, text: string) {
  const agent: any = { name: `agent-${runtime}-s`, channelId: `local-${runtime}-s`, cwd: "/tmp/w", sessionId: "s1", runtime };
  noteAcpChannel(agent.channelId, "acp");
  try {
    const r = await handleSlashPassthrough({ principal: OWNER, tokenId: "owner:self", agent, text, hasAttachments: false }, deps);
    return r ? { status: r.status, body: (await r.json()) as any } : null;
  } finally {
    noteAcpChannel(agent.channelId, "tmux");
  }
}

test("/clear 走宿主换会话（宿主不在线时和 Codex 报同一个错），不当 prompt 直通", async () => {
  const oc = await slash("opencode", "/clear");
  const codex = await slash("codex", "/clear");
  expect(oc?.body.error).toBe(codex?.body.error);
  expect(oc?.body.error ?? "").not.toContain("没交给宿主");
});

test("表外的 /xxx 落回普通消息（返回 null），表内的 /compact 直通", async () => {
  expect(await slash("opencode", "/plan say hi")).toBeNull();
  const compact = await slash("opencode", "/compact");
  expect(compact).not.toBeNull();
  expect(runtimeCommandsFor("opencode", "agent-x", true)?.map((c) => c.name)).toEqual(["compact", "init", "review"]);
});

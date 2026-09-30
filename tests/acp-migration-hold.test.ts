import { expect, test } from "bun:test";
import { holdDuringMigration, migrationHold, migrationHeld } from "../src/bridge/acp-migration-hold.ts";
import { emitEvent } from "../src/bridge/event-bus.ts";

test("忙时拿不到迁移消息闸，空闲后所有来源押后，旧 token 不能释放新闸", async () => {
  const channelId = "test-acp-migration-hold", name = "agent-migration-hold";
  const read = async () => [{ name, channelId, runtime: "codex", transport: "tmux", acpPending: true }] as any;
  emitEvent({ agent: name, chatId: channelId, type: "agent_status", data: { status: "thinking" } });
  expect(await migrationHold({ channelId }, read, () => ({ send: () => {} }), async () => true)).toEqual({ ok: false });
  emitEvent({ agent: name, chatId: channelId, type: "agent_status", data: { status: "done" } });
  const r = await migrationHold({ channelId }, read, () => ({ send: () => {} }), async () => true);
  expect(r.ok).toBe(true); expect(migrationHeld(channelId)).toBe(true);
  const held: any[] = [], queue = { holdEnv: (e: any) => { held.push(e); } };
  for (const kind of ["api", "user", "local", "bridge"]) {
    expect(holdDuringMigration({ from: { kind } } as any, { channelId } as any, queue)?.outcome).toEqual({ kind: "sent", note: "queued" });
  }
  expect(held).toHaveLength(4);
  expect((await migrationHold({ channelId, token: "old", release: true }, read)).ok).toBe(false);
  expect(migrationHeld(channelId)).toBe(true);
  await migrationHold({ channelId, token: r.token, release: true }, read);
  expect(migrationHeld(channelId)).toBe(false);
});
test("owner 明确 tmux 不属于自动迁移，不取得消息闸", async () => {
  const read = async () => [{ name: "manual", channelId: "manual", runtime: "codex", transport: "tmux" }] as any;
  expect((await migrationHold({ channelId: "manual" }, read)).ok).toBe(false);
});

test("旧接收端无法排空确认：退出前保守拒绝迁移并恢复消息闸", async () => {
  const channelId = "legacy-no-drain", read = async () => [{ name: channelId, channelId, runtime: "codex", transport: "tmux", acpPending: true }] as any;
  const sent: string[] = [];
  const r = await migrationHold({ channelId }, read, () => ({ send: (s) => { sent.push(s); } }), async () => false);
  expect(r.ok).toBe(false); expect(migrationHeld(channelId)).toBe(false);
  expect(sent.some((s) => JSON.parse(s).type === "migration_resume")).toBe(true);
});

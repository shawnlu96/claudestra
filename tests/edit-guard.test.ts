/**
 * edit_message 的两道闸（src/bridge/edit-guard.ts，adv1 P1-1）：只准改自己经 reply 发出的消息；带保留按钮的消息谁都不能改。
 * 不带 components 的 edit 在 Discord 上会保留原按钮，改掉班子确认卡的正文就能骗 owner 点。
 */
import { describe, expect, test } from "bun:test";
import { discordEditMessage, setBotUserId } from "../src/bridge/discord-api.js";
import { editOwnerRefusal, messageComponentIds, noteReplySent, reservedEditRefusal } from "../src/bridge/edit-guard.js";

/** discord.js 的形状：ActionRow → components[].customId */
const rows = (...ids: string[]) => [{ type: 1, components: ids.map((customId) => ({ type: 2, customId })) }];

describe("只准改自己经 reply 发出的消息", () => {
  test("自己发的能改；别的 agent 发的、查不到记录的（bridge 贴的卡片 / 通知、bridge 重启前的）都拒；认不出调用方也拒", () => {
    expect(noteReplySent(["m1", "m2"], "ch-a")).toEqual(["m1", "m2"]);
    expect(editOwnerRefusal("m1", "ch-a")).toBeNull();
    expect(editOwnerRefusal("m2", "ch-b")).toContain("别的 agent");
    expect(editOwnerRefusal("card-by-bridge", "ch-a")).toContain("查不到你的发送记录");
    expect(editOwnerRefusal("m1", "")).toContain("认不出调用方");
  });

  test("记录有上限，最早的先丢；丢了只会让 edit 被拒", () => {
    noteReplySent(["old"], "ch-a");
    noteReplySent(Array.from({ length: 5000 }, (_, i) => `n${i}`), "ch-b");
    expect(editOwnerRefusal("old", "ch-a")).toContain("查不到");
    expect(editOwnerRefusal("n4999", "ch-b")).toBeNull();
  });
});

describe("带保留按钮的消息不许改", () => {
  test("认 discord.js 的嵌套形状和扁平的 {id}；普通按钮放行", () => {
    expect(messageComponentIds(rows("a", "team_ok:0a1b2c3d:0123456789abcdef"))).toEqual(["a", "team_ok:0a1b2c3d:0123456789abcdef"]);
    expect(reservedEditRefusal(rows("ok", "team_ok:0a1b2c3d:0123456789abcdef"))).toContain("team_ok:");
    expect(reservedEditRefusal([{ id: "auto_allow:111" }])).toContain("auto_allow:");
    expect(reservedEditRefusal(rows("release_go"))).toBeNull();
    expect(reservedEditRefusal(undefined)).toBeNull();
  });

  test("discordEditMessage：班子确认卡被拒、不调 edit；自己带普通按钮的消息照改", async () => {
    setBotUserId("BOT");
    const edits: unknown[] = [];
    const msgOf = (components: unknown) => ({ author: { id: "BOT" }, components, edit: async (o: unknown) => void edits.push(o) });
    const discordWith = (m: unknown) => ({ channels: { fetch: async () => ({ messages: { fetch: async () => m } }) } }) as never;
    const card = msgOf(rows("team_ok:0a1b2c3d:0123456789abcdef", "team_no:0a1b2c3d:0123456789abcdef"));
    await expect(discordEditMessage(discordWith(card), "PM_CHANNEL", "CARD_MSG", "部署已完成，点「确认」归档即可")).rejects.toThrow("管理按钮");
    expect(edits).toEqual([]);
    await discordEditMessage(discordWith(msgOf(rows("release_go"))), "C", "M", "改个错字");
    expect(edits).toEqual(["改个错字"]);
  });
});

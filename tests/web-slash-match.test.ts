import { describe, expect, test } from "bun:test";
import { matchSlashCommands, slashQuery, type SlashCmd } from "@/features/chat/slash-match";

const cmd = (name: string, description = ""): SlashCmd => ({ name, invokeName: name, description, scope: "user" });
const names = (xs: SlashCmd[]) => xs.map((c) => c.name);

describe("slashQuery（只在输入命令 token 期间弹）", () => {
  test("/ 开头且无空白 → 小写查询词；「/」本身 → 空串", () => {
    expect(slashQuery("/SaVe")).toBe("save");
    expect(slashQuery("/")).toBe("");
  });
  test("补全后带尾随空格 / 换行 / 不是 / 开头 → null（面板收起，二次回车是发送）", () => {
    expect(slashQuery("/save ")).toBeNull();
    expect(slashQuery("/save\nx")).toBeNull();
    expect(slashQuery("save")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  const skills = [
    cmd("discord-configure", "save the bot config"),
    cmd("autosave"),
    cmd("save-compact"),
    cmd("save"),
    cmd("other", "unrelated"),
  ];
  test("name 前缀 > name 子串 > 仅 description；同级保持原序（2026-07-24 /save 第一项是 discord-configure 的回归）", () => {
    expect(names(matchSlashCommands(skills, "save"))).toEqual(["save-compact", "save", "autosave", "discord-configure"]);
  });
  test("空查询：全部按原序（不排序），最多 40 条", () => {
    const many = Array.from({ length: 50 }, (_, i) => cmd(`c${i}`));
    const out = matchSlashCommands(many, "");
    expect(out.length).toBe(40);
    expect(out[0].name).toBe("c0");
    expect(names(matchSlashCommands(skills, ""))).toEqual(names(skills));
  });
  test("不在命令 token 里 / 没有命令 → 空", () => {
    expect(matchSlashCommands(skills, null)).toEqual([]);
    expect(matchSlashCommands([], "save")).toEqual([]);
  });
  test("不改输入数组", () => {
    const copy = [...skills];
    matchSlashCommands(skills, "save");
    expect(skills).toEqual(copy);
  });
});

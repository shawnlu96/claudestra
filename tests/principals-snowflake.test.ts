import { test, expect, describe } from "bun:test";
import { isDiscordSnowflake } from "../src/lib/principals";

/**
 * 这层校验是「.env.example 占位符污染 principals.json」那条链路上唯一的把关点：
 * 手动安装路径是 `cp .env.example .env`，而占位符过得了 `filter(Boolean)`，
 * 一路无校验写进去就会变成一条永久的假 owner（role:owner + agents ["*","master"]）。
 */
describe("isDiscordSnowflake", () => {
  test("真实的 Discord 用户 ID 通过", () => {
    expect(isDiscordSnowflake("535144625355096076")).toBe(true); // 18 位
    expect(isDiscordSnowflake("12345678901234567")).toBe(true); // 17 位下界
    expect(isDiscordSnowflake("12345678901234567890")).toBe(true); // 20 位上界
  });

  test("占位符被拦下 —— 这条是这个函数存在的理由", () => {
    expect(isDiscordSnowflake("your-discord-user-id")).toBe(false);
    expect(isDiscordSnowflake("your-server-id")).toBe(false);
    expect(isDiscordSnowflake("<your id here>")).toBe(false);
  });

  test("长度越界的数字串不通过", () => {
    expect(isDiscordSnowflake("1234567890123456")).toBe(false); // 16 位
    expect(isDiscordSnowflake("123456789012345678901")).toBe(false); // 21 位
    expect(isDiscordSnowflake("1")).toBe(false);
  });

  test("空值与纯空白不通过", () => {
    expect(isDiscordSnowflake("")).toBe(false);
    expect(isDiscordSnowflake("   ")).toBe(false);
  });

  test("两边空白被容忍（复制粘贴常带空格/换行）", () => {
    expect(isDiscordSnowflake(" 535144625355096076 ")).toBe(true);
    expect(isDiscordSnowflake("535144625355096076\n")).toBe(true);
  });

  test("混入非数字一律不通过", () => {
    expect(isDiscordSnowflake("53514462535509607a")).toBe(false);
    expect(isDiscordSnowflake("535144625355096076,535144625355096077")).toBe(false); // 忘了拆 CSV
    expect(isDiscordSnowflake("<@535144625355096076>")).toBe(false); // 复制成了 mention
    expect(isDiscordSnowflake("+535144625355096076")).toBe(false);
  });
});

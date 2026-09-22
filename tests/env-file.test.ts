/**
 * setup 写 .env：只动向导管的键，手加的键和注释在重跑时不能丢。
 */
import { describe, test, expect } from "bun:test";
import { mergeEnvContent } from "../src/lib/env-file.ts";

const HEADER = "# Claudestra 运行时配置 (由 bun run setup 生成)";
const cfg = { DISCORD_BOT_TOKEN: "", BRIDGE_PORT: "3847", USER_NAME: "Shawn", MCP_NAME: "claudestra" };

describe("mergeEnvContent", () => {
  test("没有 .env → 生成完整文件", () => {
    expect(mergeEnvContent(null, cfg, HEADER)).toBe(
      `${HEADER}\nDISCORD_BOT_TOKEN=\nBRIDGE_PORT=3847\nUSER_NAME=Shawn\nMCP_NAME=claudestra\n`,
    );
  });

  test("一路回车重跑（值都没变）→ 逐字节不变，手加的键和注释都在", () => {
    const orig = `${HEADER}\nDISCORD_BOT_TOKEN=\nBRIDGE_PORT=3847\nUSER_NAME=Shawn\nMCP_NAME=claudestra\n\n# 自己加的\nMASTER_DIR=/Users/x/master\nBRIDGE_BIND=0.0.0.0\n`;
    expect(mergeEnvContent(orig, cfg, HEADER)).toBe(orig);
  });

  test("改了的值就地改写，其它行不动", () => {
    const orig = `USER_NAME=Old\nBRIDGE_CONTROL_TOKEN=secret\nBRIDGE_PORT=3847\nDISCORD_BOT_TOKEN=\nMCP_NAME=claudestra\n`;
    expect(mergeEnvContent(orig, cfg, HEADER)).toBe(
      `USER_NAME=Shawn\nBRIDGE_CONTROL_TOKEN=secret\nBRIDGE_PORT=3847\nDISCORD_BOT_TOKEN=\nMCP_NAME=claudestra\n`,
    );
  });

  test("原文件缺的键追加在末尾，不多出空行；没有结尾换行也补上", () => {
    expect(mergeEnvContent("BRIDGE_BIND=0.0.0.0", { USER_NAME: "Shawn" }, HEADER)).toBe("BRIDGE_BIND=0.0.0.0\nUSER_NAME=Shawn\n");
    expect(mergeEnvContent("BRIDGE_BIND=0.0.0.0\n\n", { USER_NAME: "Shawn" }, HEADER)).toBe("BRIDGE_BIND=0.0.0.0\nUSER_NAME=Shawn\n");
  });

  test("注释掉的同名键不算（不改注释）", () => {
    expect(mergeEnvContent("# USER_NAME=Old\n", { USER_NAME: "Shawn" }, HEADER)).toBe("# USER_NAME=Old\nUSER_NAME=Shawn\n");
  });
});

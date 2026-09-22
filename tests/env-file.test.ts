/**
 * setup 写 .env：只动向导管的键，手加的键和注释在重跑时不能丢。
 */
import { describe, test, expect } from "bun:test";
import { mergeEnvContent, parseDotenv, parseEnvRaw, repoEnvVar } from "../src/lib/env-file.ts";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { resolveBridgePort, DEFAULT_BRIDGE_PORT } from "../src/lib/bridge-url.ts";

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

describe("parseDotenv（与 Bun 加载 .env 同口径）", () => {
  test("引号 / export / 行内注释 / 空值 / 键名含数字", () => {
    const env = parseDotenv([
      'A="1"', "B='2'", "export C=3", "D=4 # 注释", "E=", "  F = 6  ", "K2=x", "# X=nope", "G=\"a # b\" # c", "H=p#q",
    ].join("\n"));
    // H：未加引号时 `#` 不需要前置空格也算注释（Bun 实测 `p#q` → `p`）
    expect(env).toEqual({ A: "1", B: "2", C: "3", D: "4", E: "", F: "6", K2: "x", G: "a # b", H: "p" });
  });

  // 审查指出的三处偏差 + 多行值：逐项钉住，并与真实 Bun 加载同一份文件的结果比对
  const EDGE = [
    "U1=foo#bar", "U2=#x", "Q1=\"a\\nb\"", "Q2='a\\nb'", "Q3=\"a\\tb\"", "Q4=\"x\\\"y\"", "Q5=\"a\"b\" # c",
    "Q7=`bt`", "M1=\"line1", "line2\"", "N1=\"noclose", "N2=next",
    // 找不到闭合引号的放最后：后面任何一行以同类引号结尾都会被当成它的闭合（多行值，Bun 同样如此）
    "Q6=\"a\"b", "",
  ].join("\n");

  test("未加引号的 # / 双引号转义 / 未闭合引号 / 多行值", () => {
    expect(parseDotenv(EDGE)).toEqual({
      U1: "foo", U2: "", Q1: "a\nb", Q2: "a\\nb", Q3: "a\\tb", Q4: 'x\\"y', Q5: 'a"b',
      Q6: '"a"b', Q7: "bt", M1: "line1\nline2", N1: '"noclose', N2: "next",
    });
  });

  test("与 Bun 真实加载 .env 的结果一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "dotenv-bun-"));
    writeFileSync(join(dir, ".env"), EDGE);
    const keys = Object.keys(parseDotenv(EDGE));
    const r = spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k]]))))`], {
      cwd: dir, env: { HOME: process.env.HOME, PATH: process.env.PATH }, encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(parseDotenv(EDGE));
  });

  test("CRLF 行尾", () => {
    expect(parseDotenv("BRIDGE_PORT=13847\r\nUSER_NAME=x\r\n")).toEqual({ BRIDGE_PORT: "13847", USER_NAME: "x" });
  });

  test("带引号的端口能被正确读出（doctor 旧正则会读成默认端口 → 误诊）", () => {
    expect(resolveBridgePort(parseDotenv('BRIDGE_PORT="13847"'))).toBe(13847);
  });
});

describe("parseEnvRaw（setup 向导：取原文，不去引号）", () => {
  test("值保持原文", () => {
    expect(parseEnvRaw('A="1"\nB= 2\nlower=x\n')).toEqual({ A: '"1"', B: " 2" });
  });
});

describe("resolveBridgePort", () => {
  test("没设 / 非法 → 默认；合法 → 数字", () => {
    expect(resolveBridgePort({})).toBe(DEFAULT_BRIDGE_PORT);
    expect(resolveBridgePort({ BRIDGE_PORT: "" })).toBe(DEFAULT_BRIDGE_PORT);
    expect(resolveBridgePort({ BRIDGE_PORT: "abc" })).toBe(DEFAULT_BRIDGE_PORT);
    expect(resolveBridgePort({ BRIDGE_PORT: "70000" })).toBe(DEFAULT_BRIDGE_PORT);
    expect(resolveBridgePort({ BRIDGE_PORT: "13847" })).toBe(13847);
  });
});

describe("repoEnvVar（manager 从任意 cwd 调起也能拿到安装级变量）", () => {
  test("process.env 优先；没有再读仓库根 .env；都没有 → 空串", () => {
    const root = mkdtempSync(join(tmpdir(), "repoenv-"));
    writeFileSync(join(root, ".env"), 'BRIDGE_BIND="0.0.0.0"\nUSER_NAME=shawn\n');
    expect(repoEnvVar("BRIDGE_BIND", root, {})).toBe("0.0.0.0");
    expect(repoEnvVar("BRIDGE_BIND", root, { BRIDGE_BIND: "127.0.0.1" })).toBe("127.0.0.1");
    expect(repoEnvVar("MASTER_DIR", root, {})).toBe("");
    expect(repoEnvVar("USER_NAME", join(root, "nope"), {})).toBe("");
  });
});

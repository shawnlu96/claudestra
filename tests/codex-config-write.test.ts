import { describe, expect, test } from "bun:test";
import { applyCodexDefaults, readCodexDefaultsToml, tomlBasicString } from "../src/lib/codex-config-write.ts";

// 照真实 ~/.codex/config.toml 的样子：顶层键、注释、多行字符串和跨行数组里有以 [ 开头的行、多个表
const SAMPLE = `# Codex 配置（手写）
model = "gpt-5.5" # 主力
approval_policy = "on-request"
notify = [
  ["say", "done"],
]
instructions = """
[这不是表头]
model = "也不是键"
"""
model_reasoning_effort = 'high'

# MCP 服务器
[mcp_servers.claudestra]
command = "bun"
args = ["run", "/path/to/channel-server.ts"]
env = { MCP_NAME = "claudestra" }

[mcp_servers.claudestra.tools]
model = "不是顶层"

[profiles.fast]
model = "gpt-5.5-mini"
model_reasoning_effort = "low"

[projects."/Users/me/repo"]
trust_level = "trusted"
`;


describe("applyCodexDefaults", () => {
  test("两行都已有 → 原地替换，行尾注释保留，其余逐字不变", () => {
    const out = applyCodexDefaults(SAMPLE, { model: "gpt-5.6", effort: "xhigh" });
    const expected = SAMPLE.replace('model = "gpt-5.5" # 主力', 'model = "gpt-5.6" # 主力').replace("model_reasoning_effort = 'high'", 'model_reasoning_effort = "xhigh"');
    expect(out).toBe(expected);
    expect(readCodexDefaultsToml(out)).toEqual({ model: "gpt-5.6", effort: "xhigh" });
  });

  test("只给一项：另一项不动", () => {
    const out = applyCodexDefaults(SAMPLE, { effort: "low" });
    expect(out).toBe(SAMPLE.replace("model_reasoning_effort = 'high'", 'model_reasoning_effort = "low"'));
  });

  test("都没有 → 插到最后一个顶层键值对后面、第一个 [表] 之前；多行字符串 / 数组里的 [ 不算表头", () => {
    const base = SAMPLE.replace('model = "gpt-5.5" # 主力\n', "").replace("model_reasoning_effort = 'high'\n", "");
    const out = applyCodexDefaults(base, { model: "gpt-5.6", effort: "high" });
    const lines = out.split("\n");
    const at = lines.indexOf('model = "gpt-5.6"');
    expect(at).toBeGreaterThan(lines.indexOf('"""', lines.indexOf('instructions = """')));
    expect(lines[at + 1]).toBe('model_reasoning_effort = "high"');
    expect(at).toBeLessThan(lines.indexOf("[mcp_servers.claudestra]"));
    expect(out.replace('model = "gpt-5.6"\nmodel_reasoning_effort = "high"\n', "")).toBe(base);
    expect(readCodexDefaultsToml(out)).toEqual({ model: "gpt-5.6", effort: "high" });
  });

  test("没有顶层键、开头就是表 → 加在文件开头", () => {
    const base = "[mcp_servers.x]\ncommand = \"x\"\n";
    expect(applyCodexDefaults(base, { model: "m1" })).toBe('model = "m1"\n' + base);
  });

  test("没有任何 [表] → 追加到末尾，保持以换行结尾", () => {
    expect(applyCodexDefaults('approval_policy = "never"\n# 尾注释\n', { model: "m1" })).toBe('approval_policy = "never"\n# 尾注释\nmodel = "m1"\n');
    expect(applyCodexDefaults("", { model: "m1", effort: "low" })).toBe('model = "m1"\nmodel_reasoning_effort = "low"\n');
    expect(applyCodexDefaults('a = 1', { effort: "low" })).toBe('a = 1\nmodel_reasoning_effort = "low"');
  });

  test("清空 → 删掉那一行（null 和空串一样），表里的同名键不动", () => {
    const out = applyCodexDefaults(SAMPLE, { model: null, effort: "" });
    expect(out).toBe(SAMPLE.replace('model = "gpt-5.5" # 主力\n', "").replace("model_reasoning_effort = 'high'\n", ""));
    expect(out).toContain('[profiles.fast]\nmodel = "gpt-5.5-mini"\nmodel_reasoning_effort = "low"');
    expect(readCodexDefaultsToml(out)).toEqual({ model: null, effort: null });
    expect(applyCodexDefaults(out, { model: null })).toBe(out); // 本来就没有：不变
  });

  test("值是多行字符串的旧键 → 整段替换", () => {
    const base = 'model = """\nold\n"""\nx = 1\n[t]\n';
    expect(applyCodexDefaults(base, { model: "m1" })).toBe('model = "m1"\nx = 1\n[t]\n');
  });

  test("带引号的键名也认（否则会多写一个重复键，Codex 直接读不了配置）", () => {
    expect(applyCodexDefaults('"model" = "a"\n[t]\n', { model: "b" })).toBe('model = "b"\n[t]\n');
  });

  test("CRLF 文件沿用 CRLF", () => {
    expect(applyCodexDefaults('a = 1\r\n[t]\r\nb = 2\r\n', { model: "m" })).toBe('a = 1\r\nmodel = "m"\r\n[t]\r\nb = 2\r\n');
  });

  test("读回：basic / literal 字符串、转义、多行字符串里的假键不算", () => {
    expect(readCodexDefaultsToml(SAMPLE)).toEqual({ model: "gpt-5.5", effort: "high" });
    expect(readCodexDefaultsToml('model = "a\\"b"\nmodel_reasoning_effort = 3\n')).toEqual({ model: 'a"b', effort: null });
    expect(readCodexDefaultsToml("[t]\nmodel = \"x\"\n")).toEqual({ model: null, effort: null });
  });

  test("值里的引号 / 反斜杠 / 控制字符按 TOML 转义", () => {
    expect(tomlBasicString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlBasicString("x\ny\u0001")).toBe('"x\\ny\\u0001"');
    const out = applyCodexDefaults("[t]\n", { model: 'we"ird\\' });
    expect(out).toBe('model = "we\\"ird\\\\"\n[t]\n');
    expect(readCodexDefaultsToml(out).model).toBe('we"ird\\');
  });

  test("其余行逐字不变（真实样例前后 diff）", () => {
    const out = applyCodexDefaults(SAMPLE, { model: "z", effort: "low" });
    const strip = (s: string, m: string, e: string) => s.replace(`${m}\n`, "").replace(`${e}\n`, "");
    expect(strip(out, 'model = "z" # 主力', 'model_reasoning_effort = "low"')).toBe(strip(SAMPLE, 'model = "gpt-5.5" # 主力', "model_reasoning_effort = 'high'"));
    expect(out.slice(out.indexOf("# MCP 服务器"))).toBe(SAMPLE.slice(SAMPLE.indexOf("# MCP 服务器")));
  });
});

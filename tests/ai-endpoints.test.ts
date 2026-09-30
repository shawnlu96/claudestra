/**
 * lib/ai-endpoints.ts + ai-inventory 的配置读取：官方 / 第三方 / 缺配置三类判定、base_url 脱敏、凭据字段不出现在输出里。
 * 验收线 P1：凭据（含 base_url 里的 key 参数）不得输出；第三方不得报成官方。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyClaudeEndpoint, classifyCodexEndpoint, classifyPiEndpoint, sanitizeBaseUrl } from "../src/lib/ai-endpoints.js";
import { claudeLayers, codexConfigPath, projectLayers } from "../src/lib/ai-inventory.js";

const SECRET = "SENTINEL0secret0VALUE0123456789";

describe("sanitizeBaseUrl", () => {
  test("去掉 query / fragment / 账号口令", () => {
    const s = sanitizeBaseUrl(`https://user:${SECRET}@proxy.example.com/v1/?key=${SECRET}&x=1#${SECRET}`)!;
    expect(s.baseUrl).toBe("https://proxy.example.com");
    expect(s.host).toBe("proxy.example.com");
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });
  test.each([
    "https://relay.example/api_key/shortKey123/v1",
    "https://relay.example/v1/secretpassword/anthropic",
    "https://relay.example/v1;token=FAKETOKEN",
    "https://relay.example/v1/%73hortKey123",
    "https://gw.example.com/sk-abc/v1",
  ])("路径一律不输出（短 key、纯字母、路径参数、编码段都不猜）：%s", (url) => {
    const s = sanitizeBaseUrl(url)!;
    expect(s.baseUrl).toBe(`https://${s.host}`);
    for (const leak of ["shortKey", "secretpassword", "FAKETOKEN", "73hort", "sk-abc", "v1"]) expect(JSON.stringify(s)).not.toContain(leak);
  });
  test("端口保留：官方判定要看它", () => {
    expect(sanitizeBaseUrl("http://LOCALHOST:11434/v1")).toEqual({ baseUrl: "http://localhost:11434", host: "localhost:11434", protocol: "http:", port: "11434" });
    expect(sanitizeBaseUrl(`https://gw.example.com/%E0%A4%A/v1`)!.host).toBe("gw.example.com"); // 坏的 % 转义不抛
  });
  test("解析不了 / 空 → null，不回原文", () => {
    expect(sanitizeBaseUrl(`not a url ${SECRET}`)).toBeNull();
    expect(sanitizeBaseUrl("")).toBeNull();
    expect(sanitizeBaseUrl(42)).toBeNull();
  });
});

describe("Claude Code", () => {
  test("缺配置 = 官方缺省", () => {
    const v = classifyClaudeEndpoint([{ from: "当前进程 env", env: {} }]);
    expect(v.kind).toBe("official");
    expect(v.host).toBeNull();
  });
  test("settings 写官方地址 = 官方", () => {
    expect(classifyClaudeEndpoint([{ from: "s", env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }]).kind).toBe("official");
  });
  test("第三方给主机名", () => {
    const v = classifyClaudeEndpoint([{ from: "s", env: { ANTHROPIC_BASE_URL: `https://api.deepseek.com/anthropic?key=${SECRET}`, ANTHROPIC_MODEL: "deepseek-chat" }, model: "opus" }]);
    expect(v.kind).toBe("third_party");
    expect(v.host).toBe("api.deepseek.com");
    expect(v.models).toEqual({ "s model": "opus", "s ANTHROPIC_MODEL": "deepseek-chat" });
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });
  test.each([
    "https://api.anthropic.com.evil.example",
    "http://api.anthropic.com",
    "https://api.anthropic.com:8443",
    "https://api.anthropic.com@evil.example",
    "https://anthropic.com",
  ])("伪装 / 非标准的官方地址一律第三方：%s", (url) => {
    expect(classifyClaudeEndpoint([{ from: "s", env: { ANTHROPIC_BASE_URL: url } }]).kind).toBe("third_party");
  });
  test("来源冲突：任一第三方即第三方，并标冲突", () => {
    const v = classifyClaudeEndpoint([
      { from: "settings", env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
      { from: "env", env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic" } },
    ]);
    expect(v.kind).toBe("third_party");
    expect(v.host).toBe("open.bigmodel.cn");
    expect(v.conflict).toBe(true);
    expect(v.sources.map((s) => s.from)).toEqual(["settings ANTHROPIC_BASE_URL", "env ANTHROPIC_BASE_URL"]);
  });
  test("两处不同的第三方也算冲突；同一个第三方写两遍不算", () => {
    const two = classifyClaudeEndpoint([
      { from: "settings", env: { ANTHROPIC_BASE_URL: "https://a.example/v1" } },
      { from: "env", env: { ANTHROPIC_BASE_URL: "https://b.example/v1" } },
    ]);
    expect(two).toMatchObject({ kind: "third_party", host: "a.example", conflict: true });
    const same = classifyClaudeEndpoint([
      { from: "settings", env: { ANTHROPIC_BASE_URL: "https://a.example/v1" } },
      { from: "env", env: { ANTHROPIC_BASE_URL: "https://a.example/anthropic" } },
    ]);
    expect(same.conflict).toBe(false);
  });
  test("settings 解析不了 = 未知，不当官方", () => {
    const v = classifyClaudeEndpoint([{ from: "s", env: null }, { from: "env", env: {} }]);
    expect(v.kind).toBe("unknown");
  });
  test("地址写坏 = 未知，不输出原文", () => {
    const v = classifyClaudeEndpoint([{ from: "s", env: { ANTHROPIC_BASE_URL: `garbage ${SECRET}` } }]);
    expect(v.kind).toBe("unknown");
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });
  test("Bedrock / Vertex 开关 = 第三方并写明哪家", () => {
    const v = classifyClaudeEndpoint([{ from: "env", env: { CLAUDE_CODE_USE_BEDROCK: "1" } }]);
    expect(v.kind).toBe("third_party");
    expect(v.provider).toBe("Amazon Bedrock");
    expect(classifyClaudeEndpoint([{ from: "env", env: { CLAUDE_CODE_USE_VERTEX: "0" } }]).kind).toBe("official");
  });
});

describe("Codex", () => {
  test("没有 config.toml = OpenAI 官方", () => {
    const v = classifyCodexEndpoint(undefined, {});
    expect(v.kind).toBe("official");
    expect(v.provider).toBe("openai");
  });
  test("只写了 model = 官方 + 配置模型", () => {
    const v = classifyCodexEndpoint({ model: "gpt-6.1-sol" }, {});
    expect(v.kind).toBe("official");
    expect(v.models).toEqual({ "config.toml model": "gpt-6.1-sol" });
  });
  test("自定义 provider 给主机名，凭据字段不输出", () => {
    const toml = {
      model: "deepseek-chat", model_provider: "ds",
      model_providers: {
        ds: { name: "DeepSeek", base_url: `https://api.deepseek.com/v1?api-key=${SECRET}`, env_key: "DS_KEY", http_headers: { Authorization: SECRET }, experimental_bearer_token: SECRET },
      },
    };
    const v = classifyCodexEndpoint(toml, {});
    expect(v.kind).toBe("third_party");
    expect(v.host).toBe("api.deepseek.com");
    expect(v.provider).toBe("ds（DeepSeek）");
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });
  test("profile 覆盖顶层", () => {
    const toml = { model: "a", profile: "p", profiles: { p: { model: "b", model_provider: "az" } }, model_providers: { az: { base_url: "https://x.openai.azure.com/openai" } } };
    const v = classifyCodexEndpoint(toml, {});
    expect(v.models).toEqual({ "config.toml profiles.p.model": "b" });
    expect(v.kind).toBe("third_party");
    expect(v.host).toBe("x.openai.azure.com");
  });
  test("OPENAI_BASE_URL 覆盖内置 openai = 第三方", () => {
    expect(classifyCodexEndpoint({}, { OPENAI_BASE_URL: "https://relay.example.com/v1" }).kind).toBe("third_party");
    expect(classifyCodexEndpoint({}, { OPENAI_BASE_URL: "https://api.openai.com/v1" }).kind).toBe("official");
  });
  test("provider 表里定义了 openai：OPENAI_BASE_URL / openai_base_url 照样列出，任一非官方即第三方", () => {
    const toml = { openai_base_url: "https://api.openai.com/v1", model_providers: { openai: { base_url: "https://api.openai.com/v1" } } };
    const v = classifyCodexEndpoint(toml, { OPENAI_BASE_URL: "https://relay.example/v1" });
    expect(v.sources.map((s) => s.from)).toEqual(["config.toml model_providers.openai.base_url", "config.toml openai_base_url", "当前进程 env OPENAI_BASE_URL"]);
    expect(v).toMatchObject({ kind: "third_party", host: "relay.example", conflict: true });
    expect(classifyCodexEndpoint({ model_provider: "ds", model_providers: { ds: { base_url: "https://api.deepseek.com" } } }, { OPENAI_BASE_URL: "https://x.example" }).sources).toHaveLength(1);
  });
  test("provider 找不到定义 / 文件解析不了 = 未知；内置本地模型 = 第三方", () => {
    expect(classifyCodexEndpoint({ model_provider: "nope" }, {}).kind).toBe("unknown");
    expect(classifyCodexEndpoint(null, {}).kind).toBe("unknown");
    expect(classifyCodexEndpoint({ model_provider: "oss" }, {}).kind).toBe("third_party");
  });
});

test("Pi 只报接入商名，不判官方", () => {
  const v = classifyPiEndpoint({ defaultProvider: "anthropic", defaultModel: "claude-x" }, ["my-proxy"]);
  expect(v.kind).toBe("unknown");
  expect(v.provider).toBe("anthropic");
  expect(v.models).toEqual({ "settings.json defaultModel": "claude-x" });
  expect(v.note).toContain("my-proxy");
});

describe("读真实文件：凭据字段从一开始就不进结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-inv-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("Claude settings.json 与进程 env 只挑判定键", () => {
    const cc = join(dir, "claude");
    mkdirSync(cc, { recursive: true });
    writeFileSync(join(cc, "settings.json"), JSON.stringify({
      model: "opus", apiKeyHelper: SECRET,
      env: { ANTHROPIC_BASE_URL: `https://api.moonshot.cn/anthropic?token=${SECRET}`, ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_API_KEY: SECRET },
    }));
    const layers = claudeLayers({ CLAUDE_CONFIG_DIR: cc, ANTHROPIC_API_KEY: SECRET, OTHER_TOKEN: SECRET });
    const settings = layers.find((l) => l.from === "~/.claude/settings.json")!;
    expect(Object.keys(settings.env!)).toEqual(["ANTHROPIC_BASE_URL"]);
    expect(layers.find((l) => l.from === "当前进程 env")!.env).toEqual({});
    const v = classifyClaudeEndpoint(layers);
    expect(v.kind).toBe("third_party");
    expect(v.host).toBe("api.moonshot.cn");
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });

  test("写坏的 settings.json → 未知", () => {
    const cc = join(dir, "broken");
    mkdirSync(cc, { recursive: true });
    writeFileSync(join(cc, "settings.json"), "{ not json");
    expect(classifyClaudeEndpoint(claudeLayers({ CLAUDE_CONFIG_DIR: cc })).kind).toBe("unknown");
  });

  test("agent 项目级 settings 把某个 agent 指到第三方 → 整体判第三方；非 Claude / 家目录 / 无线索的不收", () => {
    const mk = (name: string, files: Record<string, string>) => {
      const d = join(dir, name);
      mkdirSync(join(d, ".claude"), { recursive: true });
      for (const [f, body] of Object.entries(files)) writeFileSync(join(d, ".claude", f), body);
      return d;
    };
    const proxied = mk("proj-a", { "settings.local.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: SECRET } }) });
    const plain = mk("proj-b", { "settings.json": JSON.stringify({ permissions: { allow: [] } }) });
    const codex = mk("proj-c", { "settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://x.example" } }) });
    const home = mk("home", { "settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://y.example" } }) });
    const agents = [
      { name: "agent-a", cwd: proxied }, { name: "agent-a2", cwd: proxied }, { name: "agent-b", cwd: plain },
      { name: "agent-c", cwd: codex, runtime: "codex" }, { name: "agent-h", cwd: home }, { name: "agent-n" },
    ];
    const layers = projectLayers(agents, home);
    expect(layers.map((l) => l.from)).toEqual(["agent-a .claude/settings.local.json"]);
    const v = classifyClaudeEndpoint([...claudeLayers({ CLAUDE_CONFIG_DIR: join(dir, "none") }, agents)]);
    expect(v.kind).toBe("third_party");
    expect(v.host).toBe("api.deepseek.com");
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });

  test("CODEX_HOME 决定 config.toml 位置", () => {
    expect(codexConfigPath({ CODEX_HOME: join(dir, "cx") })).toBe(join(dir, "cx", "config.toml"));
  });
});

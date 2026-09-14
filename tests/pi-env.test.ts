/**
 * v2.23+ Pi 能力档案测试
 *
 * 重点锁住：
 *   - 档案 → 启动参数的翻译（minimal 必须真的关掉三类发现；信任开关落到 --no-approve）
 *   - 脏数据不抛、按缺省处理（registry 是手改得到的地方）
 *   - 磁盘清单读取（全局 settings.json / 项目 .pi/）与实际文件布局一致
 *   - 运行时快照的解析与新鲜度判断
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  describePiEnvProfile,
  isPackageSource,
  normalizePiEnvProfile,
  piEnvFlags,
  piEnvSnapshotPath,
  readPiGlobalEnv,
  readPiProjectEnv,
  readPiRuntimeSnapshot,
  snapshotIsFresh,
} from "../src/lib/pi-env.ts";

describe("normalizePiEnvProfile", () => {
  test("脏数据一律按缺省处理，不抛", () => {
    expect(normalizePiEnvProfile(undefined)).toEqual({});
    expect(normalizePiEnvProfile(null)).toEqual({});
    expect(normalizePiEnvProfile("minimal")).toEqual({});
    expect(normalizePiEnvProfile({ base: "yolo" })).toEqual({}); // 未知 base 不认
    expect(normalizePiEnvProfile({ extensions: "x" })).toEqual({});
    expect(normalizePiEnvProfile({ extensions: ["", "  ", 3] })).toEqual({});
  });

  test("合法字段被保留并去空", () => {
    expect(normalizePiEnvProfile({ base: "minimal", extensions: ["/a.ts", ""] })).toEqual({
      base: "minimal",
      extensions: ["/a.ts"],
    });
    expect(normalizePiEnvProfile({ trustProject: false })).toEqual({ trustProject: false });
    expect(normalizePiEnvProfile({ trustProject: "no" })).toEqual({}); // 非布尔不认
    expect(normalizePiEnvProfile({ mcpConfig: "  /tmp/m.json " })).toEqual({ mcpConfig: "/tmp/m.json" });
  });
});

describe("piEnvFlags", () => {
  test("缺省档案一个 flag 都不加（继承全局 = 引入档案前的行为）", () => {
    expect(piEnvFlags(undefined)).toEqual([]);
    expect(piEnvFlags({})).toEqual([]);
    expect(piEnvFlags({ base: "inherit" })).toEqual([]);
  });

  test("minimal 关掉三类发现（实测：--no-extensions 连包里的扩展一起关）", () => {
    expect(piEnvFlags({ base: "minimal" })).toEqual([
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
    ]);
  });

  test("不信任项目资源 → --no-approve（默认不出现）", () => {
    expect(piEnvFlags({ trustProject: false })).toEqual(["--no-approve"]);
    expect(piEnvFlags({ trustProject: true })).toEqual([]);
  });

  test("增删与 MCP 配置", () => {
    const flags = piEnvFlags({
      base: "minimal",
      extensions: ["/repo/ext.ts", "npm:pi-lens"],
      skills: ["/repo/skills"],
      excludeTools: ["web_search", "ask_codex"],
      mcpConfig: "/tmp/mcp.json",
    });
    expect(flags).toEqual([
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      // ⚠ 包源必须排在路径之前（实测：反序会让 npm: 源被静默忽略）
      "--extension",
      "npm:pi-lens",
      "--extension",
      "/repo/ext.ts",
      "--skill",
      "/repo/skills",
      "--exclude-tools",
      "web_search,ask_codex",
      "--mcp-config",
      "/tmp/mcp.json",
    ]);
  });

  test("isPackageSource 认 npm:/git:/http，其余当路径", () => {
    expect(isPackageSource("npm:pi-lens")).toBe(true);
    expect(isPackageSource("git:github.com/x/y")).toBe(true);
    expect(isPackageSource("https://example.com/e.ts")).toBe(true);
    expect(isPackageSource("/repo/ext.ts")).toBe(false);
    expect(isPackageSource("~/ext.ts")).toBe(false);
  });

  test("工具白名单用逗号连接", () => {
    expect(piEnvFlags({ tools: ["read", "bash"] })).toEqual(["--tools", "read,bash"]);
  });
});

describe("describePiEnvProfile", () => {
  test("人话描述覆盖关键开关", () => {
    expect(describePiEnvProfile(undefined)).toBe("继承全局");
    expect(describePiEnvProfile({ base: "minimal" })).toBe("最小集（不继承全局）");
    const text = describePiEnvProfile({ base: "minimal", excludeTools: ["web_search"], trustProject: false });
    expect(text).toContain("最小集");
    expect(text).toContain("禁工具 web_search");
    expect(text).toContain("不信任项目资源");
  });
});

describe("readPiGlobalEnv", () => {
  test("读出 packages/extensions/本地扩展/技能/MCP/提供商", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-env-global-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-lens"], extensions: ["/repo/hb.ts"], skills: ["/repo/skills"] }),
    );
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { mem0: { url: "http://x" } } }));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { glm: {}, codex: {} } }));
    mkdirSync(join(dir, "extensions"));
    writeFileSync(join(dir, "extensions", "mem0-perceive.ts"), "// x");
    mkdirSync(join(dir, "skills"));
    mkdirSync(join(dir, "skills", "save-compact"));
    writeFileSync(join(dir, "MEMORY.md"), "x");

    const env = readPiGlobalEnv(dir);
    expect(env.packages).toEqual(["npm:pi-lens"]);
    expect(env.extensions).toEqual(["/repo/hb.ts"]);
    expect(env.localExtensions).toEqual(["mem0-perceive.ts"]);
    expect(env.localSkills).toEqual(["save-compact"]);
    expect(env.mcpServers).toEqual(["mem0"]);
    expect(env.providers).toEqual(["glm", "codex"]);
    expect(env.memoryFiles).toEqual(["MEMORY.md"]);
  });

  test("目录/文件缺失时返回空清单而不是抛", () => {
    const env = readPiGlobalEnv(join(tmpdir(), "pi-env-does-not-exist"));
    expect(env.packages).toEqual([]);
    expect(env.localExtensions).toEqual([]);
    expect(env.mcpServers).toEqual([]);
  });
});

describe("readPiProjectEnv", () => {
  test("识别项目级资源与上下文文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-env-project-"));
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(dir, ".pi", "skills"), { recursive: true });
    mkdirSync(join(dir, ".agents", "skills", "foo"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), "{}");
    writeFileSync(join(dir, ".pi", "extensions", "local.ts"), "// x");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { local: {} } }));
    writeFileSync(join(dir, "AGENTS.md"), "x");

    const env = readPiProjectEnv(dir);
    expect(env.settingsPresent).toBe(true);
    expect(env.extensions).toEqual(["local.ts"]);
    expect(env.mcpServers).toEqual(["local"]);
    expect(env.contextFiles).toEqual(["AGENTS.md"]);
    expect(env.agentSkills).toEqual(["foo"]);
  });

  test("干净目录：什么都没有", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-env-clean-"));
    const env = readPiProjectEnv(dir);
    expect(env.settingsPresent).toBe(false);
    expect(env.extensions).toEqual([]);
    expect(env.contextFiles).toEqual([]);
  });
});

describe("运行时快照", () => {
  test("落点与解析：缺字段不炸，数字按 tools 长度兜底", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-env-home-"));
    const dir = join(home, ".claude-orchestrator", "pi-env");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "agent-x.json"),
      JSON.stringify({ at: "2026-09-14T00:00:00.000Z", agent: "agent-x", tools: ["read", "bash"], commands: ["x"] }),
    );
    const snap = readPiRuntimeSnapshot("agent-x", home);
    expect(snap?.toolCount).toBe(2);
    expect(snap?.tools).toEqual(["read", "bash"]);
    expect(snap?.commandCount).toBe(1);
    expect(piEnvSnapshotPath("agent-x", home)).toBe(join(dir, "agent-x.json"));
  });

  test("新鲜度：过期快照不当实况用", () => {
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    expect(snapshotIsFresh(null, now)).toBe(false);
    expect(snapshotIsFresh({ at: "2026-09-14T11:00:00.000Z" } as any, now)).toBe(true);
    expect(snapshotIsFresh({ at: "2026-01-01T00:00:00.000Z" } as any, now)).toBe(false);
    expect(snapshotIsFresh({ at: "垃圾" } as any, now)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { classifyClaudeInstall } from "../src/lib/claude-binary";

describe("classifyClaudeInstall — CC 自动升级走哪条路", () => {
  test("homebrew node 的 npm 全局安装（本机现状）→ npm，prefix = /opt/homebrew", () => {
    expect(classifyClaudeInstall("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe")).toEqual({
      kind: "npm",
      prefix: "/opt/homebrew",
    });
  });
  test("nvm 的 npm 全局安装 → npm，prefix 是那个 node 版本目录（升级必须装回这里）", () => {
    expect(
      classifyClaudeInstall("/Users/u/.nvm/versions/node/v22.3.0/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
    ).toEqual({ kind: "npm", prefix: "/Users/u/.nvm/versions/node/v22.3.0" });
  });
  test("brew cask → brew", () => {
    expect(classifyClaudeInstall("/opt/homebrew/Caskroom/claude-code/2.1.278/claude")).toEqual({
      kind: "brew",
      cask: "claude-code",
    });
  });
  test("官方原生安装器 → native（自带自更新，不插手）", () => {
    expect(classifyClaudeInstall("/Users/u/.local/share/claude/versions/2.1.278").kind).toBe("native");
  });
  test("volta / pnpm 等认不出的 → unknown（旧逻辑一律当 npm，会误升级）", () => {
    expect(classifyClaudeInstall("/Users/u/.volta/tools/image/packages/@anthropic-ai/claude-code/bin/claude").kind).toBe("unknown");
    expect(classifyClaudeInstall("/Users/u/Library/pnpm/global/5/.pnpm/x/node_modules/claude").kind).toBe("unknown");
  });
});

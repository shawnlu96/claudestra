import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { MCP_MOUNT_EXTENSION, piRpcArgs } from "../src/lib/acp/pi-adapter/args.ts";
import mountMcpServers, { PI_MCP_SERVERS_ENV } from "../src/lib/acp/pi-adapter/mcp-mount.ts";

/** `-e X` 成对出现的位置：返回 X 的列表 */
const extensions = (args: string[]) => args.flatMap((a, i) => (a === "-e" || a === "--extension" ? [args[i + 1]] : []));

describe("Pi 适配器 · 启动参数", () => {
  test("钉住：-e builtin:mcp 永远在，能力档带 --no-extensions 时也在（否则模型静默看不到 reply）", () => {
    for (const base of [[], ["--no-extensions", "--no-skills", "--no-prompt-templates"], ["-ne", "-e", "npm:pkg", "-e", "/x/ext.ts"]]) {
      const args = piRpcArgs("sid-1", base);
      expect(extensions(args)).toContain("builtin:mcp");
      expect(extensions(args)).toContain(MCP_MOUNT_EXTENSION);
    }
  });

  test("rpc 模式、能力档参数原样保序、会话 id 由适配器给", () => {
    expect(piRpcArgs("sid-1", ["--no-extensions", "--model", "p/m"])).toEqual([
      "--mode", "rpc", "--no-extensions", "--model", "p/m", "-e", "builtin:mcp", "-e", MCP_MOUNT_EXTENSION, "--session-id", "sid-1",
    ]);
  });

  test("挂载扩展是本仓里真实存在的绝对路径（pi 按路径 -e 加载）", () => {
    expect(MCP_MOUNT_EXTENSION.startsWith("/")).toBe(true);
    expect(existsSync(MCP_MOUNT_EXTENSION)).toBe(true);
  });

  test("调用方带会话 / 模式类参数 = 宿主 bug，直接拒；没有会话 id 也拒", () => {
    for (const flag of ["--mode", "--session-id", "--session", "--continue", "-c", "--resume", "--fork", "--no-session"]) {
      expect(() => piRpcArgs("sid-1", [flag, "x"])).toThrow(flag);
    }
    expect(() => piRpcArgs("")).toThrow("会话 id");
  });
});

describe("Pi 适配器 · 挂 MCP 的扩展", () => {
  test("按环境变量挂上每个 server，exposure 一律 direct；挂完把变量删掉（bash 工具的子进程看不到代理 token）", () => {
    const calls: [string, Record<string, unknown>][] = [];
    const servers = { claudestra: { command: "/bin/bun", args: ["cs.ts"], env: { A: "1" } } };
    const env: Record<string, string | undefined> = { [PI_MCP_SERVERS_ENV]: JSON.stringify(servers), KEEP: "1" };
    mountMcpServers({ registerMcpServer: (n, c) => void calls.push([n, c]) }, env);
    expect(calls).toEqual([["claudestra", { command: "/bin/bun", args: ["cs.ts"], env: { A: "1" }, exposure: "direct" }]]);
    expect(env).toEqual({ KEEP: "1" });
  });

  test("没有变量什么都不挂；JSON 坏了照样抛（pi 会发 extension_error，不静默）", () => {
    const calls: string[] = [];
    mountMcpServers({ registerMcpServer: (n) => void calls.push(n) }, {});
    expect(calls).toEqual([]);
    expect(() => mountMcpServers({ registerMcpServer: () => {} }, { [PI_MCP_SERVERS_ENV]: "{bad" })).toThrow();
  });
});

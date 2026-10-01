import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { MCP_MOUNT_EXTENSION, piRpcArgs } from "../src/lib/acp/pi-adapter/args.ts";
import mountMcpServers, { PI_MCP_SERVERS_ENV } from "../src/lib/acp/pi-adapter/mcp-mount.ts";
import { parseArgs } from "./pi-upstream-0.99.2.ts";

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
    for (const flag of ["--mode", "--session-id", "--session", "--session-dir", "--continue", "-c", "--resume", "--fork", "--no-session", "--no-tools", "--mode=print"]) {
      expect(() => piRpcArgs("sid-1", [flag, "x"])).toThrow(flag.split("=")[0]);
    }
    expect(() => piRpcArgs("")).toThrow("会话 id");
  });
});

/**
 * 判据是 pi 0.99.2 自己的 parseArgs（tests/pi-upstream-0.99.2.ts 原样移植）：要么 piRpcArgs 拒，要么 pi 解析出来
 * mode=rpc、sessionId=适配器给的、扩展里有 builtin:mcp 和挂载扩展，没有正文 / 文件 / 会话类字段 / 诊断。
 */
function piSees(args: string[]) {
  const p = parseArgs(args);
  return {
    mode: p.mode, sessionId: p.sessionId, mcp: p.extensions?.includes("builtin:mcp") && p.extensions?.includes(MCP_MOUNT_EXTENSION),
    stray: [...p.messages, ...p.fileArgs, ...p.diagnostics.map((d: { message: string }) => d.message)],
    session: [p.sessionDir, p.session, p.fork, p.continue, p.resume, p.noSession, p.noTools, p.print].filter((v) => v !== undefined),
  };
}
const SAFE = { mode: "rpc", sessionId: "owned", mcp: true, stray: [], session: [] };

describe("Pi 适配器 · 参数经 pi 0.99.2 parseArgs 实际解析", () => {
  test("审查复现的三种都拒：-- 吞掉后面全部、缺值的 --extension 吃掉 builtin:mcp、--session-dir", () => {
    expect(piSees(["--mode", "rpc", "--no-extensions", "--", "-e", "builtin:mcp", "--session-id", "owned"]).stray.length).toBeGreaterThan(0); // 修前的形状
    expect(() => piRpcArgs("owned", ["--no-extensions", "--"])).toThrow("--");
    expect(() => piRpcArgs("owned", ["--no-extensions", "--extension"])).toThrow("缺值");
    expect(() => piRpcArgs("owned", ["--session-dir", "/elsewhere"])).toThrow("--session-dir");
  });

  test("正常的能力档 / 模型参数：pi 看到的正是适配器要的", () => {
    for (const base of [
      [], ["--approve", "--no-extensions", "--no-skills", "--no-prompt-templates"], ["-ne", "-e", "npm:pkg", "-e", "/x/ext.ts", "--skill", "/s"],
      ["--tools", "read,bash,mcp__claudestra__reply", "--exclude-tools", "write"], ["--mcp-config", "/m.json", "--name", "a", "--append-system-prompt", "--x"],
      ["--model", "p/m", "--thinking", "high", "--no-approve", "--tools", "--"],
    ]) {
      expect(piSees(piRpcArgs("owned", base))).toEqual(SAFE);
    }
  });

  test("各种边缘写法：要么拒，要么 pi 解析结果安全（随机组合 2000 次）", () => {
    const pool = ["--", "-e", "--extension", "--tools", "--exclude-tools", "--mcp-config", "--name", "-n", "--session-dir", "--session-id", "--mode",
      "--print", "-p", "@f", "msg", "--x=1", "--tools=read", "--unknown", "-z", "--no-extensions", "--approve", "-", "---x", "", " ", "/abs", "-ne", "--model"];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    let accepted = 0;
    for (let k = 0; k < 2000; k++) {
      const base = Array.from({ length: 1 + rnd(5) }, () => pool[rnd(pool.length)]!);
      let args: string[];
      try {
        args = piRpcArgs("owned", base);
      } catch {
        continue;
      }
      accepted++;
      expect({ base, sees: piSees(args) }).toEqual({ base, sees: SAFE });
    }
    expect(accepted).toBeGreaterThan(50); // 确实有被接受的组合在受检
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

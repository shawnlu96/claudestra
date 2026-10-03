/**
 * reply 在 pi 最终工具表里活不活得下来（#300 r1 P1-4、#302 r1 P1-1）。判据全是上游原样移植的函数（tests/pi-upstream-0.99.2.ts）：
 * 实际参数 → parseArgs → 工具筛选（piKeepsTool），工具名用 createMcpToolName（含 64 字符截断加哈希）。不看 argv 里有没有某个子串。
 * 两层：manager 拼参数（piAcpArgs 经 keepReplyTool，保证不了就抛），适配器起 pi 前对着实际参数再查（piMountProblem）。
 */
import { describe, expect, test } from "bun:test";
import { piRpcArgs } from "../src/lib/acp/pi-adapter/args.ts";
import { piMountProblem } from "../src/lib/acp/pi-adapter/main.ts";
import { keepReplyTool, piReplyToolName, replyToolProblem } from "../src/lib/acp/pi-adapter/reply-tool.ts";
import type { PiEnvProfile } from "../src/lib/pi-env.ts";
import { piAcpArgs, piAcpClash } from "../src/lib/runtimes/pi-acp.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";
import { createMcpToolName, parseArgs, piKeepsTool } from "./pi-upstream-0.99.2.ts";

const spec = (piEnv?: PiEnvProfile): LaunchSpec => ({
  mode: "resume", channelId: "1", bridgeUrl: "ws://127.0.0.1:9", sessionId: "s", agentName: "agent-pa", purpose: "p", extras: piEnv ? { piEnv } : {},
});

/** manager 拼出的参数交给适配器、再交给 pi：pi 会不会留下 server 的 reply（名字按 pi 自己的规则算） */
function piKeepsReply(piEnv: PiEnvProfile | undefined, server: string): boolean {
  const parsed = parseArgs(piRpcArgs("s", piAcpArgs(spec(piEnv), "agent-pa", "/repo", false, server)));
  return piKeepsTool(parsed, createMcpToolName(server, "reply"));
}

const PROFILES: PiEnvProfile[] = [
  {}, { base: "minimal" }, { base: "minimal", tools: ["read", "bash"] }, { tools: ["read", "bash", "reply"] }, { tools: ["read"], excludeTools: ["write"] },
  { tools: ["mcp__claudestra__reply"] }, { trustProject: false, tools: ["read"] },
  { tools: ["read"], excludeTools: ["mcp__claudestra__reply"] }, { excludeTools: ["mcp__claudestra__reply"] }, { excludeTools: ["reply"] },
];
const SERVERS = ["claudestra", "my-mcp", "a".repeat(52), "a".repeat(53), "a".repeat(60), "bad.name", "x y"];

describe("能力档 × MCP_NAME：要么拼参数时就拒，要么 pi 真的留下 reply", () => {
  for (const server of SERVERS) {
    test(`MCP_NAME=${server.length > 20 ? `${server.length} 个 a` : server}`, () => {
      for (const piEnv of PROFILES) {
        let kept: boolean | "refused";
        try {
          kept = piKeepsReply(piEnv, server);
        } catch {
          kept = "refused";
        }
        expect({ piEnv, kept }).not.toEqual({ piEnv, kept: false });
      }
    });
  }

  test("审查的几种都按预期：白名单补上 / 旧名 reply 换掉；黑名单禁 reply、名字要截断加哈希、pi 不收的名字都拒", () => {
    expect(keepReplyTool({ tools: ["read", "bash"] }, "claudestra")?.tools).toEqual(["read", "bash", "mcp__claudestra__reply"]);
    expect(keepReplyTool({ tools: ["read", "reply"] }, "my-mcp")?.tools).toEqual(["read", "mcp__my_mcp__reply"]);
    expect(keepReplyTool({ base: "minimal" }, "claudestra")).toEqual({ base: "minimal" });
    expect(() => keepReplyTool({ tools: ["read"], excludeTools: ["mcp__claudestra__reply"] }, "claudestra")).toThrow("excludeTools");
    expect(() => keepReplyTool({ excludeTools: ["reply"] }, "claudestra")).toThrow("excludeTools");
    expect(() => piReplyToolName("a".repeat(60))).toThrow("太长");
    expect(createMcpToolName("a".repeat(60), "reply")).not.toBe(`mcp__${"a".repeat(60)}__reply`); // 上游确实截断加哈希
    expect(piReplyToolName("a".repeat(52))).toBe(createMcpToolName("a".repeat(52), "reply")); // 不截断的最长名字与上游一致
    expect(() => piReplyToolName("bad.name")).toThrow("不收");
  });
});

describe("适配器对着实际参数再查（宿主 / 沙箱之外的调用方传来什么都兜住）", () => {
  test("和上游筛选结论一致：白名单缺 reply、黑名单有 reply 都拒；别的 server 不要求 reply", () => {
    const cases: [string[], boolean][] = [
      [[], true], [["--tools", "read,bash"], false], [["--tools", "read,mcp__claudestra__reply"], true], [["--tools", "--"], false],
      [["--exclude-tools", "mcp__claudestra__reply"], false], [["--tools", "mcp__claudestra__reply", "--exclude-tools", "mcp__claudestra__reply"], false],
      [["--tools", " read , mcp__claudestra__reply ,"], true],
    ];
    for (const [base, keeps] of cases) {
      expect({ base, keeps: piKeepsTool(parseArgs(piRpcArgs("s", base)), "mcp__claudestra__reply") }).toEqual({ base, keeps });
      expect({ base, refused: piMountProblem(["claudestra"], "", base, {}) !== null }).toEqual({ base, refused: !keeps });
    }
    expect(piMountProblem(["other"], "", ["--tools", "read"], {})).toBeNull();
    expect(piMountProblem(["my-mcp"], "", ["--tools", "read"], { MCP_NAME: "my-mcp" })).toContain("mcp__my_mcp__reply");
    expect(replyToolProblem("a".repeat(60))).toContain("太长");
  });

  test("切 transport 的预检也拦（改 registry 之前）", () => {
    expect(piAcpClash("", {}, { tools: ["read"], excludeTools: ["reply"] })).toContain("excludeTools");
    expect(piAcpClash("", { MCP_NAME: "a".repeat(60) }, {})).toContain("太长");
    expect(piAcpClash("", {}, { tools: ["read"] })).toBeNull();
  });
});

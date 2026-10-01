/**
 * pi 的 mcp.json 里有同名 server（`-` 与 `_` 算同名）时，它静默顶掉扩展挂的 channel-server：模型没有 reply、也不报错
 * （pi 0.99 的内置 MCP 也会连上配置里那个同名 server、注册同名工具）。所以起 pi 前查用户级 <agent-dir>/mcp.json 与项目 <cwd>/.pi/mcp.json，
 * 撞名就拒起并点名文件。不改名：reply 的识别 / 隐藏、回复提示、bridge 的工具过滤都按 MCP_NAME 认。
 * 比 pi 略严：项目文件不看信任、禁用的条目也算（改一行配置就成了真覆盖）。agent 目录按 Pi 的规则算（lib/pi-path.ts）。
 * 只依赖 node 内置模块和 pi-path：pi 里的挂载扩展也调它。tests/pi-acp-mcp-clash.test.ts、tests/pi-acp-agent-dir.test.ts。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { piAgentDirOf } from "../../pi-path.js";

const namespace = (name: string) => name.replace(/-/g, "_");

function serverNames(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const servers = JSON.parse(readFileSync(path, "utf8"))?.mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch (e) {
    // pi 读到坏文件也是报错后整份跳过（config.js readConfigFile），里面的条目覆盖不了我们挂的 server
    console.error(`[pi-acp] ${path} 解析失败，按没有同名 server 算：${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** 要挂的 server 名与 pi 配置撞了就返回给人看的原因，不撞返回 null；cwd 为空只查用户级。agentDir 缺省按本进程的环境算 */
export function piMcpClash(names: readonly string[], cwd: string, agentDir: string = piAgentDirOf(process.env, cwd || undefined)): string | null {
  const files = [join(agentDir, "mcp.json"), ...(cwd ? [join(cwd, ".pi", "mcp.json")] : [])];
  for (const file of files) {
    const hit = serverNames(file).find((n) => names.some((m) => namespace(m) === namespace(n)));
    if (hit) return `${file} 里有名为「${hit}」的 MCP server，会顶掉 Claudestra 挂的同名 channel-server（模型就没有 reply）：改名或删掉它再切 acp`;
  }
  return null;
}

/**
 * Pi 扩展：把 ACP 适配器交来的 MCP server（session/new|resume 的 mcpServers，经环境变量传进 pi）挂进本会话。
 * 连接用 pi 公开导出的 createMcpExtension（内置 MCP 的同一份代码），只喂我们的 server，不经 registerMcpServer / builtin:mcp：
 * 第三方 MCP 扩展注册了 /mcp（如 pi-mcp-adapter）时 pi 不加载 builtin:mcp，靠它就静默没有 reply；这样也不会重连用户 mcp.json 里的 server。
 * exposure 固定 direct：缺省的 codemode 不把工具声明给模型。读完就从 pi 的环境里删掉：pi 的 bash 工具按 process.env 起子进程，留着就把回环代理 token 给了模型。
 * session_start（pi 等它跑完才读命令）先查撞名，再等 reply 真进了模型的工具表才报 MOUNT_OK（MOUNT_STATUS_KEY），否则报原因、适配器拒会话。
 * tests/pi-acp-mount-tools.test.ts。
 */
import { piAgentDirOf } from "../../pi-path.js";
import { piMcpClash } from "./mcp-clash.js";
import { piReplyToolName } from "./reply-tool.js";

export const PI_MCP_SERVERS_ENV = "CLAUDESTRA_PI_MCP_SERVERS";
/** 挂载扩展的状态键：值是 MOUNT_OK 或挂不上的原因；rpc 模式下 pi 把 setStatus 原样作为 extension_ui_request 吐给适配器 */
export const MOUNT_STATUS_KEY = "claudestra-mcp-mount";
export const MOUNT_OK = "ok";
/** 等 reply 进工具表的上限：要起 channel-server、走完 MCP 握手；须远小于适配器等启动查询的 60s（server.ts） */
const MOUNT_WAIT_MS = 20_000;

type Rec = Record<string, unknown>;
type Handler = (event: unknown, ctx: MountCtx) => unknown;

interface MountCtx {
  cwd: string;
  ui: { setStatus(key: string, text: string | undefined): void };
}

export interface MountApi {
  on(event: string, handler: Handler): unknown;
  getActiveTools(): string[];
  registerCommand?(name: string, options: unknown): void;
}

/** 起连接：把 servers 交给内置 MCP 的代码，它在 session_start 时开始连、连上后把工具注册进 pi */
type Connect = (pi: MountApi, servers: Record<string, Rec>) => Promise<void>;

const SKIPPED_EVENTS = new Set(["before_agent_start", "mcp_servers_change"]);

/**
 * 内置 MCP 代码里不归我们管的几处：/mcp 命令（非内置扩展注册它，pi 就把用户的 builtin:mcp 当成被替换、不加载）、
 * before_agent_start（会删掉 builtin 写的 mcp_servers 提示段）、mcp_servers_change 和 getMcpServers（别的扩展注册的 server 归 builtin 连）。
 */
function connectorApi(pi: MountApi): MountApi {
  return new Proxy(pi, {
    get(target, key) {
      if (key === "registerCommand") return (name: string, options: unknown) => (name === "mcp" ? undefined : target.registerCommand?.(name, options));
      if (key === "on") return (event: string, handler: Handler) => (SKIPPED_EVENTS.has(event) ? () => {} : target.on(event, handler));
      if (key === "getMcpServers") return () => [];
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const PI_PKG: string = "@earendil-works/pi-coding-agent";

const connectInPi: Connect = async (pi, servers) => {
  // pi 把自己的包作为虚拟模块提供给扩展。包名放变量里：字面量会让 bun build 去解析它，本仓不装 pi，bridge 入口打包就挂
  const { createMcpExtension } = await import(PI_PKG);
  // scope=extension：/mcp 里改设置只作用于本会话，不往任何 mcp.json 写（我们也没注册 /mcp）
  const entries = Object.entries(servers).map(([name, config]) => ({ name, config, source: "claudestra", scope: "extension" }));
  createMcpExtension({ loadConfig: () => ({ servers: entries, errors: [] }) })(connectorApi(pi));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 撞名、或等到期 reply 还不在模型的工具表里：返回原因；挂好了返回 MOUNT_OK */
async function mountStatus(pi: MountApi, names: string[], cwd: string, env: Record<string, string | undefined>, waitMs: number): Promise<string> {
  const clash = piMcpClash(names, cwd, piAgentDirOf(env, cwd));
  if (clash) return clash;
  const channel = env.MCP_NAME || "claudestra";
  if (!names.includes(channel)) return MOUNT_OK;
  const reply = piReplyToolName(channel);
  // ponytail: 轮询工具表（100ms），内置 MCP 不暴露连接完成的信号；pi 加了工具变更事件再换
  for (const end = Date.now() + waitMs; !pi.getActiveTools().includes(reply); await sleep(100)) {
    if (Date.now() >= end) return `等了 ${waitMs / 1000}s 工具表里还没有 ${reply}（channel-server 没连上或被别的扩展挡掉）：模型没法回复，不当接通`;
  }
  return MOUNT_OK;
}

export default async function mountMcpServers(
  pi: MountApi, env: Record<string, string | undefined> = process.env, connect: Connect = connectInPi, waitMs = MOUNT_WAIT_MS,
): Promise<void> {
  const raw = env[PI_MCP_SERVERS_ENV];
  if (!raw) return;
  delete env[PI_MCP_SERVERS_ENV];
  const servers = JSON.parse(raw) as Record<string, Rec>;
  const direct = Object.fromEntries(Object.entries(servers).map(([name, config]) => [name, { ...config, exposure: "direct" }]));
  await connect(pi, direct); // 先于下面的 session_start：内置 MCP 的 handler 要先跑、开始连，我们才等得到工具
  // 残余风险：撞名查的是磁盘上的 mcp.json，不是 Pi 已加载的快照；在加载与检查之间改写再恢复配置的同机进程不防
  // （没有系统级隔离时这类进程本来就能直接改 Pi 配置）。以后可改为 channel-server 回宿主握手确认实际挂上的是自己的实例。
  const names = Object.keys(servers);
  pi.on("session_start", async (_e, ctx) => ctx.ui.setStatus(MOUNT_STATUS_KEY, await mountStatus(pi, names, ctx.cwd, env, waitMs)));
}

/**
 * 适配器起 pi 的参数：rpc 模式 + 调用方给的能力档参数 + 挂 MCP 的两件套 + 会话 id。
 * 调用方参数先按 pi 0.99.2 parseArgs 的元数解析成结构，只收白名单里的选项，再由结构重新拼 argv：`--`（其后全成正文）、
 * 位置正文、缺值选项（会吞掉后面适配器的 -e / --session-id）、`--x=值`、会话 / 模式类选项一律拒，不靠字符串里有没有某个词。
 * `-e builtin:mcp` 照旧带上：能力档的 --no-extensions 会连内置 MCP 一起关掉（pi 0.99.1 实测），用户自己 mcp.json 里的 server 靠它；
 * channel-server 不靠它（第三方扩展注册 /mcp 时 pi 根本不加载它），挂载扩展自带连接器（mcp-mount.ts）。
 * tests/pi-acp-args.test.ts（拿上游 parseArgs 原样核对 mode / sessionId / extensions）。
 */
import { fileURLToPath } from "node:url";
import { isPiThinkingLevel, PI_THINKING_LEVELS } from "../../pi-launch.js";

export const MCP_MOUNT_EXTENSION = fileURLToPath(new URL("./mcp-mount.ts", import.meta.url));

/** value：后面跟一个值；repeat：可出现多次（开关重复给和给一次一样）；plain：pi 不认它（扩展的选项），值以 - 或 @ 开头时 pi 不吞值，后一个参数会被当成选项 */
type FlagSpec = { value: boolean; repeat?: boolean; plain?: boolean };

const BASE_FLAGS: Record<string, FlagSpec> = {
  "--approve": { value: false, repeat: true },
  "--no-approve": { value: false, repeat: true },
  "--no-extensions": { value: false, repeat: true },
  "--no-skills": { value: false, repeat: true },
  "--no-prompt-templates": { value: false, repeat: true },
  "--extension": { value: true, repeat: true },
  "--skill": { value: true, repeat: true },
  "--tools": { value: true },
  "--exclude-tools": { value: true },
  "--mcp-config": { value: true, plain: true },
  "--name": { value: true },
  "--append-system-prompt": { value: true, repeat: true },
  "--model": { value: true },
  "--thinking": { value: true },
};
/** pi 0.99.2 的短写（dist/cli/args.js），解析时换成长写 */
const ALIASES: Record<string, string> = {
  "-a": "--approve", "-na": "--no-approve", "-ne": "--no-extensions", "-ns": "--no-skills", "-np": "--no-prompt-templates",
  "-e": "--extension", "-t": "--tools", "-xt": "--exclude-tools", "-n": "--name",
};
/** 会话、模式、输出类：由适配器决定，调用方带了就是宿主的 bug（--no-tools 还会连 reply 一起筛掉） */
const OWNED = new Set([
  "--mode", "--session-id", "--session", "--session-dir", "--continue", "-c", "--resume", "-r", "--fork", "--no-session",
  "--print", "-p", "--export", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--help", "-h", "--version", "-v", "--list-models",
]);

interface PiBaseArg {
  flag: string;
  value?: string;
}

/** 调用方的 pi 参数 → 结构；任何 pi 会解析成别的意思的写法都抛（消息点名那个参数） */
function parsePiBaseArgs(args: readonly string[]): PiBaseArg[] {
  const out: PiBaseArg[] = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (OWNED.has(raw) || OWNED.has(raw.split("=")[0]!)) throw new Error(`pi 的 ${raw.split("=")[0]} 由 ACP 适配器决定，调用方不能再传`);
    const flag = ALIASES[raw] ?? raw;
    const spec = BASE_FLAGS[flag];
    if (!spec) throw new Error(`适配器不收这个 pi 参数：${JSON.stringify(raw)}（只收能力档 / 模型类选项，不收正文、文件、--、--x=值）`);
    if (!spec.repeat && out.some((a) => a.flag === flag)) throw new Error(`pi 的 ${flag} 只能给一次（pi 以最后一个为准，前面的会静默作废）`);
    if (!spec.value) {
      const opposite = flag === "--approve" ? "--no-approve" : flag === "--no-approve" ? "--approve" : "";
      if (opposite && out.some((a) => a.flag === opposite)) throw new Error("pi 的 --approve 和 --no-approve 同时给了（pi 以最后一个为准）");
      out.push({ flag });
      continue;
    }
    const value = args[++i];
    if (value === undefined || !value.trim()) throw new Error(`pi 的 ${flag} 缺值（缺值会吞掉适配器排在后面的参数）`);
    if (spec.plain && /^[-@]/.test(value)) throw new Error(`pi 的 ${flag} 的值不能以 - 或 @ 开头（pi 不会把它当值）：${value}`);
    if (flag === "--thinking" && !isPiThinkingLevel(value)) throw new Error(`pi 的 --thinking 只认 ${PI_THINKING_LEVELS.join(" / ")}（收到 ${value}，pi 会只警告、照默认档跑）`);
    out.push({ flag, value });
  }
  return out;
}

/** pi 实际拿到的工具白名单 / 黑名单（同 pi parseArgs：按逗号切、去空白、丢空项）；没给就是 undefined */
export function piToolLists(baseArgs: readonly string[]): { tools?: string[]; excludeTools?: string[] } {
  const list = (flag: string) => {
    const v = parsePiBaseArgs(baseArgs).find((a) => a.flag === flag)?.value;
    return v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter((n) => n.length > 0);
  };
  return { tools: list("--tools"), excludeTools: list("--exclude-tools") };
}

export function piRpcArgs(sessionId: string, baseArgs: readonly string[] = []): string[] {
  if (!sessionId) throw new Error("起 pi 缺会话 id");
  const base = parsePiBaseArgs(baseArgs).flatMap((a) => (a.value === undefined ? [a.flag] : [a.flag, a.value]));
  return ["--mode", "rpc", ...base, "-e", "builtin:mcp", "-e", MCP_MOUNT_EXTENSION, "--session-id", sessionId];
}

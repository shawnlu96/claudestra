/**
 * 中继中心这一侧的双认（src/relay/server.ts 只在原调用点换成这里的函数）：
 *   升级时选族：接收 on 且客户端提议了新族子协议才选新族，否则旧族——旧客户端、只认旧族的 front 都不受影响；
 *   认证：只按这条连接选定的族验签，另一族的签名成立也拒（不降级、不切新），回的错误码仍是 auth_failed；
 *   welcome：发送 on 时附上绑定本连接认证身份的能力；
 *   peer 请求：接收 on 时去掉两族的中继来源头与标记头——这些只该由中继 / 本机盖，别的实例自带的一律是伪造。
 * off 档每个函数的结果与现行代码相同；observe 结果也相同，另外在日志里报告 on 档会怎么判（只报名字与族，不报头值）。
 */
import type { Headers } from "../relay-protocol.js";
import { LOCAL_ROLES, RELAY_FAMILIES, relayFamilyOf, roleOf, type RelayFamilyId } from "../floka-compat/relay/families.js";
import { verifyRelayAuth, type RelayAuthFields } from "../floka-compat/relay/handshake.js";
import { issueCenterCapability, type CenterCapability } from "./capability.js";
import { parseCenterRename, type CenterRename, type CenterRenameConfig } from "./gear.js";

type Logger = (level: "info" | "warn" | "error", msg: string) => void;
/** 中继的启动参数里本卡读的两项；rename 缺省 = 两档 off */
export interface CenterOptions { rename?: CenterRenameConfig; log?: Logger }

const parsed = new WeakMap<object, CenterRename>();
/** 每个连接（ConnData）握手选定的族；没记过的一律旧族 */
const connFamily = new WeakMap<object, RelayFamilyId>();

const logOf = (opts: CenterOptions): Logger => opts.log ?? ((level, msg) => (level === "info" ? console.log : console.error)(`[relay] ${msg}`));

/** 每份启动参数只解析、只报一次配置问题 */
function gearsOf(opts: CenterOptions): CenterRename {
  let r = parsed.get(opts);
  if (r) return r;
  const { rename, problems } = parseCenterRename(opts.rename);
  for (const p of problems) logOf(opts)("warn", p);
  parsed.set(opts, (r = rename));
  return r;
}

const L = RELAY_FAMILIES.legacy;
const F = RELAY_FAMILIES.floka;

/** 升级响应的 Sec-WebSocket-Protocol；同时把这条连接的族记在 conn 上 */
export function centerSubprotocol(req: Request, conn: object, opts: CenterOptions): string {
  const { receive } = gearsOf(opts);
  const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
  const candidate: RelayFamilyId = offered.includes(F.subprotocol) && offered.includes(L.subprotocol) ? "floka" : "legacy";
  if (receive === "observe" && candidate === "floka") logOf(opts)("info", "center observe: 客户端提议了新族子协议，on 档会选 floka");
  const family = receive === "on" ? candidate : "legacy";
  connFamily.set(conn, family);
  return RELAY_FAMILIES[family].subprotocol;
}

function centerFamily(conn: object): RelayFamilyId {
  return connFamily.get(conn) ?? "legacy";
}

/** 认证签名：只按连接的族验。旧族连接上放行条件与 verifyAuthSignature 相同 */
export function centerVerifyAuth(conn: object, a: RelayAuthFields, sig: string, opts: CenterOptions): boolean {
  const { receive } = gearsOf(opts);
  const family = centerFamily(conn);
  const r = verifyRelayAuth(family, a, sig);
  if (!r.ok && receive !== "off") logOf(opts)("info", `center ${receive}: ${family} 连接认证失败（${r.reason}），不换族重验`);
  return r.ok;
}

/** welcome 帧附加的字段：发送 on 才有能力，observe 只报告 */
export function centerWelcome(fp: string, opts: CenterOptions): { capability?: CenterCapability } {
  const { send } = gearsOf(opts);
  if (send === "observe") logOf(opts)("info", `center observe: on 档会给 ${fp} 发新族能力`);
  return send === "on" ? { capability: issueCenterCapability(fp) } : {};
}

/** 只该由中继或本机盖的头：两族的中继头（来源、基址、路径模式）与本机回环标记 */
function stampedByUs(k: string): boolean {
  const low = k.toLowerCase();
  return relayFamilyOf(low) !== null || roleOf(low, LOCAL_ROLES) !== null;
}

/** 转给接收方之前的 peer 请求帧：接收 on 才清洗，off / observe 原样 */
export function centerForward<T extends { headers: Headers }>(frame: T, opts: CenterOptions): T {
  const { receive } = gearsOf(opts);
  if (receive === "off") return frame;
  const forged = Object.keys(frame.headers).filter(stampedByUs);
  if (!forged.length) return frame;
  if (receive === "observe") {
    logOf(opts)("info", `center observe: on 档会去掉 peer 请求自带的 ${forged.length} 个来源头（${forged.join(", ")}）`);
    return frame;
  }
  const headers: Headers = {};
  for (const [k, v] of Object.entries(frame.headers)) if (!stampedByUs(k)) headers[k] = v;
  return { ...frame, headers };
}

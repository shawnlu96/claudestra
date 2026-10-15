/**
 * 中继中心这一侧的双认（src/relay/server.ts 只在原调用点换成这里的函数）：
 *   升级时选族：接收 on 且客户端提议了新族子协议（单独提议或与旧族并提）才选新族，否则旧族——旧客户端不受影响；
 *        并提是本卡客户端的形式（旧中心照样选旧族，升级次序任意），单独提议与 floka-compat 的 acceptSubprotocol(on) 一致；
 *   hello：新族连接上附 subprotocol 报选定的族（客户端不靠 ws.protocol：Bun 客户端的这个值会被随后到的帧覆盖成乱码）；
 *        旧族连接的 hello 一字不变。这一字段在认证前、不可信，报错了只会让认证失败（中心只按自己选的族验），不会切新或降级；
 *   认证：只按这条连接选定的族验签，另一族的签名成立也拒（不降级、不切新），回的错误码仍是 auth_failed；
 *   welcome：发送 on 时附上绑定本连接认证身份的能力；
 *   peer 请求：接收 on 时去掉两族的中继来源头与标记头——这些只该由中继 / 本机盖，别的实例自带的一律是伪造；
 *   隧道请求（front 发给实例的 req）：接收 on 时去掉浏览器夹带的新族中继头与两族标记头。front 已清掉旧族中继头并盖上自己的，
 *        帧里的盖章头仍用 canonical 旧族名（实例侧按族读还没接线，换名会让现行实例读不到 base），两族不会同时出现。
 * off 档每个函数的结果与现行代码相同；observe 结果也相同，另外在日志里报告 on 档会怎么判（只报名字与族，不报头值）。
 */
import { RELAY_FROM, type Headers } from "../relay-protocol.js";
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
  const candidate: RelayFamilyId = offered.includes(F.subprotocol) ? "floka" : "legacy";
  if (receive === "observe" && candidate === "floka") logOf(opts)("info", "center observe: 客户端提议了新族子协议，on 档会选 floka");
  const family = receive === "on" ? candidate : "legacy";
  connFamily.set(conn, family);
  return RELAY_FAMILIES[family].subprotocol;
}

function centerFamily(conn: object): RelayFamilyId {
  return connFamily.get(conn) ?? "legacy";
}

/** hello 帧附加的字段：只有新族连接才有 */
export function centerHello(conn: object): { subprotocol?: string } {
  return centerFamily(conn) === "floka" ? { subprotocol: F.subprotocol } : {};
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

/** front 盖过章之后、浏览器还能夹带进来的：新族的中继头，两族的本机标记头（旧族中继头 front 已经清过、重盖过） */
function forgedInTunnel(k: string): boolean {
  const low = k.toLowerCase();
  const family = relayFamilyOf(low);
  return (family !== null && family !== L.id) || roleOf(low, LOCAL_ROLES) !== null;
}

/** front 发给实例的帧：只管隧道 req（from: "relay"），接收 on 才清洗，off / observe 原样 */
export function centerTunnel<T extends object>(frame: T, opts: CenterOptions): T {
  const { receive } = gearsOf(opts);
  if (receive === "off") return frame;
  const f = frame as { t?: unknown; from?: unknown; headers?: unknown };
  if (f.t !== "req" || f.from !== RELAY_FROM || !f.headers || typeof f.headers !== "object") return frame;
  const headers = f.headers as Headers;
  const forged = Object.keys(headers).filter(forgedInTunnel);
  if (!forged.length) return frame;
  if (receive === "observe") {
    logOf(opts)("info", `center observe: on 档会去掉隧道请求夹带的 ${forged.length} 个中继头（${forged.join(", ")}）`);
    return frame;
  }
  const clean: Headers = {};
  for (const [k, v] of Object.entries(headers)) if (!forgedInTunnel(k)) clean[k] = v;
  return { ...frame, headers: clean };
}

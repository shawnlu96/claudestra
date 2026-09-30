/**
 * 经中继打开的页面能不能加入加密邀请（owner 定：缺省允许，留「严格模式」开关，开了就拒）。
 * 允许时走的还是同一条 peer-join-auto：指纹核对、持钥证明都在 manager 里做，这里只决定放不放进去。
 * 开关存 config.json（lib/config-store.ts peerRelayJoinStrict），每次现读；manager 的 peer-relay-strict 写同一个键。
 * 只有 owner 设备能改；经中继的页面只能打开、不能关——被攻破的中继托管着那个页面，能关的话严格模式就形同虚设。
 * 单测在 tests/peer-relay-strict.test.ts。
 */
import { readConfig, setPeerRelayJoinStrict } from "../lib/config-store.js";
import { canManage } from "../lib/devices.js";
import { isOwnerPrincipal, type Principal } from "../lib/principals.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "./api-respond.js";
import { sourceAllows } from "./request-context.js";

const RELAY_STRICT_PATH = "/peers/relay-strict";
const OFF_FROM_RELAY_REFUSED = "经中继打开的页面不能关掉严格模式：请在本机页面关，或让大总管跑 peer-relay-strict off";

const relayJoinStrict = async (): Promise<boolean> => (await readConfig()).peerRelayJoinStrict === true;

/** 这个页面来的加入请求碰不碰得了加密邀请：本机 / 局域网照旧放行；中继页面看严格模式；判不出来源的一律不放 */
export async function keyedJoinAllowed(req: Request): Promise<boolean> {
  if (sourceAllows(req, "keyedInvite")) return true;
  return sourceAllows(req, "relayPageJoin") && !(await relayJoinStrict());
}

/** 加入页的淡色提示用：这次是在中继页面上、且放行了 */
export async function relayPageJoinNote(req: Request): Promise<boolean> {
  return !sourceAllows(req, "keyedInvite") && (await keyedJoinAllowed(req));
}

const canSet = (p: Principal): boolean => isOwnerPrincipal(p) && canManage(p);

/** GET / POST /peers/relay-strict；别的路径返回 null */
export async function handleRelayStrict(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== RELAY_STRICT_PATH) return null;
  const viaRelayPage = !sourceAllows(req, "keyedInvite");
  if (req.method === "GET") return apiJson(200, { ok: true, strict: await relayJoinStrict(), viaRelayPage, canSet: canSet(principal) });
  if (req.method !== "POST") return null;
  if (!canSet(principal)) return forbidden("only the owner's own devices can change strict mode");
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  if (typeof body?.strict !== "boolean") return apiJson(400, { ok: false, error: 'body must be {"strict": true|false}' });
  if (!body.strict && viaRelayPage) return apiJson(403, { ok: false, error: OFF_FROM_RELAY_REFUSED, code: "relay_strict_off_local_only" });
  const cfg = await setPeerRelayJoinStrict(body.strict);
  return apiJson(200, { ok: true, strict: cfg.peerRelayJoinStrict === true, viaRelayPage, canSet: true });
}

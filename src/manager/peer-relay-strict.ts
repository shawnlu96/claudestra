/**
 * `peer-relay-strict [status|on|off]`：经中继打开的页面能不能加入加密邀请（bridge/peer-relay-strict.ts）。
 * 缺省关 = 允许；on 恢复拒绝。写的是 config.json 的 peerRelayJoinStrict，bridge 每次加入现读，不用重启。
 * 网页上只有 owner 设备能改、且中继页面只能打开；这条命令给大总管用，本机跑，两个方向都能改。
 */
import { readConfig, setPeerRelayJoinStrict } from "../lib/config-store.js";
import { output } from "./core.js";

const USAGE = "peer-relay-strict [status|on|off]";

export async function cmdPeerRelayStrict(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  if (sub !== "status" && sub !== "on" && sub !== "off") return output({ ok: false, error: `不认识的参数 ${sub}`, usage: USAGE });
  const strict = sub === "status" ? (await readConfig()).peerRelayJoinStrict === true : (await setPeerRelayJoinStrict(sub === "on")).peerRelayJoinStrict === true;
  output({ ok: true, strict, note: strict ? "严格模式开：经中继打开的页面不能加入加密邀请" : "严格模式关：经中继打开的页面也能加入加密邀请（指纹核对、持钥证明照做）" });
}

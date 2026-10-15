/**
 * 实例到中继中心这一段的客户端双认（src/lib/relay-client.ts 在原调用点调这里）：
 *   提议：发送 on、接收 on、手里有中心发来的有效能力，才提议 [新族, 旧族]，否则只提议旧族。两个都提议是为了顺序任意：
 *        旧中心（只认旧族）照样选旧族，新中心按自己的接收档选；中心回切 off 时同一份提议落到旧族，身份不变、不断线。
 *   签名：按中心在升级响应里选定的子协议签，只认自己提议过的；
 *   能力：只从 welcome（认证之后）收，绑定本机指纹；welcome 里没有或不合格就清掉，下次连接回旧族。
 * 两档 off 时提议、签名与现行客户端逐字节相同，welcome 里的能力字段不看。
 */
import type { InstanceKey } from "../instance-signature.js";
import { keyFingerprint } from "../relay-protocol.js";
import { RELAY_FAMILIES, type RelayFamilyId } from "../floka-compat/relay/families.js";
import { signRelayAuth } from "../floka-compat/relay/handshake.js";
import { admitCenterCapability, type CenterCapability } from "./capability.js";
import { parseCenterRename, type CenterRename } from "./gear.js";

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

export class CenterLink {
  private readonly rename: CenterRename;
  private readonly fp: string;
  private capability: CenterCapability | null = null;
  private offered: readonly string[] = [];
  private _family: RelayFamilyId = "legacy";

  constructor(raw: unknown, private readonly key: InstanceKey, private readonly log: Logger) {
    const { rename, problems } = parseCenterRename(raw);
    for (const p of problems) log("warn", p);
    this.rename = rename;
    this.fp = keyFingerprint(key.publicKey);
  }

  /** 当前（最近一次握手）连接的族 */
  get family(): RelayFamilyId {
    return this._family;
  }

  /** 能力是否仍可用：每次提议前按当前时间重核一遍（过期的不再用） */
  private live(now: number): boolean {
    const c = this.capability;
    return !!c && admitCenterCapability(c, { fp: this.fp, authenticated: true }, now).ok;
  }

  /** 新连接要提议的子协议列表 */
  offer(now = Date.now()): string[] {
    const live = this.rename.receive !== "off" && this.live(now);
    const both = live && this.rename.send === "on" && this.rename.receive === "on";
    if (live && this.rename.send === "observe") this.log("info", "center observe: 中心有新族能力，on 档会提议 floka");
    const out = both ? [RELAY_FAMILIES.floka.subprotocol, RELAY_FAMILIES.legacy.subprotocol] : [RELAY_FAMILIES.legacy.subprotocol];
    this.offered = out;
    return out;
  }

  /** hello 之后的认证签名：族按升级响应选定的子协议，没提议过的子协议不认 */
  sign(selected: string, nonce: string, name: string, slug: string): string {
    const floka = selected === RELAY_FAMILIES.floka.subprotocol && this.offered.includes(selected);
    this._family = floka ? "floka" : "legacy";
    return signRelayAuth(this._family, this.key.privateKey, { key: this.key.publicKey, nonce, name, slug });
  }

  /** welcome 到了：按接收档收或清能力 */
  welcome(f: Record<string, unknown>, now = Date.now()): void {
    if (this.rename.receive === "off") return;
    const had = this.capability !== null;
    this.capability = null;
    if (f.capability === undefined) {
      if (had) this.log("info", "中心不再发新族能力，下次连接回旧族");
      return;
    }
    const r = admitCenterCapability(f.capability, { fp: this.fp, authenticated: true }, now);
    if (!r.ok) return this.log("warn", `中心的新族能力不合格（${r.reason}），按旧族`);
    this.capability = r.capability;
    if (this.rename.receive === "observe") this.log("info", "center observe: 中心发来有效的新族能力，on 档会据此提议 floka");
  }
}

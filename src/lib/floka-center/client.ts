/**
 * 实例到中继中心这一段的客户端双认（src/lib/relay-client.ts 在原调用点调这里）：
 *   提议：发送 on、接收 on、手里有中心发来的有效能力，才提议 [新族, 旧族]，否则只提议旧族。两个都提议是为了顺序任意：
 *        旧中心（只认旧族）照样选旧族，新中心按自己的接收档选；中心回切 off 时同一份提议落到旧族，身份不变、不断线。
 *   签名：按中心在 hello 里报的选定子协议签（没报 = 旧族；不读 ws.protocol，Bun 客户端的这个值会被随后到的帧覆盖），只认自己提议过的；
 *   能力：只从本连接发出 auth 之后的那一个 welcome 收，绑定本机指纹；认证前到的 welcome 里的能力一概不看（不收也不清）。
 *        welcome 里没有能力字段 = 中心撤回，清掉，下次连接回旧族；字段在但不合格（未知族、身份 / 版本不符、过期……）
 *        只拒这一份，手里仍有效的旧能力照留——坏声明既不切新也不把已有的支持降掉。
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
  /** 本连接已发出 auth、还没收到 welcome：只有这时的 welcome 才算认证过的能力来源 */
  private authSent = false;

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
    this.authSent = false;
    return out;
  }

  /** hello 之后的认证签名：族按中心在 hello 里报的子协议，没报或没提议过的一律旧族 */
  sign(selected: string, nonce: string, name: string, slug: string): string {
    const floka = selected === RELAY_FAMILIES.floka.subprotocol && this.offered.includes(selected);
    this._family = floka ? "floka" : "legacy";
    this.authSent = true;
    return signRelayAuth(this._family, this.key.privateKey, { key: this.key.publicKey, nonce, name, slug });
  }

  /** welcome 到了：按接收档收或清能力 */
  welcome(f: Record<string, unknown>, now = Date.now()): void {
    if (this.rename.receive === "off") return;
    const authenticated = this.authSent;
    this.authSent = false;
    if (!authenticated) {
      if (f.capability !== undefined) this.log("warn", "认证前的 welcome 带了新族能力，不收");
      return;
    }
    if (f.capability === undefined) {
      if (this.capability) this.log("info", "中心不再发新族能力，下次连接回旧族");
      this.capability = null;
      return;
    }
    const r = admitCenterCapability(f.capability, { fp: this.fp, authenticated }, now);
    if (!r.ok) return this.log("warn", `中心的新族能力不合格（${r.reason}），不收；已有的能力${this.capability ? "照留" : "仍没有"}`);
    this.capability = r.capability;
    if (this.rename.receive === "observe") this.log("info", "center observe: 中心发来有效的新族能力，on 档会据此提议 floka");
  }
}

/**
 * 台账四用途的本机接线（rename-floka-LEDGER1 r2）：各入口只调这里的一两个函数，判定都在 gear.ts / uses.ts。
 *   档位：config.json 的 `rename` 一节（ledgerReceive / ledgerSend，gear.ts 解析），每次现读，读不懂按 off；
 *   接收：ledgerReceive() 给档位和 observe 报告出口；
 *   发送：ledgerSendFamilyFor 按 ledgerSend + 注入的对端能力来源选族。能力来源不在本卡（中心先双认后另开卡），
 *         缺省「没有」= 恒发旧族；ledgerSend=on 却没有证明时记一条报告。
 * 会读配置和本机钥匙，不进协议核心闭包（shared-ledger-auth.ts 只引 request.ts / uses.ts）。单测 tests/floka-ledger.test.ts。
 */
import { readConfigSync } from "../config-store.js";
import { instanceKeySync, type InstanceKey } from "../instance-key.js";
import type { SignatureFamily, SignatureUse } from "../floka-compat/signature/families.js";
import { parseLedgerRename, type LedgerRename } from "./gear.js";
import { signLedgerUse, ledgerSendFamily, type LedgerReceive, type LedgerSigned } from "./uses.js";

export { ledgerPurposeHeaders } from "./request.js";

const said = new Set<string>();
/** 同一句只报一次：每个请求都现读配置，坏配置或缺证明不能刷屏 */
function report(line: string): void {
  if (said.has(line)) return;
  said.add(line);
  console.warn(`⚠️ [floka-ledger] ${line}`);
}

function ledgerRename(raw: unknown = readConfigSync().rename): LedgerRename {
  const { rename, problems } = parseLedgerRename(raw);
  for (const p of problems) report(p);
  return rename;
}

export function ledgerReceive(rename: LedgerRename = ledgerRename()): LedgerReceive {
  return {
    receive: rename.receive,
    report: (o) => report(`observe: ${o.use} 的 ${o.family} 族签名${o.wouldAccept ? "开到 on 会被认" : "开到 on 也验不过"}`),
  };
}

/** 对端（中心 / peer）的能力证明与本机钉住的身份；null = 没有 */
export type LedgerCapabilitySource = (use: SignatureUse, peer: string) =>
  { capability?: unknown; pinned: { instanceId: string; publicKey: string } | null } | null;

let capabilitySource: LedgerCapabilitySource = () => null;

/** 来源接线的卡用；传 null 恢复缺省「没有」 */
export function setLedgerCapabilitySource(source: LedgerCapabilitySource | null): void {
  capabilitySource = source ?? (() => null);
}

export function ledgerSendFamilyFor(use: SignatureUse, peer: string, rename: LedgerRename = ledgerRename(), now = Date.now()): SignatureFamily {
  if (rename.send === "off") return "claudestra";
  const cap = capabilitySource(use, peer);
  if (!cap) {
    if (rename.send === "on") report(`rename.ledgerSend=on，但 ${use} 的对端 ${peer} 没有能力证明，照发旧族`);
    return "claudestra";
  }
  const r = ledgerSendFamily(rename.send, cap, now);
  if (r.observed) report(`observe: ${use} 发给 ${peer} 时 on 档会发 ${r.observed} 族`);
  return r.family;
}

/**
 * 包一层已有的旧族签名器：选到旧族就原样调它（字节与改动前相同，测试注入的签名器照旧生效），选到新族才用本机钥匙签新族。
 * 入口只把 `sign` 换成 `ledgerSigner(用途, 对端, sign)`。
 */
export function ledgerSigner(use: SignatureUse, peer: string, legacy: (fields: string[]) => LedgerSigned | null,
  key: () => InstanceKey | null = instanceKeySync): (fields: string[]) => LedgerSigned | null {
  return (fields) => ledgerSendFamilyFor(use, peer) === "floka" ? signLedgerUse(use, fields, key(), "floka") : legacy(fields);
}

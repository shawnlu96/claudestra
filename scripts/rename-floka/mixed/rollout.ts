/**
 * rename.rollout：三机混版本滚动的计划与放行（rename-floka-MIX1）。纯函数，不读写文件、不连网。
 *   off     什么都不做；
 *   observe 缺省：只生成滚动计划（每台机器每一步要拨的档位与回滚动作）；
 *   on      只放行本目录的隔离矩阵——临时三实例 + 本机假中心；任何指向临时目录之外或真实中心的目标一律拒绝。
 * 计划次序固定：中心先双认 → 逐机切 state / runtime / services / mcp，再开该机的接收 → 三台都切完才开新发送。
 * 真实部署不在这里：生产切 on 由 PM 另行操作。
 */
import { isAbsolute, relative, resolve } from "node:path";

export type RolloutMode = "off" | "observe" | "on";

/** 每台机器的切换分项，按执行次序；回滚按相反次序 */
export const CUT_PARTS = ["state", "runtime", "services", "mcp", "receive"] as const;
export type CutPart = typeof CUT_PARTS[number];

/** 各分项在 config.json `rename` 一节里要拨到 on 的键（与各前卡的开关同名） */
export const PART_KEYS: Readonly<Record<CutPart, Record<string, unknown>>> = {
  state: { state: "on" },
  runtime: { runtime: "on" },
  services: { services: "on" },
  mcp: { mcp: "on" },
  // 新版本的接收档：两族都认，发送仍是旧族
  receive: { centerReceive: "on", signature: "on", peerRelayInbound: "on", ledgerReceive: "on", e2e: { receive: "on", send: "off" } },
};
const CENTER_KEYS = { centerReceive: "on", centerSend: "on" };
/** 三台都切完后才开：发送新族（仍要对端的认证能力才真发） */
export const SEND_KEYS = { centerSend: "on", peerRequestSend: "on", ledgerSend: "on", e2e: { receive: "on", send: "on" } };

export interface RolloutStep {
  id: string;
  kind: "center" | "cut" | "send";
  machine?: string;
  part?: CutPart;
  /** 这一步拨到的 rename 档位 */
  set: Record<string, unknown>;
  /** 这一步的回滚（失败时按已完成步骤逆序执行） */
  rollback: string;
}

export interface RolloutPlan {
  mode: RolloutMode;
  order: string[];
  steps: RolloutStep[];
  /** 合成验收不证明的事：照实写出来，不声称兼容 */
  notCovered: string[];
  problems: string[];
}

const ROLLBACK: Record<CutPart, string> = {
  state: "rollbackState：新根搬回旧根，迁移后新增的数据随根一起回去",
  runtime: "rollbackRuntimeAlias：只删本次建的别名，server 不动",
  services: "runServicePlan rollback：先停新四件再恢复旧四件，任何时刻只有一个写者",
  mcp: "rename.mcp 回 off：全新会话用旧族，已记新族的会话续接仍按记录",
  receive: "接收档回 off：只认旧族",
};

export const NOT_COVERED = [
  "真实三机未升级：本计划与矩阵只在临时三实例与本机假中心上跑",
  "不换域名：推送订阅、邀请链接与中继地址保持原域名，矩阵不验证换域",
  "不换 VAPID：推送沿用原 VAPID 钥匙，矩阵不声称新旧 VAPID 兼容",
];

/** 缺省 observe；off / observe / on 以外的值按 off（打错字不能变成执行） */
export function parseRollout(config: unknown): { mode: RolloutMode; problems: string[] } {
  const rename = config && typeof config === "object" ? (config as { rename?: unknown }).rename : undefined;
  const raw = rename && typeof rename === "object" ? (rename as { rollout?: unknown }).rollout : undefined;
  if (raw === undefined) return { mode: "observe", problems: [] };
  if (raw === "off" || raw === "observe" || raw === "on") return { mode: raw, problems: [] };
  return { mode: "off", problems: [`rename.rollout: ${JSON.stringify(raw)} 不是 off / observe / on，按 off 处理`] };
}

/** 三台机器的全部升级次序（全排列） */
export function upgradeOrders(machines: readonly string[]): string[][] {
  if (machines.length <= 1) return [[...machines]];
  return machines.flatMap((m, i) => upgradeOrders([...machines.slice(0, i), ...machines.slice(i + 1)]).map((rest) => [m, ...rest]));
}

export function rolloutSteps(order: readonly string[]): RolloutStep[] {
  if (new Set(order).size !== order.length || order.length === 0) throw new Error(`升级次序不合法：${JSON.stringify(order)}`);
  const steps: RolloutStep[] = [{ id: "center:dual", kind: "center", set: CENTER_KEYS, rollback: "中心接收 / 发送回 off：只认旧族，客户端重连回旧族" }];
  for (const machine of order) {
    for (const part of CUT_PARTS) steps.push({ id: `cut:${machine}:${part}`, kind: "cut", machine, part, set: PART_KEYS[part], rollback: ROLLBACK[part] });
  }
  for (const machine of order) {
    steps.push({ id: `send:${machine}`, kind: "send", machine, set: SEND_KEYS, rollback: "发送档回 off：下一次发送即回旧族，已发出的不重发" });
  }
  return steps;
}

/** off 没有步骤；observe / on 给同一份计划 */
export function rolloutPlan(config: unknown, order: readonly string[]): RolloutPlan {
  const { mode, problems } = parseRollout(config);
  return { mode, order: [...order], steps: mode === "off" ? [] : rolloutSteps(order), notCovered: NOT_COVERED, problems };
}

/** 隔离目标：所有根都在 base 之下、base 严格在某个系统临时目录（tmpRoots）之下，中心是本机回环上的假中心 */
export interface IsolatedTarget { base: string; tmpRoots: string[]; roots: string[]; center: string }

const inside = (dir: string, p: string): boolean => {
  const r = relative(resolve(dir), resolve(p));
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
};

/** on 的放行：只认本卡的临时三实例与假中心；off / observe 不执行 */
export function admitRun(mode: RolloutMode, t: IsolatedTarget): { ok: true } | { ok: false; reason: string } {
  if (mode !== "on") return { ok: false, reason: `rename.rollout=${mode}：只出计划，不执行` };
  const underTmp = t.tmpRoots.some((tmp) => isAbsolute(tmp) && resolve(t.base) !== resolve(tmp) && inside(tmp, t.base));
  if (!isAbsolute(t.base) || !underTmp) return { ok: false, reason: "not_isolated: 运行目录不在系统临时目录之下" };
  const outside = t.roots.filter((r) => !isAbsolute(r) || !inside(t.base, r));
  if (outside.length) return { ok: false, reason: `not_isolated: ${outside.length} 个根在运行目录之外` };
  let url: URL;
  try {
    url = new URL(t.center);
  } catch {
    return { ok: false, reason: "not_isolated: 中心地址不合法" };
  }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") return { ok: false, reason: "not_isolated: 只认本机回环上的假中心" };
  return { ok: true };
}

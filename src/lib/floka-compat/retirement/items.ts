/**
 * 收兼容的退出项（rename-floka-CLEAN1）：旧名兼容按项拆开，每项只认领与它相关的退出理由（floka-observation/exit.ts 的 code/subject）。
 * 一条理由没有任何一项认领、也不在 COMMON 里时按「阻止全部」处理——观察模块新加的理由码不会因为这里没登记而被悄悄放行。
 * 阶段 1（旧发送、旧安装别名）先收；阶段 2 的项要等阶段 1 全部收完（plan.ts 的 phase_order）。
 */
import type { ExitReason } from "../../floka-observation/types.js";

const RECEIVE_AREAS = ["signature", "relay", "ledger", "e2e", "browser"] as const;
type ReceiveArea = (typeof RECEIVE_AREAS)[number];

export const RETIRE_ITEMS = [
  "legacy-send", "install-alias",
  "receive-signature", "receive-relay", "receive-ledger", "receive-e2e", "receive-browser",
  "browser-storage", "scheme", "env", "legacy-read",
] as const;
export type RetireItem = (typeof RETIRE_ITEMS)[number];
export const isRetireItem = (v: unknown): v is RetireItem => typeof v === "string" && (RETIRE_ITEMS as readonly string[]).includes(v);

export const PHASE: Readonly<Record<RetireItem, 1 | 2>> = {
  "legacy-send": 1, "install-alias": 1,
  "receive-signature": 2, "receive-relay": 2, "receive-ledger": 2, "receive-e2e": 2, "receive-browser": 2,
  "browser-storage": 2, scheme: 2, env: 2, "legacy-read": 2,
};

/** 三机 / 节点、全部切新发送、观察窗口、回滚期：哪一项都绕不过 */
const COMMON = /^(fleet_|node_|not_all_send_new$|switch_time_unknown$|window_|rollback_)/;

/** 理由码去掉 _unknown 尾巴：没观测到与有旧流量对同一项生效 */
const base = (code: string): string => code.replace(/_unknown$/, "");

const traffic = (r: ExitReason, direction: "send" | "receive", area?: ReceiveArea): boolean =>
  (base(r.code) === "legacy_traffic" || r.code === "floka_traffic_unknown")
  && (r.subject ?? "").startsWith(area ? `${direction}/${area}/` : `${direction}/`);
const holder = (r: ExitReason, codes: readonly string[], subjects: readonly string[]): boolean =>
  codes.includes(base(r.code)) && subjects.includes(r.subject ?? "");
const infra = (r: ExitReason, items: readonly string[]): boolean => /^infra_/.test(r.code) && items.includes(r.subject ?? "");
const clients = (r: ExitReason, kinds: readonly string[]): boolean => holder(r, ["legacy_clients", "offline_clients"], kinds);
const payload = (r: ExitReason, kinds: readonly string[]): boolean => holder(r, ["payload_live", "payload_unexpired"], kinds);
const pending = (r: ExitReason): boolean => base(r.code) === "pending_calls" || base(r.code) === "pending_unexpired";
const sessions = (r: ExitReason): boolean => base(r.code) === "legacy_sessions";
const center = (r: ExitReason): boolean => r.code === "center_observation_missing";

/** 每格旧族载荷只挡收它那一区的接收 */
const AREA_PAYLOADS: Readonly<Record<ReceiveArea, readonly string[]>> = {
  signature: ["invite", "signature-capability"],
  relay: ["center-capability"],
  ledger: ["center-capability", "review-ticket", "lend-receipt"],
  e2e: ["e2e-capability"],
  browser: ["device-credential"],
};

function receive(area: ReceiveArea) {
  return (r: ExitReason): boolean =>
    traffic(r, "receive", area) || payload(r, AREA_PAYLOADS[area]) || pending(r)
    || (area === "browser" && clients(r, ["browser", "sw"]))
    || ((area === "relay" || area === "ledger") && center(r));
}

/** legacy-read 不在表里：旧读是最后的兜底，任何一条理由都挡它 */
const CLAIMS: Readonly<Record<Exclude<RetireItem, "legacy-read">, (r: ExitReason) => boolean>> = {
  "legacy-send": (r) => traffic(r, "send"),
  "install-alias": (r) => sessions(r) || infra(r, ["installCopies", "systemd"]),
  "receive-signature": receive("signature"),
  "receive-relay": receive("relay"),
  "receive-ledger": receive("ledger"),
  "receive-e2e": receive("e2e"),
  "receive-browser": receive("browser"),
  "browser-storage": (r) => clients(r, ["browser", "sw"]) || payload(r, ["device-credential"])
    || traffic(r, "receive", "browser") || infra(r, ["domain", "vapid"]),
  scheme: (r) => clients(r, ["browser", "native"]) || infra(r, ["installCopies"]),
  env: (r) => sessions(r) || infra(r, ["systemd", "nginx", "installCopies"]),
};

/** 挡某一项的理由：公共理由、该项认领的理由、以及谁都没认领的理由（失败即关） */
export function reasonsFor(item: RetireItem, all: readonly ExitReason[]): ExitReason[] {
  if (item === "legacy-read") return [...all];
  const claims = Object.values(CLAIMS);
  return all.filter((r) => COMMON.test(r.code) || CLAIMS[item](r) || !claims.some((c) => c(r)));
}

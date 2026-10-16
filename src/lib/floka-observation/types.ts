/**
 * 旧格式观察（rename-floka-OBSERVE1）的样本与报告形状。样本是显式输入的脱敏合成数据，
 * 只含计数、时间戳、枚举和受限字符集的节点 id；任何一项没观测到就是 "unknown"，判定时与「有旧流量」同样拒绝退出。
 * 这里不读生产配置、日志或统计；各族的线上名字见 floka-compat/*，本模块只按族 / 区域计数。
 */

export type Count = number | "unknown";
export type Instant = number | null | "unknown";

/** 线协议区域：签名（含请求签名）、中继、共享台账与回执票据、E2E、浏览器（cookie / CSRF / SW 消息 / 链接 scheme） */
export const AREAS = ["signature", "relay", "ledger", "e2e", "browser"] as const;
export type Area = (typeof AREAS)[number];
export const DIRECTIONS = ["receive", "send"] as const;
type Direction = (typeof DIRECTIONS)[number];
/** machine = 三台主机各自上报；center = 中继 / 台账中心上报（私仓侧） */
export const SOURCES = ["machine", "center"] as const;
type Source = (typeof SOURCES)[number];
/** 中心只经手中继与台账两段，其余区域没有中心视角 */
export const CENTER_AREAS: readonly Area[] = ["relay", "ledger"];

export const NODE_KINDS = ["machine", "relay", "ledger"] as const;
type NodeKind = (typeof NODE_KINDS)[number];
export const CLIENT_KINDS = ["browser", "sw", "native"] as const;
type ClientKind = (typeof CLIENT_KINDS)[number];
export const PAYLOAD_KINDS = [
  "invite", "signature-capability", "e2e-capability", "center-capability",
  "review-ticket", "lend-receipt", "device-credential",
] as const;
export type PayloadKind = (typeof PAYLOAD_KINDS)[number];
export const INFRA_ITEMS = ["domain", "vapid", "systemd", "nginx", "installCopies"] as const;
export type InfraItem = (typeof INFRA_ITEMS)[number];
export type InfraState = "done" | "pending" | "unknown";

export interface ObservedNode {
  id: string;
  kind: NodeKind;
  version: string | "unknown";
  receiveFloka: boolean | "unknown";
  sendFamily: "legacy" | "floka" | "unknown";
}
export interface TrafficCell { direction: Direction; area: Area; source: Source; legacy: Count; floka: Count }
export interface ClientCell { kind: ClientKind; legacy: Count; offline: Count }
export interface PayloadCell { kind: PayloadKind; legacyLive: Count; maxExpiresAt: Instant }

export interface ObservationSample {
  v: 1;
  fleet: { machines: number | "unknown" };
  window: { start: number; end: number } | "unknown";
  /** 最后一个节点切到新族发送的时刻；null = 还没全部切新 */
  allNewSendAt: Instant;
  rollbackPeriodMs: number | "unknown";
  nodes: ObservedNode[];
  traffic: TrafficCell[];
  sessions: { legacyMcp: Count };
  clients: ClientCell[];
  pending: { legacyCalls: Count; maxExpiresAt: Instant };
  payloads: PayloadCell[];
  infra: Record<InfraItem, InfraState>;
}

export interface ExitReason { code: string; subject?: string }
